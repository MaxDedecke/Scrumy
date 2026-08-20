"use client";

import { useEffect } from "react";

// Sobald die Live-Anwendung erreichbar ist, wird DIESER Tab (den der
// Play-Knopf extra dafür geöffnet hat) zur echten laufenden App – per
// `window.location.replace`, damit "Zurück" nicht auf diese Zwischenseite
// zurückführt. Der sichtbare Link auf der Seite bleibt als Fallback stehen,
// falls der Browser den automatischen Wechsel unterbindet.
export function LiveStackRedirect({ url }: { url: string }) {
  useEffect(() => {
    window.location.replace(url);
  }, [url]);

  return null;
}
