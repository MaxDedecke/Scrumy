import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import {
  AGENT_ROLE_LABEL,
  AGENT_STATUS_LABEL,
  CONNECTOR_PROVIDER_LABEL,
  CONNECTOR_STATUS_LABEL,
  CONNECTOR_STATUS_PILL,
} from "@/lib/labels";
import { ProjectTabs } from "@/components/ProjectTabs";
import { ConfirmButton } from "@/components/ConfirmButton";
import { createAgentAndAssign, removeAgentAssignment, updateAgentAssignment } from "@/lib/actions/agents";
import { createConnector, deleteConnector, updateConnectorStatus } from "@/lib/actions/connectors";
import { buttonPrimaryClass, buttonSecondaryClass, inputClass, labelClass } from "@/lib/ui";
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
    <main className="flex-1 mx-auto w-full max-w-5xl px-6 py-10">
      <header className="mb-6">
        <Link href="/" className="text-sm text-neutral-500 hover:text-neutral-300">
          ← Kunden &amp; Projekte
        </Link>
        <div className="mt-2">
          <p className="text-sm uppercase tracking-wider text-neutral-500">{project.organization.name}</p>
          <h1 className="mt-1 text-2xl font-semibold">{project.name}</h1>
        </div>
      </header>

      <ProjectTabs projectId={project.id} active="team" />

      {/* Connectoren */}
      <section className="mb-10">
        <h2 className="mb-4 text-sm font-medium uppercase tracking-wider text-neutral-500">Connectoren</h2>
        <div className="space-y-3">
          {connectors.map((connector) => (
            <div key={connector.id} className="flex items-center justify-between rounded-md border border-neutral-800 px-4 py-3">
              <div>
                <p className="text-sm font-medium">
                  {connector.name}{" "}
                  <span className="ml-1 text-xs text-neutral-500">
                    ({CONNECTOR_PROVIDER_LABEL[connector.provider]}
                    {connector.projectId ? ", nur dieses Projekt" : ", kundenweit"})
                  </span>
                </p>
                {connector.config != null && (
                  <p className="mt-0.5 max-w-xl truncate text-xs text-neutral-600">
                    {JSON.stringify(connector.config)}
                  </p>
                )}
              </div>
              <div className="flex items-center gap-2">
                <form action={updateConnectorStatus} className="flex items-center gap-1.5">
                  <input type="hidden" name="id" value={connector.id} />
                  <input type="hidden" name="organizationId" value={project.organizationId} />
                  <input type="hidden" name="projectId" value={project.id} />
                  <select
                    name="status"
                    defaultValue={connector.status}
                    className={`${CONNECTOR_STATUS_PILL[connector.status]} border-none bg-transparent`}
                  >
                    <option value="ACTIVE">{CONNECTOR_STATUS_LABEL.ACTIVE}</option>
                    <option value="INACTIVE">{CONNECTOR_STATUS_LABEL.INACTIVE}</option>
                    <option value="ERROR">{CONNECTOR_STATUS_LABEL.ERROR}</option>
                  </select>
                  <button type="submit" className="text-xs text-neutral-500 hover:text-neutral-300">
                    ✓
                  </button>
                </form>
                <form action={deleteConnector}>
                  <input type="hidden" name="id" value={connector.id} />
                  <input type="hidden" name="organizationId" value={project.organizationId} />
                  <input type="hidden" name="projectId" value={project.id} />
                  <ConfirmButton confirmText={`Connector "${connector.name}" löschen?`} className="text-xs text-red-400 hover:text-red-300">
                    Entfernen
                  </ConfirmButton>
                </form>
              </div>
            </div>
          ))}
          {connectors.length === 0 && <p className="text-sm text-neutral-600">Noch keine Connectoren.</p>}
        </div>

        <details className="mt-4">
          <summary className="cursor-pointer select-none text-sm text-neutral-500 hover:text-neutral-300">
            + Neuer Connector
          </summary>
          <form action={createConnector} className="mt-3 grid gap-3 rounded-md border border-neutral-900 p-4 sm:grid-cols-2">
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
                className={inputClass}
                placeholder='{"baseUrl":"https://…","projectKey":"DEMO"} oder {"repoUrl":"https://…","defaultBranch":"main"}'
              />
            </div>
            <div className="sm:col-span-2">
              <button type="submit" className={buttonSecondaryClass}>
                Connector anlegen
              </button>
            </div>
          </form>
        </details>
      </section>

      {/* Agenten-Team */}
      <section>
        <h2 className="mb-4 text-sm font-medium uppercase tracking-wider text-neutral-500">Agenten-Team</h2>
        <div className="space-y-3">
          {project.agents.map(({ id: assignmentId, agent, connector }) => (
            <form
              key={assignmentId}
              action={updateAgentAssignment}
              className="grid grid-cols-1 gap-3 rounded-md border border-neutral-800 p-4 sm:grid-cols-[1fr_1fr_1fr_auto_auto]"
            >
              <input type="hidden" name="assignmentId" value={assignmentId} />
              <input type="hidden" name="agentId" value={agent.id} />
              <input type="hidden" name="projectId" value={project.id} />
              <div>
                <label className={labelClass}>Agent</label>
                <p className="px-1 py-1.5 text-sm font-medium">
                  {agent.name} <span className="text-xs text-neutral-500">({AGENT_ROLE_LABEL[agent.role]})</span>
                </p>
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
              <div className="flex items-end gap-2">
                <button type="submit" className={buttonPrimaryClass}>
                  Speichern
                </button>
              </div>
              <div className="flex items-end sm:col-span-5">
                <RemoveAssignmentForm assignmentId={assignmentId} projectId={project.id} agentName={agent.name} />
              </div>
            </form>
          ))}
          {project.agents.length === 0 && <p className="text-sm text-neutral-600">Noch keine Agenten im Team.</p>}
        </div>

        <details className="mt-6">
          <summary className="cursor-pointer select-none text-sm text-neutral-500 hover:text-neutral-300">
            + Agent hinzufügen
          </summary>
          <form action={createAgentAndAssign} className="mt-3 grid gap-3 rounded-md border border-neutral-900 p-4 sm:grid-cols-2">
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
          </form>
        </details>
      </section>
    </main>
  );
}

function RemoveAssignmentForm({
  assignmentId,
  projectId,
  agentName,
}: {
  assignmentId: string;
  projectId: string;
  agentName: string;
}) {
  return (
    <form action={removeAgentAssignment}>
      <input type="hidden" name="assignmentId" value={assignmentId} />
      <input type="hidden" name="projectId" value={projectId} />
      <ConfirmButton
        confirmText={`"${agentName}" aus diesem Projekt entfernen? Der Agent bleibt an anderen Projekten bestehen.`}
        className="text-xs text-red-400 hover:text-red-300"
      >
        Aus Projekt entfernen
      </ConfirmButton>
    </form>
  );
}
