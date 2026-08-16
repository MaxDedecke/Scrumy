"use client";

export function ConfirmButton({
  confirmText,
  children,
  className,
  name,
  value,
}: {
  /** `null` = ohne Rückfrage absenden (z.B. wenn nichts überschrieben wird). */
  confirmText: string | null;
  children: React.ReactNode;
  className?: string;
  /** Für Formulare mit mehreren Submit-Buttons (z.B. Vorlagenauswahl). */
  name?: string;
  value?: string;
}) {
  return (
    <button
      type="submit"
      className={className}
      name={name}
      value={value}
      onClick={(e) => {
        if (confirmText && !window.confirm(confirmText)) e.preventDefault();
      }}
    >
      {children}
    </button>
  );
}
