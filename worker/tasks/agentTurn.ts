// Beispiel-/Referenz-Task fuer einen Agenten-Lauf.
//
// Zeigt bewusst nur das Geruest, das jede kuenftige Pipeline-Stufe braucht
// (Support-Triage, Product-Owner, Planning, Coding-Agenten, siehe README-
// Roadmap "Echte Agenten-Orchestrierung"): Agent laden, Status setzen,
// Rate-Limit gegen das LLM-Profil ziehen, Ergebnis + Audit-Trail schreiben.
// Der eigentliche LLM-/Connector-Aufruf ist noch nicht angebunden (kommt mit
// der Claude-Agent-SDK-Integration) – hier steht statt dessen ein markierter
// Platzhalter.
import type { Task } from "graphile-worker";
import { prisma } from "@/lib/prisma";
import { withLlmProfileLimit } from "../llmProfileLimiter";

export interface AgentTurnPayload {
  agentId: string;
  projectId: string;
  /** Kurzer Hinweis, was diesen Lauf ausgeloest hat (Ticket-Id, SupportRequest-Id, ...). */
  reason: string;
}

const agentTurn: Task<"agentTurn"> = async (payload, helpers) => {
  const { agentId, projectId, reason } = payload;

  const agent = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
  helpers.logger.info(`Agent ${agent.name} (${agent.role}) startet Lauf: ${reason}`);

  await prisma.agent.update({ where: { id: agentId }, data: { status: "WORKING" } });

  try {
    if (agent.llmProfileId) {
      await withLlmProfileLimit(agent.llmProfileId, async () => {
        // TODO: echter LLM-Aufruf ueber das zugewiesene LlmProfile (Claude
        // Agent SDK / Provider-Client), sobald die Orchestrierung angebunden
        // wird. Bis dahin nur ein simulierter Arbeitsschritt.
      });
    }

    await prisma.activityLogEntry.create({
      data: {
        agentId: agent.id,
        actor: agent.name,
        action: "agent_turn_completed",
        detail: reason,
      },
    });
  } finally {
    await prisma.agent.update({ where: { id: agentId }, data: { status: "IDLE" } });
  }

  helpers.logger.info(`Agent ${agent.name} fertig (Projekt ${projectId}).`);
};

export default agentTurn;
