// Der Agenten-Tool-Loop für die Ticket-Umsetzung: Werkzeugaufruf, Ergebnis
// sehen, nächster Werkzeugaufruf – bis der Agent selbst `finish` ruft. Das
// Gegenstück zum früheren Ein-Antwort-DATEI/EDIT-Format (siehe worker/tasks/
// ticketWork.ts): Der Agent liest/sucht/ändert/testet interaktiv, statt
// blind eine vorbereitete Kontextauswahl in einer einzigen Antwort
// umzusetzen.
import type { Agent } from "@/generated/prisma/client";
import type { ChatMessage, ContentBlock } from "@/lib/llm";
import { discardUncommittedChanges } from "@/lib/workspace";
import { optionsFromAgent, type ClarificationOption } from "@/lib/clarificationOptions";
import { runAgentTurn } from "./agentRun";
import { ALL_TOOLS, executeTool, type ToolContext } from "./agentTools";

/// Jeder Turn ist gezielt (ein Werkzeugaufruf, eine Antwort) – deutlich
/// grosszuegiger als frueher noetig, wo ein einzelner Aufruf die ganze
/// Umsetzung tragen musste.
const MAX_TOOL_TURNS = 20;
/// Gesamtbudget ueber alle Turns UND Bash-Aufrufe zusammen, entspricht dem
/// bisherigen Zeitlimit des einzelnen Umsetzungs-Aufrufs.
const LOOP_BUDGET_MS = 900_000;
/// Anteil des Gesamtbudgets, der maximal in run_command verbraucht werden
/// darf – ein Agent, der nur noch Tests laufen laesst, soll nicht das ganze
/// Budget einer einzigen Bash-Kette opfern.
const BASH_TIME_BUDGET_MS = 600_000;

export interface ImplementationLoopResult {
  /** Relative Pfade, die tatsaechlich (erfolgreich) geschrieben/geaendert wurden. */
  files: string[];
  /** Am Ende noch unaufgeloeste Ablehnungen (Pfad wurde zuletzt zurueckgewiesen und nie erfolgreich nachgebessert). */
  rejected: { path: string; reason: string }[];
  summary: string;
  notes: string;
  clarification: string;
  clarificationOptions: ClarificationOption[];
  /** false, wenn der Loop ohne "finish" abgebrochen ist (Turn-/Zeitlimit). */
  finished: boolean;
  commitMessage: string;
}

const EMPTY_RESULT: ImplementationLoopResult = {
  files: [],
  rejected: [],
  summary: "",
  notes: "",
  clarification: "",
  clarificationOptions: [],
  finished: false,
  commitMessage: "",
};

