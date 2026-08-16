import type { ReactNode } from "react";
import { PlusIcon } from "@/components/icons";

// Aufklappbares Formular („+ Neuer Kunde", „+ Agent hinzufügen").
// Rein serverseitig über <details>, kein Client-State nötig.
export function Disclosure({
  label,
  children,
  className = "",
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <details className={`group card overflow-hidden ${className}`}>
      <summary className="disclosure-summary px-4 py-3">
        <PlusIcon className="h-4 w-4 transition-transform group-open:rotate-45" />
        {label}
      </summary>
      <div className="border-t border-hairline bg-surface-2/40 p-4">{children}</div>
    </details>
  );
}

// Raster für Formularfelder innerhalb einer Disclosure – zwei Spalten ab sm.
export const formGridClass = "grid gap-4 sm:grid-cols-2";
