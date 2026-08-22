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
import { reconcileStaleLocksNow } from "../../../worker/reconcile";
import { scheduleParallelCheck } from "../../../worker/tasks/parallelCheck";

/// Anlass-Kennung der Beschluesse, mit denen eine Ausbaustufe beauftragt wird.
/// Ueber sie wird gezaehlt, die wievielte es ist – und sie taucht in der
/// Klaerungsliste als eigener Anlass auf.
const EXTENSION_TRIGGER = "extension_commissioned";

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
    // Fuellt fehlende Rollen auch bei einem laufenden Projekt auf – etwa wenn
    // eine neue Standardrolle (z.B. DESIGN) erst nach dem ersten Kickoff
    // dieses Projekts eingefuehrt wurde. Was schon besetzt ist, bleibt
    // unangetastet.
    await ensureProjectTeam(projectId);
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

/// Um wie viele Sprints das Budget mindestens ueber den aktuellen Stand hinaus
/// reicht, wenn eine Ausbaustufe beauftragt wird. Dieselbe Schrittweite wie in
/// worker/tasks/sprintPlanning.ts und src/lib/clarificationDecision.ts – wer
/// gerade neue Arbeit beauftragt, soll nicht im naechsten Moment eine Klaerung
/// zum aufgebrauchten Budget beantworten muessen.
const SPRINT_BUDGET_STEP = 6;

/// Ausbaustufe: neue Arbeit fuer ein Projekt, an dem das Team schon gebaut hat.
///
/// Bis hierher gab es dafuer nur einen Weg, und der war zufaellig: Genau in dem
/// Moment, in dem der Product Owner den Backlog leer meldete, durfte der
/// Auftraggeber in die Klaerung schreiben, was noch fehlt. War die Klaerung
/// schon mit "Auftrag erfuellt" geschlossen oder lief das Team noch, blieb nur
/// "Anforderung anlegen" – ohne dass irgendwer sie je aufgriff, denn das Team
/// stand auf autopilot=false und niemand stiess einen Sprint an.
///
/// Diese Action ist der ausdrueckliche Auftrag "baut weiter": Sie haelt fest,
/// WAS dazukommt (als Beschluss im Register, damit es in jedem weiteren Prompt
/// steht), raeumt die alten "sind wir fertig?"-Klaerungen ab, gibt Budget und
/// Autopilot frei und stoesst die naechste Sprint-Planung an.
export async function commissionExtension(formData: FormData): Promise<ActionResult> {
  const projectId = str(formData, "projectId");
  const goal = str(formData, "goal");
  if (!projectId) return fail("Kein Projekt angegeben.");
  if (!goal) return fail("Bitte kurz beschreiben, was das Team als Nächstes bauen soll.");

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, status: true, sprintBudget: true, workspacePath: true },
  });
  if (!project) return fail("Projekt nicht gefunden.");
  if (project.status === "ARCHIVED") return fail("Das Projekt ist archiviert.");
  if (!project.workspacePath) {
    return fail("Hier hat das Team noch nie gearbeitet – erst „Team starten“, danach gibt es Ausbaustufen.");
  }

  // Fuellt Rollen auf, die es beim ersten Kickoff dieses Projekts noch nicht
  // gab (z.B. DESIGN) – eine Ausbaustufe ist der natuerliche Moment dafuer.
  await ensureProjectTeam(projectId);

  const sprintCount = await prisma.sprint.count({ where: { projectId } });
  const stage = (await prisma.clarification.count({ where: { projectId, trigger: EXTENSION_TRIGGER } })) + 1;
  const now = new Date();
  const question = `Ausbaustufe ${stage}: Was soll das Team zusätzlich bauen?`;

  await prisma.$transaction([
    prisma.project.update({
      where: { id: projectId },
      data: {
        status: "ACTIVE",
        autopilot: true,
        // Die aktuelle Anforderungsliste IST der Auftrag dieser Ausbaustufe:
        // Wer sie beauftragt, gibt damit auch die Anforderungen frei, die er
        // seit der letzten Freigabe ergaenzt hat.
        requirementsApprovedAt: now,
        sprintBudget: Math.max(project.sprintBudget, sprintCount + SPRINT_BUDGET_STEP),
      },
    }),
    // Als bereits entschiedene Klaerung: Damit steht der Auftrag im
    // Beschlussregister und liegt jedem Agenten in jedem Prompt vor – und er
    // steht nach dem alten "der Auftrag ist erfuellt", das er ausdruecklich
    // ueberholt.
    prisma.clarification.create({
      data: {
        projectId,
        scope: "PROJECT",
        trigger: EXTENSION_TRIGGER,
        question,
        context: "Vom Auftraggeber beauftragte Ausbaustufe.",
        status: "DECIDED",
        decision: goal,
        decidedBy: "Auftraggeber",
        decidedAt: now,
      },
    }),
    // Eine noch offene "sind wir fertig?"- oder Budget-Frage ist mit dem
    // Auftrag beantwortet; sie stehenzulassen wuerde das Team weiter
    // blockieren (offene PROJECT-Klaerungen halten die Arbeit an).
    prisma.clarification.updateMany({
      where: { projectId, status: "OPEN", trigger: { in: ["backlog_empty", "sprint_budget"] } },
      data: { status: "DECIDED", decision: `Ausbaustufe ${stage} beauftragt: ${goal}`, decidedBy: "Auftraggeber", decidedAt: now },
    }),
    prisma.activityLogEntry.create({
      data: {
        projectId,
        actor: "Mensch",
        action: "extension_commissioned",
        detail: `Ausbaustufe ${stage} beauftragt: ${goal.slice(0, 300)}`,
      },
    }),
  ]);

  const next = await scheduleNextStep(projectId);
  revalidateProject(projectId);
  return ok(`Ausbaustufe ${stage} beauftragt – sie steht ab sofort im Beschlussregister. ${next}`);
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

