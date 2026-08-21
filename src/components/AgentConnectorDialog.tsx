"use client";

import { useRef } from "react";
import { ActionForm } from "@/components/ActionForm";
import { PlusIcon } from "@/components/icons";
import { updateAgentConnector } from "@/lib/actions/agents";
import { buttonPrimaryClass, buttonSecondaryClass, inputClass, labelClass } from "@/lib/ui";

// Ersetzt die Connector-Auswahl, die früher als eigenes <select> in jeder
// Agenten-Zeile stand: der aktuelle Connector steht jetzt als Badge in der
// Kopfzeile, ohne Connector ein schlichtes "+"-Badge. Beide öffnen denselben
// Dialog zum Einrichten – die dichte Zeile bleibt dadurch frei von einem
// dritten Dropdown neben Status und LLM-Profil.
export function AgentConnectorDialog({
  assignmentId,
  projectId,
  agentName,
  connectors,
  currentConnector,
}: {
  assignmentId: string;
  projectId: string;
  agentName: string;
  connectors: { id: string; name: string }[];
  currentConnector: { id: string; name: string } | null;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  function close() {
    dialogRef.current?.close();
  }

  return (
    <>
      <button
        type="button"
        onClick={() => dialogRef.current?.showModal()}
        title={currentConnector ? `Connector von ${agentName} ändern` : `Connector für ${agentName} einrichten`}
        className={`pill shrink-0 transition-colors ${
          currentConnector
            ? "pill-neutral hover:border-hairline-strong"
            : "border-dashed text-ink-4 hover:border-hairline-strong hover:text-ink-3"
        }`}
      >
        {currentConnector ? (
          currentConnector.name
        ) : (
          <>
            <PlusIcon className="h-2.5 w-2.5" />
            Connector
          </>
        )}
      </button>

      <dialog
        ref={dialogRef}
        aria-labelledby={`connector-dialog-title-${assignmentId}`}
        onClick={(event) => {
          if (event.target === event.currentTarget) close();
        }}
        className="m-auto w-[min(26rem,calc(100vw-2rem))] rounded-xl border border-hairline bg-surface p-0 text-ink shadow-2xl shadow-black/60 backdrop:bg-black/60"
      >
        <div className="border-b border-hairline px-5 py-4">
          <h2 id={`connector-dialog-title-${assignmentId}`} className="text-base font-semibold text-ink">
            Connector für {agentName}
          </h2>
        </div>

        {/* `key` erzwingt einen Neuaufbau bei geändertem Connector – sonst
            derselbe Darstellungsbug wie zuvor bei den Status-/Profil-Feldern
            in der Zeile (unkontrollierter defaultValue bleibt nach dem
            Speichern auf dem alten Stand stehen). */}
        <ActionForm
          action={updateAgentConnector}
          key={currentConnector?.id ?? "none"}
          className="space-y-4 p-5"
          onResult={(result) => {
            if (result.status === "success") close();
          }}
        >
          <input type="hidden" name="assignmentId" value={assignmentId} />
          <input type="hidden" name="projectId" value={projectId} />
          <div>
            <label className={labelClass} htmlFor={`connector-select-${assignmentId}`}>
              Connector
            </label>
            <select
              id={`connector-select-${assignmentId}`}
              name="connectorId"
              defaultValue={currentConnector?.id ?? ""}
              className={inputClass}
              autoFocus
            >
              <option value="">— keiner —</option>
              {connectors.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div className="flex justify-end gap-2 border-t border-hairline pt-4">
            <button type="button" onClick={close} className={buttonSecondaryClass}>
              Abbrechen
            </button>
            <button type="submit" className={buttonPrimaryClass}>
              Speichern
            </button>
          </div>
        </ActionForm>
      </dialog>
    </>
  );
}
