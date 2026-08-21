import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { LIVE_STATUS_LABEL, LIVE_STATUS_PILL, PROJECT_STATUS_LABEL, PROJECT_STATUS_PILL } from "@/lib/labels";
import { getOtherLiveProject } from "@/lib/liveStack";
import { LiveAppControls } from "@/components/LiveAppControls";
import { LiveRefresh } from "@/components/LiveRefresh";
import { PageHeader } from "@/components/PageHeader";
import { ProjectTabs } from "@/components/ProjectTabs";
import { TeamControls } from "@/components/TeamControls";
import { ExternalLinkIcon, InboxIcon, SpinnerIcon } from "@/components/icons";
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

  // Läuft parallel zum Projekt-Fetch: die Kopfzeile ist auf jedem Tab
  // sichtbar, der "Team arbeitet"-Spinner also unabhängig davon, welche
  // Unterseite gerade offen ist (siehe office/page.tsx für die Details).
  // Die offenen Klärungen kommen aus demselben Grund hier statt im Büro-Tab
  // rein: der Statustext daneben soll tab-übergreifend sichtbar sein.
  const [project, runningCount, openClarifications] = await Promise.all([
    prisma.project.findUnique({
      where: { id: projectId },
      select: {
        id: true,
        name: true,
        status: true,
        autopilot: true,
        repoUrl: true,
        organizationId: true,
        organization: { select: { name: true } },
        liveStatus: true,
      },
    }),
    prisma.agentRun.count({ where: { projectId, status: "RUNNING" } }),
    prisma.clarification.findMany({ where: { projectId, status: "OPEN" }, select: { scope: true } }),
  ]);
  if (!project) notFound();

  // Nur ein Projekt gleichzeitig live – fuer die deaktivierte Play-Taste bei
  // allen ANDEREN Projekten, siehe LiveAppControls.
  const otherLiveProject = await getOtherLiveProject(project.id);

  // Früher eine eigene Textkarte oben im Büro-Tab ("PanelStrip") – nahm dort
  // Platz weg, der den Karten fehlte. Jetzt eine knappe, tab-übergreifende
  // Kurzfassung direkt im Seitenkopf; die volle Formulierung steht als
  // Tooltip (title) dahinter.
  const blockingClarification = openClarifications.some((entry) => entry.scope === "PROJECT");
  const statusMessage = blockingClarification
    ? {
        text: "Wartet auf deine Entscheidung",
        title:
          "Das Team wartet auf deine Entscheidung. Solange die Grundsatzfrage offen ist, nimmt niemand einen neuen Schritt an.",
      }
    : openClarifications.length > 0
      ? {
          text: `${openClarifications.length} Klärung${openClarifications.length === 1 ? "" : "en"} offen`,
          title: `${openClarifications.length} Klärung${openClarifications.length === 1 ? "" : "en"} offen – die betroffenen Tickets liegen, der Rest läuft weiter.`,
        }
      : project.status === "PAUSED" || runningCount > 0
        ? null
        : project.autopilot
          ? {
              text: "Nächster Schritt automatisch",
              title: "Niemand arbeitet gerade. Der nächste Schritt kommt automatisch.",
            }
          : {
              text: "Autopilot aus",
              title: "Autopilot ist aus – das Team wartet auf den nächsten Anstoß.",
            };

  return (
    <main className={pageFixedClass}>
      <PageHeader
        className="mb-5"
        backHref="/"
        backLabel={project.organization.name}
        title={project.name}
        status={
          <>
            {/* Ersetzt die frühere Textkarte "Das Team arbeitet gerade." im
                Büro-Tab: der Zustand ist tab-übergreifend relevant, deshalb
                hier direkt neben dem Namen statt als eigener Panel-Streifen. */}
            {runningCount > 0 && (
              <span
                role="status"
                title={`Team arbeitet – ${runningCount} laufende${runningCount === 1 ? "r Schritt" : " Schritte"}`}
                aria-label={`Team arbeitet – ${runningCount} laufende${runningCount === 1 ? "r Schritt" : " Schritte"}`}
                className="inline-flex shrink-0"
              >
                <SpinnerIcon className="h-4 w-4 text-good motion-safe:animate-spin" />
              </span>
            )}
            {statusMessage && (
              <span title={statusMessage.title} className="shrink-0 truncate text-xs text-ink-3">
                {statusMessage.text}
              </span>
            )}
            {/* Aktiv/Pausiert nicht mehr als eigene Pille: ein Projekt ist
                standardmäßig aktiv, das Play/Pause-Icon in TeamControls
                zeigt den abweichenden Zustand bereits an. Discovery/Konzept/
                Archiviert bleiben sichtbar, das sind echte Phasen. */}
            {project.status !== "ACTIVE" && project.status !== "PAUSED" && (
              <span className={`${PROJECT_STATUS_PILL[project.status]} pill-dot`}>
                {PROJECT_STATUS_LABEL[project.status]}
              </span>
            )}
            {(project.liveStatus === "RUNNING" || project.liveStatus === "STARTING") && (
              <span className={`${LIVE_STATUS_PILL[project.liveStatus]} pill-dot`}>
                {LIVE_STATUS_LABEL[project.liveStatus]}
              </span>
            )}
          </>
        }
        actions={
          <>
            <LiveAppControls
              projectId={project.id}
              liveStatus={project.liveStatus}
              blockedBy={otherLiveProject}
            />
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
