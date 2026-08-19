"use client";

import { useState } from "react";
import { PanelLeftIcon, ScrumyMark } from "@/components/icons";
import { setSidebarCollapsed, useSidebarCollapsed } from "@/lib/sidebarCollapse";

// Ersetzt den bisherigen Logo-Link in der Header-Leiste: Das "S" ist jetzt
// der einzige Schalter für die Sidebar – im eingeklappten Zustand ist die
// Sidebar komplett unsichtbar, ein eigener Knopf darin wäre also nicht
// erreichbar. Beim Hover weicht das Logo kurz einem Panel-Icon, das die
// anstehende Aktion (Ein-/Ausklappen) zeigt. Die Navigation zur Startseite
// liegt seither am unteren Rand der Sidebar selbst.
export function SidebarToggle() {
  const collapsed = useSidebarCollapsed();
  const [hovered, setHovered] = useState(false);

  return (
    <button
      type="button"
      onClick={() => setSidebarCollapsed(!collapsed)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      aria-label={collapsed ? "Sidebar ausklappen" : "Sidebar einklappen"}
      title={collapsed ? "Sidebar ausklappen" : "Sidebar einklappen"}
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-brand transition-colors hover:bg-surface-2"
    >
      {hovered ? (
        <PanelLeftIcon className="h-5 w-5" />
      ) : (
        <ScrumyMark className="h-6 w-6 -rotate-6" />
      )}
    </button>
  );
}
