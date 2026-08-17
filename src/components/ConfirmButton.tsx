"use client";

import { useToast } from "@/components/Toast";

export function ConfirmButton({
  confirmText,
  children,
  className,
  name,
  value,
  title,
}: {
  /** `null` = ohne Rückfrage absenden (z.B. wenn nichts überschrieben wird). */
  confirmText: string | null;
  children: React.ReactNode;
  className?: string;
  /** Für Formulare mit mehreren Submit-Buttons (z.B. Vorlagenauswahl). */
  name?: string;
  value?: string;
  /** Klartext für Icon-Buttons ohne Beschriftung: Tooltip, Screenreader-Name
   *  und sichtbarer Ersatztext – dieselben drei Kanäle wie in <IconSubmit>. */
  title?: string;
}) {
  const showToast = useToast();

  return (
    <button
      type="submit"
      className={className}
      name={name}
      value={value}
      title={title}
      aria-label={title}
      onClick={(e) => {
        if (confirmText && !window.confirm(confirmText)) {
          e.preventDefault();
          // Auch der Abbruch bekommt eine Rückmeldung – sonst ist der einzige
          // Klick der App, auf den nichts folgt, ausgerechnet der bei einer
          // Sicherheitsabfrage.
          showToast({ message: "Abgebrochen – es wurde nichts geändert.", key: "confirm-cancelled" });
        }
      }}
    >
      {children}
      {title && <span className="sr-only">{title}</span>}
    </button>
  );
}
