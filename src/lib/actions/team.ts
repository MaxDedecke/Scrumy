"use server";

// Alles, womit der Mensch das Agenten-Team steuert: starten, anhalten,
// weiterlaufen lassen, nachfragen, freigeben.
//
// Die Actions selbst arbeiten NICHT – sie reihen Jobs ein (siehe
// worker/queue.ts). Ein Klick soll sofort zurückkommen, auch wenn das Team
// danach eine halbe Stunde beschäftigt ist.
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { fail, note, ok, type ActionResult } from "@/lib/actions/result";
import { agentForRole, ensureProjectTeam } from "@/lib/team";
import { enqueueAgentJob } from "../../../worker/queue";

function str(formData: FormData, key: string): string | null {
  const value = String(formData.get(key) ?? "").trim();
  return value.length > 0 ? value : null;
}

function revalidateProject(projectId: string) {
  revalidatePath(`/projects/${projectId}`);
  revalidatePath(`/projects/${projectId}/office`);
  revalidatePath(`/projects/${projectId}/records`);
  revalidatePath(`/projects/${projectId}/discovery`);
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

/// Bestimmt aus dem Projektstand, was als Naechstes ansteht, und reiht es ein.
/// Dieselbe Logik nutzen „Fortsetzen" und „Nächsten Schritt anstoßen".
async function scheduleNextStep(projectId: string): Promise<string> {
  const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });

  const sprint = await prisma.sprint.findFirst({
    where: { projectId },
    orderBy: { number: "desc" },
    include: { tickets: true },
  });

  // Noch kein Arbeitsplatz/Sprint: erster Arbeitstag.
  if (!project.workspacePath || !sprint) {
    const productOwner = await agentForRole(projectId, "PRODUCT_OWNER");
    if (!productOwner) return "Es ist kein Team zugeordnet.";
    await enqueueAgentJob("teamKickoff", {
      agentId: productOwner.id,
      projectId,
      reason: "Arbeit aufgenommen",
    });
    return `${productOwner.name} richtet das Repository ein und liest den Auftrag.`;
  }

  if (sprint.status === "DONE") {
    const productOwner = await agentForRole(projectId, "PRODUCT_OWNER");
    if (!productOwner) return "Es ist kein Product Owner zugeordnet.";
    await enqueueAgentJob("sprintPlanning", {
      agentId: productOwner.id,
      projectId,
      reason: "nächster Sprint angestoßen",
    });
    return `${productOwner.name} plant Sprint ${sprint.number + 1}.`;
  }

  const openTicket = sprint.tickets
    .filter((ticket) => ticket.status === "BACKLOG" || ticket.status === "IN_PROGRESS")
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0];

  if (openTicket) {
    const assignee = openTicket.assigneeId
      ? await prisma.agent.findUnique({ where: { id: openTicket.assigneeId } })
      : await agentForRole(projectId, "BACKEND");
    if (!assignee) return "Für das nächste Ticket ist niemand zuständig.";
    await enqueueAgentJob("ticketWork", {
      agentId: assignee.id,
      projectId,
      ticketId: openTicket.id,
      reason: "von Hand angestoßen",
    });
    return `${assignee.name} übernimmt „${openTicket.title}".`;
  }

  const scrumMaster = await agentForRole(projectId, "SCRUM_MASTER");
  if (!scrumMaster) return "Es ist kein Scrum Master zugeordnet.";
  await enqueueAgentJob("sprintReview", {
    agentId: scrumMaster.id,
    projectId,
    sprintId: sprint.id,
    reason: "von Hand angestoßen",
  });
  return `${scrumMaster.name} schließt Sprint ${sprint.number} ab.`;
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

  const ticket = review.ticket;
  const projectId = ticket.projectId;

  await prisma.$transaction([
    prisma.reviewApproval.update({
      where: { id: reviewId },
      data: {
        decision,
        comment: comment ?? review.comment,
        decidedAt: new Date(),
        reviewerName: "Mensch",
      },
    }),
    prisma.ticket.update({
      where: { id: ticket.id },
      data: { status: decision === "APPROVED" ? "DONE" : "IN_PROGRESS" },
    }),
    prisma.activityLogEntry.create({
      data: {
        projectId,
        ticketId: ticket.id,
        actor: "Mensch",
        action: decision === "APPROVED" ? "human_approved" : "human_rejected",
        detail:
          `„${ticket.title}" ${decision === "APPROVED" ? "freigegeben" : "zurückgewiesen"}` +
          (comment ? `: ${comment}` : ""),
      },
    }),
  ]);

  // Zurueckgewiesen heisst: derselbe Kollege macht weiter, mit der Begruendung
  // des Chefs als neuer Vorgabe.
  if (decision === "REJECTED") {
    const assignee = ticket.assigneeId
      ? await prisma.agent.findUnique({ where: { id: ticket.assigneeId } })
      : await agentForRole(projectId, "BACKEND");
    const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });

    if (assignee && project.status === "ACTIVE") {
      await prisma.ticket.update({
        where: { id: ticket.id },
        data: {
          plan: `${ticket.plan ?? ""}\n\n## Rückmeldung des Auftraggebers\n${comment ?? "(ohne Begründung)"}`,
        },
      });
      await enqueueAgentJob("ticketWork", {
        agentId: assignee.id,
        projectId,
        ticketId: ticket.id,
        reason: `Nacharbeit nach Rückweisung durch den Auftraggeber: ${(comment ?? "").slice(0, 200)}`,
      });
    }
  }

  revalidateProject(projectId);
  return ok(
    decision === "APPROVED"
      ? `„${ticket.title}" freigegeben.`
      : `„${ticket.title}" zurückgewiesen – das Team arbeitet nach.`,
  );
}
