"use client";

import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { useToast } from "@/components/Toast";
import type { ActionResult } from "@/lib/actions/result";

// Formular für Server-Actions mit Rückmeldung: Statt die Action direkt an
// `<form action>` zu hängen, ruft der Client sie hier auf, wartet das Ergebnis
// ab und zeigt es als Toast oben rechts. Dadurch bekommt JEDER Absende-Button
// der App eine sichtbare Antwort – auch dann, wenn die Action nichts geändert
// hat (fehlendes Pflichtfeld, nichts zu tun).
//
// Actions, die auf eine andere Seite führen (Löschen), liefern `redirectTo`
// statt selbst `redirect()` aufzurufen: So steht die Meldung fest, bevor
// navigiert wird, und der Toast überlebt den Seitenwechsel.
export function ActionForm({
  action,
  children,
  className,
  encType,
}: {
  action: (formData: FormData) => Promise<ActionResult>;
  children: ReactNode;
  className?: string;
  encType?: string;
}) {
  const showToast = useToast();
  const router = useRouter();

  return (
    <form
      className={className}
      encType={encType}
      action={async (formData) => {
        let result: ActionResult;
        try {
          result = await action(formData);
        } catch (error) {
          // Serverseitige Ausnahmen (DB weg, Timeout) landen hier statt die
          // ganze Seite durch eine Fehlerseite zu ersetzen.
          showToast({
            variant: "error",
            message: `Aktion fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}`,
          });
          return;
        }

        showToast({ variant: result.status, message: result.message });
        if (result.redirectTo) router.push(result.redirectTo);
      }}
    >
      {children}
    </form>
  );
}
