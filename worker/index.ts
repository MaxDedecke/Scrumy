// Eigenstaendiger Worker-Prozess, komplett getrennt von der Next.js-App.
//
// Agenten-Arbeit (LLM-Aufrufe, Connector-Polling, Ticket-Bearbeitung) laeuft
// hier statt in Server Actions, weil sie potenziell lange dauert und nicht in
// einen Request/Response-Zyklus passt. Skaliert horizontal ueber die Anzahl
// laufender Worker-Container (siehe docker-compose.yml, `--scale worker=N`) –
// nicht ueber die Anzahl Agenten: ein IDLE-Agent verbraucht keine Ressourcen,
// er ist nur eine Zeile in der DB, bis ein Job fuer ihn ansteht.
import "dotenv/config";
import { run } from "graphile-worker";
import { taskList } from "./tasks";
import { reconcileStaleRuns } from "./reconcile";

/// Wie oft nach verwaisten Laeufen gesucht wird. Beim Start einmal sofort,
/// danach stuendlich – ein abgestuerzter Nachbar-Worker soll nicht bis zum
/// naechsten Deploy als "arbeitet gerade" in der Oberflaeche stehen.
const RECONCILE_INTERVAL_MS = 60 * 60 * 1000;

async function reconcile() {
  try {
    const cleaned = await reconcileStaleRuns();
    if (cleaned > 0) console.log(`[worker] ${cleaned} abgebrochene Agentenlaeufe aufgeraeumt.`);
  } catch (error) {
    console.error("[worker] Aufraeumen fehlgeschlagen:", error);
  }
}

async function main() {
  await reconcile();
  const reconcileTimer = setInterval(reconcile, RECONCILE_INTERVAL_MS);

  const runner = await run({
    connectionString: process.env.DATABASE_URL,
    taskList,
    // Wie viele Jobs DIESER Prozess parallel bearbeitet. Serialisierung pro
    // Agent passiert unabhaengig davon ueber `queueName` (siehe queue.ts).
    concurrency: 5,
  });

  console.log("[worker] gestartet, warte auf Jobs...");

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, async () => {
      console.log(`[worker] ${signal} empfangen, fahre sauber herunter...`);
      clearInterval(reconcileTimer);
      await runner.stop();
      process.exit(0);
    });
  }

  await runner.promise;
}

main().catch((err) => {
  console.error("[worker] fataler Fehler:", err);
  process.exit(1);
});
