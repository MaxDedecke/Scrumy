// Manuelles Test-Werkzeug fuer die Entwicklung: legt einen `agentTurn`-Job
// fuer den ersten in der DB gefundenen Agenten an, um die Queue end-to-end zu
// pruefen (Job wird vom laufenden Worker abgeholt, Agent-Status springt kurz
// auf WORKING, danach entsteht ein ActivityLogEntry). Kein Teil der
// eigentlichen Anwendung, nur zur Verifikation.
import "dotenv/config";
import { prisma } from "@/lib/prisma";
import { enqueueAgentJob } from "./queue";

async function main() {
  const agent = await prisma.agent.findFirst({
    include: { assignments: true },
  });
  if (!agent || agent.assignments.length === 0) {
    console.error("Kein Agent mit Projekt-Zuordnung gefunden. Erst `npm run db:seed` ausfuehren.");
    process.exit(1);
  }

  await enqueueAgentJob("agentTurn", {
    agentId: agent.id,
    projectId: agent.assignments[0].projectId,
    reason: "manueller Test-Job",
  });

  console.log(`Job fuer Agent "${agent.name}" (${agent.id}) eingereiht.`);
  process.exit(0);
}

main();
