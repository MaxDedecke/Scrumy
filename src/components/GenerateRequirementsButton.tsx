"use client";

import { useFormStatus } from "react-dom";
import { generateRequirementsFromConcept } from "@/lib/actions/requirements";
import { ActionForm } from "@/components/ActionForm";
import { SparklesIcon } from "@/components/icons";
import { buttonSecondaryClass } from "@/lib/ui";

// Eigene Client-Komponente, weil der LLM-Aufruf lange dauern kann: Der Button
// zeigt währenddessen den Fortschritt an. Das Ergebnis – Erfolg wie Fehler
// (kein Key, Modell nicht erreichbar, Guthaben leer) – meldet <ActionForm> als
// Toast oben rechts.
function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className={`${buttonSecondaryClass} disabled:opacity-60`}>
      <SparklesIcon className={`h-4 w-4 ${pending ? "animate-pulse" : ""}`} />
      {pending ? "Generiere…" : "Anforderungen jetzt generieren"}
    </button>
  );
}

export function GenerateRequirementsButton({
  projectId,
  profileName,
}: {
  projectId: string;
  /** Name des Profils, das verwendet wird – damit es keine Überraschung gibt. */
  profileName: string | null;
}) {
  return (
    <ActionForm
      action={generateRequirementsFromConcept}
      className="flex flex-wrap items-center gap-3"
    >
      <input type="hidden" name="projectId" value={projectId} />
      <SubmitButton />
      <span className="text-xs text-ink-3">
        {profileName ? `nutzt „${profileName}“` : "kein LLM-Profil angelegt"}
      </span>
    </ActionForm>
  );
}
