"use client";

// Merkt sich die zuletzt besuchte Seite außerhalb der Einstellungen, damit
// der Einstellungen-Knopf in der Header-Leiste bei erneutem Klick genau
// dorthin zurückspringt – man muss sich den Weg zurück nicht selbst merken.
// sessionStorage statt localStorage: gilt nur für die laufende Sitzung, ein
// neuer Tab startet ohne einen möglicherweise veralteten Rücksprungpunkt.
const LAST_VIEW_STORAGE_KEY = "scrumy:last-view";

export function rememberLastView(path: string) {
  if (path.startsWith("/settings")) return;
  window.sessionStorage.setItem(LAST_VIEW_STORAGE_KEY, path);
}

export function getLastView(): string {
  return window.sessionStorage.getItem(LAST_VIEW_STORAGE_KEY) ?? "/";
}
