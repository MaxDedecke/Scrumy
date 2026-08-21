import { notFound } from "next/navigation";
import { headers } from "next/headers";
import { prisma } from "@/lib/prisma";
import { getLiveStackInfo } from "@/lib/liveStack";
import { LiveBoot } from "@/components/LiveBoot";

// Der Tab, den der "Anwendung starten"-Knopf im Projektkopf (siehe
// LiveAppControls) IMMER neu öffnet – unabhängig davon, ob der Stack schon
// läuft oder gerade erst gestartet wird.
//
// Bewusst AUSSERHALB von /projects/[projectId] (eigene Top-Level-Route statt
// .../live) und damit ausserhalb von dessen Layout (Kopfzeile, Tab-Leiste) –
// UND per AppShell (siehe src/components/AppShell.tsx) auch ausserhalb der
// globalen Sidebar/Suchleiste. Der Moment, in dem die eigene Anwendung
// hochfaehrt, soll sich wie eine Konsole anfuehlen, nicht wie eine weitere
// App-Seite mit einer Karte drin.
//
// Solange die Anwendung noch nicht erreichbar ist, zeigt <LiveBoot> das
// Docker-Compose-Log als fensterfuellenden Boot-Screen; sobald sie es ist,
// blendet dieselbe Komponente auf die echte, voll durchklickbare Anwendung
// (inkl. Backend/DB) über – NICHT eingebettet wie die Vorschau (src/lib/
// preview.ts, PreviewFrame.tsx), weil generierte Frontends Assets fast immer
// absolut verlinken und ein iframe hier ohnehin nicht die Zielumgebung wäre,
// in der ein Auftraggeber die App am Ende benutzt.
//
// Kein eigener Polling-Client: <LiveBoot> pollt sich selbst per
// `router.refresh()`, solange der Stack noch hochfährt (siehe dort).
export const dynamic = "force-dynamic";

export default async function LiveBootPage({ params }: PageProps<"/live/[projectId]">) {
  const { projectId } = await params;

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { name: true, workspacePath: true },
  });
  if (!project) notFound();

  const info = await getLiveStackInfo(projectId);

  // Wie previewUrl in preview/page.tsx: derselbe Hostname wie Scrumy selbst,
  // nur mit dem vom Kunden-Compose-Stack veröffentlichten Port.
  const hostname = ((await headers()).get("host") ?? "localhost").split(":")[0];
  const liveUrl = info.status === "RUNNING" && info.port ? `http://${hostname}:${info.port}/` : null;

  return (
    <LiveBoot
      projectId={projectId}
      projectName={project.name}
      hasWorkspace={project.workspacePath !== null}
      status={info.status}
      log={info.log}
      error={info.error}
      startedAt={info.startedAt ? info.startedAt.toISOString() : null}
      liveUrl={liveUrl}
    />
  );
}
