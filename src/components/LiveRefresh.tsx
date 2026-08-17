"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";

// Hält die Projektansicht aktuell, ohne dass jemand F5 drückt.
//
// Bewusst simples Nachladen der Server-Komponente (`router.refresh()`) statt
// WebSockets: Die Arbeitsschritte der Agenten dauern Sekunden bis Minuten, ein
// Takt von wenigen Sekunden reicht völlig – und es kommt kein zweiter
// Übertragungsweg neben der normalen Seite dazu.
//
// Auf Formularseiten ruht der Takt: Der Schalter steht im Projekt-Layout und
// gilt damit für alle Tabs, aber ein Refresh mitten im Konzepttext oder in der
// Agentenkonfiguration wäre eine Falle – dort wird getippt, nicht beobachtet.
const FORM_ROUTES = /\/(discovery|team)$/;

export function LiveRefresh({
  intervalMs = 6000,
  label = "Live",
}: {
  intervalMs?: number;
  label?: string;
}) {
  const router = useRouter();
  const pathname = usePathname() ?? "";
  const [live, setLive] = useState(true);

  const onFormRoute = FORM_ROUTES.test(pathname);
  const active = live && !onFormRoute;

  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => router.refresh(), intervalMs);
    return () => clearInterval(timer);
  }, [active, intervalMs, router]);

  return (
    <button
      type="button"
      onClick={() => setLive((current) => !current)}
      disabled={onFormRoute}
      className="inline-flex items-center gap-1.5 text-xs font-medium text-ink-3 transition-colors hover:text-ink disabled:cursor-default disabled:hover:text-ink-3"
      title={
        onFormRoute
          ? "Auf dieser Seite wird nicht automatisch aktualisiert, damit Eingaben nicht verloren gehen."
          : live
            ? "Automatische Aktualisierung anhalten"
            : "Automatisch aktualisieren"
      }
    >
      <span
        className={`h-2 w-2 rounded-full ${active ? "animate-pulse bg-good" : "bg-ink-4"}`}
        aria-hidden
      />
      {active ? label : "Pausiert"}
    </button>
  );
}
