// Gemeinsame Tailwind-Klassen. Jede Seite zieht Layout, Formulare und Buttons
// von hier – so bleiben Innenabstände, Höhen und Rundungen app-weit identisch.

// Ein einziger Seiten-Container für ALLE Seiten: gleiche Breite, gleiche
// Ränder, gleicher oberer Abstand. Dadurch stehen Zurück-Pfeil und erste
// Textzeile auf jeder Seite exakt an derselben Stelle.
export const pageClass = "mx-auto w-full max-w-6xl flex-1 px-8 py-9";

export const inputClass =
  "w-full rounded-lg border border-hairline bg-surface-2 px-3 py-2 text-sm text-ink transition-colors placeholder:text-ink-4 focus:border-accent-border focus:outline-none";

export const labelClass = "mb-1.5 block text-xs font-medium text-ink-3";

const buttonBaseClass =
  "inline-flex items-center justify-center gap-1.5 rounded-lg px-3.5 py-2 text-sm font-medium transition-colors";

export const buttonPrimaryClass = `${buttonBaseClass} bg-accent-solid text-white hover:bg-accent-solid-hover`;

export const buttonSecondaryClass = `${buttonBaseClass} border border-hairline-strong text-ink-2 hover:bg-surface-2 hover:text-ink`;

export const buttonDangerClass = `${buttonBaseClass} border border-critical/35 text-critical hover:bg-critical/10`;

// Textbutton für destruktive Aktionen innerhalb einer Zeile (kein Rahmen).
export const buttonDangerQuietClass =
  "text-xs font-medium text-critical transition-colors hover:text-ink";

export const cardClass = "card";
