// Enqueue-Helper fuer graphile-worker (Postgres-native Job-Queue, eigenes
// "graphile_worker"-Schema in derselben DB, kein zusaetzlicher Redis-Baustein).
//
// Zentrale Design-Entscheidung: Jeder Agenten-Job bekommt als `queueName`
// `agent:<agentId>`. graphile-worker fuehrt Jobs innerhalb derselben Queue
// strikt sequenziell aus (FIFO) – damit kann ein Agent nie zwei Jobs
// gleichzeitig laufen haben, ganz ohne manuelles Locking auf `Agent.status`.
// `Agent.status` (IDLE/WORKING/BLOCKED) bleibt rein UI-/Beobachtungs-Feld,
// nicht der Nebenlaeufigkeits-Mechanismus.
//
// Wird sowohl vom Worker-Prozess selbst genutzt (Folge-Jobs, z.B. naechster
// Pipeline-Schritt), als auch spaeter von Next.js Server Actions, wenn echte
// Trigger dazukommen (z.B. neue SupportRequest -> Support-Agent-Job).
import { makeWorkerUtils, type WorkerUtils } from "graphile-worker";
import { prisma } from "@/lib/prisma";
import "./taskTypes"; // registriert die GraphileWorker.Tasks-Typen (declare global)

let workerUtilsPromise: Promise<WorkerUtils> | null = null;

function getWorkerUtils(): Promise<WorkerUtils> {
  if (!workerUtilsPromise) {
    workerUtilsPromise = makeWorkerUtils({
      connectionString: process.env.DATABASE_URL,
    });
  }
  return workerUtilsPromise;
}

export async function enqueueAgentJob<TIdentifier extends keyof GraphileWorker.Tasks>(
  taskIdentifier: TIdentifier,
  payload: GraphileWorker.Tasks[TIdentifier],
) {
  const utils = await getWorkerUtils();
  // Alle Agenten-Job-Payloads haben ein `agentId`-Feld (siehe z.B.
  // AgentTurnPayload) – TS kann das ueber den generischen Indexed-Access-Typ
  // allein nicht ableiten, daher hier ein begruendeter Cast.
  const agentId = (payload as { agentId: string }).agentId;
  // Ein Ticket darf nie zweimal gleichzeitig in der Warteschlange stehen.
  // Beobachtet: Jeder Nacharbeits-Pfad reiht das Ticket erneut ein und ruft
  // danach `continueSprint`, das dasselbe – weiterhin offene – Ticket gleich
  // noch einmal zieht. Ergebnis waren zwei Jobs fuer dasselbe Ticket, also ein
  // kompletter doppelter Anlauf samt Modellkosten und verbrauchtem
  // Anlauf-Budget. Mit `jobKey` ueberschreibt das zweite Einreihen das erste;
  // laeuft der erste Job schon, legt graphile-worker den neuen sauber daneben.
  const ticketId = (payload as { ticketId?: string }).ticketId;

  // `addJob`s eigene Signatur ist ueber ein zweites, hier nicht sichtbares
  // Generic konditional typisiert – TS kann das mit unserem `TIdentifier`
  // nicht mehr vereinheitlichen, obwohl beide Seiten strukturell identisch
  // sind. Die eigentliche Typsicherheit hat der Aufrufer schon durch die
  // Parametertypen dieser Funktion.
  await utils.addJob(taskIdentifier, payload as never, {
    queueName: `agent:${agentId}`,
    ...(ticketId ? { jobKey: `${taskIdentifier}:${ticketId}`, jobKeyMode: "replace" as const } : {}),
    // graphile-worker wiederholt fehlgeschlagene Jobs sonst bis zu 25 Mal.
    // Ein Agenten-Schritt ist ein LLM-Aufruf: Ein zweiter Versuch faengt eine
    // Zufallsstoerung ab, alles darueber verbrennt nur Modellkosten fuer einen
    // Fehler, der beim dritten Mal genauso auftritt. Danach steht der Agent
    // sichtbar auf BLOCKED und der Mensch entscheidet.
    maxAttempts: 2,
  });
}

/// Reiht einen Job mit Verzoegerung ein, unter einem festen `jobKey` – ein
/// zweiter Aufruf mit demselben Key ERSETZT den noch wartenden ersten, statt
/// eine zweite Kette daneben aufzubauen. Gedacht fuer selbst-nachplanende
/// periodische Jobs (siehe worker/tasks/parallelCheck.ts): Jeder Lauf plant am
/// Ende seinen eigenen Nachfolger, und ein doppelter Anstoss (Sprint-Start UND
/// Umschalten auf PARALLEL kurz danach) soll keine zweite, parallele Kette
/// erzeugen.
export async function enqueueDelayedAgentJob<TIdentifier extends keyof GraphileWorker.Tasks>(
  taskIdentifier: TIdentifier,
  payload: GraphileWorker.Tasks[TIdentifier],
  { runAt, jobKey }: { runAt: Date; jobKey: string },
) {
  const utils = await getWorkerUtils();
  const agentId = (payload as { agentId: string }).agentId;
  await utils.addJob(taskIdentifier, payload as never, {
    queueName: `agent:${agentId}`,
    runAt,
    jobKey,
    jobKeyMode: "replace",
    maxAttempts: 2,
  });
}

