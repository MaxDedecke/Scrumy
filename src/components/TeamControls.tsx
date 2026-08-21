import { ActionForm } from "@/components/ActionForm";
import { ConfirmButton } from "@/components/ConfirmButton";
import { IconSubmit } from "@/components/IconSubmit";
import { BoltIcon, ForwardIcon, LanesIcon, PauseIcon, PlayIcon, SearchIcon } from "@/components/icons";
import { nudgeProductOwner, nudgeTeam, pauseTeam, resumeTeam, setAutopilot, setWorkMode } from "@/lib/actions/team";
import { iconButtonClass, iconButtonOnClass } from "@/lib/ui";
import type { ProjectStatus, WorkMode } from "@/generated/prisma/client";

// Die Steuerung des Teams – anhalten, fortsetzen, anstoßen, Klarheits-Check,
// Autopilot – als Icon-Gruppe im Seitenkopf, direkt neben dem Projektnamen.
//
// Vorher war das ein Kartenblock „Steuerung" im Team-Büro, also nur dort und
// erst nach dem Scrollen erreichbar. Wer im Board sieht, dass etwas schiefläuft,
// will das Team von dort anhalten können – deshalb liegt die Gruppe jetzt im
// Kopf, der auf jedem Projekt-Tab derselbe ist.
//
// Wenige, immer gleiche Aktionen mit eindeutigem Bild (Play/Pause/Vorspulen) –
// genau die Sorte Aktion, die ohne Beschriftung funktioniert. Klartext gibt es
// über Tooltip und Screenreader-Text.
export function TeamControls({
  projectId,
  status,
  autopilot,
  workMode,
}: {
  projectId: string;
  status: ProjectStatus;
  autopilot: boolean;
  workMode: WorkMode;
}) {
  const parallel = workMode === "PARALLEL";
  // Vor dem Start gibt es nichts zu steuern; die Freigaben und der Startknopf
  // liegen auf dem Anforderungs-Tab.
  if (status !== "ACTIVE" && status !== "PAUSED") return null;

  return (
    <div className="flex items-center gap-0.5 rounded-lg border border-hairline bg-surface p-0.5">
      {status === "ACTIVE" ? (
        <ActionForm action={pauseTeam}>
          <input type="hidden" name="projectId" value={projectId} />
          <ConfirmButton
            confirmText="Arbeit anhalten? Der laufende Schritt wird noch beendet."
            title="Arbeit anhalten"
            className={iconButtonClass}
          >
            <PauseIcon className="h-4 w-4" />
          </ConfirmButton>
        </ActionForm>
      ) : (
        <ActionForm action={resumeTeam}>
          <input type="hidden" name="projectId" value={projectId} />
          <IconSubmit title="Arbeit fortsetzen">
            <PlayIcon className="h-3.5 w-3.5" />
          </IconSubmit>
        </ActionForm>
      )}

      {status === "ACTIVE" && (
        <ActionForm action={nudgeTeam}>
          <input type="hidden" name="projectId" value={projectId} />
          <IconSubmit title="Nächsten Schritt anstoßen">
            <ForwardIcon className="h-3.5 w-3.5" />
          </IconSubmit>
        </ActionForm>
      )}

      <ActionForm action={nudgeProductOwner}>
        <input type="hidden" name="projectId" value={projectId} />
        <IconSubmit title="Product Owner bitten, das Projekt auf unklare oder undefinierte Stellen zu prüfen">
          <SearchIcon className="h-3.5 w-3.5" />
        </IconSubmit>
      </ActionForm>

      <ActionForm action={setAutopilot}>
        <input type="hidden" name="projectId" value={projectId} />
        <input type="hidden" name="autopilot" value={autopilot ? "off" : "on"} />
        <IconSubmit
          title={
            autopilot
              ? "Autopilot ist an – das Team plant nach dem Review weiter. Jetzt ausschalten."
              : "Autopilot ist aus – das Team hält nach dem Sprint an. Jetzt einschalten."
          }
          className={autopilot ? iconButtonOnClass : iconButtonClass}
        >
          <BoltIcon className="h-4 w-4" filled={autopilot} />
        </IconSubmit>
      </ActionForm>

      <ActionForm action={setWorkMode}>
        <input type="hidden" name="projectId" value={projectId} />
        <input type="hidden" name="workMode" value={parallel ? "SEQUENTIAL" : "PARALLEL"} />
        <IconSubmit
          title={
            parallel
              ? "Paralleler Modus – mehrere Agenten arbeiten gleichzeitig (Backend immer vor Frontend). Jetzt auf sequenziell umschalten."
              : "Sequenzieller Modus – das Team zieht ein Ticket nach dem anderen. Jetzt auf parallel umschalten."
          }
          className={parallel ? iconButtonOnClass : iconButtonClass}
        >
          <LanesIcon className="h-4 w-4" />
        </IconSubmit>
      </ActionForm>
    </div>
  );
}
