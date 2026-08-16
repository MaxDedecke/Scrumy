import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import {
  AGENT_ROLE_LABEL,
  AGENT_STATUS_LABEL,
  CONNECTOR_PROVIDER_LABEL,
  CONNECTOR_STATUS_LABEL,
  CONNECTOR_STATUS_PILL,
  PROJECT_STATUS_LABEL,
  PROJECT_STATUS_PILL,
} from "@/lib/labels";
import { ActionForm } from "@/components/ActionForm";
import { ProjectTabs } from "@/components/ProjectTabs";
import { ConfirmButton } from "@/components/ConfirmButton";
import { PageHeader } from "@/components/PageHeader";
import { EmptyHint, Section } from "@/components/Section";
import { Disclosure, formGridClass } from "@/components/Disclosure";
import { createAgentAndAssign, removeAgentAssignment, updateAgentAssignment } from "@/lib/actions/agents";
import { createConnector, deleteConnector, updateConnectorStatus } from "@/lib/actions/connectors";
import {
  buttonDangerQuietClass,
  buttonPrimaryClass,
  buttonSecondaryClass,
  inputClass,
  labelClass,
  pageClass,
} from "@/lib/ui";
import type { AgentRole, AgentStatus, ConnectorProvider } from "@/generated/prisma/client";

// Immer live aus der DB rendern, nicht zur Build-Zeit einfrieren.
export const dynamic = "force-dynamic";

const AGENT_ROLES: AgentRole[] = [
  "SUPPORT",
  "PRODUCT_OWNER",
  "PLANNING",
  "BACKEND",
  "FRONTEND",
  "QA",
  "REVIEWER",
  "DEVOPS",
];

const AGENT_STATUSES: AgentStatus[] = ["IDLE", "WORKING", "BLOCKED"];

const CONNECTOR_PROVIDERS: ConnectorProvider[] = ["JIRA", "ZENDESK", "EMAIL", "GIT", "GENERIC_WEBHOOK"];

export default async function ProjectTeamPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: {
      organization: true,
      agents: { include: { agent: { include: { llmProfile: true } }, connector: true }, orderBy: { createdAt: "asc" } },
    },
  });

  if (!project) notFound();

  const [llmProfiles, connectors] = await Promise.all([
    prisma.llmProfile.findMany({ orderBy: { name: "asc" } }),
    prisma.connector.findMany({
      where: { organizationId: project.organizationId, OR: [{ projectId: null }, { projectId: project.id }] },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  return (
    <main className={pageClass}>
      <PageHeader
        backHref="/"
        backLabel="Kunden"
        context={project.organization.name}
        title={project.name}
        status={
          <span className={`${PROJECT_STATUS_PILL[project.status]} pill-dot`}>
            {PROJECT_STATUS_LABEL[project.status]}
          </span>
        }
      />

      <ProjectTabs projectId={project.id} active="team" />

      <Section title="Connectoren">
        <div className="space-y-2">
          {connectors.map((connector) => (
            <div key={connector.id} className="card flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-ink">
                  {connector.name}
                  <span className="ml-2 text-xs font-normal text-ink-3">
                    {CONNECTOR_PROVIDER_LABEL[connector.provider]}
                    {connector.projectId ? " · nur dieses Projekt" : " · kundenweit"}
                  </span>
                </p>
                {connector.config != null && (
                  <p className="mt-0.5 max-w-xl truncate font-mono text-xs text-ink-4">
                    {JSON.stringify(connector.config)}
                  </p>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <ActionForm action={updateConnectorStatus} className="flex items-center gap-2">
                  <input type="hidden" name="id" value={connector.id} />
                  <input type="hidden" name="organizationId" value={project.organizationId} />
                  <input type="hidden" name="projectId" value={project.id} />
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
                  <input type="hidden" name="organizationId" value={project.organizationId} />
                  <input type="hidden" name="projectId" value={project.id} />
                  <ConfirmButton
                    confirmText={`Connector "${connector.name}" löschen?`}
                    className={buttonDangerQuietClass}
                  >
                    Entfernen
                  </ConfirmButton>
                </ActionForm>
              </div>
            </div>
          ))}
          {connectors.length === 0 && <EmptyHint>Noch keine Connectoren eingerichtet.</EmptyHint>}
        </div>

        <Disclosure label="Neuer Connector" className="mt-3">
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
              <label className={labelClass}>Credential-Referenz (optional)</label>
              <input name="credentialRef" className={inputClass} placeholder="vault://…, nie den Schlüssel selbst" />
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
      </Section>

      <Section title="Agenten-Team" className="mb-0">
        <div className="space-y-2">
          {project.agents.map(({ id: assignmentId, agent, connector }) => (
            // Zwei Formulare nebeneinander statt ineinander (verschachtelte
            // <form> sind ungültig) – die Zeile bleibt trotzdem eine Zeile.
            <div key={assignmentId} className="card flex flex-wrap items-end gap-x-4 gap-y-3 p-4">
              <ActionForm
                action={updateAgentAssignment}
                className="grid min-w-0 flex-1 grid-cols-1 items-end gap-4 sm:grid-cols-[1.2fr_1fr_1fr_1fr_auto]"
              >
                <input type="hidden" name="assignmentId" value={assignmentId} />
                <input type="hidden" name="agentId" value={agent.id} />
                <input type="hidden" name="projectId" value={project.id} />
                <div>
                  <span className={labelClass}>Agent</span>
                  <p className="truncate text-sm font-medium text-ink">{agent.name}</p>
                  <p className="truncate text-xs text-ink-3">{AGENT_ROLE_LABEL[agent.role]}</p>
                </div>
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
                  <select name="llmProfileId" defaultValue={agent.llmProfile?.id ?? ""} className={inputClass}>
                    <option value="">— kein Profil —</option>
                    {llmProfiles.map((profile) => (
                      <option key={profile.id} value={profile.id}>
                        {profile.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className={labelClass}>Connector</label>
                  <select name="connectorId" defaultValue={connector?.id ?? ""} className={inputClass}>
                    <option value="">— keiner —</option>
                    {connectors.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </div>
                <button type="submit" className={buttonPrimaryClass}>
                  Speichern
                </button>
              </ActionForm>
              <ActionForm action={removeAgentAssignment} className="pb-2">
                <input type="hidden" name="assignmentId" value={assignmentId} />
                <input type="hidden" name="projectId" value={project.id} />
                <ConfirmButton
                  confirmText={`"${agent.name}" aus diesem Projekt entfernen? Der Agent bleibt an anderen Projekten bestehen.`}
                  className={buttonDangerQuietClass}
                >
                  Entfernen
                </ConfirmButton>
              </ActionForm>
            </div>
          ))}
          {project.agents.length === 0 && <EmptyHint>Noch keine Agenten im Team.</EmptyHint>}
        </div>

        <Disclosure label="Agent hinzufügen" className="mt-3">
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
            <div className="sm:col-span-2">
              <button type="submit" className={buttonSecondaryClass}>
                Agent hinzufügen
              </button>
            </div>
          </ActionForm>
        </Disclosure>
      </Section>
    </main>
  );
}
