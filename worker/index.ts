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
import { reconcileCancelledRuns, reconcileDeadJobs, reconcileOrphanWorkspaces, reconcileStaleRuns } from "./reconcile";
import { reconcileStaleLiveStarts } from "@/lib/liveStack";

/// Wie oft nach verwaisten Laeufen gesucht wird. Beim Start einmal sofort,
/// danach stuendlich – ein abgestuerzter Nachbar-Worker soll nicht bis zum
/// naechsten Deploy als "arbeitet gerade" in der Oberflaeche stehen.
const RECONCILE_INTERVAL_MS = 60 * 60 * 1000;

/// Eigener, deutlich engerer Takt fuer die beiden Faelle, in denen nichts
/// geschaetzt werden muss: ein von Hand gestoppter Lauf und ein endgueltig
/// gescheiterter Job. Beide Zustaende sind eindeutig, sobald sie eintreten –
/// sie muessen nicht bis zum naechsten stuendlichen Durchlauf warten. Kostet
/// zwei kleine, indizierte Abfragen pro Minute.
const QUICK_RECONCILE_INTERVAL_MS = 60 * 1000;

async function reconcile() {
  try {
    const cleaned = await reconcileStaleRuns();
    if (cleaned > 0) console.log(`[worker] ${cleaned} abgebrochene Agentenlaeufe aufgeraeumt.`);
  } catch (error) {
    console.error("[worker] Aufraeumen fehlgeschlagen:", error);
  }

  // Getrennter try-Block: Ein Dateisystem-Problem im Volume darf das Aufraeumen
  // der Laeufe nicht verhindern (und umgekehrt).
  try {
    await reconcileOrphanWorkspaces();
  } catch (error) {
    console.error("[worker] Aufraeumen verwaister Arbeitsverzeichnisse fehlgeschlagen:", error);
  }

  // Wieder eigener try-Block: siehe reconcileStaleLiveStarts – ein durch
  // diesen Neustart abgebrochener Live-Stack-Start darf die anderen beiden
  // Aufraeumschritte nicht mitreissen (und umgekehrt).
  try {
    const fixed = await reconcileStaleLiveStarts();
    if (fixed > 0) console.log(`[worker] ${fixed} durch Neustart unterbrochene Live-Stack-Starts aufgeraeumt.`);
  } catch (error) {
    console.error("[worker] Aufraeumen unterbrochener Live-Stack-Starts fehlgeschlagen:", error);
  }
}

/// Der schnelle Takt (siehe QUICK_RECONCILE_INTERVAL_MS). Bewusst getrennt vom
/// grossen `reconcile()`: Dessen Schritte gehen ueber Docker und das
/// Dateisystem und haben im Minutentakt nichts verloren.
async function quickReconcile() {
  try {
    const cancelled = await reconcileCancelledRuns();
    if (cancelled > 0) console.log(`[worker] ${cancelled} von Hand gestoppte Laeufe nachtraeglich abgeschlossen.`);
  } catch (error) {
    console.error("[worker] Aufraeumen gestoppter Laeufe fehlgeschlagen:", error);
  }

  try {
    const dead = await reconcileDeadJobs();
    if (dead > 0) console.log(`[worker] ${dead} endgueltig gescheiterte Jobs aus der Queue genommen.`);
  } catch (error) {
    console.error("[worker] Aufraeumen gescheiterter Jobs fehlgeschlagen:", error);
  }
}

async function main() {
  await reconcile();
  const reconcileTimer = setInterval(reconcile, RECONCILE_INTERVAL_MS);
  const quickTimer = setInterval(quickReconcile, QUICK_RECONCILE_INTERVAL_MS);

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
      clearInterval(quickTimer);
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
