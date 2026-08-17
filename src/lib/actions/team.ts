"use server";

// Alles, womit der Mensch das Agenten-Team steuert: starten, anhalten,
// weiterlaufen lassen, nachfragen, freigeben.
//
// Die Actions selbst arbeiten NICHT – sie reihen Jobs ein (siehe
// worker/queue.ts). Ein Klick soll sofort zurückkommen, auch wenn das Team
// danach eine halbe Stunde beschäftigt ist.
import { prisma } from "@/lib/prisma";
import { fail, note, ok, type ActionResult } from "@/lib/actions/result";
import { agentForRole, ensureProjectTeam } from "@/lib/team";
import { scheduleNextStep } from "@/lib/nextStep";
import { revalidateProject } from "@/lib/actions/revalidate";
import { resolveReview } from "@/lib/reviewDecision";
import { enqueueAgentJob } from "../../../worker/queue";

function str(formData: FormData, key: string): string | null {
  const value = String(formData.get(key) ?? "").trim();
  return value.length > 0 ? value : null;
}

/// Team-Start: Mannschaft aufstellen, Projekt auf Aktiv, ersten Arbeitstag
/// einreihen (Repo anlegen, Auftrag lesen). Setzt Konzept- UND
/// Anforderungsfreigabe voraus – dieselbe Pruefung wie in der Oberflaeche,
/// damit auch ein direkter Aufruf nicht daran vorbeikommt.
export async function startTeam(formData: FormData): Promise<ActionResult> {
  const projectId = str(formData, "projectId");
  if (!projectId) return fail("Kein Projekt angegeben.");

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: { concept: true },
  });
  if (!project) return fail("Projekt nicht gefunden.");
  if (project.concept?.status !== "FINALIZED") return fail("Erst das Konzept freigeben, dann das Team starten.");
  if (!project.requirementsApprovedAt) {
    return fail("Erst die Anforderungen freigeben, dann das Team starten.");
  }
  if (project.status === "ACTIVE") return note("Das Team arbeitet bereits an diesem Projekt.");

  // Es gab schon einen ersten Arbeitstag (Repo steht): Dann ist „starten" ein
  // Fortsetzen, kein zweiter Kickoff – sonst schriebe das Team das
  // Projektverständnis neu und plante einen Sprint neben dem laufenden.
  if (project.workspacePath) {
    await prisma.$transaction([
      prisma.project.update({ where: { id: projectId }, data: { status: "ACTIVE" } }),
      prisma.activityLogEntry.create({
        data: { projectId, actor: "Mensch", action: "team_resumed", detail: "Arbeit fortgesetzt" },
      }),
    ]);
    const next = await scheduleNextStep(projectId);
    revalidateProject(projectId);
    return ok(`Das Team nimmt die Arbeit wieder auf. ${next}`);
  }

  const hired = await ensureProjectTeam(projectId);
  const productOwner = await agentForRole(projectId, "PRODUCT_OWNER");
  if (!productOwner) return fail("Es konnte kein Team aufgestellt werden.");

  await prisma.$transaction([
    prisma.project.update({ where: { id: projectId }, data: { status: "ACTIVE", autopilot: true } }),
    prisma.activityLogEntry.create({
      data: {
        projectId,
        actor: "Mensch",
        action: "team_started",
        detail:
          `Agenten-Team gestartet` +
          (hired.length > 0 ? ` – neu ins Team: ${hired.map((agent) => agent.name).join(", ")}` : ""),
      },
    }),
  ]);

  await enqueueAgentJob("teamKickoff", {
    agentId: productOwner.id,
    projectId,
    reason: "Team gestartet – erster Arbeitstag",
  });

  revalidateProject(projectId);
  return ok(
    `Team gestartet. ${productOwner.name} richtet gerade das Repository ein und liest den Auftrag – im Team-Büro live mitzuverfolgen.`,
  );
}

/// Not-Aus: Laufende Jobs brechen beim naechsten Schritt ab (jeder Task prueft
/// den Projektstatus), neue kommen nicht dazu.
export async function pauseTeam(formData: FormData): Promise<ActionResult> {
  const projectId = str(formData, "projectId");
  if (!projectId) return fail("Kein Projekt angegeben.");

  await prisma.$transaction([
    prisma.project.update({ where: { id: projectId }, data: { status: "PAUSED" } }),
    prisma.activityLogEntry.create({
      data: { projectId, actor: "Mensch", action: "team_paused", detail: "Arbeit angehalten" },
    }),
  ]);

  revalidateProject(projectId);
  return ok("Team angehalten. Der laufende Schritt wird noch zu Ende gebracht, danach ruht die Arbeit.");
}

export async function resumeTeam(formData: FormData): Promise<ActionResult> {
  const projectId = str(formData, "projectId");
  if (!projectId) return fail("Kein Projekt angegeben.");

  await prisma.$transaction([
    prisma.project.update({ where: { id: projectId }, data: { status: "ACTIVE" } }),
    prisma.activityLogEntry.create({
      data: { projectId, actor: "Mensch", action: "team_resumed", detail: "Arbeit fortgesetzt" },
    }),
  ]);

  const result = await scheduleNextStep(projectId);
  revalidateProject(projectId);
  return ok(`Team arbeitet weiter. ${result}`);
}

