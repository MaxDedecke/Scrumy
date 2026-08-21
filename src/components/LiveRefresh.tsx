"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";

// Hält die Projektansicht aktuell, ohne dass jemand F5 drückt.
//
// Bewusst simples Nachladen der Server-Komponente (`router.refresh()`) statt
// WebSockets: Die Arbeitsschritte der Agenten dauern Sekunden bis Minuten, ein
// Takt von wenigen Sekunden reicht völlig – und es kommt kein zweiter
// Übertragungsweg neben der normalen Seite dazu.
//
// Kein manueller Pause-Schalter (und keine "Live"/"Pausiert"-Anzeige dafür)
// mehr: eine Projektansicht ist per Default automatisch aktuell, das ist
// keine Nutzerentscheidung. Auf Formularseiten ruht der Takt weiterhin
// automatisch – ein Refresh mitten im Konzepttext oder in der
// Agentenkonfiguration wäre eine Falle – dort wird getippt, nicht beobachtet.
const FORM_ROUTES = /\/(discovery|team)$/;

export function LiveRefresh({ intervalMs = 6000 }: { intervalMs?: number }) {
  const router = useRouter();
  const pathname = usePathname() ?? "";
  const active = !FORM_ROUTES.test(pathname);

  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => router.refresh(), intervalMs);
    return () => clearInterval(timer);
  }, [active, intervalMs, router]);

  return null;
}
