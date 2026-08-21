import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import {
  AGENT_ROLE_LABEL,
  AGENT_STATUS_LABEL,
  AGENT_STATUS_PILL,
  CONNECTOR_PROVIDER_LABEL,
  CONNECTOR_STATUS_LABEL,
  CONNECTOR_STATUS_PILL,
  PROJECT_STATUS_LABEL,
} from "@/lib/labels";
import { ActionForm } from "@/components/ActionForm";
import { AgentConnectorDialog } from "@/components/AgentConnectorDialog";
import { ConfirmButton } from "@/components/ConfirmButton";
import { Panel, PanelEmpty, PanelGrid } from "@/components/Panel";
import { Disclosure, formGridClass } from "@/components/Disclosure";
import { SaveIcon, TrashIcon } from "@/components/icons";
import { createAgentAndAssign, removeAgentAssignment, updateAgentAssignment } from "@/lib/actions/agents";
import { createConnector, deleteConnector, updateConnectorStatus } from "@/lib/actions/connectors";
import { deleteProject, updateProject } from "@/lib/actions/projects";
import {
  buttonDangerClass,
  buttonPrimaryClass,
  buttonSecondaryClass,
  iconButtonPrimaryClass,
  iconButtonSmallDangerClass,
  inputClass,
  labelClass,
} from "@/lib/ui";
import type { AgentRole, AgentStatus, ConnectorProvider } from "@/generated/prisma/client";

// Alles, was am Projekt eingestellt wird: Mannschaft, angebundene Systeme und
// die Stammdaten des Projekts selbst. Letztere lagen früher unten auf der
// Übersicht – ein Formular, an dem man im Alltag vorbeiscrollte, das aber die
// gefährlichste Aktion der App enthält (Projekt löschen). Konfiguration gehört
// an einen Ort, das Dashboard bleibt zum Beobachten.
export const dynamic = "force-dynamic";

const AGENT_ROLES: AgentRole[] = [
  "SUPPORT",
  "PRODUCT_OWNER",
  "PLANNING",
  "BACKEND",
  "FRONTEND",
  "DESIGN",
  "QA",
  "REVIEWER",
  "DEVOPS",
];

const AGENT_STATUSES: AgentStatus[] = ["IDLE", "WORKING", "BLOCKED"];

const CONNECTOR_PROVIDERS: ConnectorProvider[] = ["JIRA", "ZENDESK", "EMAIL", "GIT", "GENERIC_WEBHOOK"];

