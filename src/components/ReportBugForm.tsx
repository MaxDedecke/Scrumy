"use client";

import { useState } from "react";
import { ActionForm } from "@/components/ActionForm";
import { IconSubmit } from "@/components/IconSubmit";
import { WarningIcon, SendIcon } from "@/components/icons";
import { reportBug } from "@/lib/actions/bugReport";
import { buttonPrimaryClass, buttonSecondaryClass, inputClass } from "@/lib/ui";

// Direkt unter der Fehlermeldung von Vorschau/Live-Anwendung (siehe
// preview/page.tsx bzw. live/page.tsx, ERROR-Zweig): "das Team sagt fertig,
// aber es läuft nicht" darf keine Lücke sein, die nur ein Mensch von Hand
// zuschraubt (Nachbau des Containers, Docker-Image bauen, …) – das war
// zuletzt genau der Fall bei Drapbox. Der Knopf hier macht daraus sofort ein
// echtes, dringendes BUG-Ticket im Projekt (siehe src/lib/actions/bugReport.ts),
// mit der Fehlermeldung als Beleg, statt dass es beim Auftraggeber hängen
// bleibt.
export function ReportBugForm({
  projectId,
  source,
  diagnostics,
}: {
  projectId: string;
  source: "live" | "preview";
  diagnostics: string | null;
}) {
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className={buttonSecondaryClass}>
        <WarningIcon className="h-3.5 w-3.5" />
        Bug ans Team melden
      </button>
    );
  }

  return (
    <ActionForm
      action={reportBug}
      className="flex w-full max-w-md flex-col gap-2 text-left"
      onResult={(result) => {
        if (result.status !== "error") setOpen(false);
      }}
    >
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="source" value={source} />
      <input type="hidden" name="diagnostics" value={diagnostics ?? ""} />
      <textarea
        name="note"
        rows={2}
        autoFocus
        placeholder="Was hast du beobachtet? (die Fehlermeldung oben wird automatisch mitgeschickt)"
        className={`${inputClass} resize-none`}
      />
      <div className="flex justify-end gap-2">
        <button type="button" onClick={() => setOpen(false)} className="text-xs text-ink-3 hover:text-ink">
          Abbrechen
        </button>
        <IconSubmit title="Als dringendes Ticket ans Team melden" className={buttonPrimaryClass}>
          <SendIcon className="h-3.5 w-3.5" />
          Melden
        </IconSubmit>
      </div>
    </ActionForm>
  );
}
