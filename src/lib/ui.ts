// Gemeinsame Tailwind-Klassen. Jede Seite zieht Layout, Formulare und Buttons
// von hier – so bleiben Innenabstände, Höhen und Rundungen app-weit identisch.

// Ein einziger Seiten-Container für ALLE Seiten: gleiche Breite, gleiche
// Ränder, gleicher oberer Abstand. Dadurch stehen Zurück-Pfeil und erste
// Textzeile auf jeder Seite exakt an derselben Stelle.
export const pageClass = "mx-auto w-full max-w-6xl flex-1 px-8 py-9";

// Projektseiten: breiter als der normale Seiten-Container, weil die Panels
// hier nebeneinander stehen (siehe <PanelGrid>) und auf großen Schirmen sonst
// links und rechts viel Fläche ungenutzt bliebe. Ab lg exakt fensterhoch. Die
// Seite selbst wächst dann nicht mehr mit dem Inhalt – gescrollt wird
// innerhalb der Panels (siehe src/components/Panel.tsx). Unter lg bleibt es
// beim normalen Untereinander mit Seiten-Scroll, weil auf einem schmalen
// Schirm nebeneinander nichts zu gewinnen ist.
export const pageFixedClass =
  "mx-auto flex w-full max-w-[110rem] flex-1 flex-col px-8 py-7 lg:h-full lg:min-h-0";

export const inputClass =
  "w-full rounded-lg border border-hairline bg-surface-2 px-3 py-2 text-sm text-ink transition-colors placeholder:text-ink-4 focus:border-accent-border focus:outline-none";

export const labelClass = "mb-1.5 block text-xs font-medium text-ink-3";

const buttonBaseClass =
  "inline-flex items-center justify-center gap-1.5 rounded-lg px-3.5 py-2 text-sm font-medium transition-colors";

// Dunkler statt weißer Text: accent-solid ist ein sehr helles Grün, Weiß
// darauf wäre kaum lesbar.
export const buttonPrimaryClass = `${buttonBaseClass} bg-accent-solid text-canvas hover:bg-accent-solid-hover`;

export const buttonSecondaryClass = `${buttonBaseClass} border border-hairline-strong text-ink-2 hover:bg-surface-2 hover:text-ink`;

export const buttonDangerClass = `${buttonBaseClass} border border-critical/35 text-critical hover:bg-critical/10`;

// Textbutton für destruktive Aktionen innerhalb einer Zeile (kein Rahmen).
export const buttonDangerQuietClass =
  "text-xs font-medium text-critical transition-colors hover:text-ink";

// Icon-Buttons: quadratisch, ohne Beschriftung, Bedeutung über Tooltip und
// Screenreader-Text (siehe <IconSubmit>). Nur für Aktionen, die sich in einem
// Bild eindeutig sagen lassen – alles Erklärungsbedürftige bleibt ein
// beschrifteter Button.
const iconButtonBaseClass =
  "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors";

export const iconButtonClass = `${iconButtonBaseClass} text-ink-3 hover:bg-surface-3 hover:text-ink`;

/// Eingeschalteter Zustand (Autopilot an) – Farbe UND gefülltes Icon.
export const iconButtonOnClass = `${iconButtonBaseClass} bg-accent-soft text-accent hover:bg-accent-soft`;

/// Icon-Button in Akzentfarbe: transparent statt gefüllt, grüner Umriss,
/// grünes Icon – zu sehen ist nur das Icon, keine Farbfläche. Grundsätzliches
/// Muster für JEDEN farbigen Icon-Button (nicht nur diesen hier): Hover
/// hellt die Fläche nur leicht auf (accent-soft), statt sie voll zu füllen.
export const iconButtonPrimaryClass = `${iconButtonBaseClass} border border-accent text-accent hover:bg-accent-soft`;

/// Löschen/Entfernen in Listenzeilen: bleibt unauffällig, bis die Zeile
/// überfahren wird (`group-hover` in der Zeile), und wird erst dann rot.
export const iconButtonDangerClass = `${iconButtonBaseClass} text-ink-4 hover:bg-critical/10 hover:text-critical`;

/// Kleinere Variante für dichte Listenzeilen.
export const iconButtonSmallDangerClass =
  "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-4 opacity-0 transition-all group-hover:opacity-100 hover:bg-critical/10 hover:text-critical focus-visible:opacity-100";

export const cardClass = "card";