/// SEQUENTIAL (Standard) <-> PARALLEL – siehe `Project.workMode` und
/// worker/orchestration.ts#continueSprint. Gedacht als spaeter zu gatendes
/// Premium-Feature, aktuell noch ohne Freischaltbeschraenkung.
export async function setWorkMode(formData: FormData): Promise<ActionResult> {
  const projectId = str(formData, "projectId");
  if (!projectId) return fail("Kein Projekt angegeben.");
  const parallel = String(formData.get("workMode") ?? "") === "PARALLEL";
  const workMode = parallel ? "PARALLEL" : "SEQUENTIAL";

  await prisma.project.update({ where: { id: projectId }, data: { workMode } });
  await prisma.activityLogEntry.create({
    data: {
      projectId,
      actor: "Mensch",
      action: parallel ? "work_mode_parallel" : "work_mode_sequential",
      detail: parallel
        ? "Team darf jetzt mehrere Tickets gleichzeitig ziehen – Backend geht dabei immer vor Frontend"
        : "Team zieht wieder immer nur ein Ticket gleichzeitig",
    },
  });

  // Auf Parallel umgeschaltet, waehrend der Sprint schon laeuft: sofort den
  // periodischen Scrum-Master-Check anstossen (siehe worker/tasks/parallelCheck.ts),
  // statt bis zum naechsten Sprint-Start zu warten. `scheduleNextStep` sorgt
  // zusaetzlich dafuer, dass ein evtl. gerade brachliegendes Ticket ueberhaupt
  // erst laeuft – ohne ein laufendes primaeres Ticket hat der Parallel-Check
  // nichts, wonach er ein zweites, unabhaengiges Ticket ausrichten koennte.
  if (parallel) {
    try {
      await scheduleNextStep(projectId);
      await scheduleParallelCheck(projectId);
    } catch {
      // Kein Sprint aktiv o.ä. – nichts zu tun, der naechste normale Anstoss
      // greift ohnehin.
    }
  }

  revalidateProject(projectId);
  return ok(
    parallel
      ? "Paralleler Modus an – mehrere Agenten arbeiten gleichzeitig, Backend immer vor Frontend."
      : "Sequenzieller Modus – das Team zieht wieder nur ein Ticket auf einmal.",
  );
}

