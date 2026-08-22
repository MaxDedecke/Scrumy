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
import { AgentRunError, runAgentTurn, runTrackedTool } from "./agentRun";
import { ALL_TOOLS, executeTool, LONG_RUNNING_TOOLS, type ToolContext } from "./agentTools";

/// Jeder Turn ist gezielt (ein Werkzeugaufruf, eine Antwort) – deutlich
/// grosszuegiger als frueher noetig, wo ein einzelner Aufruf die ganze
/// Umsetzung tragen musste.
///
/// 20 war bei kleineren/lokalen Modellen (u.a. qwen3-coder über RunPod) zu
/// knapp: 12-13 Turns gehen dort oft fürs reine Erkunden drauf (list/read/
/// search), bevor überhaupt geschrieben wird – bei ~3-5s je Turn bleibt im
/// 15-Minuten-Budget (siehe LOOP_BUDGET_MS) reichlich Luft nach oben, ohne
/// die Zielsetzung ("gezielt, ein Aufruf pro Turn") aufzugeben.
const MAX_TOOL_TURNS = 50;
/// Gesamtbudget ueber alle Turns UND Bash-Aufrufe zusammen, entspricht dem
/// bisherigen Zeitlimit des einzelnen Umsetzungs-Aufrufs.
const LOOP_BUDGET_MS = 900_000;
/// Anteil des Gesamtbudgets, der maximal in run_command verbraucht werden
/// darf – ein Agent, der nur noch Tests laufen laesst, soll nicht das ganze
/// Budget einer einzigen Bash-Kette opfern.
const BASH_TIME_BUDGET_MS = 600_000;
/// Ab diesem Schritt bekommt ein Anlauf, der noch nichts geschrieben hat, eine
/// Erinnerung an sein Budget. Beobachtet: Zwei Drittel aller Werkzeugaufrufe
/// waren Lesen (293 read_file gegen 96 Schreibaufrufe), und knapp die Haelfte
/// aller Anlaeufe lief ins Limit, ohne je etwas zu aendern – der Agent merkt
/// von sich aus nicht, dass ihm die Schritte ausgehen.
const NUDGE_AFTER_TURN = 28;
/// So viele Schritte vor Schluss wird zum Abschluss aufgefordert. Ohne diese
/// letzte Runde endet ein Anlauf am Limit stumm, und `discardUncommittedChanges`
/// wirft auch fertige Arbeit weg – ein "finish" mit dem, was da ist, ist immer
/// besser als ein verworfener Anlauf.
const LAST_CALL_TURNS = 3;
/// Anteil des Zeitbudgets, ab dem dieselbe Schlussaufforderung greift – ein
/// Anlauf kann auch an der Zeit sterben, lange bevor die Schritte alle sind.
const LAST_CALL_TIME_FRACTION = 0.85;
/// Mindest-Restzeit, um einen weiteren Turn ueberhaupt erst zu versuchen. Bei
/// 5s (der alte Wert) wurde im Timeless-Projekt wiederholt ein Turn mit einem
/// auf wenige Sekunden zusammengeschrumpften `timeoutMs` gestartet (siehe
/// `Math.min(600_000, remaining)` unten) – ein Modellaufruf, der so gut wie
/// garantiert per Timeout scheitert, noch bevor der Anbieter ueberhaupt
/// antworten koennte. Besser: den Anlauf sauber ueber die Restzeit-Erinnerung
/// (`budgetNote`, LAST_CALL_TIME_FRACTION) auslaufen lassen, statt einen
/// letzten, zum Scheitern verurteilten Aufruf zu verbrennen.
const MIN_TURN_TIMEOUT_MS = 45_000;

/// Werkzeuge, deren Ergebnis sich innerhalb eines Anlaufs nur aendert, wenn
/// jemand schreibt. Nur die kommen aus dem Zwischenspeicher: `run_command`
/// gehoert bewusst nicht dazu (Tests nach einer Aenderung erneut laufen zu
/// lassen ist der Sinn der Sache), `edit_file`/`write_file` erst recht nicht.
const REPLAYABLE_TOOLS = new Set(["read_file", "list_files", "search_files"]);

