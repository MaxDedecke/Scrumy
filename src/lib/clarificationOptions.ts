// Die Wege, zwischen denen der Auftraggeber bei einer Klärung wählt.
//
// Bewusst hier und nicht im Worker: Die Optionen werden im Worker geschrieben
// (Standardvorschläge bzw. Agenda des Scrum Masters), aber in der Oberfläche
// gelesen und in der Server-Action ausgeführt. Als reine Typen- und
// Parser-Datei ohne Datenbank- und Queue-Bezug kann sie jede Seite laden.
//
// `effect` ist der Grund, warum ein Beschluss mehr ist als eine Notiz: Er sagt,
// was mit der eingefrorenen Arbeit passiert.

/// Wie viele zusaetzliche Anlaeufe ein Ticket bekommt, wenn ein Mensch
/// „nochmal versuchen" beschliesst (siehe `Ticket.attemptBudget`). Bewusst
/// hier: Der Worker legt das Budget an, die Server-Action stockt es auf, und
/// beide Seiten sollen dieselbe Zahl meinen.
export const TICKET_ATTEMPT_GRANT = 3;

export type ClarificationEffect =
  /** Eingefrorenen Schritt wieder einreihen (bzw. den nächsten fälligen). */
  | "resume"
  /** Ticket zurück in den Backlog, das Team zieht das nächste. */
  | "skip"
  /** Team hält an und wartet auf den Menschen. */
  | "stop"
  /** Sprint-Budget aufstocken und weiterarbeiten. */
  | "budget"
  /**
   * Ticket ohne weiteren Anlauf als erledigt verbuchen. Anders als "resume"
   * wird der eingefrorene Arbeitsschritt NICHT erneut eingereiht – sonst
   * scheitert ein strukturell blockierter Schritt (z.B. eine gesperrte Datei)
   * bei jedem Anlauf identisch wieder und erzeugt Klärung um Klärung, obwohl
   * der Beschluss längst "schließen" lautete.
   */
  | "close";

export const CLARIFICATION_EFFECTS: ClarificationEffect[] = ["resume", "skip", "stop", "budget", "close"];

export interface ClarificationOption {
  key: string;
  label: string;
  detail?: string;
  effect: ClarificationEffect;
}

/// Der Weg, den es in jeder Klärung zusätzlich gibt und der nie aus der
/// Datenbank kommt: „Nichts davon – ich schreibe es selbst auf." Er gehört
/// nicht zu den gespeicherten Optionen, weil er keine Empfehlung des Teams ist,
/// sondern das Recht des Auftraggebers, eine eigene Antwort zu geben.
export const OWN_OPTION_KEY = "__own";

/// Der Weg, der die Entscheidung an das Team zurückgibt, statt sie selbst zu
/// treffen. Anders als `OWN_OPTION_KEY` ist das kein Textfeld – der Klick
/// allein muss reichen, sonst landet „entscheide du das bitte" wortwörtlich
/// als unausführbarer Beschluss im Protokoll und die Klärung kommt genauso
/// zurück (siehe decideClarification in actions/clarifications.ts).
export const DELEGATE_OPTION_KEY = "__delegate";

/// Wie viele Wege ein Agent höchstens vorschlagen darf. Mehr macht die
/// Entscheidung nicht besser, nur länger.
const MAX_AGENT_OPTIONS = 4;

/// Macht aus den Vorschlägen eines Agenten geprüfte Optionen.
///
/// Die Umsetzer liefern ihre Wege als Freitext-Liste („- Nur server.js
/// verwenden: index.js entfällt, ein Einstiegspunkt weniger"), QA und Scrum
/// Master als JSON-Objekte. Beide landen hier, damit eine Klärung nicht mehr
/// mit den immer gleichen drei Standardwegen dasteht, sondern mit den Wegen,
/// um die es tatsächlich geht.
///
/// Alle so entstandenen Optionen wirken „resume": Der Beschluss geht ins Ticket
/// und ins Beschlussregister, das Team nimmt die Arbeit damit wieder auf.
export function optionsFromAgent(value: unknown): ClarificationOption[] {
  const entries: { label: string; detail?: string }[] = [];

  if (typeof value === "string") {
    for (const line of value.split(/\r?\n/)) {
      // Aufzählungszeichen und Nummerierung sind Zierrat des Modells.
      const text = line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim();
      if (text.length < 3) continue;
      // „Titel: Erklärung" oder „Titel | Erklärung" – beides schreiben Modelle.
      const split = text.match(/^(.{3,90}?)\s*(?::|\||–|—)\s+(.+)$/);
      entries.push(split ? { label: split[1], detail: split[2] } : { label: text });
    }
  } else if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry === "string") {
        if (entry.trim().length >= 3) entries.push({ label: entry.trim() });
        continue;
      }
      const item = (entry ?? {}) as { label?: unknown; detail?: unknown };
      const label = String(item.label ?? "").trim();
      if (label.length < 3) continue;
      entries.push({
        label,
        detail: typeof item.detail === "string" ? item.detail.trim() : undefined,
      });
    }
  }

  return entries.slice(0, MAX_AGENT_OPTIONS).map((entry, index) => ({
    key: `option-${index + 1}`,
    label: entry.label.slice(0, 160),
    detail: entry.detail ? entry.detail.slice(0, 600) : undefined,
    effect: "resume" as const,
  }));
}

/// Hängt die Auswege an, die immer wählbar bleiben müssen.
///
/// Ein Agent schlägt fachliche Wege vor („so oder so lösen") – er denkt nicht
/// daran, dass der Auftraggeber das Ticket auch zurückstellen oder das Team
/// anhalten können muss. Diese beiden Wege stehen deshalb hinter den
/// Vorschlägen, nicht davor: erst die Sache, dann der Notausgang.
export function withFallbackOptions(
  options: ClarificationOption[],
  { canSkipTicket }: { canSkipTicket: boolean },
): ClarificationOption[] {
  const complete = [...options];

  if (canSkipTicket && !complete.some((option) => option.effect === "skip")) {
    complete.push({
      key: "skip",
      label: "Zurückstellen, Team macht weiter",
      detail: "Das Ticket geht zurück in den Backlog, der Sprint läuft mit den übrigen Tickets weiter.",
      effect: "skip",
    });
  }

  if (!complete.some((option) => option.effect === "stop")) {
    complete.push({
      key: "stop",
      label: "Team anhalten",
      detail: "Niemand arbeitet weiter, bis du den nächsten Schritt anstößt.",
      effect: "stop",
    });
  }

  return complete;
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
