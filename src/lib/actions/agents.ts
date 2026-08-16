"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import type { AgentRole, AgentStatus } from "@/generated/prisma/client";

function str(formData: FormData, key: string): string | null {
  const value = String(formData.get(key) ?? "").trim();
  return value.length > 0 ? value : null;
}

export async function createAgentAndAssign(formData: FormData) {
  const projectId = str(formData, "projectId");
  const name = str(formData, "name");
  const role = str(formData, "role") as AgentRole | null;
  if (!projectId || !name || !role) return;

  const agent = await prisma.agent.create({
    data: { name, role, llmProfileId: str(formData, "llmProfileId") },
  });

  await prisma.agentAssignment.create({
    data: {
      agentId: agent.id,
      projectId,
      connectorId: str(formData, "connectorId"),
    },
  });

  revalidatePath(`/projects/${projectId}/team`);
  revalidatePath(`/projects/${projectId}`);
}

export async function updateAgentAssignment(formData: FormData) {
  const assignmentId = str(formData, "assignmentId");
  const agentId = str(formData, "agentId");
  const projectId = str(formData, "projectId");
  if (!assignmentId || !agentId || !projectId) return;

  const status = str(formData, "status") as AgentStatus | null;

  await prisma.agent.update({
    where: { id: agentId },
    data: {
      llmProfileId: str(formData, "llmProfileId"),
      status: status ?? undefined,
    },
  });

  await prisma.agentAssignment.update({
    where: { id: assignmentId },
    data: { connectorId: str(formData, "connectorId") },
  });

  revalidatePath(`/projects/${projectId}/team`);
  revalidatePath(`/projects/${projectId}`);
}

export async function removeAgentAssignment(formData: FormData) {
  const assignmentId = str(formData, "assignmentId");
  const projectId = str(formData, "projectId");
  if (!assignmentId || !projectId) return;

  // Entfernt nur den Einsatz im Projekt, der Agent selbst bleibt bestehen
  // (kann an anderen Kundenprojekten weiterarbeiten).
  await prisma.agentAssignment.delete({ where: { id: assignmentId } });

  revalidatePath(`/projects/${projectId}/team`);
  revalidatePath(`/projects/${projectId}`);
}
