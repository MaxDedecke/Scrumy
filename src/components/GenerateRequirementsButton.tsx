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
function SubmitButton({ compact, title }: { compact: boolean; title: string }) {
  const { pending } = useFormStatus();

  if (compact) {
    return (
      <button
        type="submit"
        disabled={pending}
        title={title}
        className="quiet-link inline-flex items-center gap-1.5 font-medium disabled:opacity-60"
      >
        <SparklesIcon className={`h-3.5 w-3.5 ${pending ? "animate-pulse" : ""}`} />
        {pending ? "Generiere…" : "Generieren"}
      </button>
    );
  }

  return (
    <button type="submit" disabled={pending} title={title} className={`${buttonSecondaryClass} disabled:opacity-60`}>
      <SparklesIcon className={`h-4 w-4 ${pending ? "animate-pulse" : ""}`} />
      {pending ? "Generiere…" : "Anforderungen jetzt generieren"}
    </button>
  );
}

export function GenerateRequirementsButton({
  projectId,
  profileName,
  compact = false,
}: {
  projectId: string;
  /** Name des Profils, das verwendet wird – damit es keine Überraschung gibt. */
  profileName: string | null;
  /** Für die Kopfzeile eines Panels: nur Icon + ein Wort, Rest im Tooltip. */
  compact?: boolean;
}) {
  const profileHint = profileName ? `nutzt „${profileName}“` : "kein LLM-Profil angelegt";

  return (
    <ActionForm action={generateRequirementsFromConcept} className="flex flex-wrap items-center gap-3">
      <input type="hidden" name="projectId" value={projectId} />
      <SubmitButton
        compact={compact}
        title={`Der Product-Owner-Agent liest das Konzept und leitet daraus Anforderungen ab – ${profileHint}. Bestehende bleiben erhalten.`}
      />
      {!compact && <span className="text-xs text-ink-3">{profileHint}</span>}
    </ActionForm>
  );
}
