"use client";

import { useRef, useState, type ReactNode } from "react";
import type { Priority, ReviewDecision, TicketStatus, TicketType } from "@/generated/prisma/client";
import {
  PRIORITY_LABEL,
  PRIORITY_PILL,
  REVIEW_DECISION_LABEL,
  REVIEW_DECISION_PILL,
  TICKET_STATUS_LABEL,
  TICKET_TYPE_LABEL,
} from "@/lib/labels";
import { Panel } from "@/components/Panel";
import { WarningIcon } from "@/components/icons";

export type BoardTicket = {
  id: string;
  title: string;
  description: string | null;
  plan: string | null;
  result: string | null;
  estimate: number | null;
  type: TicketType;
  status: TicketStatus;
  priority: Priority;
  requestedBy: string | null;
  isCritical: boolean;
  externalRef: string | null;
  createdAt: Date;
  updatedAt: Date;
  assignee: { id: string; name: string } | null;
  sprint: { number: number } | null;
  /// Tickets, die vor diesem hier fertig sein muessen (siehe
  /// worker/tasks/sprintPlanning.ts, "dependsOn"). Erst wenn alle hier DONE
  /// sind, zieht das Team dieses Ticket – siehe worker/orchestration.ts.
  blockedBy: { id: string; title: string; status: TicketStatus }[];
  /// Frontend-Ticket, das wartet, weil im selben Sprint noch Backend-Arbeit
  /// offen ist (siehe worker/clarification.ts#backendGatedTicketIds) – anders
  /// als `blockedBy` keine explizite Verknüpfung, sondern das feste Prinzip
  /// „Backend vor Frontend".
  backendGated: boolean;
  reviews: {
    id: string;
    reviewerName: string;
    decision: ReviewDecision;
    comment: string | null;
    createdAt: Date;
    decidedAt: Date | null;
  }[];
};

