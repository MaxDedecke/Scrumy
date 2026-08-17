import { notFound } from "next/navigation";
import { headers } from "next/headers";
import { prisma } from "@/lib/prisma";
import { getPreviewInfo } from "@/lib/preview";
import { startPreviewAction, stopPreviewAction } from "@/lib/actions/preview";
import { PREVIEW_STATUS_LABEL, PREVIEW_STATUS_PILL } from "@/lib/labels";
import { Panel } from "@/components/Panel";
import { ActionForm } from "@/components/ActionForm";
import { IconSubmit } from "@/components/IconSubmit";
import { PlayIcon, StopIcon } from "@/components/icons";
import { PreviewFrame } from "@/components/PreviewFrame";

// Zeigt das Frontend, das das Team im Projekt-Repo gebaut hat, live in einem
// iframe – siehe src/lib/preview.ts für die Erkennung/den Prozessstart.
//
// Bewusst kein eigener Polling-Client: Diese Seite läuft unter dem globalen
// <LiveRefresh> im Projekt-Layout (6s-Takt, siehe dort), das reicht, um von
// „startet gerade" zu „läuft" zu wechseln, sobald der Dev-Server oben ist.
export const dynamic = "force-dynamic";

export default async function ProjectPreviewPage({
  params,
}: PageProps<"/projects/[projectId]/preview">) {
  const { projectId } = await params;

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { workspacePath: true },
  });
  if (!project) notFound();

  const info = await getPreviewInfo(projectId);

  // Die Vorschau läuft auf einem echten, ueber docker-compose veroeffentlichten
  // Port (siehe preview.ts) – dasselbe Hostname wie fuer Scrumy selbst, nur mit
  // anderem Port, funktioniert deshalb ohne Pfad-Proxy und ohne CORS-Sonderfall.
  const hostname = ((await headers()).get("host") ?? "localhost").split(":")[0];
  const previewUrl = info.status === "RUNNING" && info.port ? `http://${hostname}:${info.port}/` : null;

  return (
    <Panel
      title="Vorschau"
      className="flex-1"
      padded={false}
      scroll={false}
      action={
        <>
          <span className={`${PREVIEW_STATUS_PILL[info.status]} pill-dot`}>
            {PREVIEW_STATUS_LABEL[info.status]}
          </span>
          {info.status === "RUNNING" || info.status === "STARTING" ? (
            <ActionForm action={stopPreviewAction}>
              <input type="hidden" name="projectId" value={projectId} />
              <IconSubmit title="Vorschau stoppen">
                <StopIcon className="h-3.5 w-3.5" />
              </IconSubmit>
            </ActionForm>
          ) : (
            <ActionForm action={startPreviewAction}>
              <input type="hidden" name="projectId" value={projectId} />
              <IconSubmit title="Vorschau starten">
                <PlayIcon className="h-3.5 w-3.5" />
              </IconSubmit>
            </ActionForm>
          )}
        </>
      }
    >
      {!project.workspacePath ? (
        <p className="flex flex-1 items-center justify-center px-6 py-6 text-center text-sm text-ink-3">
          Das Team hat noch kein Repository angelegt – erst das Team starten, dann gibt es hier etwas zu zeigen.
        </p>
      ) : previewUrl ? (
        <PreviewFrame url={previewUrl} />
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-6 text-center">
          <p className="max-w-md text-sm text-ink-3">
            {info.status === "STARTING"
              ? `Vorschau startet${info.command ? ` (${info.command})` : ""} – das kann beim ersten Mal (npm install) etwas dauern …`
              : info.status === "ERROR"
                ? (info.error ?? "Die Vorschau konnte nicht gestartet werden.")
                : "Noch keine Vorschau gestartet. Ein Klick auf ▶ oben sucht ein Frontend im Repository und startet es."}
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
