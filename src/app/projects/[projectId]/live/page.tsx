import { notFound } from "next/navigation";
import { headers } from "next/headers";
import { prisma } from "@/lib/prisma";
import { getLiveStackInfo } from "@/lib/liveStack";
import { startLiveAction, stopLiveAction } from "@/lib/actions/live";
import { LIVE_STATUS_LABEL, LIVE_STATUS_PILL } from "@/lib/labels";
import { Panel } from "@/components/Panel";
import { ActionForm } from "@/components/ActionForm";
import { IconSubmit } from "@/components/IconSubmit";
import { PlayIcon, StopIcon } from "@/components/icons";
import { LiveStackRedirect } from "@/components/LiveStackRedirect";

// Der Tab, den der "Anwendung starten"-Knopf im Projektkopf (siehe
// LiveAppControls) IMMER neu öffnet – unabhängig davon, ob der Stack schon
// läuft oder gerade erst gestartet wird. Solange er noch nicht erreichbar
// ist, zeigt diese Seite Fortschritt/Log; sobald er es ist, wird der Tab per
// <LiveStackRedirect> zur echten, voll durchklickbaren Anwendung (inkl.
// Backend/DB) – NICHT eingebettet wie die Vorschau (src/lib/preview.ts,
// PreviewFrame.tsx), weil generierte Frontends Assets fast immer absolut
// verlinken und ein iframe dafür ohnehin keinen Mehrwert hätte.
//
// Kein eigener Polling-Client: läuft wie preview/page.tsx unter dem globalen
// <LiveRefresh> im Projekt-Layout (6s-Takt).
export const dynamic = "force-dynamic";

export default async function ProjectLivePage({
  params,
}: PageProps<"/projects/[projectId]/live">) {
  const { projectId } = await params;

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { workspacePath: true },
  });
  if (!project) notFound();

  const info = await getLiveStackInfo(projectId);

  // Wie previewUrl in preview/page.tsx: derselbe Hostname wie Scrumy selbst,
  // nur mit dem vom Kunden-Compose-Stack veröffentlichten Port.
  const hostname = ((await headers()).get("host") ?? "localhost").split(":")[0];
  const liveUrl = info.status === "RUNNING" && info.port ? `http://${hostname}:${info.port}/` : null;

  return (
    <Panel
      title="Anwendung"
      className="flex-1"
      action={
        <>
          <span className={`${LIVE_STATUS_PILL[info.status]} pill-dot`}>{LIVE_STATUS_LABEL[info.status]}</span>
          {info.status === "RUNNING" || info.status === "STARTING" ? (
            <ActionForm action={stopLiveAction}>
              <input type="hidden" name="projectId" value={projectId} />
              <IconSubmit title="Anwendung beenden">
                <StopIcon className="h-3.5 w-3.5" />
              </IconSubmit>
            </ActionForm>
          ) : (
            <ActionForm action={startLiveAction}>
              <input type="hidden" name="projectId" value={projectId} />
              <IconSubmit title="Anwendung starten">
                <PlayIcon className="h-3.5 w-3.5" />
              </IconSubmit>
            </ActionForm>
          )}
        </>
      }
    >
      {!project.workspacePath ? (
        <p className="flex flex-1 items-center justify-center px-6 py-6 text-center text-sm text-ink-3">
          Das Team hat noch kein Repository angelegt – erst das Team starten, dann gibt es hier etwas zu testen.
        </p>
      ) : liveUrl ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-6 text-center">
          <LiveStackRedirect url={liveUrl} />
          <p className="max-w-md text-sm text-ink-3">
            Anwendung ist erreichbar – dieser Tab wechselt automatisch dorthin.
          </p>
          <a href={liveUrl} className="quiet-link text-sm font-medium">
            Falls nicht: Anwendung öffnen →
          </a>
        </div>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-6 text-center">
          <p className="max-w-md text-sm text-ink-3">
            {info.status === "STARTING"
              ? "Anwendung startet – der volle Docker-Compose-Stack (Frontend, Backend, Datenbank) wird gebaut. Das kann beim ersten Mal einige Minuten dauern …"
              : info.status === "ERROR"
                ? (info.error ?? "Die Anwendung konnte nicht gestartet werden.")
                : "Noch keine Anwendung gestartet. Ein Klick auf ▶ oben baut den vollen Stack aus dem Repository und startet ihn."}
          </p>
          {info.log && (
            <pre className="max-h-64 w-full max-w-2xl overflow-auto rounded-lg border border-hairline bg-surface-2/60 p-3 text-left text-xs text-ink-3">
              {info.log}
            </pre>
          )}
        </div>
      )}
    </Panel>
  );
}
