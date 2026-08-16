"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

// Hält das Team-Büro aktuell, ohne dass jemand F5 drückt.
//
// Bewusst simples Nachladen der Server-Komponente (`router.refresh()`) statt
// WebSockets: Die Arbeitsschritte der Agenten dauern Sekunden bis Minuten, ein
// Takt von wenigen Sekunden reicht völlig – und es kommt kein zweiter
// Übertragungsweg neben der normalen Seite dazu.
export function LiveRefresh({
  intervalMs = 6000,
  label = "Live",
}: {
  intervalMs?: number;
  label?: string;
}) {
  const router = useRouter();
  const [live, setLive] = useState(true);

  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => router.refresh(), intervalMs);
    return () => clearInterval(timer);
  }, [live, intervalMs, router]);

  return (
    <button
      type="button"
      onClick={() => setLive((current) => !current)}
      className="inline-flex items-center gap-1.5 text-xs font-medium text-ink-3 transition-colors hover:text-ink"
      title={live ? "Automatische Aktualisierung anhalten" : "Automatisch aktualisieren"}
    >
      <span
        className={`h-2 w-2 rounded-full ${live ? "animate-pulse bg-good" : "bg-ink-4"}`}
        aria-hidden
      />
      {live ? label : "Pausiert"}
    </button>
  );
}
