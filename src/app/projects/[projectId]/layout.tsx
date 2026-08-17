import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { PROJECT_STATUS_LABEL, PROJECT_STATUS_PILL } from "@/lib/labels";
import { LiveRefresh } from "@/components/LiveRefresh";
import { PageHeader } from "@/components/PageHeader";
import { ProjectTabs } from "@/components/ProjectTabs";
import { TeamControls } from "@/components/TeamControls";
import { ExternalLinkIcon, InboxIcon } from "@/components/icons";
import { iconButtonClass, pageFixedClass } from "@/lib/ui";

// Gemeinsamer Rahmen aller Projekt-Tabs: Kopfzeile, Team-Steuerung und
// Tab-Leiste stehen hier ein einziges Mal, statt auf jeder der fünf Seiten
// erneut.
//
// Zwei Dinge folgen daraus:
//  * Die Steuerung des Teams (Pause/Weiter/Anstoßen/Autopilot) ist auf jedem
//    Tab erreichbar, nicht nur im Büro.
//  * Der Rahmen ist ab lg genau fensterhoch und gibt den Rest der Höhe an die
//    Seite weiter (`min-h-0 flex-1`). Erst dadurch können die Panels der Tabs
//    ihren Inhalt selbst scrollen, statt die Seite wachsen zu lassen.
export const dynamic = "force-dynamic";

export default async function ProjectLayout({
  children,
  params,
}: LayoutProps<"/projects/[projectId]">) {
  const { projectId } = await params;

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      id: true,
      name: true,
      status: true,
      autopilot: true,
      repoUrl: true,
      organizationId: true,
      organization: { select: { name: true } },
    },
  });
  if (!project) notFound();

  return (
    <main className={pageFixedClass}>
      <PageHeader
        className="mb-5"
        backHref="/"
        backLabel="Kunden"
        context={project.organization.name}
        title={project.name}
        status={
          <span className={`${PROJECT_STATUS_PILL[project.status]} pill-dot`}>
            {PROJECT_STATUS_LABEL[project.status]}
          </span>
        }
        actions={
          <>
            <TeamControls
              projectId={project.id}
              status={project.status}
              autopilot={project.autopilot}
            />
            <Link
              href={`/organizations/${project.organizationId}/inbox`}
              title="Support-Postfach des Kunden"
              aria-label="Support-Postfach des Kunden"
              className={iconButtonClass}
            >
              <InboxIcon className="h-4 w-4" />
            </Link>
            {project.repoUrl && (
              <a
                href={project.repoUrl}
                target="_blank"
                rel="noreferrer"
                title="Repository des Kunden öffnen"
                aria-label="Repository des Kunden öffnen"
                className={iconButtonClass}
              >
                <ExternalLinkIcon className="h-4 w-4" />
              </a>
            )}
            <LiveRefresh />
          </>
        }
      />

      <ProjectTabs projectId={project.id} className="mb-5" />

      {/* `lg:min-h-0` gibt die Höhenschranke nur dort weiter, wo die Panels
          nebeneinander stehen – darunter wächst die Seite wie gewohnt. */}
      <div className="flex flex-1 flex-col lg:min-h-0">{children}</div>
    </main>
  );
}