export async function setAutopilot(formData: FormData): Promise<ActionResult> {
  const projectId = str(formData, "projectId");
  if (!projectId) return fail("Kein Projekt angegeben.");
  const on = String(formData.get("autopilot") ?? "") === "on";

  await prisma.project.update({ where: { id: projectId }, data: { autopilot: on } });
  await prisma.activityLogEntry.create({
    data: {
      projectId,
      actor: "Mensch",
      action: on ? "autopilot_on" : "autopilot_off",
      detail: on
        ? "Team plant nach jedem Sprint selbstständig den nächsten"
        : "Team hält nach dem laufenden Sprint an",
    },
  });

  revalidateProject(projectId);
  return ok(on ? "Autopilot an – das Team plant nach dem Review direkt weiter." : "Autopilot aus – das Team hält nach dem laufenden Sprint an.");
}

/// „Macht weiter" von Hand: reiht den Schritt ein, der laut Board dran ist.
export async function nudgeTeam(formData: FormData): Promise<ActionResult> {
  const projectId = str(formData, "projectId");
  if (!projectId) return fail("Kein Projekt angegeben.");

  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) return fail("Projekt nicht gefunden.");
  if (project.status !== "ACTIVE") return fail("Das Projekt ist nicht aktiv – erst fortsetzen.");

  const running = await prisma.agentRun.findFirst({ where: { projectId, status: "RUNNING" } });
  if (running) return note("Das Team arbeitet gerade – der nächste Schritt kommt von allein.");

  const message = await scheduleNextStep(projectId);
  revalidateProject(projectId);
  return ok(message);
}

/// Rueckfrage ans Team – die Antwort schreibt der Scrum-Master-Agent, sobald
/// der Worker sie abgearbeitet hat.
export async function askTeam(formData: FormData): Promise<ActionResult> {
  const projectId = str(formData, "projectId");
  const question = str(formData, "question");
  if (!projectId) return fail("Kein Projekt angegeben.");
  if (!question) return fail("Bitte eine Frage eingeben.");

  const scrumMaster = await agentForRole(projectId, "SCRUM_MASTER");
  if (!scrumMaster) return fail("Diesem Projekt ist kein Team zugeordnet – erst das Team starten.");

  const inquiry = await prisma.teamInquiry.create({ data: { projectId, question } });
  await enqueueAgentJob("teamInquiry", {
    agentId: scrumMaster.id,
    projectId,
    inquiryId: inquiry.id,
    reason: "Rückfrage des Auftraggebers",
  });

  revalidateProject(projectId);
  return ok(`Frage an ${scrumMaster.name} weitergegeben – die Antwort erscheint gleich hier.`);
}

/// Menschliche Freigabe fuer ein Ticket, das das Team abgegeben hat.
/// Ablehnung schickt das Ticket mit Begruendung zurueck ins Team.
export async function decideReview(formData: FormData): Promise<ActionResult> {
  const reviewId = str(formData, "reviewId");
  const decision = str(formData, "decision");
  const comment = str(formData, "comment");
  if (!reviewId || (decision !== "APPROVED" && decision !== "REJECTED")) {
    return fail("Keine gültige Entscheidung übergeben.");
  }

  const review = await prisma.reviewApproval.findUnique({
    where: { id: reviewId },
    include: { ticket: true },
  });
  if (!review) return fail("Freigabe nicht gefunden.");
  if (review.decision !== "PENDING") return note("Diese Freigabe ist bereits entschieden.");

  const projectId = review.ticket.projectId;
  const outcome = await resolveReview({ reviewId, decision, comment, decidedBy: "Mensch" });
  revalidateProject(projectId);
  return ok(outcome);
}

/// „Team soll entscheiden": Liegt vom Product Owner schon eine Empfehlung vor
/// (siehe reviewTriage), setzt sie das Team sofort um. Sonst prueft der
/// Product Owner die Freigabe jetzt selbst, mit `forceDecide` – auch bei als
/// kritisch markierten Tickets, die reviewTriage sonst nie anfasst: Diesmal
/// hat der Auftraggeber die Entscheidung ausdruecklich abgegeben.
export async function delegateReview(formData: FormData): Promise<ActionResult> {
  const reviewId = str(formData, "reviewId");
  if (!reviewId) return fail("Keine Freigabe angegeben.");

  const review = await prisma.reviewApproval.findUnique({ where: { id: reviewId }, include: { ticket: true } });
  if (!review) return fail("Freigabe nicht gefunden.");
  if (review.decision !== "PENDING") return note("Diese Freigabe ist bereits entschieden.");

  const projectId = review.ticket.projectId;

  if (review.recommendedDecision) {
    const outcome = await resolveReview({
      reviewId,
      decision: review.recommendedDecision,
      comment: review.recommendedFeedback,
      decidedBy: "Team (auf deinen Wunsch)",
    });
    revalidateProject(projectId);
    return ok(`An das Team delegiert. ${outcome}`);
  }

  const decider = (await agentForRole(projectId, "PRODUCT_OWNER")) ?? (await agentForRole(projectId, "SCRUM_MASTER"));
  if (!decider) return fail("Kein Product Owner oder Scrum Master im Team – bitte selbst entscheiden.");

  await enqueueAgentJob("reviewTriage", {
    agentId: decider.id,
    projectId,
    reviewId,
    reason: "Auftraggeber hat die Entscheidung delegiert",
    forceDecide: true,
  });

  revalidateProject(projectId);
  return ok(`${decider.name} entscheidet jetzt – die Freigabe schließt sich gleich von selbst.`);
}
