import type { ReactNode } from "react";
import { iconButtonClass } from "@/lib/ui";

// Absende-Button ohne Beschriftung.
//
// Ein Icon allein ist nur dann bedienbar, wenn seine Bedeutung auf drei Wegen
// da ist: Tooltip für die Maus (`title`), Name für Screenreader (`aria-label`)
// und sichtbarer Text, sobald jemand Bilder/Icons nicht sieht (`sr-only`).
// Deshalb gibt es diese Komponente – damit kein Icon-Button in der App
// versehentlich als stummes Quadrat endet.
export function IconSubmit({
  title,
  children,
  className = iconButtonClass,
  name,
  value,
}: {
  /** Klartext der Aktion, z.B. „Arbeit anhalten". Dient allen drei Kanälen. */
  title: string;
  children: ReactNode;
  className?: string;
  name?: string;
  value?: string;
}) {
  return (
    <button type="submit" title={title} aria-label={title} name={name} value={value} className={className}>
      {children}
      <span className="sr-only">{title}</span>
    </button>
  );
}