export async function runImplementationLoop({
  agent,
  projectId,
  dir,
  ticketId,
  sprintId,
  system,
  initialPrompt,
  maxTokensPerTurn = 4000,
}: {
  agent: Agent;
  projectId: string;
  dir: string;
  ticketId: string;
  sprintId?: string;
  system: string;
  initialPrompt: string;
  maxTokensPerTurn?: number;
}): Promise<ImplementationLoopResult> {
  const ctx: ToolContext = {
    dir,
    projectId,
    createdThisAttempt: new Set(),
    bashTimeUsedMs: 0,
    bashTimeBudgetMs: BASH_TIME_BUDGET_MS,
  };

  const messages: ChatMessage[] = [{ role: "user", content: initialPrompt }];
  const touchedFiles = new Set<string>();
  // Pfad -> letzter Ablehnungsgrund. Ein spaeter im selben Loop erfolgreicher
  // Aufruf auf denselben Pfad loescht den Eintrag wieder – nur was am Ende
  // noch offen ist, gilt als wirklich abgelehnt.
  const rejectedByPath = new Map<string, string>();
  const deadline = Date.now() + LOOP_BUDGET_MS;
  let loggedPrompt = initialPrompt;

  try {
    for (let turn = 1; turn <= MAX_TOOL_TURNS; turn++) {
      const remaining = deadline - Date.now();
      if (remaining <= 5000) break;

      const turnResult = await runAgentTurn({
        agent,
        projectId,
        ticketId,
        sprintId,
        kind: "implementation",
        headline: turn === 1 ? "Setzt das Ticket um" : `Setzt das Ticket um (Schritt ${turn})`,
        system,
        messages,
        loggedPrompt,
        tools: ALL_TOOLS,
        maxTokens: maxTokensPerTurn,
        timeoutMs: Math.min(300_000, remaining),
      });

      const assistantBlocks: ContentBlock[] = [];
      if (turnResult.text.trim()) assistantBlocks.push({ type: "text", text: turnResult.text });
      for (const call of turnResult.toolCalls) {
        assistantBlocks.push({ type: "tool_use", id: call.id, name: call.name, input: call.input });
      }
      messages.push({ role: "assistant", content: assistantBlocks });

      if (turnResult.toolCalls.length === 0) {
        // Nur Text, kein Aufruf – auch keinen "finish". Statt die Schleife
        // wortlos zu beenden, erinnert eine Nutzernachricht an den Auftrag; das
        // Modell bekommt im selben Anlauf die Chance, es richtig zu machen.
        const reminder = "Kein Werkzeugaufruf erkannt. Nutze read_file/list_files/search_files für Kontext, edit_file/write_file für Änderungen, run_command für Tests/Builds – oder finish, wenn alles erledigt ist.";
        messages.push({ role: "user", content: [{ type: "text", text: reminder }] });
        loggedPrompt = `(Erinnerung: ${reminder})`;
        continue;
      }

      // "finish" beendet den Loop sofort – Anweisung im Prompt ist, es nie
      // zusammen mit anderen Werkzeugen im selben Schritt aufzurufen.
      const finishCall = turnResult.toolCalls.find((call) => call.name === "finish");
      if (finishCall) {
        const clarificationRaw = String(finishCall.input.clarification ?? "").trim();
        // Ein Rest aus einem Formatfehler darf kein Ticket blockieren, bis ihn
        // jemand wegklickt – gleiche Mindestlaenge wie im frueheren Blockformat.
        const clarification = clarificationRaw.length >= 15 ? clarificationRaw : "";
        return {
          files: [...touchedFiles],
          rejected: [...rejectedByPath].map(([path, reason]) => ({ path, reason })),
          summary: String(finishCall.input.summary ?? "").trim() || "Ohne Zusammenfassung.",
          notes: String(finishCall.input.notes ?? "").trim(),
          clarification,
          clarificationOptions: clarification ? optionsFromAgent(finishCall.input.clarificationOptions) : [],
          finished: true,
          commitMessage: String(finishCall.input.commitMessage ?? "").trim().slice(0, 120) || "Ticket umgesetzt",
        };
      }

      const toolResultBlocks: ContentBlock[] = [];
      for (const call of turnResult.toolCalls) {
        const execResult = await executeTool(call.name, call.input, ctx);
        if (call.name === "write_file" || call.name === "edit_file") {
          const relPath = String(call.input.path ?? "");
          if (relPath) {
            if (execResult.isError) rejectedByPath.set(relPath, execResult.content);
            else {
              rejectedByPath.delete(relPath);
              touchedFiles.add(relPath);
            }
          }
        }
        toolResultBlocks.push({ type: "tool_result", toolUseId: call.id, content: execResult.content, isError: execResult.isError });
      }
      messages.push({ role: "user", content: toolResultBlocks });
      loggedPrompt = toolResultBlocks
        .map((block) => (block.type === "tool_result" ? `[Ergebnis]\n${block.content}` : ""))
        .join("\n\n");
    }
  } catch (error) {
    // Ein Turn ist mit einem echten Fehler abgebrochen (z.B. Anbieter nicht
    // erreichbar) – nicht nur Turn-/Zeitlimit erreicht. Genau wie unten muss
    // ein angefangener, nicht committeter Stand weg, sonst sieht ein erneuter
    // Anlauf (Requeue durch graphile-worker) fremde Halbarbeit als
    // Ausgangslage. Der eigentliche Fehler zaehlt trotzdem als Fehlschlag des
    // Ticket-Jobs – deshalb wird er nach dem Aufräumen weitergereicht.
    await discardUncommittedChanges(dir).catch(() => {});
    throw error;
  }

  // Turn- oder Zeitlimit erreicht, ohne dass "finish" aufgerufen wurde: wie
  // jeder andere Fehlschlag behandeln (siehe Plan) – kein Sonderfall in
  // ticketWork.ts. Angefangene, nicht committete Schreibvorgänge nicht liegen
  // lassen, sonst baut der naechste Anlauf versehentlich darauf auf.
  await discardUncommittedChanges(dir);
  return EMPTY_RESULT;
}
