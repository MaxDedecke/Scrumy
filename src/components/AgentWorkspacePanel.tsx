"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { AgentRole, AgentStatus, InquiryStatus } from "@/generated/prisma/client";
import {
  AGENT_ROLE_LABEL,
  AGENT_STATUS_LABEL,
  AGENT_STATUS_PILL,
  INQUIRY_STATUS_LABEL,
  RUN_KIND_LABEL,
} from "@/lib/labels";
import { ActionForm } from "@/components/ActionForm";
import { AgentResponse } from "@/components/AgentResponse";
import { IconSubmit } from "@/components/IconSubmit";
import { Panel, PanelEmpty } from "@/components/Panel";
import { ChatIcon, GridIcon, ListIcon, SendIcon } from "@/components/icons";
import { askTeam } from "@/lib/actions/team";
import { iconButtonClass, inputClass } from "@/lib/ui";

export type AgentWorkspaceEntry = {
  id: string;
  name: string;
  role: AgentRole;
  status: AgentStatus;
  running: { headline: string; kind: string; startedAt: Date } | null;
  last: { headline: string; startedAt: Date } | null;
};

export type TeamInquiryEntry = {
  id: string;
  question: string;
  answer: string | null;
  status: InquiryStatus;
  createdAt: Date;
  answeredByName: string | null;
};

type ViewMode = "list" | "office" | "chat";

// Titel folgt dem Tab: Liste/Büroplan zeigen dieselbe Frage ("wer arbeitet
// woran"), der Chat-Tab ist inhaltlich ein anderes Thema (Rückfragen) und
// bekommt deshalb einen eigenen Titel statt eines generischen Oberbegriffs.
const MODE_TITLE: Record<ViewMode, string> = {
  list: "Wer gerade woran arbeitet",
  office: "Wer gerade woran arbeitet",
  chat: "Rückfragen ans Team",
};

