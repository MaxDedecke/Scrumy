// Einheitliches Rückgabeformat aller Server-Actions.
//
// Jede Action meldet zurück, was passiert ist – auch wenn sie nichts getan hat
// (fehlende Pflichtfelder, nichts zu ändern). Die Oberfläche macht daraus in
// `<ActionForm>` eine Toast-Meldung oben rechts, damit kein Klick ohne Antwort
// bleibt. Kein "use server" hier: Die Datei enthält nur Typen und Helfer und
// wird sowohl vom Server als auch vom Client importiert.

export type ActionStatus = "success" | "error" | "info";

export type ActionResult = {
  status: ActionStatus;
  message: string;
  /** Ziel, zu dem nach der Meldung navigiert wird (z.B. nach dem Löschen). */
  redirectTo?: string;
};

export function ok(message: string, redirectTo?: string): ActionResult {
  return { status: "success", message, redirectTo };
}

export function fail(message: string): ActionResult {
  return { status: "error", message };
}

/// Weder Erfolg noch Fehler: Die Aktion war zulässig, hat aber bewusst nichts
/// geändert (z.B. identischer Konzepttext bei erneuter Freigabe).
export function note(message: string): ActionResult {
  return { status: "info", message };
}
