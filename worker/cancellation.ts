// Bruecke zwischen einem Klick im Browser ("Lauf stoppen", siehe
// src/lib/actions/records.ts) und einem laufenden Modell-/Werkzeugaufruf
// dieses Worker-Prozesses.
//
// Beide sind grundsaetzlich getrennt: Die Next.js-App und der Worker laufen
// in eigenen Containern, ein Klick kann also nichts direkt im Speicher des
// Workers veraendern. Der einzige gemeinsame Kanal ist die Datenbank – der
// Klick setzt `AgentRun.cancelRequested`, und wer einen Lauf tatsaechlich
// ausfuehrt, fragt das periodisch ab.
import { prisma } from "@/lib/prisma";

/// Kurz genug fuer ein zuegiges "Stopp" (im Team-Buero-Sinn: der Kollege legt
/// die Hand hin, nicht erst Minuten spaeter), lang genug, um bei einem
/// vielbeschaeftigten Worker-Pool keine spuerbare Zusatzlast zu erzeugen –
/// ein einzelnes Primaerschluessel-`findUnique` alle paar Sekunden pro
/// laufendem Aufruf faellt gegenueber den Modell-/Docker-Aufrufen selbst
/// nicht ins Gewicht.
const POLL_MS = 1500;

/// Ueberwacht `AgentRun.cancelRequested` fuer die Dauer eines Aufrufs. Das
/// zurueckgegebene `AbortSignal` feuert, sobald jemand den Lauf abgebrochen
/// hat – gedacht zum Durchreichen an `fetch`/`execFile` (per `AbortSignal.any`
/// mit dem ohnehin vorhandenen Zeitlimit kombinierbar) oder zur einfachen
/// Pruefung `signal.aborted` nach einem `await`.
///
/// `stop()` IMMER im `finally` des Aufrufers aufrufen – sonst laeuft die
/// Abfrage weiter, auch wenn der eigentliche Aufruf laengst fertig ist.
export function watchForCancellation(runId: string): { signal: AbortSignal; stop: () => void } {
  const controller = new AbortController();
  const timer = setInterval(() => {
    prisma.agentRun
      .findUnique({ where: { id: runId }, select: { cancelRequested: true } })
      .then((run) => {
        if (run?.cancelRequested) controller.abort(new Error("Von Hand abgebrochen."));
      })
      .catch(() => {
        // Ein Verbindungsfehler beim Abfragen ist kein Abbruchwunsch –
        // einfach beim naechsten Intervall erneut versuchen.
      });
  }, POLL_MS);
  // Der Poll-Timer haelt den Node-Prozess sonst leicht laenger am Leben als
  // noetig (unref = zaehlt nicht als Grund, den Event-Loop offenzuhalten).
  timer.unref?.();

  return {
    signal: controller.signal,
    stop: () => clearInterval(timer),
  };
}
