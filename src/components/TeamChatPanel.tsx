"use client";

import { useEffect, useRef } from "react";
import type { InquiryStatus } from "@/generated/prisma/client";
import { INQUIRY_STATUS_LABEL } from "@/lib/labels";
import { ActionForm } from "@/components/ActionForm";
import { IconSubmit } from "@/components/IconSubmit";
import { AgentResponse } from "@/components/AgentResponse";
import { Panel, PanelEmpty } from "@/components/Panel";
import { SendIcon } from "@/components/icons";
import { askTeam } from "@/lib/actions/team";
import { iconButtonClass, inputClass } from "@/lib/ui";

export type TeamInquiryEntry = {
  id: string;
  question: string;
  answer: string | null;
  status: InquiryStatus;
  createdAt: Date;
  answeredByName: string | null;
};

// Rückfragen ans Team, jetzt als eigene Chat-Karte statt eingebettet im
// Büroplan: Frage rechts (der Auftraggeber schreibt), Antwort links (das
// Team antwortet) – wie ein gewöhnlicher Chatverlauf, chronologisch von oben
// nach unten. Scrollt beim Laden automatisch ans Ende, damit die jüngste
// Nachricht sichtbar ist, ohne erst hinunterscrollen zu müssen.
export function TeamChatPanel({
  projectId,
  inquiries,
  className,
}: {
  projectId: string;
  inquiries: TeamInquiryEntry[];
  className?: string;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const ordered = [...inquiries].reverse();

  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [inquiries.length]);

  const latest = inquiries[0];

  return (
    <Panel
      title="Rückfragen ans Team"
      count={inquiries.length}
      padded={false}
      scroll={false}
      className={className}
      collapsible
      collapsedView={
        <p className="line-clamp-2 px-4 py-3 text-sm text-ink-2">
          {latest ? latest.question : "Noch keine Rückfrage gestellt."}
        </p>
      }
      footer={
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
      }
    >
      <div ref={scrollRef} className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto p-4">
        {ordered.length === 0 ? (
          <PanelEmpty>Noch keine Rückfrage gestellt – frag direkt unten.</PanelEmpty>
        ) : (
          ordered.map((inquiry) => (
            <div key={inquiry.id} className="flex flex-col gap-1.5">
              <div className="max-w-[88%] self-end">
                <p className="text-sm text-ink">{inquiry.question}</p>
                <p className="mt-1 text-[11px] text-ink-3">{formatTime(inquiry.createdAt)}</p>
              </div>
              {inquiry.answer ? (
                <div className="max-w-[88%] self-start">
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
    </Panel>
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