/// „Macht weiter" von Hand: reiht den Schritt ein, der laut Board dran ist.
export async function nudgeTeam(formData: FormData): Promise<ActionResult> {
  const projectId = str(formData, "projectId");
  if (!projectId) return fail("Kein Projekt angegeben.");

  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) return fail("Projekt nicht gefunden.");
  if (project.status !== "ACTIVE") return fail("Das Projekt ist nicht aktiv – erst fortsetzen.");

  // Erst aufräumen, dann erst nachsehen, ob wirklich noch jemand arbeitet –
  // sonst täuscht genau der Zustand, den wir gerade auflösen wollen, die
  // Prüfung direkt darunter: Ein AgentRun, der mit einem abgestürzten Worker
  // gestorben ist, steht ohne dieses Aufräumen für immer auf RUNNING, und
  // "das Team arbeitet gerade" wäre schlicht falsch (siehe worker/reconcile.ts,
  // beobachtet im iPhoto-Projekt).
  const cleaned = await reconcileStaleLocksNow();

  // Im parallelen Modus (`Project.workMode`) darf trotz eines schon
  // laufenden Agenten noch ein ZWEITES, unabhängiges Ticket abholbar sein –
  // dort bricht der Anstoß nicht einfach ab, sondern lässt `scheduleNextStep`
  // selbst entscheiden (dank `nextOpenTickets`/`activeTicketJobIds` reiht das
  // ein schon laufendes Ticket ohnehin nie doppelt ein, siehe worker/queue.ts).
  // Im sequenziellen Standardmodus bleibt es beim alten kurzen Weg: läuft
  // gerade etwas, kommt der nächste Schritt ohnehin von allein danach.
  if (project.workMode === "SEQUENTIAL") {
    const running = await prisma.agentRun.findFirst({ where: { projectId, status: "RUNNING" } });
    if (running) return note("Das Team arbeitet gerade – der nächste Schritt kommt von allein.");
  }

  const message = await scheduleNextStep(projectId);
  revalidateProject(projectId);
  const cleanupParts = [
    cleaned.unlockedPools > 0 ? "eine hängende Job-Sperre eines abgestürzten Workers gelöst" : null,
    cleaned.abandonedRuns > 0 ? "liegengebliebene Agentenläufe abgeschlossen" : null,
    cleaned.cancelledRuns > 0 ? "einen von Hand gestoppten Lauf nachgetragen" : null,
    cleaned.deadJobs > 0 ? "endgültig gescheiterte Jobs aus der Warteschlange genommen" : null,
  ].filter((part): part is string => part !== null);
  const cleanupNote = cleanupParts.length > 0 ? ` (davor ${cleanupParts.join(", ")})` : "";
  return ok(`${message}${cleanupNote}`);
}

/// Der Auftraggeber stößt den Product Owner von Hand an, das Projekt auf
/// unklare oder undefinierte Zustände zu prüfen (siehe worker/tasks/poSweep.ts)
/// – gedacht für den Moment, in dem im Büro der Eindruck entsteht, irgendwo
/// sei etwas liegen geblieben, ohne dass sich das an einer konkreten Sackgasse
/// festmachen lässt. Läuft unabhängig vom nächsten fälligen Arbeitsschritt.
export async function nudgeProductOwner(formData: FormData): Promise<ActionResult> {
  const projectId = str(formData, "projectId");
  if (!projectId) return fail("Kein Projekt angegeben.");

  const productOwner = await agentForRole(projectId, "PRODUCT_OWNER");
  if (!productOwner) return fail("Diesem Projekt ist kein Product Owner zugeordnet – erst das Team starten.");

  // Dieselbe Vorab-Aufräumung wie bei nudgeTeam (s.o.): poSweep selbst stößt
  // am Ende zwar auch die Wiederaufnahme an (worker/tasks/poSweep.ts), aber
  // eine tote Job-Sperre blockiert die Warteschlange des betroffenen Agenten
  // unabhängig davon – die muss weg, bevor überhaupt wieder etwas läuft.
  await reconcileStaleLocksNow();

  await enqueueAgentJob("poSweep", {
    agentId: productOwner.id,
    projectId,
    reason: "Auftraggeber bittet um Klarheit im Projekt",
  });

  revalidateProject(projectId);
  return ok(`${productOwner.name} geht das Projekt durch und meldet sich im Büro, sobald etwas gefunden ist.`);
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
