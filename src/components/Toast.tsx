"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { CheckIcon, WarningIcon } from "@/components/icons";
import type { ActionStatus } from "@/lib/actions/result";

// Eine einzige Meldungsstelle für die ganze App: oben rechts, über allem.
// Jeder Klick auf einen Button landet hier – erfolgreiche Aktionen genauso wie
// abgelehnte oder abgebrochene. Der Toast-Stapel hängt im Root-Layout und
// überlebt Client-Navigation, sodass auch eine Meldung sichtbar bleibt, die
// direkt vor einem Seitenwechsel ausgelöst wurde (z.B. "Kunde gelöscht").

export type ToastOptions = {
  message: string;
  variant?: ActionStatus;
  /** Anzeigedauer in ms; sonst variantenabhängiger Standard. */
  duration?: number;
  /**
   * Meldungen mit gleichem Schlüssel ersetzen einander, statt sich zu stapeln –
   * für Aktionen, die man schnell mehrfach auslösen kann.
   */
  key?: string;
};

type ToastItem = Required<Omit<ToastOptions, "duration">> & { id: number; duration: number };

const DEFAULT_DURATION: Record<ActionStatus, number> = {
  success: 3500,
  info: 2500,
  error: 8000, // Fehlertexte (z.B. LLM-Antworten) brauchen länger zum Lesen.
};

// Mehr als vier gleichzeitig sind nicht mehr lesbar – die ältesten fallen raus.
const MAX_VISIBLE = 4;

const ToastContext = createContext<((options: ToastOptions) => void) | null>(null);

export function useToast() {
  const showToast = useContext(ToastContext);
  if (!showToast) {
    throw new Error("useToast() braucht einen <ToastProvider> im Baum (siehe app/layout.tsx).");
  }
  return showToast;
}

let nextToastId = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const showToast = useCallback((options: ToastOptions) => {
    const variant = options.variant ?? "info";
    const id = ++nextToastId;
    const item: ToastItem = {
      id,
      message: options.message,
      variant,
      duration: options.duration ?? DEFAULT_DURATION[variant],
      key: options.key ?? `toast-${id}`,
    };
    setToasts((current) => [...current.filter((toast) => toast.key !== item.key), item].slice(-MAX_VISIBLE));
  }, []);

  return (
    <ToastContext.Provider value={showToast}>
      {children}
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-none fixed right-4 top-4 z-50 flex w-[min(23rem,calc(100vw-2rem))] flex-col gap-2"
      >
        {toasts.map((toast) => (
          <ToastCard key={toast.id} toast={toast} onDismiss={() => dismiss(toast.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

const VARIANT_CLASS: Record<ActionStatus, string> = {
  success: "border-good/40 text-good",
  error: "border-critical/45 text-critical",
  info: "border-hairline-strong text-ink-2",
};

function ToastCard({ toast, onDismiss }: { toast: ToastItem; onDismiss: () => void }) {
  useEffect(() => {
    const timer = window.setTimeout(onDismiss, toast.duration);
    return () => window.clearTimeout(timer);
  }, [toast.duration, onDismiss]);

  return (
    <div
      className={`toast-enter pointer-events-auto flex items-start gap-2.5 rounded-xl border bg-surface px-3.5 py-3 shadow-2xl shadow-black/60 ${
        VARIANT_CLASS[toast.variant]
      }`}
    >
      <span className="mt-0.5 shrink-0">
        {toast.variant === "success" ? (
          <CheckIcon className="h-4 w-4" />
        ) : toast.variant === "error" ? (
          <WarningIcon className="h-4 w-4" />
        ) : (
          // Neutraler Punkt: Hinweise ohne Wertung bekommen kein Statussymbol.
          <span className="block h-1.5 w-1.5 translate-y-1.5 rounded-full bg-current" />
        )}
      </span>
      <p className="min-w-0 flex-1 whitespace-pre-line break-words text-xs leading-relaxed text-ink-2">
        {toast.message}
      </p>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Meldung schließen"
        className="-mr-1 shrink-0 rounded px-1 text-sm leading-none text-ink-4 transition-colors hover:text-ink"
      >
        ×
      </button>
    </div>
  );
}
