"use client";

import { useState, type ReactNode } from "react";
import { ChevronRightIcon } from "@/components/icons";

// Panel: die Flächenform der Projektseiten.
//
// Der Unterschied zu <Section>: Ein Panel hat eine BEGRENZTE Höhe und scrollt
// seinen Inhalt selbst. Damit bleibt eine Projektseite immer genau fensterhoch,
// egal ob ein Sprint 5 oder 80 Tickets hat – bei <Section> wuchs stattdessen die
// Seite, und mit jedem Sprint wurde mehr Scrollen nötig, um überhaupt zu sehen,
// was es an Abschnitten gibt.
//
// Aufbau: fester Kopf (Titel, Zähler, Aktionen) – scrollender Rumpf – fester
// Fuß (Formular/Buttons, die nicht weglaufen dürfen). Unter lg hebt <PanelGrid>
// die Höhenbegrenzung auf, dann wächst das Panel wieder mit seinem Inhalt.
//
// `collapsible`/`collapsedView`: Ein Panel lässt sich per Icon neben dem Titel
// einklappen – dann bleibt nur der Kopf (plus `collapsedView`, eine knappe
// Zusammenfassung) stehen, Rumpf und Fuß verschwinden. Wichtig: Das Panel
// klappt nur in der HÖHE ein (`flex-none` statt `flex-1`), nie in der Breite –
// die Spaltenbreite gibt weiterhin <PanelGrid> vor. Von der frei werdenden
// Höhe profitiert ausschließlich das Panel in derselben Spalte, weil die
// aufrufende Seite die beiden gestapelten Panels einer Spalte in eine eigene
// Flex-Spalte packt statt sie eine gemeinsame Grid-Zeile teilen zu lassen –
// sonst schrumpfte mit dem eingeklappten Panel auch das Nachbarpanel der
// anderen Spalte in derselben Zeile mit.
export function Panel({
  title,
  count,
  action,
  children,
  footer,
  className = "",
  /** `false` für Inhalte, die ihr Scrollen selbst regeln (z.B. das Board mit
   *  vier eigenen Spalten oder ein Textfeld, das die Panelhöhe füllt). */
  scroll = true,
  /** Innenabstand des Rumpfs – für randlose Listen auf `false`. */
  padded = true,
  tone,
  /** Blendet das Einklapp-Icon ein. Ohne `collapsedView` bleibt beim
   *  Einklappen nur der Kopf stehen. */
  collapsible = false,
  /** Was im eingeklappten Zustand statt Rumpf/Fuß steht – knapp, ohne
   *  eigenes Scrollen. */
  collapsedView,
  /** Eingeklappt starten (z.B. für Panels, die selten die Aufmerksamkeit
   *  brauchen). Standard: aufgeklappt. */
  defaultCollapsed = false,
}: {
  title: string;
  count?: number;
  action?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
  scroll?: boolean;
  padded?: boolean;
  /** `attention` hebt Panels hervor, die auf eine Entscheidung warten. */
  tone?: "attention";
  collapsible?: boolean;
  collapsedView?: ReactNode;
  defaultCollapsed?: boolean;
}) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);

  return (
    <section
      className={`card flex min-w-0 flex-col overflow-hidden ${
        collapsible ? (collapsed ? "min-h-0 shrink-0" : "min-h-0 flex-1") : "min-h-0"
      } ${tone === "attention" ? "border-accent-border" : ""} ${className}`}
    >
      <div className="flex h-11 shrink-0 items-center gap-2.5 border-b border-hairline px-4">
        {collapsible && (
          <button
            type="button"
            onClick={() => setCollapsed((value) => !value)}
            title={collapsed ? "Aufklappen" : "Einklappen"}
            aria-label={collapsed ? "Aufklappen" : "Einklappen"}
            aria-expanded={!collapsed}
            className="-ml-1 shrink-0 rounded p-1 text-ink-3 transition-colors hover:bg-surface-3 hover:text-ink"
          >
            <ChevronRightIcon className={`h-3.5 w-3.5 transition-transform ${collapsed ? "" : "rotate-90"}`} />
          </button>
        )}
        <h2 className="section-title truncate">{title}</h2>
        {typeof count === "number" && (
          <span className="shrink-0 rounded-full bg-surface-3 px-1.5 text-[11px] font-medium tabular-nums text-ink-3">
            {count}
          </span>
        )}
        {action && <div className="ml-auto flex shrink-0 items-center gap-2 text-xs">{action}</div>}
      </div>

      {collapsible && collapsed ? (
        collapsedView && <div className="min-h-0 shrink-0">{collapsedView}</div>
      ) : (
        <>
          <div
            className={`flex min-h-0 flex-1 flex-col ${scroll ? "overflow-y-auto" : "overflow-hidden"} ${
              padded ? "p-4" : ""
            }`}
          >
            {children}
          </div>

          {footer && (
            <div className="panel-footer shrink-0 border-t border-hairline px-4 py-3">{footer}</div>
          )}
        </>
      )}
    </section>
  );
}

// Raster der Panels einer Projektseite. Ab lg füllt es die restliche
// Fensterhöhe (`min-h-0 flex-1`) und teilt sie auf die Zeilen auf – erst
// dadurch bekommen die Panels eine begrenzte Höhe und scrollen selbst.
// Darunter ist es eine gewöhnliche Spalte.
export function PanelGrid({
  children,
  className = "",
}: {
  children: ReactNode;
  /** Spalten-/Zeilenaufteilung ab lg, z.B. "lg:grid-cols-2 lg:grid-rows-2". */
  className?: string;
}) {
  // `min-h-0` bewusst erst ab lg: Darunter darf das Raster mit seinem Inhalt
  // wachsen (die Seite scrollt dann normal). Ohne diese Schranke würden die
  // gestapelten Panels auf schmalen Schirmen in die Fensterhöhe gequetscht.
  return (
    <div className={`grid flex-1 grid-cols-1 gap-4 lg:min-h-0 lg:overflow-hidden ${className}`}>
      {children}
    </div>
  );
}

// Spalte innerhalb von <PanelGrid> mit zwei oder mehr gestapelten Panels.
// Eigene Flex-Spalte statt gemeinsamer Grid-Zeile mit der Nachbarspalte:
// Klappt ein Panel hier ein, wächst nur sein Stapel-Nachbar in dieser Spalte
// in die frei werdende Höhe – die andere Spalte bleibt unberührt.
export function PanelStack({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`flex min-h-0 flex-col gap-4 ${className}`}>{children}</div>;
}

// Schmaler Streifen über dem Raster (Kennzahlen, Statuszeile, Hinweis). Nimmt
// nur seine eigene Höhe ein und wird nie mitgescrollt.
export function PanelStrip({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={`mb-4 shrink-0 ${className}`}>{children}</div>;
}

// Platzhalter innerhalb eines Panels – mittig, damit ein leeres Panel nicht wie
// ein Ladefehler aussieht.
export function PanelEmpty({ children }: { children: ReactNode }) {
  return (
    <p className="flex flex-1 items-center justify-center px-4 py-6 text-center text-sm text-ink-3">
      {children}
    </p>
  );
}