export default async function ProjectTeamPage({ params }: PageProps<"/projects/[projectId]/team">) {
  const { projectId } = await params;

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: {
      agents: {
        include: { agent: { include: { llmProfile: true } }, connector: true },
        orderBy: { createdAt: "asc" },
      },
    },
  });

  if (!project) notFound();

  const [llmProfiles, connectors, lastRepoPush] = await Promise.all([
    prisma.llmProfile.findMany({ orderBy: { name: "asc" } }),
    prisma.connector.findMany({
      where: { organizationId: project.organizationId, OR: [{ projectId: null }, { projectId: project.id }] },
      orderBy: { createdAt: "asc" },
    }),
    // Letztes Push-Ereignis (siehe worker/projectRepository.ts) – ohne das war
    // ein erfolgreicher wie ein fehlgeschlagener Push komplett unsichtbar,
    // erst über einen manuellen Blick in DB/Repo zu erkennen.
    prisma.activityLogEntry.findFirst({
      where: { projectId: project.id, action: { in: ["repo_pushed", "repo_push_failed"] } },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  return (
    <PanelGrid className="lg:grid-cols-2 lg:grid-rows-2">
      <Panel title="Agenten-Team" count={project.agents.length} className="card-ghost lg:row-span-2" padded={false}>
        {project.agents.length === 0 ? (
          <PanelEmpty>Noch keine Agenten im Team.</PanelEmpty>
        ) : (
          <ul className="divide-y divide-hairline">
            {project.agents.map(({ id: assignmentId, agent, connector }) => (
              <li key={assignmentId} className="group px-4 py-3.5">
                <div className="flex items-start gap-3">
                  {/* Initialen statt einer weiteren Farbcodierung – Rolle und
                      Zustand tragen die Pills schon eindeutig genug. */}
                  <span
                    aria-hidden
                    className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-3 text-xs font-semibold text-ink-2"
                  >
                    {agent.name.trim().slice(0, 2).toUpperCase()}
                  </span>

                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <p className="truncate text-sm font-medium text-ink">{agent.name}</p>
                      <span className="pill pill-neutral shrink-0">{AGENT_ROLE_LABEL[agent.role]}</span>
                      <span className={`${AGENT_STATUS_PILL[agent.status]} pill-dot shrink-0`}>
                        {AGENT_STATUS_LABEL[agent.status]}
                      </span>
                      {/* Ohne angelegte Connectoren im Kunden/Projekt gäbe es
                          im Dialog nur die Auswahl „— keiner —" – eine
                          Einrichtung, die nichts zu entscheiden gibt. */}
                      {connectors.length > 0 && (
                        <AgentConnectorDialog
                          assignmentId={assignmentId}
                          projectId={project.id}
                          agentName={agent.name}
                          connectors={connectors}
                          currentConnector={connector}
                        />
                      )}
                    </div>

                    {/* `key` erzwingt einen Neuaufbau des Formulars nach dem
                        Speichern: Ohne ihn behalten die <select>-Felder als
                        unkontrollierte Komponenten ihren alten `defaultValue`
                        im DOM bei – der Toast meldet „gespeichert“, doch die
                        Auswahl zeigt sichtbar weiter den Stand vor dem Klick,
                        bis man die Seite von Hand neu lädt. */}
                    <ActionForm
                      action={updateAgentAssignment}
                      key={`${assignmentId}:${agent.status}:${agent.llmProfile?.id ?? ""}`}
                      className="mt-2.5 grid grid-cols-1 items-end gap-3 sm:grid-cols-[1fr_1fr_auto]"
                    >
                      <input type="hidden" name="assignmentId" value={assignmentId} />
                      <input type="hidden" name="agentId" value={agent.id} />
                      <input type="hidden" name="projectId" value={project.id} />
                      <div>
                        <label className={labelClass}>Status</label>
                        <select name="status" defaultValue={agent.status} className={inputClass}>
                          {AGENT_STATUSES.map((status) => (
                            <option key={status} value={status}>
                              {AGENT_STATUS_LABEL[status]}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className={labelClass}>LLM-Profil</label>
                        <select
                          name="llmProfileId"
                          defaultValue={agent.llmProfile?.id ?? ""}
                          className={inputClass}
                        >
                          <option value="">— kein Profil —</option>
                          {llmProfiles.map((profile) => (
                            <option key={profile.id} value={profile.id}>
                              {profile.name}
                            </option>
                          ))}
                        </select>
                      </div>
                      {/* mb-0.5: gleicht 2px aus, um die 8px-Rasterhöhe des
                          Icon-Buttons (h-8) bündig mit der etwas höheren
                          Select-Box (inputClass: Padding+Zeilenhöhe+Rahmen)
                          auszurichten – items-end allein reicht hier nicht
                          ganz. */}
                      <button
                        type="submit"
                        title="Speichern"
                        aria-label="Speichern"
                        className={`${iconButtonPrimaryClass} mb-0.5`}
                      >
                        <SaveIcon className="h-4 w-4" />
                      </button>
                    </ActionForm>
                  </div>

                  <ActionForm action={removeAgentAssignment} className="mt-0.5 shrink-0">
                    <input type="hidden" name="assignmentId" value={assignmentId} />
                    <input type="hidden" name="projectId" value={project.id} />
                    <ConfirmButton
                      confirmText={`"${agent.name}" aus diesem Projekt entfernen? Der Agent bleibt an anderen Projekten bestehen.`}
                      title={`${agent.name} aus dem Team nehmen`}
                      className={iconButtonSmallDangerClass}
                    >
                      <TrashIcon className="h-4 w-4" />
                    </ConfirmButton>
                  </ActionForm>
                </div>
              </li>
            ))}
          </ul>
        )}

        <div className="p-4">
          <Disclosure label="Agent hinzufügen">
            <ActionForm action={createAgentAndAssign} className={formGridClass}>
              <input type="hidden" name="projectId" value={project.id} />
              <div>
                <label className={labelClass}>Name</label>
                <input name="name" required className={inputClass} placeholder="z.B. Backend-Agent" />
              </div>
              <div>
                <label className={labelClass}>Rolle</label>
                <select name="role" className={inputClass} defaultValue="BACKEND">
                  {AGENT_ROLES.map((role) => (
                    <option key={role} value={role}>
                      {AGENT_ROLE_LABEL[role]}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className={labelClass}>LLM-Profil</label>
                <select name="llmProfileId" className={inputClass} defaultValue="">
                  <option value="">— kein Profil —</option>
                  {llmProfiles.map((profile) => (
                    <option key={profile.id} value={profile.id}>
                      {profile.name}
                    </option>
                  ))}
                </select>
              </div>
              {connectors.length > 0 && (
                <div>
                  <label className={labelClass}>Connector</label>
                  <select name="connectorId" className={inputClass} defaultValue="">
                    <option value="">— keiner —</option>
                    {connectors.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <div className="sm:col-span-2">
                <button type="submit" className={buttonSecondaryClass}>
                  Agent hinzufügen
                </button>
              </div>
            </ActionForm>
          </Disclosure>
        </div>
      </Panel>

      <Panel title="Connectoren" count={connectors.length} padded={false} className="card-ghost">
        {lastRepoPush && (
          <p
            className={`border-b border-hairline px-4 py-2 text-xs ${
              lastRepoPush.action === "repo_push_failed" ? "text-red-600" : "text-ink-4"
            }`}
          >
            {lastRepoPush.action === "repo_pushed" ? "✅ Zuletzt gepusht" : "⚠️ Push fehlgeschlagen"} am{" "}
            {lastRepoPush.createdAt.toLocaleString("de-DE")}
            {lastRepoPush.action === "repo_push_failed" && lastRepoPush.detail ? `: ${lastRepoPush.detail}` : ""}
          </p>
        )}
        {connectors.length === 0 ? (
          <PanelEmpty>Noch keine Connectoren eingerichtet.</PanelEmpty>
        ) : (
          <ul className="divide-y divide-hairline">
            {connectors.map((connector) => (
              <li
                key={connector.id}
                className="group flex flex-wrap items-center justify-between gap-3 px-4 py-2.5"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-ink">
                    {connector.name}
                    <span className="ml-2 text-xs font-normal text-ink-3">
                      {CONNECTOR_PROVIDER_LABEL[connector.provider]}
                      {connector.projectId ? " · nur dieses Projekt" : " · kundenweit"}
                    </span>
                  </p>
                  {connector.config != null && (
                    <p className="mt-0.5 truncate font-mono text-xs text-ink-4">
                      {JSON.stringify(connector.config)}
                    </p>
                  )}
                  {connector.credentialRef && (
                    <p className="mt-0.5 truncate font-mono text-xs text-ink-4">
                      Zugang:{" "}
                      {connector.credentialRef.startsWith("enc:")
                        ? "🔒 Token verschlüsselt hinterlegt"
                        : connector.credentialRef}
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {/* `key` erzwingt einen Neuaufbau nach dem Speichern – sonst
                      derselbe Darstellungsbug wie bei den Agenten-Feldern. */}
                  <ActionForm
                    action={updateConnectorStatus}
                    key={connector.status}
                    className="flex items-center gap-2"
                  >
                    <input type="hidden" name="id" value={connector.id} />
                    <select
                      name="status"
                      defaultValue={connector.status}
                      aria-label={`Status von ${connector.name}`}
                      className={`${CONNECTOR_STATUS_PILL[connector.status]} cursor-pointer appearance-none pr-2`}
                    >
                      <option value="ACTIVE">{CONNECTOR_STATUS_LABEL.ACTIVE}</option>
                      <option value="INACTIVE">{CONNECTOR_STATUS_LABEL.INACTIVE}</option>
                      <option value="ERROR">{CONNECTOR_STATUS_LABEL.ERROR}</option>
                    </select>
                    <button type="submit" className="quiet-link text-xs font-medium">
                      Übernehmen
                    </button>
                  </ActionForm>
                  <ActionForm action={deleteConnector}>
                    <input type="hidden" name="id" value={connector.id} />
                    <ConfirmButton
                      confirmText={`Connector "${connector.name}" löschen?`}
                      title={`Connector „${connector.name}" löschen`}
                      className={iconButtonSmallDangerClass}
                    >
                      <TrashIcon className="h-4 w-4" />
                    </ConfirmButton>
                  </ActionForm>
                </div>
              </li>
            ))}
          </ul>
        )}

        <div className="p-4">
          <Disclosure label="Neuer Connector">
            <ActionForm action={createConnector} className={formGridClass}>
              <input type="hidden" name="organizationId" value={project.organizationId} />
              <div>
                <label className={labelClass}>Name</label>
                <input name="name" required className={inputClass} placeholder="z.B. Kunden-Jira" />
              </div>
              <div>
                <label className={labelClass}>Anbieter</label>
                <select name="provider" className={inputClass} defaultValue="JIRA">
                  {CONNECTOR_PROVIDERS.map((provider) => (
                    <option key={provider} value={provider}>
                      {CONNECTOR_PROVIDER_LABEL[provider]}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className={labelClass}>Geltungsbereich</label>
                <select name="projectId" className={inputClass} defaultValue={project.id}>
                  <option value={project.id}>Nur dieses Projekt (z.B. Git-Repo)</option>
                  <option value="">Kundenweit (z.B. ein Jira-Postfach)</option>
                </select>
              </div>
              <div>
                <label className={labelClass}>Zugang / Token (optional)</label>
                <input
                  name="credentialRef"
                  type="password"
                  autoComplete="off"
                  className={inputClass}
                  placeholder="z.B. ghp_… oder env:KUNDE_A_GITHUB_TOKEN"
                />
                <p className="mt-1 text-xs text-ink-4">
                  Direkt eingegebener Token wird verschlüsselt gespeichert. Alternativ &bdquo;env:NAME&rdquo; für einen
                  Token, der schon als Umgebungsvariable im Worker gesetzt ist.
                </p>
              </div>
              <div className="sm:col-span-2">
                <label className={labelClass}>Config (JSON, optional)</label>
                <textarea
                  name="config"
                  rows={2}
                  className={`${inputClass} font-mono text-xs`}
                  placeholder='{"baseUrl":"https://…","projectKey":"DEMO"} oder {"repoUrl":"https://…","defaultBranch":"main"}'
                />
              </div>
              <div className="sm:col-span-2">
                <button type="submit" className={buttonSecondaryClass}>
                  Connector anlegen
                </button>
              </div>
            </ActionForm>
          </Disclosure>
        </div>
      </Panel>

      <Panel title="Projekt-Einstellungen" className="card-ghost">
        {/* `key` erzwingt einen Neuaufbau nach dem Speichern – sonst derselbe
            Darstellungsbug wie bei den Agenten-Feldern oben. */}
        <ActionForm
          action={updateProject}
          key={`${project.name}:${project.status}:${project.repoUrl ?? ""}:${project.description ?? ""}`}
          className="grid gap-3 sm:grid-cols-2"
        >
          <input type="hidden" name="id" value={project.id} />
          <div>
            <label className={labelClass}>Name</label>
            <input name="name" defaultValue={project.name} required className={inputClass} />
          </div>
          <div>
            <label className={labelClass}>Status</label>
            <select name="status" defaultValue={project.status} className={inputClass}>
              <option value="DISCOVERY">{PROJECT_STATUS_LABEL.DISCOVERY}</option>
              <option value="CONCEPT">{PROJECT_STATUS_LABEL.CONCEPT}</option>
              <option value="ACTIVE">{PROJECT_STATUS_LABEL.ACTIVE}</option>
              <option value="PAUSED">{PROJECT_STATUS_LABEL.PAUSED}</option>
              <option value="ARCHIVED">{PROJECT_STATUS_LABEL.ARCHIVED}</option>
            </select>
          </div>
          <div>
            <label className={labelClass}>Repository-URL</label>
            <input
              name="repoUrl"
              type="url"
              defaultValue={project.repoUrl ?? ""}
              placeholder="https://github.com/organisation/repository.git"
              className={inputClass}
            />
            <p className="mt-1 text-xs text-ink-4">HTTPS-Repo; Scrumy klont es und pusht jeden Team-Commit nach origin.</p>
          </div>
          <div>
            <label className={labelClass}>Beschreibung</label>
            <input name="description" defaultValue={project.description ?? ""} className={inputClass} />
          </div>
          <div className="sm:col-span-2">
            <button type="submit" className={buttonPrimaryClass}>
              Speichern
            </button>
          </div>
        </ActionForm>

        {/* Noch ohne Funktion: liveKeepData existiert in der DB, wird aber
            aktuell nirgends gelesen (siehe prisma/schema.prisma) – Terminate
            löscht die Datenbank-Daten der Live-Anwendung immer. Sichtbar
            ausgegraut, damit klar ist, dass die Funktion kommt, statt sie
            vorzutäuschen. */}
        <div className="mt-4 border-t border-hairline pt-4">
          <label className="flex items-center gap-2 text-sm text-ink-4">
            <input type="checkbox" disabled className="accent-accent-solid" />
            Daten der Live-Anwendung beim Beenden behalten
            <span className="pill pill-neutral">Premium – demnächst verfügbar</span>
          </label>
          <p className="mt-1 text-xs text-ink-4">
            Aktuell werden die Datenbank-Inhalte der Live-Anwendung beim Beenden immer gelöscht, um Speicher zu sparen.
          </p>
        </div>

        <ActionForm action={deleteProject} className="mt-4 border-t border-hairline pt-4">
          <input type="hidden" name="id" value={project.id} />
          <ConfirmButton
            confirmText={
              `Projekt "${project.name}" inkl. aller Tickets und Agenten-Einsätze wirklich löschen?` +
              (project.workspacePath
                ? " Das Repository mit der gebauten Software wird dabei unwiderruflich mitgelöscht."
                : "")
            }
            className={buttonDangerClass}
          >
            Projekt löschen
          </ConfirmButton>
        </ActionForm>
      </Panel>
    </PanelGrid>
  );
}
