"use client";

import { useState, type ReactNode } from "react";
import type { AgentRole, AgentStatus } from "@/generated/prisma/client";
import { AGENT_ROLE_LABEL, AGENT_STATUS_LABEL, AGENT_STATUS_PILL, RUN_KIND_LABEL } from "@/lib/labels";
import { Panel, PanelEmpty } from "@/components/Panel";
import { DesktopIcon, GridIcon, ListIcon, PersonIcon } from "@/components/icons";

export type AgentWorkspaceEntry = {
  id: string;
  name: string;
  role: AgentRole;
  status: AgentStatus;
  running: { headline: string; kind: string; startedAt: Date } | null;
  last: { headline: string; startedAt: Date } | null;
};

type ViewMode = "list" | "office";

// „Wer gerade woran arbeitet": Liste (bewährt, textlich dicht) oder Büroplan
// (ein Blick genügt). Der Umschalter sitzt oben rechts auf Titelhöhe, wie bei
// jedem <Panel>-`action` – nur dass hier zwei Ansichten um denselben Platz
// konkurrieren, statt eine feste Aktion zu sein.
export function AgentWorkspacePanel({
  agents,
  footer,
  children,
}: {
  agents: AgentWorkspaceEntry[];
  footer?: ReactNode;
  /** Zusatzinhalt unter der Ansicht, z.B. Rückfragen – unabhängig vom Modus. */
  children?: ReactNode;
}) {
  const [mode, setMode] = useState<ViewMode>("list");

  // Eingeklappt reicht die Namenszeile: einmal auf den Blick lesbar, wer
  // gerade zum Team gehört, ohne Status und Aufgaben mitzuschleppen.
  // `line-clamp-2` kappt bei mehr Namen als Platz automatisch mit „…".
  const namesLine = agents.length === 0 ? "Niemand zugeordnet." : agents.map((agent) => agent.name).join(", ");

  return (
    <Panel
      title="Wer gerade woran arbeitet"
      count={agents.length}
      padded={false}
      footer={footer}
      collapsible
      collapsedView={<p className="line-clamp-2 px-4 py-3 text-sm text-ink-2">{namesLine}</p>}
      action={
        <div className="flex shrink-0 items-center gap-0.5 rounded-lg bg-surface-2 p-0.5">
          <button
            type="button"
            onClick={() => setMode("list")}
            title="Liste"
            aria-label="Liste"
            aria-pressed={mode === "list"}
            className={`inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors ${
              mode === "list" ? "bg-surface text-ink shadow-sm" : "text-ink-3 hover:text-ink"
            }`}
          >
            <ListIcon className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => setMode("office")}
            title="Büroplan"
            aria-label="Büroplan"
            aria-pressed={mode === "office"}
            className={`inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors ${
              mode === "office" ? "bg-surface text-ink shadow-sm" : "text-ink-3 hover:text-ink"
            }`}
          >
            <GridIcon className="h-4 w-4" />
          </button>
        </div>
      }
    >
      {agents.length === 0 ? (
        <PanelEmpty>Diesem Projekt ist noch niemand zugeordnet.</PanelEmpty>
      ) : mode === "list" ? (
        <AgentListView agents={agents} />
      ) : (
        <AgentOfficeView agents={agents} />
      )}

      {children}
    </Panel>
  );
}

function AgentListView({ agents }: { agents: AgentWorkspaceEntry[] }) {
  return (
    <ul className="divide-y divide-hairline">
      {agents.map((agent) => (
        <li key={agent.id} className="px-4 py-2.5">
          <div className="flex items-center justify-between gap-3">
            <span className="truncate text-sm font-medium text-ink">{agent.name}</span>
            <span className={`${AGENT_STATUS_PILL[agent.status]} pill-dot shrink-0`}>
              {AGENT_STATUS_LABEL[agent.status]}
            </span>
          </div>
          <p className="text-xs text-ink-3">{AGENT_ROLE_LABEL[agent.role]}</p>
          <p className="mt-1 text-sm text-ink-2">
            {agent.running ? (
              agent.running.headline
            ) : agent.last ? (
              <span className="text-ink-3">
                zuletzt: {agent.last.headline}{" "}
                <span className="text-ink-4">· {formatTime(agent.last.startedAt)}</span>
              </span>
            ) : (
              <span className="text-ink-4">noch nichts getan</span>
            )}
          </p>
          {agent.running && (
            <p className="mt-0.5 text-xs text-ink-4">
              {RUN_KIND_LABEL[agent.running.kind] ?? agent.running.kind} · seit{" "}
              {formatTime(agent.running.startedAt)}
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}

// Der Büroplan: jeder Agent ein Strichmännchen an seinem PC. Arbeitet er,
// sitzt er dran – Männchen und Bildschirm rücken zusammen und werden massiv
// grün. Ist er passiv, rückt das Männchen vom PC ab und beide bleiben nur
// grün umrandet. Der Zustand ist damit auf einen Blick sichtbar, ohne Text
// lesen zu müssen.
function AgentOfficeView({ agents }: { agents: AgentWorkspaceEntry[] }) {
  return (
    <div className="grid grid-cols-2 gap-3 p-4 sm:grid-cols-3 md:grid-cols-4">
      {agents.map((agent) => {
        const working = agent.running !== null;
        return (
          <div
            key={agent.id}
            title={working ? agent.running!.headline : (agent.last?.headline ?? "noch nichts getan")}
            className="flex flex-col items-center gap-2 rounded-lg border border-hairline px-2 py-3 text-center"
          >
            <div className="flex h-16 w-full flex-col items-center justify-end text-good">
              <PersonIcon
                filled={working}
                className={`h-7 w-7 shrink-0 transition-[margin] ${working ? "-mb-1.5" : "mb-2.5"}`}
              />
              <DesktopIcon filled={working} className="h-8 w-8 shrink-0" />
            </div>
            <span className="w-full truncate text-xs font-medium text-ink">{agent.name}</span>
            <span className="text-[11px] text-ink-3">{AGENT_ROLE_LABEL[agent.role]}</span>
          </div>
        );
      })}
    </div>
  );
}

function formatTime(date: Date): string {
  return date.toLocaleString("de-DE", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
