"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { generateRequirementsFromConcept, type GenerateRequirementsState } from "@/lib/actions/requirements";
import { SparklesIcon } from "@/components/icons";
import { buttonSecondaryClass } from "@/lib/ui";

// Eigene Client-Komponente, weil der LLM-Aufruf lange dauern kann und sowohl
// Fortschritt als auch Fehler (kein Key, Modell nicht erreichbar, Guthaben
// leer) direkt an der Aktion stehen müssen – ein serverseitig geworfener
// Fehler würde stattdessen die ganze Seite ersetzen.
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
  const [state, formAction] = useActionState<GenerateRequirementsState, FormData>(
    generateRequirementsFromConcept,
    null,
  );

  return (
    <div>
      <form action={formAction} className="flex flex-wrap items-center gap-3">
        <input type="hidden" name="projectId" value={projectId} />
        <SubmitButton />
        <span className="text-xs text-ink-3">
          {profileName ? `nutzt „${profileName}"` : "kein LLM-Profil angelegt"}
        </span>
      </form>
      {state && (
        <p
          role="status"
          className={`mt-3 rounded-lg border px-3 py-2 text-xs leading-relaxed ${
            state.ok
              ? "border-good/35 bg-good/10 text-good"
              : "border-critical/35 bg-critical/10 text-critical"
          }`}
        >
          {state.message}
        </p>
      )}
    </div>
  );
}
