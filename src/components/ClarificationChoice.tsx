"use client";

import { useState } from "react";
import { DELEGATE_OPTION_KEY, OWN_OPTION_KEY, type ClarificationOption } from "@/lib/clarificationOptions";
import { inputClass } from "@/lib/ui";

// Die Auswahl, mit der der Auftraggeber eine Klärung entscheidet.
//
// Vorher standen hier drei immer gleiche Standardwege („Nochmal versuchen",
// „Zurückstellen", „Team anhalten") und darunter ein Textfeld ohne eigenen
// Platz in der Auswahl. Zu einer fachlichen Frage – welcher Server, welches
// Datenmodell – passte keiner der drei, also tippte der Mensch die Antwort ins
// Feld, während oben trotzdem „Nochmal versuchen" angehakt blieb: Der Beschluss
// las sich danach wie „Nochmal versuchen – nur server.js verwenden".
//
// Jetzt kommen die Wege vom Team (Umsetzer, QA, Scrum Master), und der eigene
// Weg ist eine gleichberechtigte Auswahl mit dem Textfeld darin. Wer ins Feld
// schreibt, wählt ihn automatisch – niemand muss daran denken, das Radio
// umzustellen.
//
// `recommendedKey`: Legt der Product Owner eine Klärung trotzdem vor (siehe
// clarificationTriage), empfiehlt er einen der Wege. Der steht dann statt des
// ersten Wegs vorausgewählt da und trägt ein Pill – zustimmen soll ein Klick
// sein, kein Formulieren.
//
// „Team soll entscheiden" ist bewusst ein eigener Weg und kein Hinweis im
// Textfeld: Wer dort „entscheide du das bitte" hineinschreibt, bekommt sonst
// genau das als wörtlichen, unausführbaren Beschluss zurück – die Klärung
// landet postwendend wieder hier. Der Klick trägt stattdessen tatsächlich
// eine Entscheidung ein (siehe decideClarification).
export function ClarificationChoice({
  options,
  recommendedKey,
}: {
  options: ClarificationOption[];
  recommendedKey?: string | null;
}) {
  const recommended = recommendedKey ? options.find((option) => option.key === recommendedKey) : undefined;
  const [choice, setChoice] = useState(recommended?.key ?? options[0]?.key ?? OWN_OPTION_KEY);
  const ownChosen = choice === OWN_OPTION_KEY;

  return (
    <div className="grid gap-1.5">
      {options.map((option) => (
        <label
          key={option.key}
          className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-hairline bg-surface-2 px-3 py-2 transition-colors hover:border-hairline-strong has-checked:border-accent-border"
        >
          <input
            type="radio"
            name="option"
            value={option.key}
            checked={choice === option.key}
            onChange={() => setChoice(option.key)}
            className="mt-0.5 accent-[var(--color-accent-solid)]"
          />
          <span className="min-w-0">
            <span className="block text-sm text-ink">
              {option.label}
              {option.key === recommended?.key && (
                <span className="ml-2 pill pill-info align-middle">Empfehlung</span>
              )}
            </span>
            {option.detail && <span className="mt-0.5 block text-xs text-ink-3">{option.detail}</span>}
          </span>
        </label>
      ))}

      <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-hairline bg-surface-2 px-3 py-2 transition-colors hover:border-hairline-strong has-checked:border-accent-border">
        <input
          type="radio"
          name="option"
          value={DELEGATE_OPTION_KEY}
          checked={choice === DELEGATE_OPTION_KEY}
          onChange={() => setChoice(DELEGATE_OPTION_KEY)}
          className="mt-0.5 accent-[var(--color-accent-solid)]"
        />
        <span className="min-w-0">
          <span className="block text-sm text-ink">Team soll entscheiden</span>
          <span className="mt-0.5 block text-xs text-ink-3">
            {recommended
              ? "Das Team setzt seine Empfehlung von oben um, ohne dass du sie extra auswählst."
              : "Der Product Owner wählt jetzt selbst einen Weg – ohne erneute Rückfrage."}
          </span>
        </span>
      </label>

      <div className="rounded-lg border border-hairline bg-surface-2 px-3 py-2 transition-colors has-checked:border-accent-border">
        <label className="flex cursor-pointer items-start gap-2.5">
          <input
            type="radio"
            name="option"
            value={OWN_OPTION_KEY}
            checked={ownChosen}
            onChange={() => setChoice(OWN_OPTION_KEY)}
            className="mt-0.5 accent-[var(--color-accent-solid)]"
          />
          <span className="min-w-0">
            <span className="block text-sm text-ink">Eigener Weg</span>
            <span className="mt-0.5 block text-xs text-ink-3">
              Wenn kein Vorschlag passt: Schreib auf, was das Team tun soll.
            </span>
          </span>
        </label>

        <textarea
          name="comment"
          rows={ownChosen ? 3 : 2}
          onFocus={() => setChoice(OWN_OPTION_KEY)}
          placeholder={
            ownChosen
              ? "Dein Beschluss – das Team bekommt ihn ab jetzt in jedem Arbeitsschritt mit."
              : "Ergänzung zum gewählten Weg (optional) – oder hier den eigenen Weg aufschreiben."
          }
          className={`${inputClass} mt-2 w-full`}
        />
      </div>
    </div>
  );
}