/// Was ein Anlauf getan hat – rein zur Diagnose, unabhaengig davon, ob er
/// erfolgreich war. Ein gescheiterter Anlauf liefert keine `files` (sein
/// Arbeitsstand wird verworfen), sein Weg ist fuer den naechsten Anlauf aber
/// das Wertvollste ueberhaupt: Ohne ihn liest der naechste dieselben Dateien
/// noch einmal und landet in derselben Sackgasse (siehe
/// worker/tasks/ticketWork.ts, "Bisherige Anlaeufe").
export interface AttemptTrace {
  /** Wie viele Modell-Turns der Anlauf gebraucht hat. */
  turns: number;
  /** Dateien, die der Anlauf gelesen hat (in Lesereihenfolge, ohne Dubletten). */
  read: string[];
  /** Suchbegriffe aus search_files. */
  searched: string[];
  /** Ausgefuehrte Shell-Befehle. */
  commands: string[];
  /** Erfolgreich geschriebene Pfade – auch bei einem abgebrochenen Anlauf, wo
   *  sie anschliessend verworfen werden. */
  wrote: string[];
  /** Letzte Wortmeldung des Modells, gekuerzt – meist seine Begruendung. */
  lastText: string;
  /** Wie oft der Agent einen lesenden Aufruf wiederholt hat, den er im selben
   *  Anlauf schon gemacht hatte (siehe REPLAYABLE_TOOLS). Hoher Wert heisst:
   *  Der Agent dreht sich im Kreis, statt zu arbeiten. */
  replayed: number;
}

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
  /** Immer gefuellt, auch bei einem abgebrochenen Anlauf. */
  trace: AttemptTrace;
}

/// Der Hinweis, der einem Werkzeug-Ergebnis angehaengt wird, wenn das Budget
/// knapp wird. Bewusst am letzten Tool-Ergebnis statt als eigener Textblock:
/// Ein Anbieter darf zwischen Werkzeugaufruf und Ergebnis keine fremde
/// Nachricht sehen, der Text im Ergebnis kommt ueberall gleich an.
function budgetNote(input: { turn: number; wroteSomething: boolean; remainingMs: number }): string {
  const turnsLeft = MAX_TOOL_TURNS - input.turn;
  const timeIsUp = input.remainingMs <= LOOP_BUDGET_MS * (1 - LAST_CALL_TIME_FRACTION);

  if (turnsLeft <= LAST_CALL_TURNS || timeIsUp) {
    return (
      `\n\n[Scrumy] Letzte Runde: ${turnsLeft <= LAST_CALL_TURNS ? `noch ${Math.max(turnsLeft, 0)} Schritt(e)` : "die Zeit ist gleich um"}. ` +
      `Ruf JETZT "finish" auf – mit dem, was du hast. ` +
      (input.wroteSomething
        ? "Deine Änderungen sind sonst verloren: Ein Anlauf ohne finish wird komplett verworfen."
        : "Wenn du nichts ändern konntest, schreib in \"summary\", woran es lag und was du geprüft hast.")
    );
  }

  if (input.turn >= NUDGE_AFTER_TURN && !input.wroteSomething) {
    return (
      `\n\n[Scrumy] Schritt ${input.turn} von ${MAX_TOOL_TURNS}, und noch keine einzige Änderung geschrieben. ` +
      `Hör auf zu lesen und fang an zu ändern (edit_file/write_file) – ein Anlauf, der nur liest, endet ohne Ergebnis und zählt trotzdem als Versuch.`
    );
  }

  return "";
}

