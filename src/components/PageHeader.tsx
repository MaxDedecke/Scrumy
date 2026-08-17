import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowLeftIcon } from "@/components/icons";

// Einheitlicher Seitenkopf für ALLE Seiten.
//
// Die Kontextzeile (Zurück-Link + Pfad) hat eine feste Höhe und wird immer
// gerendert – auch auf Seiten ohne Zurück-Link. Nur so liegen der Zurück-Pfeil
// bzw. die erste Textzeile und darunter die Überschrift auf jeder Seite auf
// exakt derselben Höhe.
export function PageHeader({
  backHref,
  backLabel,
  context,
  title,
  status,
  actions,
  description,
  className = "mb-7",
}: {
  backHref?: string;
  backLabel?: string;
  /** Pfad-Kontext rechts vom Zurück-Link, z.B. der Kundenname. */
  context?: string;
  title: string;
  /** Status-Pill direkt neben dem Titel. */
  status?: ReactNode;
  /** Sekundäre Links/Buttons am rechten Rand der Titelzeile. */
  actions?: ReactNode;
  description?: string;
  /** Nur der Außenabstand – auf den fensterhohen Projektseiten enger. */
  className?: string;
}) {
  return (
    <header className={`shrink-0 ${className}`}>
      <div className="flex h-5 items-center gap-2 text-xs">
        {backHref && (
          <Link
            href={backHref}
            className="quiet-link inline-flex items-center gap-1.5 font-medium"
          >
            <ArrowLeftIcon className="h-3.5 w-3.5" />
            {backLabel}
          </Link>
        )}
        {backHref && context && <span className="text-ink-4">/</span>}
        {context && (
          <span className="truncate font-medium uppercase tracking-wider text-ink-3">
            {context}
          </span>
        )}
      </div>

      <div className="mt-2.5 flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
        <div className="flex min-w-0 items-center gap-3">
          <h1 className="truncate text-2xl font-semibold text-ink">{title}</h1>
          {status}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-3 text-sm">{actions}</div>}
      </div>

      {description && (
        <p className="mt-2.5 max-w-2xl text-sm leading-relaxed text-ink-2">{description}</p>
      )}
    </header>
  );
}