/// Tickets, die gerade schon einen `ticketWork`-Job in der Warteschlange haben
/// – egal ob noch wartend oder bereits gesperrt/laufend. Nur im parallelen
/// Arbeitsmodus gebraucht (`Project.workMode`, siehe
/// worker/orchestration.ts#nextOpenTickets): dort holt ein einziger Aufruf
/// mehrere Tickets auf einmal, und ohne diese Pruefung wuerde ein Ticket,
/// dessen Job gerade laeuft, beim naechsten Aufruf (z.B. weil ein ANDERES
/// Ticket parallel fertig wird und `continueSprint` erneut anstoesst) ein
/// zweites Mal eingereiht. Der neue Job wartet dann brav in derselben
/// Agenten-Queue – `jobKey`/`jobKeyMode: "replace"` kann einen bereits
/// GESPERRTEN Job naemlich nicht ersetzen (siehe Kommentar zu `jobKey` oben) –
/// und der Umsetzer faesst dasselbe Ticket kurz danach ein zweites Mal an.
export async function activeTicketJobIds(ticketIds: string[]): Promise<Set<string>> {
  if (ticketIds.length === 0) return new Set();
  const jobKeys = ticketIds.map((ticketId) => `ticketWork:${ticketId}`);
  const rows = await prisma.$queryRaw<{ key: string }[]>`
    select key from graphile_worker.jobs where key = any(${jobKeys}::text[])
  `;
  return new Set(rows.map((row) => row.key.slice("ticketWork:".length)));
}

/// Nimmt alle noch wartenden Jobs der genannten Agenten aus der Queue. Wird
/// beim Loeschen eines Projekts gebraucht: Ein eingereihter Job wuerde sonst
/// noch anlaufen, sein Arbeitsverzeichnis neu anlegen (`ensureRepo`) und danach
/// an der fehlenden Projektzeile scheitern – ein frisch verwaistes Repo als
/// Ergebnis genau der Aktion, die aufraeumen sollte.
///
/// Gelesen wird ueber die oeffentliche `jobs`-Sicht, geloescht ueber die API
/// von graphile-worker (`completeJobs` entfernt die Zeilen). Gesperrte Jobs
/// laufen gerade und lassen sich nicht abbrechen – die brechen von selbst ab,
/// weil jeder Task seinen Projektstatus prueft.
export async function cancelAgentJobs(agentIds: string[]): Promise<number> {
  if (agentIds.length === 0) return 0;
  const queueNames = agentIds.map((agentId) => `agent:${agentId}`);

  const rows = await prisma.$queryRaw<{ id: string }[]>`
    select id::text as id
    from graphile_worker.jobs
    where queue_name = any(${queueNames}::text[]) and locked_at is null
  `;
  if (rows.length === 0) return 0;

  const utils = await getWorkerUtils();
  const removed = await utils.completeJobs(rows.map((row) => row.id));
  return removed.length;
}

/// Jobs, die endgueltig gescheitert sind: Ihr Anlauf-Budget ist verbraucht
/// (`attempts >= max_attempts`) und sie sind nicht mehr gesperrt. Die von
/// graphile-worker generierte Spalte `is_available` steht damit dauerhaft auf
/// `false` – solche Zeilen laufen nie wieder an, sie sind tot, nicht wartend.
///
/// Genau das macht sie gefaehrlich: Wer in die Queue schaut, haelt sie leicht
/// fuer ausstehende Arbeit. Deshalb holt `reconcileDeadJobs`
/// (worker/reconcile.ts) sie hervor, macht sie im Projekt sichtbar und raeumt
/// sie weg.
///
/// Wie ein Job hier landet, ist NICHT auf zweimal fachlich gescheitert
/// beschraenkt: graphile-worker zaehlt `attempts` schon beim Abholen hoch, ein
/// zweimal mitten im Job beendeter Worker (Rebuild, Neustart) reicht also
/// ebenso – solche Zeilen haben dann nicht einmal ein `last_error`.
///
/// Gelesen wird ausnahmsweise aus der internen Tabelle statt aus der
/// oeffentlichen `jobs`-Sicht: Nur dort steht der Payload, und den brauchen wir
/// – graphile-worker setzt `key` beim endgueltigen Scheitern auf NULL (damit
/// derselbe `jobKey` wieder vergeben werden kann), der Weg ueber den Job-Key
/// zum Ticket ist bei genau diesen Zeilen also verbaut.
export interface DeadJob {
  id: string;
  taskIdentifier: string;
  payload: { projectId?: string; ticketId?: string; agentId?: string };
  lastError: string | null;
  createdAt: Date;
}

