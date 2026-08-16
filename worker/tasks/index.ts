// Zentrale Task-Registry fuer graphile-worker. Neue Pipeline-Schritte
// (Support-Triage, Product-Owner, Planning, Coding-Agenten, ...) kommen hier
// als weiterer Eintrag dazu, jeweils als eigene Datei nach dem Muster von
// `agentTurn.ts` + ein weiterer Eintrag im `GraphileWorker.Tasks`-Interface
// unten (graphile-worker's Mechanismus fuer typisierte Task-Payloads).
import type { TaskList } from "graphile-worker";
import agentTurn, { type AgentTurnPayload } from "./agentTurn";

export const taskList: TaskList = {
  agentTurn,
};

declare global {
  // Von graphile-worker vorgegebener Mechanismus fuer typisierte Task-Payloads
  // (Declaration Merging), kein selbst gewaehltes Namespace-Pattern.
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace GraphileWorker {
    interface Tasks {
      agentTurn: AgentTurnPayload;
    }
  }
}
