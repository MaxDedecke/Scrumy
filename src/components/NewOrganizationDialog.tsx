"use client";

import { useRef } from "react";
import { ActionForm } from "@/components/ActionForm";
import { PlusIcon } from "@/components/icons";
import { createOrganization } from "@/lib/actions/organizations";
import {
  buttonPrimaryClass,
  buttonSecondaryClass,
  iconButtonClass,
  inputClass,
  labelClass,
} from "@/lib/ui";

export function NewOrganizationDialog() {
  const dialogRef = useRef<HTMLDialogElement>(null);

  function closeAndReset() {
    const dialog = dialogRef.current;
    dialog?.close();
    dialog?.querySelector("form")?.reset();
  }

  return (
    <>
      <button
        type="button"
        onClick={() => dialogRef.current?.showModal()}
        aria-label="Neuen Kunden anlegen"
        title="Neuen Kunden anlegen"
        className={iconButtonClass}
      >
        <PlusIcon className="h-5 w-5" />
      </button>

      <dialog
        ref={dialogRef}
        aria-labelledby="new-organization-title"
        onClick={(event) => {
          if (event.target === event.currentTarget) closeAndReset();
        }}
        className="m-auto w-[min(32rem,calc(100vw-2rem))] rounded-xl border border-hairline bg-surface p-0 text-ink shadow-2xl shadow-black/60 backdrop:bg-black/60"
      >
        <div className="border-b border-hairline px-5 py-4">
          <h2 id="new-organization-title" className="text-base font-semibold text-ink">
            Neuen Kunden anlegen
          </h2>
          <p className="mt-1 text-sm text-ink-3">Die Projekte und das Agenten-Team legst du anschließend an.</p>
        </div>

        <ActionForm
          action={createOrganization}
          className="space-y-4 p-5"
          onResult={(result) => {
            if (result.status === "success") closeAndReset();
          }}
        >
          <div>
            <label className={labelClass} htmlFor="new-org-name">
              Name
            </label>
            <input
              id="new-org-name"
              name="name"
              required
              autoFocus
              className={inputClass}
              placeholder="Musterfirma GmbH"
            />
          </div>
          <div>
            <label className={labelClass} htmlFor="new-org-industry">
              Branche (optional)
            </label>
            <input
              id="new-org-industry"
              name="industry"
              className={inputClass}
              placeholder="z.B. Großhandel"
            />
          </div>
          <div className="flex justify-end gap-2 border-t border-hairline pt-4">
            <button type="button" onClick={closeAndReset} className={buttonSecondaryClass}>
              Abbrechen
            </button>
            <button type="submit" className={buttonPrimaryClass}>
              Kunde anlegen
            </button>
          </div>
        </ActionForm>
      </dialog>
    </>
  );
}
