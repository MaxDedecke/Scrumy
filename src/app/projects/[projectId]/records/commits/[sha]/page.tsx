import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { gitShow } from "@/lib/workspace";
import { PageHeader } from "@/components/PageHeader";
import { Section } from "@/components/Section";
import { pageClass } from "@/lib/ui";

// Ein Commit im Wortlaut: Commit-Message des Agenten plus vollständiger Diff.
// Zusammen mit dem zugehörigen Agentenlauf (Prompt/Antwort) ergibt das die
// lückenlose Kette vom Auftrag bis zur geänderten Zeile.
export const dynamic = "force-dynamic";

export default async function CommitPage({
  params,
}: {
  params: Promise<{ projectId: string; sha: string }>;
}) {
  const { projectId, sha } = await params;

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: { organization: true },
  });
  if (!project?.workspacePath) notFound();

  let diff: string;
  try {
    diff = await gitShow(project.workspacePath, sha);
  } catch {
    notFound();
  }

  return (
    <main className={pageClass}>
      <PageHeader
        backHref={`/projects/${projectId}/records`}
        backLabel="Nachweise"
        context={project.organization.name}
        title={`Commit ${sha.slice(0, 8)}`}
        description={`Im Repository ${project.workspacePath}`}
      />

      <Section title="Änderung" className="mb-0">
        <pre className="card overflow-x-auto p-5 font-mono text-xs leading-relaxed text-ink-2">{diff}</pre>
      </Section>
    </main>
  );
}
