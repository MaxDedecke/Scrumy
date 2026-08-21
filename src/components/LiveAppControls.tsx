"use client";

import { useTransition } from "react";
import { ActionForm } from "@/components/ActionForm";
import { ConfirmButton } from "@/components/ConfirmButton";
import { useToast } from "@/components/Toast";
import { PlayIcon, StopIcon } from "@/components/icons";
import { startLiveAction, stopLiveAction } from "@/lib/actions/live";
import { iconButtonClass } from "@/lib/ui";
import type { PreviewStatus } from "@/generated/prisma/client";

// Play/Terminate der Live-Anwendung – im Projektkopf, direkt links von
// <TeamControls>. Anders als dort MIT sichtbarem Text auf dem Play-Knopf: das
// ist kein tägliches Icon wie Pause/Weiter, sondern eine seltene, folgenreiche
// Aktion (startet einen vollen Docker-Compose-Build), die eine Beschriftung
// braucht.
//
// Der Play-Klick öffnet IMMER einen neuen Tab (siehe Kopfkommentar von
// src/app/live/[projectId]/page.tsx) – synchron im Click-Handler,
// VOR jedem await, sonst blockt der Popup-Blocker den erst nach der
// Server-Antwort geöffneten Tab. Deshalb hier kein <ActionForm> für den
// Play-Knopf (das reagiert erst NACH der Server-Antwort) – nur für Terminate,
// das keinen Tab öffnen muss.
export function LiveAppControls({
  projectId,
  liveStatus,
  blockedBy,
}: {
  projectId: string;
  liveStatus: PreviewStatus;
  /** Ein anderes Projekt ist gerade live – nur eins gleichzeitig ist erlaubt. */
  blockedBy: { id: string; name: string } | null;
}) {
  const showToast = useToast();
  const [pending, startTransition] = useTransition();

  const isLiveHere = liveStatus === "RUNNING" || liveStatus === "STARTING";
  const disabled = pending || (!isLiveHere && blockedBy !== null);

  function handlePlay() {
    window.open(`/live/${projectId}`, "_blank", "noopener");
    startTransition(async () => {
      const formData = new FormData();
      formData.set("projectId", projectId);
      const result = await startLiveAction(formData);
      showToast({ variant: result.status, message: result.message });
    });
  }

  return (
    <div className="flex items-center gap-0.5 rounded-lg border border-hairline bg-surface p-0.5">
      <button
        type="button"
        onClick={handlePlay}
        disabled={disabled}
        title={
          !isLiveHere && blockedBy
            ? `„${blockedBy.name}" ist gerade live – aktuell kann nur ein Projekt gleichzeitig live sein.`
            : "Vollen Stack (Frontend, Backend, Datenbank) in einem neuen Tab testbar machen"
        }
        className={`inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
          isLiveHere ? "bg-accent-soft text-accent" : "text-ink-3 hover:bg-surface-3 hover:text-ink"
        }`}
      >
        <PlayIcon className="h-3.5 w-3.5" />
        Anwendung starten
      </button>

      {isLiveHere && (
        <ActionForm action={stopLiveAction}>
          <input type="hidden" name="projectId" value={projectId} />
          <ConfirmButton
            confirmText="Anwendung beenden? Container und Datenbank-Inhalte des Live-Stacks werden entfernt."
            title="Anwendung beenden"
            className={iconButtonClass}
          >
            <StopIcon className="h-3.5 w-3.5" />
          </ConfirmButton>
        </ActionForm>
      )}
    </div>
  );
}
