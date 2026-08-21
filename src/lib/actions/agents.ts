"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { AGENT_ROLE_LABEL, AGENT_STATUS_LABEL } from "@/lib/labels";
import { fail, ok, type ActionResult } from "@/lib/actions/result";
import type { AgentRole, AgentStatus } from "@/generated/prisma/client";

function str(formData: FormData, key: string): string | null {
  const value = String(formData.get(key) ?? "").trim();
  return value.length > 0 ? value : null;
}

export async function createAgentAndAssign(formData: FormData): Promise<ActionResult> {
  const projectId = str(formData, "projectId");
  const name = str(formData, "name");
  const role = str(formData, "role") as AgentRole | null;
  if (!projectId) return fail("Kein Projekt angegeben.");
  if (!name || !role) return fail("Name und Rolle sind Pflichtfelder.");

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
  return ok(`Agent „${name}“ (${AGENT_ROLE_LABEL[role]}) ins Team aufgenommen.`);
}

export async function updateAgentAssignment(formData: FormData): Promise<ActionResult> {
  const assignmentId = str(formData, "assignmentId");
  const agentId = str(formData, "agentId");
  const projectId = str(formData, "projectId");
  if (!assignmentId || !agentId || !projectId) return fail("Kein Agenten-Einsatz angegeben.");

  const status = str(formData, "status") as AgentStatus | null;

  const agent = await prisma.agent.update({
    where: { id: agentId },
    data: {
      llmProfileId: str(formData, "llmProfileId"),
      status: status ?? undefined,
    },
  });

  revalidatePath(`/projects/${projectId}/team`);
  revalidatePath(`/projects/${projectId}`);
  return ok(`Agent „${agent.name}“ gespeichert – Status: ${AGENT_STATUS_LABEL[agent.status]}.`);
}

// Eigene Action statt Teil von updateAgentAssignment: Der Connector-Dialog
// schickt nur `connectorId` mit – hinge er am selben Formularfeld-Vertrag wie
// updateAgentAssignment (das llmProfileId immer aus dem Formular übernimmt,
// auch wenn es fehlt), würde ein Absenden ohne LLM-Profil-Feld dieses
// versehentlich auf "kein Profil" zurücksetzen.
export async function updateAgentConnector(formData: FormData): Promise<ActionResult> {
  const assignmentId = str(formData, "assignmentId");
  const projectId = str(formData, "projectId");
  if (!assignmentId || !projectId) return fail("Kein Agenten-Einsatz angegeben.");

  const assignment = await prisma.agentAssignment.update({
    where: { id: assignmentId },
    data: { connectorId: str(formData, "connectorId") },
    include: { agent: true, connector: true },
  });

  revalidatePath(`/projects/${projectId}/team`);
  revalidatePath(`/projects/${projectId}`);
  return ok(
    assignment.connector
      ? `Connector „${assignment.connector.name}“ mit „${assignment.agent.name}“ verbunden.`
      : `Connector von „${assignment.agent.name}“ entfernt.`,
  );
}

export async function removeAgentAssignment(formData: FormData): Promise<ActionResult> {
  const assignmentId = str(formData, "assignmentId");
  const projectId = str(formData, "projectId");
  if (!assignmentId || !projectId) return fail("Kein Agenten-Einsatz angegeben.");

  // Entfernt nur den Einsatz im Projekt, der Agent selbst bleibt bestehen
  // (kann an anderen Kundenprojekten weiterarbeiten).
  const assignment = await prisma.agentAssignment.delete({
    where: { id: assignmentId },
    include: { agent: true },
  });

  revalidatePath(`/projects/${projectId}/team`);
  revalidatePath(`/projects/${projectId}`);
  return ok(`„${assignment.agent.name}“ aus diesem Projekt entfernt – der Agent selbst bleibt bestehen.`);
}
