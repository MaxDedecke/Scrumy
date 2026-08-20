import { prisma } from "@/lib/prisma";
import type { AgentRun } from "@/generated/prisma/client";

// worker/agentToolLoop.ts (runImplementationLoop) legt pro Umsetzungsversuch
// eines Tickets EINEN AgentRun je Modell-Turn an: Werkzeugaufruf, Ergebnis
// sehen, naechster Werkzeugaufruf. Fuer sich allein liest sich so ein
// Folge-Turn wie ein Auftrag ohne Kontext – `prompt` traegt dort bewusst nur
// das NEUE (das Werkzeugergebnis), nicht die volle Konversation (siehe
// `runAgentTurn` in worker/agentRun.ts). Um daraus wieder einen lesbaren
// Verlauf zu machen, muessen die Turns eines Versuchs wieder zusammengefunden
// werden – dafuer gibt es keine eigene Spalte, nur diese Markierung:
// `buildProjectContext` beginnt jeden VOLLSTAENDIGEN Auftrag (= Turn 1 eines
// Versuchs) mit "# Projekt".
export function isAttemptStart(prompt: string): boolean {
  return prompt.trimStart().startsWith("# Projekt");
}

/** Erwartet Laeufe EINES Tickets/EINER Art (`kind`) in aufsteigender Startzeit. */
export function splitIntoAttempts<T extends { prompt: string }>(runsAsc: T[]): T[][] {
  const attempts: T[][] = [];
  for (const run of runsAsc) {
    if (attempts.length === 0 || isAttemptStart(run.prompt)) {
      attempts.push([run]);
    } else {
      attempts[attempts.length - 1].push(run);
    }
  }
  return attempts;
}

/// Findet zu einem einzelnen AgentRun alle Turns desselben Umsetzungsversuchs
/// (aufsteigend sortiert, der uebergebene Run selbst inklusive). Laeufe ohne
/// Ticket oder ausserhalb eines Tool-Loops (kickoff, review, ...) bestehen nur
/// aus sich selbst – kein Sonderfall fuer den Aufrufer, einfach ein Versuch
/// der Laenge 1.
export async function getAttemptRuns(run: Pick<AgentRun, "id" | "ticketId" | "kind">): Promise<AgentRun[]> {
  if (!run.ticketId) return [run as AgentRun];

  const siblings = await prisma.agentRun.findMany({
    where: { ticketId: run.ticketId, kind: run.kind },
    orderBy: { startedAt: "asc" },
  });
  const attempt = splitIntoAttempts(siblings).find((group) => group.some((r) => r.id === run.id));
  return attempt ?? [run as AgentRun];
}
