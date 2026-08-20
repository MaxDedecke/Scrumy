"use client";

import { useState } from "react";
import { ExternalLinkIcon, RefreshIcon } from "@/components/icons";
import { iconButtonClass } from "@/lib/ui";

// Das iframe der laufenden Vorschau plus eine schmale Werkzeugleiste darüber.
//
// „Neu laden" setzt bewusst nur den React-`key` hoch statt `postMessage` oder
// einen Ref-Trick zu bemühen: Ein neuer `key` baut das iframe komplett neu auf
// und lädt damit garantiert den aktuellen Stand, unabhängig davon, wie die
// Vorschau intern rendert.
export function PreviewFrame({ url }: { url: string }) {
  const [reloadKey, setReloadKey] = useState(0);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center justify-end gap-1 border-b border-hairline px-2">
        <button
          type="button"
          title="Vorschau neu laden"
          aria-label="Vorschau neu laden"
          onClick={() => setReloadKey((key) => key + 1)}
          className={iconButtonClass}
        >
          <RefreshIcon className="h-4 w-4" />
        </button>
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          title="In neuem Tab öffnen"
          aria-label="In neuem Tab öffnen"
          className={iconButtonClass}
        >
          <ExternalLinkIcon className="h-4 w-4" />
        </a>
      </div>
      <iframe
        key={reloadKey}
        src={url}
        title="Vorschau der Anwendung"
        className="min-h-0 w-full flex-1 border-0 bg-white"
      />
    </div>
  );
}