// Kanban-Board mit Detail-Dialog: die Karte bleibt knapp (Beschreibung mit
// `line-clamp-2`, sonst würde ein einziges langes Ticket die Spalte sprengen),
// ein Klick öffnet aber IMMER den vollen, ungekürzten Text – Titel, Plan,
// Ergebnis und Reviews landen sonst nirgends in der Oberfläche, nur im
// Datenbank-Feld.
export function TicketBoardPanel({
  ticketsByStatus,
  action,
}: {
  ticketsByStatus: { status: TicketStatus; tickets: BoardTicket[] }[];
  action?: ReactNode;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [selected, setSelected] = useState<BoardTicket | null>(null);

  function openTicket(ticket: BoardTicket) {
    setSelected(ticket);
    dialogRef.current?.showModal();
  }

  return (
    <Panel title="Scrum-Board" className="card-ghost lg:col-span-2" scroll={false} padded={false} action={action}>
      {/* Jede Statusspalte scrollt für sich: Ein volles „Erledigt" schiebt
          damit nie das „Zu tun" aus dem Bild. */}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 p-3 sm:grid-cols-2 lg:grid-cols-4">
        {ticketsByStatus.map(({ status, tickets }) => (
          <div key={status} className="flex min-h-0 flex-col rounded-lg border border-hairline bg-surface-2/40">
            <div className="flex h-9 shrink-0 items-center justify-between px-3">
              <h3 className="text-xs font-medium text-ink-2">{TICKET_STATUS_LABEL[status]}</h3>
              <span className="text-[11px] tabular-nums text-ink-4">{tickets.length}</span>
            </div>
            <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-2 pb-2">
              {tickets.length === 0 && <p className="px-2 py-3 text-center text-xs text-ink-4">Keine Tickets</p>}
              {tickets.map((ticket) => {
                const pendingReview = ticket.reviews.find((r) => r.decision === "PENDING");
                const openBlockers = ticket.blockedBy.filter((b) => b.status !== "DONE");
                return (
                  <button
                    key={ticket.id}
                    type="button"
                    onClick={() => openTicket(ticket)}
                    className="card-interactive card-ghost block w-full p-2.5 text-left"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-xs font-medium leading-snug text-ink">{ticket.title}</p>
                      {ticket.isCritical && (
                        <span title="Kritische Änderung – benötigt menschliches Review" className="shrink-0 text-warning">
                          <WarningIcon className="h-3.5 w-3.5" />
                          <span className="sr-only">Kritische Änderung</span>
                        </span>
                      )}
                    </div>
                    {ticket.description && (
                      <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-ink-3">{ticket.description}</p>
                    )}
                    <div className="mt-2 flex flex-wrap items-center gap-1">
                      <span className="pill pill-neutral">{TICKET_TYPE_LABEL[ticket.type]}</span>
                      <span className={PRIORITY_PILL[ticket.priority]}>{PRIORITY_LABEL[ticket.priority]}</span>
                      {pendingReview && <span className="pill pill-warning pill-dot">Review offen</span>}
                      {openBlockers.length > 0 && (
                        <span
                          className="pill pill-warning pill-dot"
                          title={`Wartet auf: ${openBlockers.map((b) => b.title).join(", ")}`}
                        >
                          Blockiert durch {openBlockers.length}
                        </span>
                      )}
                      {ticket.backendGated && (
                        <span
                          className="pill pill-warning pill-dot"
                          title="Backend-Arbeit im Sprint ist noch nicht fertig – Frontend startet erst danach"
                        >
                          Wartet auf Backend
                        </span>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      <dialog
        ref={dialogRef}
        aria-labelledby="ticket-detail-title"
        onClose={() => setSelected(null)}
        onClick={(event) => {
          if (event.target === event.currentTarget) dialogRef.current?.close();
        }}
        className="m-auto w-[min(40rem,calc(100vw-2rem))] max-h-[85vh] rounded-xl border border-hairline bg-surface p-0 text-ink shadow-2xl shadow-black/60 backdrop:bg-black/60"
      >
        {selected && <TicketDetail ticket={selected} onClose={() => dialogRef.current?.close()} />}
      </dialog>
    </Panel>
  );
}

function TicketDetail({ ticket, onClose }: { ticket: BoardTicket; onClose: () => void }) {
  return (
    <div className="flex max-h-[85vh] flex-col">
      <div className="flex shrink-0 items-start gap-3 border-b border-hairline px-5 py-4">
        <div className="min-w-0 flex-1">
          <h2 id="ticket-detail-title" className="text-base font-semibold leading-snug text-ink">
            {ticket.title}
          </h2>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <span className={`pill ${statusPillClass(ticket.status)}`}>{TICKET_STATUS_LABEL[ticket.status]}</span>
            <span className="pill pill-neutral">{TICKET_TYPE_LABEL[ticket.type]}</span>
            <span className={PRIORITY_PILL[ticket.priority]}>{PRIORITY_LABEL[ticket.priority]}</span>
            {ticket.isCritical && (
              <span className="pill pill-warning">
                <WarningIcon className="h-3 w-3" /> Kritisch – benötigt menschliches Review
              </span>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Ticket-Details schließen"
          className="-mr-1 -mt-1 shrink-0 rounded px-1.5 py-0.5 text-lg leading-none text-ink-4 transition-colors hover:text-ink"
        >
          ×
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
        <DetailField label="Beschreibung" value={ticket.description} />
        {ticket.blockedBy.length > 0 && (
          <div>
            <h3 className="section-title mb-1.5">Abhängigkeiten</h3>
            <ul className="space-y-1">
              {ticket.blockedBy.map((blocker) => (
                <li key={blocker.id} className="flex items-center gap-1.5 text-sm text-ink-2">
                  <span className={`pill ${statusPillClass(blocker.status)}`}>
                    {TICKET_STATUS_LABEL[blocker.status]}
                  </span>
                  {blocker.title}
                </li>
              ))}
            </ul>
          </div>
        )}
        <DetailField label="Umsetzungsplan" value={ticket.plan} />
        <DetailField label="Ergebnis" value={ticket.result} />

        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 border-t border-hairline pt-4 text-xs sm:grid-cols-3">
          <MetaItem label="Zugewiesen an" value={ticket.assignee?.name ?? "—"} />
          <MetaItem label="Sprint" value={ticket.sprint ? `Sprint ${ticket.sprint.number}` : "—"} />
          <MetaItem label="Story Points" value={ticket.estimate != null ? String(ticket.estimate) : "—"} />
          <MetaItem label="Angefragt von" value={ticket.requestedBy ?? "—"} />
          <MetaItem label="Externe Referenz" value={ticket.externalRef ?? "—"} />
          <MetaItem label="Erstellt" value={formatDateTime(ticket.createdAt)} />
          <MetaItem label="Zuletzt geändert" value={formatDateTime(ticket.updatedAt)} />
        </dl>

        {ticket.reviews.length > 0 && (
          <div className="border-t border-hairline pt-4">
            <h3 className="section-title mb-2">Reviews</h3>
            <ul className="space-y-2">
              {ticket.reviews.map((review) => (
                <li key={review.id} className="rounded-lg border border-hairline bg-surface-2/40 p-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-medium text-ink">{review.reviewerName}</span>
                    <span className={REVIEW_DECISION_PILL[review.decision]}>
                      {REVIEW_DECISION_LABEL[review.decision]}
                    </span>
                  </div>
                  {review.comment && (
                    <p className="mt-1.5 whitespace-pre-line break-words text-xs leading-relaxed text-ink-3">
                      {review.comment}
                    </p>
                  )}
                  <p className="mt-1.5 text-[11px] text-ink-4">
                    {review.decidedAt ? `Entschieden am ${formatDateTime(review.decidedAt)}` : `Angefragt am ${formatDateTime(review.createdAt)}`}
                  </p>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

function DetailField({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <div>
      <h3 className="section-title mb-1.5">{label}</h3>
      <p className="whitespace-pre-line break-words text-sm leading-relaxed text-ink-2">{value}</p>
    </div>
  );
}

function MetaItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-ink-4">{label}</dt>
      <dd className="mt-0.5 truncate text-ink-2" title={value}>
        {value}
      </dd>
    </div>
  );
}

function statusPillClass(status: TicketStatus): string {
  switch (status) {
    case "DONE":
      return "pill-good";
    case "IN_REVIEW":
      return "pill-info";
    case "IN_PROGRESS":
      return "pill-warning";
    default:
      return "pill-neutral";
  }
}

function formatDateTime(date: Date): string {
  return date.toLocaleString("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
