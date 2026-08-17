import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { gitShow } from "@/lib/workspace";
import { Panel, PanelGrid } from "@/components/Panel";

// Ein Commit im Wortlaut: Commit-Message des Agenten plus vollständiger Diff.
// Zusammen mit dem zugehörigen Agentenlauf (Prompt/Antwort) ergibt das die
// lückenlose Kette vom Auftrag bis zur geänderten Zeile.
export const dynamic = "force-dynamic";

export default async function CommitPage({
  params,
}: PageProps<"/projects/[projectId]/records/commits/[sha]">) {
  const { projectId, sha } = await params;

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { workspacePath: true },
  });
  if (!project?.workspacePath) notFound();

  let diff: string;
  try {
    diff = await gitShow(project.workspacePath, sha);
  } catch {
    notFound();
  }

  return (
    <PanelGrid className="lg:grid-cols-1">
      <Panel
        title={`Commit ${sha.slice(0, 8)}`}
        padded={false}
        action={
          <Link href={`/projects/${projectId}/records`} className="quiet-link font-medium">
            ← Nachweise
          </Link>
        }
      >
        <pre className="overflow-x-auto p-4 font-mono text-xs leading-relaxed text-ink-2">{diff}</pre>
      </Panel>
    </PanelGrid>
  );
}