export async function deadJobs(): Promise<DeadJob[]> {
  return await prisma.$queryRaw<DeadJob[]>`
    select j.id::text as "id",
           t.identifier as "taskIdentifier",
           j.payload as "payload",
           nullif(j.last_error, '') as "lastError",
           j.created_at as "createdAt"
    from graphile_worker._private_jobs j
    join graphile_worker._private_tasks t on t.id = j.task_id
    where j.locked_at is null and j.attempts >= j.max_attempts
    order by j.created_at asc
  `;
}

/// Nimmt Jobs aus der Queue. `completeJobs` ist der Weg von graphile-worker,
/// eine Zeile ohne Ausfuehrung loszuwerden – ein direktes DELETE wuerde an der
/// Buchfuehrung der Queue vorbeigehen.
export async function removeJobs(jobIds: string[]): Promise<number> {
  if (jobIds.length === 0) return 0;
  const utils = await getWorkerUtils();
  const removed = await utils.completeJobs(jobIds);
  return removed.length;
}

/// Gibt Jobs frei, die ein gestorbener Worker gesperrt hat.
///
/// Eine Sperre gehoert einem Worker-Pool, und stirbt der Container hart, bleibt
/// sie liegen: Der Job laeuft nie wieder, verschwindet aber auch nicht – und bei
/// einem noch existierenden Agenten haengt damit dessen ganze Queue.
/// graphile-worker fuehrt kein Lebenszeichen der Pools, deshalb entscheidet das
/// Alter der Sperre (`olderThanMs`, deutlich ueber jedem Zeitlimit eines
/// Agentenschritts – dieselbe Begruendung wie in reconcile.ts).
///
/// `forceUnlockWorkers` gibt ALLE Jobs eines Pools frei, darum werden nur Pools
/// angefasst, deren jüngste Sperre ebenfalls ueber der Schwelle liegt: Ein Pool,
/// der nebenher normal arbeitet, ist damit nie betroffen und kann keinen Job
/// doppelt ausfuehren.
export async function unlockStaleJobs(olderThanMs: number): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanMs);

  const pools = await prisma.$queryRaw<{ locked_by: string }[]>`
    select locked_by
    from graphile_worker.jobs
    where locked_by is not null
    group by locked_by
    having max(locked_at) < ${cutoff}
  `;
  if (pools.length === 0) return 0;

  const utils = await getWorkerUtils();
  await utils.forceUnlockWorkers(pools.map((pool) => pool.locked_by));
  return pools.length;
}

/// Nachhut zu `cancelAgentJobs`: Jobs, deren Agent es nicht mehr gibt.
///
/// Warum das zusaetzlich noetig ist: `cancelAgentJobs` laeuft genau einmal, im
/// Moment des Loeschens, und kann gesperrte Jobs nicht anfassen. War ein Job in
/// diesem Moment gesperrt – etwa weil ein Worker gerade herunterfuhr und die
/// Sperre Sekunden spaeter losliess –, bleibt er fuer immer liegen: Sein Agent
/// ist weg, also fragt niemand mehr nach ihm.
///
/// Danach raeumt graphile-worker seine eigenen Reste weg (`GC_JOB_QUEUES`
/// loescht Queue-Zeilen ohne Jobs) – sonst bliebe pro geloeschtem Agenten eine
/// Queue-Zeile stehen.
export async function cancelJobsOfDeletedAgents(): Promise<number> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    select j.id::text as id
    from graphile_worker.jobs j
    where j.locked_at is null
      and j.queue_name like 'agent:%'
      and not exists (select 1 from agents a where 'agent:' || a.id = j.queue_name)
  `;

  const utils = await getWorkerUtils();
  const removed = rows.length > 0 ? await utils.completeJobs(rows.map((row) => row.id)) : [];
  // Nur die Queue-Zeilen aufraeumen, ausdruecklich NICHT die Task-Namen
  // (`GC_TASK_IDENTIFIERS`): graphile-worker gibt jedem Task-Namen eine
  // Zahlen-ID, und ein laufender Worker merkt sich die IDs seiner Tasks beim
  // Start. Loescht das Aufraeumen einen gerade jobfreien Task-Namen, bekommt er
  // beim naechsten Einreihen eine NEUE ID – und der laufende Worker sucht
  // weiter nach der alten. Die Jobs dieses Tasks bleiben dann bis zum naechsten
  // Neustart unsichtbar liegen. Genau so sind die Entscheidungsvorlagen des
  // Scrum Masters (clarificationPrep) stillschweigend ausgefallen; der Mensch
  // sah im Buero nur noch die Standardvorschlaege. Ein paar Zeilen mit
  // Task-Namen kosten nichts – das Aufraeumen kostete die halbe Arbeitskette.
  await utils.cleanup({ tasks: ["GC_JOB_QUEUES"] });
  return removed.length;
}
