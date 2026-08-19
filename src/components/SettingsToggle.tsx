"use client";

import { useEffect } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { SettingsIcon } from "@/components/icons";
import { getLastView, rememberLastView } from "@/lib/lastView";

// Ersetzt den bisherigen reinen Link auf die Einstellungen: Ein Klick öffnet
// sie, ein weiterer Klick dort springt zurück zu der Seite, von der aus man
// gekommen ist – man kann mitten im Arbeitsprozess kurz in die Einstellungen
// springen, ohne sich hinterher selbst zum Ausgangspunkt zurückzuklicken.
export function SettingsToggle() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  const inSettings = pathname.startsWith("/settings");
  const currentPath = searchParams.size ? `${pathname}?${searchParams.toString()}` : pathname;

  useEffect(() => {
    rememberLastView(currentPath);
  }, [currentPath]);

  return (
    <button
      type="button"
      onClick={() => router.push(inSettings ? getLastView() : "/settings/llm-profiles")}
      aria-label={inSettings ? "Zurück zur vorherigen Ansicht" : "Einstellungen"}
      title={inSettings ? "Zurück zur vorherigen Ansicht" : "Einstellungen"}
      aria-current={inSettings ? "page" : undefined}
      className={`shrink-0 rounded-lg p-2 transition-colors ${
        inSettings
          ? "bg-accent-soft text-accent"
          : "text-ink-3 hover:bg-surface-2 hover:text-ink"
      }`}
    >
      <SettingsIcon className="h-5 w-5" />
    </button>
  );
}
