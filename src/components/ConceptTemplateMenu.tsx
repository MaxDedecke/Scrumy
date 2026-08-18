"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ActionForm } from "@/components/ActionForm";
import { ConfirmButton } from "@/components/ConfirmButton";
import { ChevronRightIcon } from "@/components/icons";
import { applyConceptTemplate } from "@/lib/actions/concept";
import { CONCEPT_TEMPLATES, CONCEPT_TEMPLATE_CATEGORIES } from "@/lib/conceptTemplates";

// Vorlagenauswahl als Popup-Menü statt aufklappbarem Bereich im Fuß: Der
// Auslöser sitzt kompakt in der Kopfzeile neben "Konzept", das Menü selbst
// wird per Portal an <body> gehängt. Grund für den Portal: Das Panel schneidet
// seinen Inhalt per overflow-hidden ab (damit Ecken rund bleiben und der
// scrollende Rumpf nicht über den Kopf hinausragt) – ein Menü, das dort direkt
// absolut positioniert wäre, würde am Panelrand abgeschnitten.
export function ConceptTemplateMenu({
  projectId,
  hasConceptContent,
}: {
  projectId: string;
  hasConceptContent: boolean;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; right: number } | null>(null);

  // Position aus dem Auslöser berechnen, sobald das Menü aufgeht – rechts-
  // bündig darunter, wie bei einem Kontextmenü.
  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    setPosition({ top: rect.bottom + 6, right: window.innerWidth - rect.right });
  }, [open]);

  useEffect(() => {
    if (!open) return;

    function handlePointerDown(event: MouseEvent) {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setOpen(false);
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    function handleReposition() {
      if (!triggerRef.current) return;
      const rect = triggerRef.current.getBoundingClientRect();
      setPosition({ top: rect.bottom + 6, right: window.innerWidth - rect.right });
    }

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("resize", handleReposition);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("resize", handleReposition);
    };
  }, [open]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        className="quiet-link inline-flex items-center gap-1 text-xs font-medium"
      >
        Aus Vorlage starten ({CONCEPT_TEMPLATES.length})
        <ChevronRightIcon className={`h-3 w-3 transition-transform ${open ? "-rotate-90" : "rotate-90"}`} />
      </button>

      {open &&
        position &&
        createPortal(
          <div
            ref={menuRef}
            style={{ top: position.top, right: position.right }}
            className="card fixed z-40 w-[min(32rem,calc(100vw-2rem))] p-3 shadow-xl"
          >
            <p className="mb-3 text-xs leading-relaxed text-ink-3">
              Jede Vorlage füllt das Konzeptfeld mit einem Entwurf für die Ablösung des jeweiligen Produkts:
              Ausgangslage, Ziel, Kernmodule, bewusste Abgrenzung, was auf Zulieferung durch den Kunden wartet
              und offene Punkte.
              {hasConceptContent && " Ein vorhandener Entwurf wird dabei überschrieben."}
            </p>
            <ActionForm
              action={applyConceptTemplate}
              className="max-h-[60vh] space-y-4 overflow-y-auto pr-1"
              onResult={() => setOpen(false)}
            >
              <input type="hidden" name="projectId" value={projectId} />
              {CONCEPT_TEMPLATE_CATEGORIES.map((category) => {
                const templates = CONCEPT_TEMPLATES.filter((t) => t.category === category);
                if (templates.length === 0) return null;
                return (
                  <div key={category}>
                    <h3 className="section-title mb-2">{category}</h3>
                    <div className="grid gap-2 sm:grid-cols-2">
                      {templates.map((template) => (
                        <ConfirmButton
                          key={template.id}
                          name="templateId"
                          value={template.id}
                          confirmText={
                            hasConceptContent
                              ? `Vorhandenen Konzept-Entwurf durch die Vorlage „${template.name}" ersetzen?`
                              : null
                          }
                          className="card-interactive block p-2.5 text-left"
                        >
                          <span className="block text-sm font-medium text-ink">Eigenes {template.name}</span>
                          <span className="mt-0.5 block text-xs leading-relaxed text-ink-3">{template.what}</span>
                        </ConfirmButton>
                      ))}
                    </div>
                  </div>
                );
              })}
            </ActionForm>
          </div>,
          document.body,
        )}
    </>
  );
}
