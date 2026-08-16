// Zusammenstellung des Agenten-Teams eines Projekts.
//
// Beim Team-Start soll dasselbe passieren wie in einer echten Firma: Es steht
// eine Mannschaft bereit, jede Rolle einmal besetzt, mit Namen statt
// Rollen-Kuerzeln – der Mensch fragt spaeter "was macht Frida gerade?" und
// nicht "was macht FRONTEND_AGENT_2?". Wer schon im Projekt ist, bleibt; es
// werden nur fehlende Rollen ergaenzt.
import { prisma } from "@/lib/prisma";
import type { Agent, AgentRole } from "@/generated/prisma/client";

/// Die Standardbesetzung. Reihenfolge = Reihenfolge in der Oberflaeche.
export const DEFAULT_TEAM: { name: string; role: AgentRole }[] = [
  { name: "Pia Ostermann", role: "PRODUCT_OWNER" },
  { name: "Simon Kranz", role: "SCRUM_MASTER" },
  { name: "Paul Neumann", role: "PLANNING" },
  { name: "Ben Ritter", role: "BACKEND" },
  { name: "Frida Lang", role: "FRONTEND" },
  { name: "Quinn Adler", role: "QA" },
  { name: "Rita Sommer", role: "REVIEWER" },
  { name: "Dennis Ohl", role: "DEVOPS" },
  { name: "Sina Prinz", role: "SUPPORT" },
];

/// Stellt sicher, dass jede Rolle im Projekt besetzt ist. Neue Agenten
/// bekommen das Standard-LLM-Profil; wer schon da ist, wird nicht angefasst.
export async function ensureProjectTeam(projectId: string): Promise<Agent[]> {
  const existing = await prisma.agentAssignment.findMany({
    where: { projectId },
    include: { agent: true },
  });
  const takenRoles = new Set(existing.map((assignment) => assignment.agent.role));

  const defaultProfile =
    (await prisma.llmProfile.findFirst({ where: { isDefault: true } })) ??
    (await prisma.llmProfile.findFirst({ orderBy: { createdAt: "asc" } }));

  const created: Agent[] = [];
  for (const member of DEFAULT_TEAM) {
    if (takenRoles.has(member.role)) continue;

    const agent = await prisma.agent.create({
      data: {
        name: member.name,
        role: member.role,
        llmProfileId: defaultProfile?.id ?? null,
        assignments: { create: { projectId } },
      },
    });
    created.push(agent);
  }

  return created;
}

/// Welche Rolle einspringt, wenn die eigentlich zustaendige nicht besetzt ist.
/// Ein Team ohne Scrum Master arbeitet trotzdem weiter – dann uebernimmt der
/// Product Owner, so wie es in kleinen Teams auch laeuft.
const ROLE_FALLBACK: Record<AgentRole, AgentRole[]> = {
  PRODUCT_OWNER: ["SCRUM_MASTER", "PLANNING"],
  SCRUM_MASTER: ["PRODUCT_OWNER", "PLANNING"],
  PLANNING: ["BACKEND", "PRODUCT_OWNER"],
  BACKEND: ["FRONTEND", "DEVOPS", "PLANNING"],
  FRONTEND: ["BACKEND", "DEVOPS", "PLANNING"],
  QA: ["REVIEWER", "BACKEND"],
  REVIEWER: ["QA", "PLANNING"],
  DEVOPS: ["BACKEND", "PLANNING"],
  SUPPORT: ["PRODUCT_OWNER", "SCRUM_MASTER"],
};

/// Holt den Agenten fuer eine Rolle im Projekt – mit Vertretungsregel und, als
/// letzter Ausweg, irgendeinem Agenten des Projekts.
export async function agentForRole(projectId: string, role: AgentRole): Promise<Agent | null> {
  const assignments = await prisma.agentAssignment.findMany({
    where: { projectId },
    include: { agent: true },
    orderBy: { createdAt: "asc" },
  });
  if (assignments.length === 0) return null;

  const byRole = new Map<AgentRole, Agent>();
  for (const assignment of assignments) {
    if (!byRole.has(assignment.agent.role)) byRole.set(assignment.agent.role, assignment.agent);
  }

  for (const candidate of [role, ...ROLE_FALLBACK[role]]) {
    const agent = byRole.get(candidate);
    if (agent) return agent;
  }
  return assignments[0].agent;
}

/// Welche Rolle ein Ticket umsetzt. Die Sprint-Planung schlaegt eine Rolle vor;
/// alles Unbekannte landet beim Backend – wie ein Ticket ohne klaren
/// Zustaendigen im echten Team beim Generalisten landet.
export function roleForTicket(suggested: string | undefined | null): AgentRole {
  const normalized = (suggested ?? "").trim().toUpperCase();
  const known: AgentRole[] = ["BACKEND", "FRONTEND", "QA", "DEVOPS", "PLANNING", "REVIEWER"];
  return (known.find((role) => role === normalized) ?? "BACKEND") as AgentRole;
}
