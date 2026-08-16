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
  // `addJob`s eigene Signatur ist ueber ein zweites, hier nicht sichtbares
  // Generic konditional typisiert – TS kann das mit unserem `TIdentifier`
  // nicht mehr vereinheitlichen, obwohl beide Seiten strukturell identisch
  // sind. Die eigentliche Typsicherheit hat der Aufrufer schon durch die
  // Parametertypen dieser Funktion.
  await utils.addJob(taskIdentifier, payload as never, {
    queueName: `agent:${agentId}`,
    // graphile-worker wiederholt fehlgeschlagene Jobs sonst bis zu 25 Mal.
    // Ein Agenten-Schritt ist ein LLM-Aufruf: Ein zweiter Versuch faengt eine
    // Zufallsstoerung ab, alles darueber verbrennt nur Modellkosten fuer einen
    // Fehler, der beim dritten Mal genauso auftritt. Danach steht der Agent
    // sichtbar auf BLOCKED und der Mensch entscheidet.
    maxAttempts: 2,
  });
}
