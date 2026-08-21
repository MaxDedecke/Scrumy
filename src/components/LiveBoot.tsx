"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ActionForm } from "@/components/ActionForm";
import { IconSubmit } from "@/components/IconSubmit";
import { ReportBugForm } from "@/components/ReportBugForm";
import { ArrowLeftIcon, CheckIcon, PlayIcon, StopIcon } from "@/components/icons";
import { startLiveAction, stopLiveAction } from "@/lib/actions/live";
import { buttonPrimaryClass, iconButtonClass } from "@/lib/ui";
import type { PreviewStatus } from "@/generated/prisma/client";

// Der fensterfuellende Boot-Screen der Live-Anwendung (siehe Kopfkommentar
// von .../live/[projectId]/page.tsx fuers "Warum" der eigenen Route).
//
// Vier Zustaende, ein Screen:
//  * kein Repository        -> Hinweis, zurueck zum Projekt
//  * STOPPED                -> Terminal-Prompt zum manuellen Start (Regelfall
//                               ist der Start ueber LiveAppControls, das
//                               diesen Tab bereits gestartet startet – das hier
//                               ist der Nachzuegler-/Wiederholungs-Pfad)
//  * STARTING                -> das echte docker-compose-Log als Boot-Log
//  * RUNNING                 -> kurzer Erfolgsmoment, dann Fade-out und
//                               Weiterleitung auf die echte Anwendung
//  * ERROR                   -> Log + "Bug melden" (siehe ReportBugForm)
//
// Der Uebergang von STARTING zu RUNNING ist die eigentliche Idee dieser
// Komponente: statt abrupt wegzuspringen (frueher `location.replace` sofort
// nach dem ersten "RUNNING"), faedet der Terminal weg, bevor navigiert wird –
// das Hochfahren der eigenen Anwendung wird zu einem Moment statt einem
// Redirect. Kein Iframe-Crossfade: siehe page.tsx-Kommentar, dieselbe
// Begruendung wie gegen eine eingebettete Vorschau.
export function LiveBoot({
  projectId,
  projectName,
  hasWorkspace,
  status,
  log,
  error,
  startedAt,
  liveUrl,
}: {
  projectId: string;
  projectName: string;
  hasWorkspace: boolean;
  status: PreviewStatus;
  log: string;
  error: string | null;
  startedAt: string | null;
  liveUrl: string | null;
}) {
  const router = useRouter();
  const [leaving, setLeaving] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const ready = status === "RUNNING" && liveUrl !== null;
  const logRef = useRef<HTMLPreElement>(null);

  // Ein <pre> scrollt bei neuem Inhalt nicht von selbst mit – ohne das hier
  // bliebe der sichtbare Ausschnitt beim ersten Poll stehen, waehrend das
  // eigentliche Log laengst weitergelaufen ist.
  useEffect(() => {
    const node = logRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [log, ready]);

  // Pollt sich selbst nach, solange der Stack hochfaehrt – wie <LiveRefresh>,
  // aber lokal und schneller (2s statt 6s): das Bauen dauert selbst Minuten,
  // ein knapperer Takt macht den Log-Tail lebendiger, ohne die Seite zu
  // ueberlasten (ein Read der Log-Datei + "docker compose ps").
  useEffect(() => {
    if (status !== "STARTING") return;
    const timer = setInterval(() => router.refresh(), 2000);
    return () => clearInterval(timer);
  }, [status, router]);

  // Sekundenzaehler seit Start – rein kosmetisch, aus `startedAt` statt einem
  // serverseitig mitgezaehlten Wert, damit er auch zwischen zwei Polls weiterläuft.
  useEffect(() => {
    if (!startedAt || status !== "STARTING") return;
    const start = new Date(startedAt).getTime();
    const tick = () => setElapsed(Math.max(0, Math.round((Date.now() - start) / 1000)));
    tick();
    const timer = setInterval(tick, 500);
    return () => clearInterval(timer);
  }, [startedAt, status]);

  // Der eigentliche Reveal: sobald die Anwendung erreichbar ist (`ready`,
  // aus den Props abgeleitet), erst kurz "bereit" zeigen, dann wegfaden, dann
  // erst navigieren – bewusst zwei Schritte (ready -> leaving) statt sofort
  // zu faden, damit der Erfolg selbst kurz sichtbar ist, bevor der Screen
  // dunkel wird.
  useEffect(() => {
    if (!ready || leaving) return;
    const toLeaving = setTimeout(() => setLeaving(true), 650);
    return () => clearTimeout(toLeaving);
  }, [ready, leaving]);

  useEffect(() => {
    if (!leaving || !liveUrl) return;
    const timer = setTimeout(() => window.location.replace(liveUrl), 700);
    return () => clearTimeout(timer);
  }, [leaving, liveUrl]);

  const backLink = (
    <Link
      href={`/projects/${projectId}`}
      className="quiet-link inline-flex items-center gap-1.5 text-xs font-medium"
    >
      <ArrowLeftIcon className="h-3.5 w-3.5" />
      Zurück zu {projectName}
    </Link>
  );

  if (!hasWorkspace) {
    return (
      <div className="live-boot flex h-dvh flex-col items-center justify-center gap-4 px-6 text-center">
        <p className="max-w-md text-sm text-ink-3">
          Das Team hat noch kein Repository angelegt – erst das Team starten, dann gibt es hier etwas zu testen.
        </p>
        {backLink}
      </div>
    );
  }

  return (
    <div className={`live-boot flex h-dvh flex-col ${leaving ? "live-boot-fade-out" : ""}`}>
      <div className="flex shrink-0 items-center justify-between px-6 py-5">
        {backLink}
        <div className="flex items-center gap-3 text-xs text-ink-3">
          {status === "STARTING" && (
            <span className="tabular-nums">{formatElapsed(elapsed)}</span>
          )}
          {(status === "STARTING" || status === "RUNNING") && (
            <ActionForm action={stopLiveAction}>
              <input type="hidden" name="projectId" value={projectId} />
              <IconSubmit title="Anwendung abbrechen" className={iconButtonClass}>
                <StopIcon className="h-3.5 w-3.5" />
              </IconSubmit>
            </ActionForm>
          )}
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-6 pb-10">
        <div className="live-terminal flex w-full max-w-3xl flex-col">
          <div className="flex shrink-0 items-center gap-2 border-b border-hairline-strong px-4 py-3">
            <span className={`h-2 w-2 rounded-full ${dotClass(status, ready)}`} aria-hidden />
            <span className="font-mono text-xs text-ink-3">{headline(status, projectName, ready)}</span>
          </div>

          <pre
            ref={logRef}
            className="live-terminal-log min-h-40 flex-1 overflow-auto px-4 py-3 font-mono text-xs leading-relaxed text-ink-2"
          >
            {log || (status === "STOPPED" ? "$ bereit zum Start" : "Warte auf die ersten Zeilen …")}
            {ready && "\n✓ Anwendung bereit."}
            {!ready && status !== "ERROR" && (
              <span className="live-cursor" aria-hidden>
                ▌
              </span>
            )}
          </pre>
        </div>

        {status === "STOPPED" && (
          <ActionForm action={startLiveAction} className="mt-6">
            <input type="hidden" name="projectId" value={projectId} />
            <IconSubmit title="Anwendung starten" className={buttonPrimaryClass}>
              <PlayIcon className="h-4 w-4" />
              Anwendung starten
            </IconSubmit>
          </ActionForm>
        )}

        {status === "ERROR" && (
          <div className="mt-6 flex w-full max-w-3xl flex-col items-center gap-3">
            <ReportBugForm
              projectId={projectId}
              source="live"
              diagnostics={[error, log].filter(Boolean).join("\n\n")}
            />
            <ActionForm action={startLiveAction}>
              <input type="hidden" name="projectId" value={projectId} />
              <IconSubmit title="Erneut versuchen" className={buttonPrimaryClass}>
                <PlayIcon className="h-4 w-4" />
                Erneut versuchen
              </IconSubmit>
            </ActionForm>
          </div>
        )}

        {ready && liveUrl && (
          <a href={liveUrl} className="quiet-link mt-6 text-sm font-medium">
            Falls es nicht automatisch weitergeht: Anwendung öffnen
            <CheckIcon className="ml-1.5 inline h-3.5 w-3.5" />
          </a>
        )}
      </div>
    </div>
  );
}

function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function dotClass(status: PreviewStatus, ready: boolean): string {
  if (ready) return "bg-good animate-pulse";
  if (status === "ERROR") return "bg-critical";
  if (status === "STARTING") return "bg-info animate-pulse";
  return "bg-ink-4";
}

function headline(status: PreviewStatus, projectName: string, ready: boolean): string {
  if (ready) return `${projectName} ist bereit`;
  if (status === "ERROR") return "Start fehlgeschlagen";
  if (status === "STARTING") return `${projectName} fährt hoch …`;
  return `${projectName} — Live-Konsole`;
}