export async function runImplementationLoop({
  agent,
  projectId,
  dir,
  workspaceSubpath = projectId,
  ticketId,
  sprintId,
  system,
  initialPrompt,
  maxTokensPerTurn = 4000,
}: {
  agent: Agent;
  projectId: string;
  dir: string;
  /** Siehe `ToolContext.workspaceSubpath` – Standard `projectId` (Normalfall:
   *  `dir` ist das Hauptverzeichnis des Projekts). */
  workspaceSubpath?: string;
  ticketId: string;
  sprintId?: string;
  system: string;
  initialPrompt: string;
  maxTokensPerTurn?: number;
}): Promise<ImplementationLoopResult> {
  const ctx: ToolContext = {
    dir,
    projectId,
    workspaceSubpath,
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

  // Mitschrift des Anlaufs (siehe AttemptTrace). Sets statt Arrays: Dass eine
  // Datei dreimal gelesen wurde, hilft dem naechsten Anlauf nicht – dass sie
  // ueberhaupt gelesen wurde, schon.
  const readFiles = new Set<string>();
  const searched = new Set<string>();
  const commands: string[] = [];
  // Ergebnisse lesender Aufrufe innerhalb dieses Anlaufs. Beobachtet wurde
  // dieselbe Datei 33 Mal gelesen und `list_files` 51 Mal aufgerufen – jedes
  // Mal Modellzeit, Kontext und ein verbrauchter Schritt fuer eine Antwort,
  // die der Agent schon hatte.
  const replayCache = new Map<string, { content: string; turn: number }>();
  let replayedCalls = 0;
  let turnsUsed = 0;
  let lastText = "";
  const trace = (): AttemptTrace => ({
    turns: turnsUsed,
    read: [...readFiles],
    searched: [...searched],
    commands,
    wrote: [...touchedFiles],
    lastText: lastText.slice(0, 600),
    replayed: replayedCalls,
  });

  try {
    for (let turn = 1; turn <= MAX_TOOL_TURNS; turn++) {
      const remaining = deadline - Date.now();
      if (remaining <= MIN_TURN_TIMEOUT_MS) break;

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
        timeoutMs: Math.min(600_000, remaining),
        // Wie bei sprint_planning: OpenRouter routet dieses Profil ueber
        // viele Anbieter mit stark schwankendem Durchsatz (siehe Kommentar in
        // src/lib/llm.ts) – ohne das sortiert es zufaellig, auch auf einen
        // gerade langsamen Anbieter, was hier wiederholt einzelne Turns
        // 60-360s statt weniger Sekunden kosten liess.
        preferThroughput: true,
      });

      turnsUsed = turn;
      if (turnResult.text.trim()) lastText = turnResult.text.trim();

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
          trace: trace(),
        };
      }

      const toolResultBlocks: ContentBlock[] = [];
      for (const call of turnResult.toolCalls) {
        const cacheKey = `${call.name}:${JSON.stringify(call.input)}`;
        const cached = REPLAYABLE_TOOLS.has(call.name) ? replayCache.get(cacheKey) : undefined;

        let execResult;
        if (cached) {
          replayedCalls++;
          execResult = {
            content:
              `${cached.content}\n\n[Scrumy] Genau diesen Aufruf hattest du in Schritt ${cached.turn} schon; ` +
              `seitdem hat sich an der Datei nichts geändert, das Ergebnis ist unverändert. ` +
              `Arbeite damit weiter, statt es noch einmal abzufragen – dieser Schritt ist trotzdem verbraucht.`,
            isError: false,
          };
        } else if (LONG_RUNNING_TOOLS.has(call.name)) {
          // run_command/run_integration_check koennen Minuten blockieren
          // (Docker-Build, Testlauf) – ohne eigenen Beleg waere der Agent fuer
          // diese ganze Zeit weder im Buero als aktiv noch in den Nachweisen
          // als "laeuft" sichtbar (siehe runTrackedTool in worker/agentRun.ts).
          execResult = await runTrackedTool(
            {
              agent,
              projectId,
              ticketId,
              sprintId,
              kind: "implementation",
              headline:
                call.name === "run_command"
                  ? `Führt Befehl aus: ${String(call.input.command ?? "").slice(0, 80)}`
                  : "Prüft die laufende Anwendung",
              prompt: `→ ${call.name}(${JSON.stringify(call.input)})`,
            },
            // Das Signal an ctx haengen statt ein neues ctx-Objekt zu
            // spreaden: ctx wird von executeTool mutiert (u.a.
            // bashTimeUsedMs), eine Kopie wuerde diese Mutation fuer den Rest
            // des Loops verlieren.
            (signal) => {
              ctx.cancelSignal = signal;
              return executeTool(call.name, call.input, ctx);
            },
          );
        } else {
          execResult = await executeTool(call.name, call.input, ctx);
          if (REPLAYABLE_TOOLS.has(call.name) && !execResult.isError) {
            replayCache.set(cacheKey, { content: execResult.content, turn });
          }
        }

        if (call.name === "read_file") readFiles.add(String(call.input.path ?? ""));
        if (call.name === "search_files") searched.add(String(call.input.query ?? ""));
        if (call.name === "run_command") commands.push(String(call.input.command ?? "").slice(0, 120));
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
        // Nach einem Schreibzugriff stimmt kein gespeichertes Leseergebnis mehr
        // – weder der Dateiinhalt noch Dateibaum oder Suchtreffer. Lieber alles
        // verwerfen als dem Agenten seinen eigenen alten Stand vorzuhalten.
        if ((call.name === "write_file" || call.name === "edit_file") && !execResult.isError) {
          replayCache.clear();
        }
        // `run_command` darf ebenfalls schreiben (npm install, Generatoren).
        if (call.name === "run_command") replayCache.clear();

        toolResultBlocks.push({ type: "tool_result", toolUseId: call.id, content: execResult.content, isError: execResult.isError });
      }

      // Budgethinweis an das letzte Ergebnis haengen, damit der Agent
      // mitbekommt, wo er steht (siehe budgetNote).
      const note = budgetNote({ turn, wroteSomething: touchedFiles.size > 0, remainingMs: deadline - Date.now() });
      const lastBlock = toolResultBlocks[toolResultBlocks.length - 1];
      if (note && lastBlock?.type === "tool_result") lastBlock.content += note;

      messages.push({ role: "user", content: toolResultBlocks });
      loggedPrompt = toolResultBlocks
        .map((block) => (block.type === "tool_result" ? `[Ergebnis]\n${block.content}` : ""))
        .join("\n\n");
    }
  } catch (error) {
    // Ein Turn ist mit einem echten Fehler abgebrochen – nicht nur Turn-/
    // Zeitlimit erreicht. Zwei grundverschiedene Fälle:
    //
    // 1. Der Anbieter selbst hat versagt (nicht erreichbar, 429/5xx, kaputtes
    //    JSON – siehe LlmError.code "TRANSPORT" in src/lib/llm.ts). Das sagt
    //    nichts über die bis dahin per write_file/edit_file geschriebenen
    //    Dateien aus – die sind echte, erfolgreich ausgeführte Werkzeug-
    //    aufrufe, keine Halbarbeit. Sie zu verwerfen, nur weil der NÄCHSTE
    //    API-Aufruf rate-limitiert wurde, kostet den Fortschritt ohne Grund:
    //    beobachtet im Drapbox-Projekt, wo dieselbe package.json-Korrektur
    //    neun Anläufe lang immer wieder vom 429 der nächsten Anfrage
    //    weggeworfen wurde, statt jemals committet zu werden.
    // 2. Alles andere (Bug im eigenen Code, kaputter Zustand) – da bleibt es
    //    beim bisherigen Verhalten: angefangener, nicht committeter Stand
    //    weg, sonst sieht ein erneuter Anlauf (Requeue durch graphile-worker)
    //    fremde Halbarbeit als Ausgangslage.
    //
    // Der eigentliche Fehler zaehlt in beiden Faellen trotzdem als
    // Fehlschlag des Ticket-Jobs – deshalb wird er nach dem Aufräumen
    // weitergereicht.
    const isTransportFailure = error instanceof AgentRunError && error.code === "TRANSPORT";
    if (!isTransportFailure) {
      await discardUncommittedChanges(dir).catch(() => {});
    }
    // Der Weg bis zum Absturz ist fuer den naechsten Anlauf genauso wertvoll
    // wie bei einem regulaeren Fehlschlag – ticketWork liest ihn hier ab.
    (error as { attemptTrace?: AttemptTrace }).attemptTrace = trace();
    throw error;
  }

  // Turn- oder Zeitlimit erreicht, ohne dass "finish" aufgerufen wurde: wie
  // jeder andere Fehlschlag behandeln (siehe Plan) – kein Sonderfall in
  // ticketWork.ts. Angefangene, nicht committete Schreibvorgänge nicht liegen
  // lassen, sonst baut der naechste Anlauf versehentlich darauf auf.
  await discardUncommittedChanges(dir);
  return {
    files: [],
    rejected: [],
    summary: "",
    notes: "",
    clarification: "",
    clarificationOptions: [],
    finished: false,
    commitMessage: "",
    trace: trace(),
  };
}
