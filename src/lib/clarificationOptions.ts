// Die Wege, zwischen denen der Auftraggeber bei einer Klärung wählt.
//
// Bewusst hier und nicht im Worker: Die Optionen werden im Worker geschrieben
// (Standardvorschläge bzw. Agenda des Scrum Masters), aber in der Oberfläche
// gelesen und in der Server-Action ausgeführt. Als reine Typen- und
// Parser-Datei ohne Datenbank- und Queue-Bezug kann sie jede Seite laden.
//
// `effect` ist der Grund, warum ein Beschluss mehr ist als eine Notiz: Er sagt,
// was mit der eingefrorenen Arbeit passiert.

export type ClarificationEffect =
  /** Eingefrorenen Schritt wieder einreihen (bzw. den nächsten fälligen). */
  | "resume"
  /** Ticket zurück in den Backlog, das Team zieht das nächste. */
  | "skip"
  /** Team hält an und wartet auf den Menschen. */
  | "stop"
  /** Sprint-Budget aufstocken und weiterarbeiten. */
  | "budget";

export const CLARIFICATION_EFFECTS: ClarificationEffect[] = ["resume", "skip", "stop", "budget"];

export interface ClarificationOption {
  key: string;
  label: string;
  detail?: string;
  effect: ClarificationEffect;
}

/// Liest die in der DB abgelegten Optionen zurück – aus `Json` wird wieder eine
/// geprüfte Liste. Unbekannte `effect`-Werte gelten als "resume": Ein Beschluss
/// soll im Zweifel weiterarbeiten lassen, nicht ins Leere laufen.
export function readOptions(value: unknown): ClarificationOption[] {
  if (!Array.isArray(value)) return [];

  const options: ClarificationOption[] = [];
  value.forEach((entry, index) => {
    const option = entry as Partial<ClarificationOption>;
    const label = String(option.label ?? "").trim();
    if (!label) return;
    options.push({
      key: String(option.key ?? `option-${index + 1}`),
      label,
      detail: typeof option.detail === "string" ? option.detail : undefined,
      effect: CLARIFICATION_EFFECTS.includes(option.effect as ClarificationEffect)
        ? (option.effect as ClarificationEffect)
        : "resume",
    });
  });
  return options;
}
