"use client";

import { useState, type ReactNode } from "react";
import type { AgentRole, AgentStatus } from "@/generated/prisma/client";
import { AGENT_ROLE_LABEL, AGENT_STATUS_LABEL, AGENT_STATUS_PILL, RUN_KIND_LABEL } from "@/lib/labels";
import { Panel, PanelEmpty } from "@/components/Panel";
import {
  BooksIcon,
  ChairIcon,
  FrameIcon,
  GridIcon,
  ListIcon,
  MugIcon,
  PersonIcon,
  PlantIcon,
  SteamIcon,
} from "@/components/icons";

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
  className,
}: {
  agents: AgentWorkspaceEntry[];
  /** z.B. `lg:col-span-2`, wenn das Panel nicht die ganze Rasterzeile einnimmt. */
  className?: string;
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
      className={className}
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

type DeskState = "working" | "idle" | "fresh";
type Decor = "plant" | "mug" | "books" | "frame";

const DECOR_ICON: Record<Decor, (props: { className?: string }) => ReactNode> = {
  plant: PlantIcon,
  mug: MugIcon,
  books: BooksIcon,
  frame: FrameIcon,
};

// Stabiler String-Hash statt Math.random(): dasselbe Deko-Item bei jedem
// Rerender, damit man Kolleg:innen am Tisch wiedererkennt statt bei jedem
// Laden neu zu würfeln.
function hash(input: string): number {
  let h = 0;
  for (let i = 0; i < input.length; i++) h = (h * 31 + input.charCodeAt(i)) >>> 0;
  return h;
}

function agentDecor(id: string): Decor {
  const decors: Decor[] = ["plant", "mug", "books", "frame"];
  return decors[hash(id) % decors.length];
}

// Feste Pipeline-Reihenfolge (siehe AGENT_ROLE_LABEL) statt Auftrittsreihenfolge:
// Agenten derselben Rolle landen im Raster nebeneinander, ohne dass es dafür
// eine eigene Gruppen-Zeile braucht.
const ROLE_ORDER = Object.keys(AGENT_ROLE_LABEL) as AgentRole[];

// Der Büroplan: alle Tische in einem Raster mit fest zwei Zeilen – so viele
// Spalten wie nötig, dazu horizontales Scrollen statt einer dritten Zeile.
// Jeder Tisch trägt drei Zustandssignale, die alleine (auch in Graustufen
// über Position/Form) den Blick tragen: Monitor leuchtet + Stuhl ist
// herangerückt = arbeitet; Monitor aus + Stuhl abgerückt = zuletzt aktiv;
// Monitor aus + Stuhl mittig, kein Deko-Item = noch nie etwas getan. Ein
// festes Deko-Item pro Person (aus der ID abgeleitet) und Dampf an der Tasse
// bei einer Pause sind reine Atmosphäre und nie das einzige Signal.
function AgentOfficeView({ agents }: { agents: AgentWorkspaceEntry[] }) {
  const ordered = [...agents].sort(
    (a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role),
  );
  // So viele Spalten, wie nötig sind, um bei zwei Zeilen alle unterzubringen –
  // Reihenfolge bleibt links-nach-rechts, oben-nach-unten wie beim Lesen.
  const columns = Math.max(1, Math.ceil(ordered.length / 2));

  return (
    <div className="office-room p-4">
      <div className="office-desks" style={{ gridTemplateColumns: `repeat(${columns}, minmax(6.75rem, 1fr))` }}>
        {ordered.map((agent) => (
          <Desk key={agent.id} agent={agent} />
        ))}
      </div>
    </div>
  );
}

function Desk({ agent }: { agent: AgentWorkspaceEntry }) {
  const state: DeskState = agent.running !== null ? "working" : agent.last !== null ? "idle" : "fresh";
  const decor = agentDecor(agent.id);
  const decorSide = hash(`${agent.id}:side`) % 2 === 0 ? "corner-left" : "corner-right";
  const DecorIcon = DECOR_ICON[decor];
  const showSteam = state === "idle" && decor === "mug";

  return (
    <div
      data-state={state}
      title={
        state === "working"
          ? agent.running!.headline
          : state === "idle"
            ? `zuletzt: ${agent.last!.headline} · ${formatTime(agent.last!.startedAt)}`
            : "noch nichts getan"
      }
      className="office-desk flex flex-col items-center gap-2 rounded-lg px-1 py-2"
    >
      <div className="office-desk-scene relative h-[5.75rem] w-full">
        <div className="office-desk-surface" />
        {state !== "fresh" && (
          <DecorIcon className={`office-decor ${decorSide} h-4 w-4`} />
        )}
        {showSteam && <SteamIcon className={`office-steam ${decorSide === "corner-left" ? "left-[9%]" : "right-[9%]"} h-3.5 w-3`} />}
        <div className="office-monitor-foot" />
        <div className="office-monitor" />
        {state === "working" && (
          <div className="office-dots">
            <span />
            <span />
            <span />
          </div>
        )}
        <ChairIcon className="office-chair h-[1.375rem] w-[1.375rem]" />
        <PersonIcon filled={state === "working"} className="office-person h-6 w-6" />
      </div>
      <span className="office-nameplate w-full truncate rounded-full px-2 py-0.5 text-center text-xs font-medium text-ink">
        {agent.name}
      </span>
      <span className="w-full truncate text-center text-[10.5px] text-ink-3">{AGENT_ROLE_LABEL[agent.role]}</span>
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
