"use client";

import { useSyncExternalStore } from "react";

// Eingeklappt-Zustand liegt in localStorage statt im React-State: sowohl die
// Sidebar als auch der Umschalter in der Header-Leiste (zwei getrennte
// Client-Components) müssen ihn lesen/schreiben können. SSR kennt
// localStorage nicht, deshalb liest useSyncExternalStore mit einem eigenen
// Server-Snapshot (immer ausgeklappt) – kein Hydration-Mismatch, kein
// setState im Effect.
const COLLAPSE_STORAGE_KEY = "scrumy:sidebar-collapsed";
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

function getSnapshot() {
  return window.localStorage.getItem(COLLAPSE_STORAGE_KEY) === "1";
}

function getServerSnapshot() {
  return false;
}

export function useSidebarCollapsed() {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

export function setSidebarCollapsed(value: boolean) {
  window.localStorage.setItem(COLLAPSE_STORAGE_KEY, value ? "1" : "0");
  listeners.forEach((listener) => listener());
}
