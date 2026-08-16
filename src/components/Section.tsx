import type { ReactNode } from "react";

// Abschnitt mit Überschrift und optionaler Aktion rechts. Ersetzt die zuvor
// pro Seite handgebaute h2-Zeile, damit Abstände überall gleich sind.
export function Section({
  title,
  action,
  children,
  className = "",
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`mb-9 ${className}`}>
      <div className="mb-3 flex h-6 items-center justify-between gap-4">
        <h2 className="section-title">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

// Platzhalter, wenn eine Liste leer ist – überall gleicher Ton und Abstand.
export function EmptyHint({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-lg border border-dashed border-hairline px-4 py-6 text-center text-sm text-ink-3">
      {children}
    </p>
  );
}
