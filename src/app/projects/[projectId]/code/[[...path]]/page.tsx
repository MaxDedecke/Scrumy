import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { listTrackedFiles, readRepoFileForViewer, REPO_VIEWER_MAX_BYTES } from "@/lib/workspace";
import { FileTreePanel } from "@/components/FileTreePanel";
import { Panel, PanelEmpty, PanelGrid } from "@/components/Panel";

// Der Dateibaum des entstehenden Repos: links alle Dateien, die das Team
// bereits committet hat, rechts ihr Inhalt – ohne dafür ins Terminal wechseln
// oder ein Repository-Tool öffnen zu müssen. Optionaler Catch-all statt
// eigener Detailseite (vgl. records/commits/[sha]), weil der Pfad selbst die
// Auswahl trägt: ein Linkklick ist eine normale Navigation, kein Client-Fetch.
export const dynamic = "force-dynamic";

export default async function ProjectCodePage({
  params,
}: PageProps<"/projects/[projectId]/code/[[...path]]">) {
  const { projectId, path: pathSegments } = await params;

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { workspacePath: true },
  });
  if (!project) notFound();

  const files = project.workspacePath ? await listTrackedFiles(project.workspacePath) : [];
  const selectedPath = pathSegments?.map(decodeURIComponent).join("/");

  let fileView: Awaited<ReturnType<typeof readRepoFileForViewer>> = null;
  if (selectedPath) {
    fileView = project.workspacePath ? await readRepoFileForViewer(project.workspacePath, selectedPath) : null;
    if (!fileView) notFound();
  }

  return (
    <PanelGrid className="lg:grid-cols-[20rem_minmax(0,1fr)]">
      <Panel title="Dateien" count={files.length} padded={false} scroll={false}>
        {files.length === 0 ? (
          <PanelEmpty>Repository ist noch leer – das Team hat noch nichts committet.</PanelEmpty>
        ) : (
          <FileTreePanel projectId={projectId} files={files} selectedPath={selectedPath} />
        )}
      </Panel>

      <Panel title={selectedPath ?? "Datei"} padded={false} action={fileView && <FileMeta view={fileView} />}>
        {!selectedPath ? (
          <PanelEmpty>Wähle links eine Datei aus, um sie anzuschauen.</PanelEmpty>
        ) : fileView!.binary ? (
          <PanelEmpty>Binärdatei ({formatSize(fileView!.size)}) – keine Textvorschau möglich.</PanelEmpty>
        ) : (
          <>
            <pre className="overflow-x-auto p-4 font-mono text-xs leading-relaxed text-ink-2">
              {fileView!.content}
            </pre>
            {fileView!.truncated && (
              <p className="border-t border-hairline px-4 py-2 text-xs text-ink-4">
                Datei gekürzt – nur die ersten {formatSize(REPO_VIEWER_MAX_BYTES)} von {formatSize(fileView!.size)}{" "}
                werden angezeigt.
              </p>
            )}
          </>
        )}
      </Panel>
    </PanelGrid>
  );
}

function FileMeta({ view }: { view: NonNullable<Awaited<ReturnType<typeof readRepoFileForViewer>>> }) {
  return <span className="text-ink-4">{formatSize(view.size)}</span>;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