// „Wer gerade woran arbeitet" + „Rückfragen ans Team" in einer Karte, drei
// gleichberechtigte Tabs (Liste, Büroplan, Rückfragen) statt zweier
// getrennter Panels: beide drehen sich um dasselbe Team, nur der Blickwinkel
// wechselt. Der Umschalter sitzt oben rechts auf Titelhöhe, wie bei jedem
// <Panel>-`action` – nur dass hier drei Ansichten um denselben Platz
// konkurrieren, statt eine feste Aktion zu sein.
export function AgentWorkspacePanel({
  agents,
  projectId,
  inquiries,
  className,
}: {
  agents: AgentWorkspaceEntry[];
  projectId: string;
  inquiries: TeamInquiryEntry[];
  /** z.B. `lg:col-span-2`, wenn das Panel nicht die ganze Rasterzeile einnimmt. */
  className?: string;
}) {
  const [mode, setMode] = useState<ViewMode>("list");
  const scrollRef = useRef<HTMLDivElement>(null);

  const orderedInquiries = [...inquiries].reverse();
  const openInquiries = inquiries.filter((inquiry) => inquiry.answer === null).length;

  useEffect(() => {
    if (mode !== "chat") return;
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [mode, inquiries.length]);

  // Eingeklappt reicht die Namenszeile: einmal auf den Blick lesbar, wer
  // gerade zum Team gehört, ohne Status und Aufgaben mitzuschleppen.
  // `line-clamp-2` kappt bei mehr Namen als Platz automatisch mit „…".
  const namesLine = agents.length === 0 ? "Niemand zugeordnet." : agents.map((agent) => agent.name).join(", ");
  const latestInquiry = inquiries[0];

  return (
    <Panel
      title={MODE_TITLE[mode]}
      count={mode === "chat" ? inquiries.length : agents.length}
      padded={false}
      scroll={mode === "list"}
      className={className}
      collapsible
      collapsedView={
        mode === "chat" ? (
          <p className="line-clamp-2 px-4 py-3 text-sm text-ink-2">
            {latestInquiry ? latestInquiry.question : "Noch keine Rückfrage gestellt."}
          </p>
        ) : (
          <p className="line-clamp-2 px-4 py-3 text-sm text-ink-2">{namesLine}</p>
        )
      }
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
          <button
            type="button"
            onClick={() => setMode("chat")}
            title="Rückfragen ans Team"
            aria-label="Rückfragen ans Team"
            aria-pressed={mode === "chat"}
            className={`relative inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors ${
              mode === "chat" ? "bg-surface text-ink shadow-sm" : "text-ink-3 hover:text-ink"
            }`}
          >
            <ChatIcon className="h-4 w-4" />
            {openInquiries > 0 && (
              <span className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-accent" />
            )}
          </button>
        </div>
      }
      footer={
        mode === "chat" ? (
          <ActionForm action={askTeam} className="flex items-end gap-2">
            <input type="hidden" name="projectId" value={projectId} />
            <textarea
              name="question"
              rows={1}
              required
              placeholder="Rückfrage ans Team – z.B. „Was blockiert euch?“"
              className={`${inputClass} min-h-9 resize-none py-2`}
            />
            <IconSubmit title="Frage an das Team schicken" className={iconButtonClass}>
              <SendIcon className="h-4 w-4" />
            </IconSubmit>
          </ActionForm>
        ) : undefined
      }
    >
      {mode === "chat" ? (
        <div ref={scrollRef} className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto p-4">
          {orderedInquiries.length === 0 ? (
            <PanelEmpty>Noch keine Rückfrage gestellt – frag direkt unten.</PanelEmpty>
          ) : (
            orderedInquiries.map((inquiry) => (
              <div key={inquiry.id} className="flex flex-col gap-1.5">
                <div className="max-w-[88%] self-end rounded-2xl rounded-br-sm bg-accent-soft/60 px-3 py-2">
                  <p className="text-sm text-ink">{inquiry.question}</p>
                  <p className="mt-1 text-[11px] text-ink-3">{formatTime(inquiry.createdAt)}</p>
                </div>
                {inquiry.answer ? (
                  <div className="max-w-[88%] self-start rounded-2xl rounded-bl-sm bg-surface-2/70 px-3 py-2">
                    {inquiry.answeredByName && (
                      <p className="text-[11px] font-medium text-ink-3">{inquiry.answeredByName}</p>
                    )}
                    <AgentResponse text={inquiry.answer} className="mt-0.5" />
                  </div>
                ) : (
                  <p className="self-start px-1 text-xs text-ink-4">{INQUIRY_STATUS_LABEL[inquiry.status]} …</p>
                )}
              </div>
            ))
          )}
        </div>
      ) : agents.length === 0 ? (
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

type AgentState = "working" | "idle" | "fresh" | "blocked";

// Stabiler String-Hash statt Math.random(): dieselbe Startposition/Drift-Bahn
// bei jedem Rerender, sonst würde jeder Server-Render die Bällchen neu
// verteilen und der Eindruck von Bewegung ginge in Sprüngen unter statt in
// echtem Treiben.
function hash(input: string): number {
  let h = 0;
  for (let i = 0; i < input.length; i++) h = (h * 31 + input.charCodeAt(i)) >>> 0;
  return h;
}

// Nur noch die Wander-Bahn INNERHALB der eigenen Grid-Zelle (siehe
// AgentOfficeView) – keine Position mehr, die kommt jetzt vom Grid-Platz
// selbst. `--dx*`/`--dy*` bleiben absichtlich klein: `.orb-cell` garantiert
// per CSS-Grid-Minimum (9rem) mindestens 1rem Rand um den 7rem-Kreis, die
// Werte hier bleiben darunter (max. 0.9rem), damit der Kreis (nicht nur die
// Schrift darin) niemals in die Nachbarzelle reicht oder am Feldrand
// verschwindet – selbst wenn die tatsächliche Zelle breiter ist, bleibt das
// konservativ und damit garantiert sicher. `@keyframes orb-drift`
// (globals.css) setzt die Werte an zwei Zwischenpunkten ein, der Browser
// interpoliert zwischen den daraus entstehenden, für jedes Bällchen fixen
// `transform`-Werten ganz normal weiter. Dauer/Verzögerung ebenfalls pro
// Agent, damit nicht alle Bällchen synchron "atmen".
function driftStyle(id: string): CSSProperties {
  const sign = (n: number) => (n % 2 === 0 ? 1 : -1);
  const rem = (h: number, base: number, span: number) => sign(h) * (base + ((h >> 3) % span) * 0.1);
  const dx1 = rem(hash(`${id}:dx1`), 0.3, 5);
  const dy1 = rem(hash(`${id}:dy1`), 0.3, 5);
  const dx2 = rem(hash(`${id}:dx2`), 0.3, 5);
  const dy2 = rem(hash(`${id}:dy2`), 0.3, 5);
  const duration = 16 + (hash(`${id}:dur`) % 11);
  const delay = -(hash(`${id}:delay`) % duration);

  return {
    animationDuration: `${duration}s`,
    animationDelay: `${delay}s`,
    "--dx1": `${dx1}rem`,
    "--dy1": `${dy1}rem`,
    "--dx2": `${dx2}rem`,
    "--dy2": `${dy2}rem`,
  } as CSSProperties;
}

// Die Ampel-Ansicht (22.08.2026, löst zuerst den Büroplan mit
// Tischen/Monitoren, dann ein frei treibendes Feld ohne Kollisionsschutz ab):
// jeder Agent bekommt eine eigene Grid-Zelle (`.orb-cell`, mindestens 9rem ×
// 9rem, per `auto-fit` responsiv über die volle Feldbreite/-höhe verteilt) –
// das Bällchen wandert nur INNERHALB dieser Zelle, nie darüber hinaus. Damit
// ist Überlappung zwischen zwei Bällchen (und ein Verschwinden am Feldrand)
// nicht nur unwahrscheinlich, sondern durch das Layout ausgeschlossen: jede
// Zelle ist exklusiv, die Sicherheitsmarge in `driftStyle` bezieht sich auf
// den KREIS (nicht auf den Text darin), also auch dann sicher, wenn der Name
// so lang ist, dass die Schrift selbst schon am Rand kappt. Name, Rolle und
// bei "arbeitet"/"blockiert" der Grund stehen direkt im Bällchen. Drei
// Farben tragen den Zustand – neutral (nichts zu tun), grün-glühend
// (arbeitet), rot-glühend-pulsierend (blockiert). Innerhalb von "neutral"
// bleibt ein Detail erhalten, ohne die Farbe zu verlassen: Ring mit dünner
// Füllung = noch nie etwas getan, matt gefüllt = zuletzt aktiv. "blocked"
// hat Vorrang vor allem anderen, unabhängig davon, ob gerade ein Lauf offen
// ist.
function AgentOfficeView({ agents }: { agents: AgentWorkspaceEntry[] }) {
  return (
    <div className="orb-field">
      {agents.map((agent) => (
        <div key={agent.id} className="orb-cell">
          <AgentOrb agent={agent} />
        </div>
      ))}
    </div>
  );
}

function AgentOrb({ agent }: { agent: AgentWorkspaceEntry }) {
  const state: AgentState =
    agent.status === "BLOCKED"
      ? "blocked"
      : agent.running !== null
        ? "working"
        : agent.last !== null
          ? "idle"
          : "fresh";

  // Bei "arbeitet"/"blockiert" steht der Grund jetzt fest im Bällchen statt
  // nur im Hover-Tooltip.
  const caption = state === "working" ? agent.running!.headline : state === "blocked" ? "wartet auf Klärung" : null;

  return (
    <div
      data-state={state}
      title={
        state === "blocked"
          ? "Blockiert – wartet auf eine Klärung"
          : state === "working"
            ? agent.running!.headline
            : state === "idle"
              ? `zuletzt: ${agent.last!.headline} · ${formatTime(agent.last!.startedAt)}`
              : "noch nichts getan"
      }
      className="orb-bubble"
      style={driftStyle(agent.id)}
    >
      <div className="orb-bubble-face flex h-full w-full flex-col items-center justify-center gap-0.5 rounded-full px-2 text-center">
        <span className="orb-bubble-name w-full truncate text-[0.8rem] font-semibold leading-tight">
          {agent.name}
        </span>
        <span className="orb-bubble-role w-full truncate text-[0.6rem] leading-tight">
          {AGENT_ROLE_LABEL[agent.role]}
        </span>
        {caption && (
          <span className="orb-bubble-caption line-clamp-2 w-full text-[0.55rem] leading-tight">{caption}</span>
        )}
      </div>
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
