// Die Werkzeuge des Umsetzer-Agenten – das Gegenstück zu Claude Codes
// Read/Edit/Write/Grep/Bash, zugeschnitten auf ein Ticket in einem
// Projekt-Repo. Jedes Werkzeug prüft seinen eigenen Übergriff (Pfad
// ausserhalb des Repos, Auftragsunterlage, Sandbox-Zeitbudget) und meldet ihn
// als normales Tool-Ergebnis zurück statt die Schleife abzubrechen – ein
// abgelehnter Aufruf ist für das Modell eine Gelegenheit, es im selben Anlauf
// richtig zu machen (siehe worker/agentToolLoop.ts).
import path from "node:path";
import type { ToolDef } from "@/lib/llm";
import { isFrozenDocPath, listTrackedFiles, readRepoFile, safeRepoPath, searchRepo, writeFiles, WorkspaceError } from "@/lib/workspace";
import { runInSandbox } from "@/lib/testRun";
import { runAgentIntegrationCheck, type HttpProbeRequest } from "@/lib/liveStack";
import { browserCheckFailed, formatBrowserProbe, runAgentBrowserCheck, type BrowserStep } from "@/lib/browserCheck";

export interface ToolContext {
  dir: string;
  projectId: string;
  /** Volume-Subpath für die run_command-Sandbox (siehe src/lib/testRun.ts) –
   *  normalerweise `projectId`, bei einem parallel laufenden Ticket (siehe
   *  worker/ticketWorktree.ts) stattdessen der Name von dessen eigenem
   *  Worktree-Geschwisterverzeichnis. MUSS zu `dir` passen, sonst sieht
   *  run_command ein anderes Verzeichnis als read_file/edit_file. */
  workspaceSubpath: string;
  /** Relative Pfade, die dieser Loop-Anlauf selbst per `write_file` angelegt
   *  hat – für die darf ein zweiter `write_file`-Aufruf überschreiben, für
   *  alles andere Bestehende ist `edit_file` Pflicht. */
  createdThisAttempt: Set<string>;
  /** Wie viel Bash-Zeit dieser Ticket-Anlauf insgesamt schon verbraucht hat. */
  bashTimeUsedMs: number;
  /** Obergrenze für die gesamte Bash-Zeit eines Anlaufs. */
  bashTimeBudgetMs: number;
  /** Nur waehrend eines LONG_RUNNING_TOOLS-Aufrufs gesetzt (siehe
   *  worker/agentToolLoop.ts) – von Hand ausgeloester Abbruch (siehe
   *  worker/cancellation.ts), den run_command an seine Docker-Sandbox
   *  durchreicht (src/lib/testRun.ts), um den Container sofort zu killen. */
  cancelSignal?: AbortSignal;
}

export interface ToolResult {
  content: string;
  isError: boolean;
}

/// Werkzeuge, die tatsaechlich einen Shell-/Docker-Prozess starten und auf
/// dessen Ende warten – im Unterschied zu read_file/write_file/etc., die
/// synchron und schnell sind. Der Tool-Loop (worker/agentToolLoop.ts)
/// begleitet nur diese mit einem eigenen "laeuft"-Beleg, weil ein einzelner
/// Aufruf hier Minuten dauern kann (docker compose up --build, Testlauf).
export const LONG_RUNNING_TOOLS = new Set(["run_command", "run_integration_check", "check_in_browser"]);

function ok(content: string): ToolResult {
  return { content, isError: false };
}
function err(content: string): ToolResult {
  return { content, isError: true };
}

function str(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  return typeof value === "string" ? value : "";
}

export const IMPLEMENTATION_TOOLS: ToolDef[] = [
  {
    name: "read_file",
    description: "Liest eine Datei aus dem Repository. Pfad relativ zur Repo-Wurzel.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "z.B. src/beispiel.ts" } },
      required: ["path"],
    },
  },
  {
    name: "list_files",
    description: "Listet alle versionierten Dateien des Repositories (Dateibaum).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "search_files",
    description: "Durchsucht den Inhalt aller versionierten Dateien nach einem Text (wie grep). Gibt Datei:Zeile:Treffer zurück.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "Suchtext, z.B. ein Funktions- oder Feldname" } },
      required: ["query"],
    },
  },
  {
    name: "write_file",
    description: "Legt eine NEUE Datei mit vollständigem Inhalt an. Für bestehende Dateien stattdessen edit_file benutzen.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string", description: "Vollständiger Dateiinhalt" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "edit_file",
    description:
      "Ändert eine bestehende Datei per Suchen/Ersetzen. `search` muss exakt und genau einmal in der Datei vorkommen (inklusive Einrückung) – bei einem Fehltreffer meldet das Werkzeug, ob 0 oder mehrere Stellen passen.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        search: { type: "string", description: "Exakt vorhandener, eindeutiger Ausschnitt" },
        replace: { type: "string", description: "Neuer Ausschnitt (leer erlaubt, um Text zu entfernen)" },
      },
      required: ["path", "search", "replace"],
    },
  },
  {
    name: "run_command",
    description:
      "Führt einen Shell-Befehl im Projektverzeichnis aus (z.B. npm install, npm test, ein Skript). Läuft in einem ressourcenbegrenzten, isolierten Container mit Zeitlimit. Nutze das gezielt, z.B. um nach Änderungen Tests laufen zu lassen.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell-Befehl, z.B. \"npm test\"" },
        cwd: { type: "string", description: "Optional: Unterverzeichnis relativ zur Repo-Wurzel" },
      },
      required: ["command"],
    },
  },
  {
    name: "run_integration_check",
    description:
      `Startet den ECHTEN Docker-Compose-Stack dieses Projekts (Frontend+Backend+DB, wie „Anwendung starten") und kann optional einen HTTP-Request dagegen fahren – inklusive Datei-Upload. ` +
      `Nutze das gezielt bei Fehlern, die NUR im laufenden System auftreten (z.B. aus einem Bug-Ticket „funktioniert nicht beim Testen der Live-Anwendung"), nicht bei jedem Ticket: run_command/Tests laufen in einer einzelnen isolierten Sandbox OHNE Compose-Netz und OHNE Datenbank – ein Fehler, der nur beim Zusammenspiel mehrerer Dienste auftritt, ist damit nicht nachstellbar, und ein Ticket sollte deshalb nicht auf bloßer Vermutung („scheint ein Docker-Problem zu sein") abgeschlossen werden, ohne diesen Check versucht zu haben. ` +
      `Baut den Stack neu (dauert bis zu einigen Minuten), prüft danach Erreichbarkeit, führt bei Angabe von „path" den Request aus und liefert Antwort + die letzten Service-Logs zurück. ` +
      `Kann fehlschlagen, weil gerade ein anderes Projekt live ist – das ist kein Befund über diesen Bug, sondern ein Grund, es später erneut zu versuchen.`,
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Pfad (+Query) für den Test-Request, z.B. \"/api/upload\". Weglassen, um nur zu prüfen, ob der Stack überhaupt hochkommt.",
        },
        method: { type: "string", description: "HTTP-Methode, Standard GET" },
        headers: { type: "object", description: "Zusätzliche Header, z.B. Authorization" },
        bodyText: { type: "string", description: "Rohtext-Körper (z.B. JSON) – nicht zusammen mit uploadFile" },
        uploadFile: {
          type: "object",
          description: "Zum Nachstellen eines Datei-Uploads (multipart/form-data)",
          properties: {
            fieldName: { type: "string", description: "Name des Formularfelds, z.B. \"file\"" },
            fileName: { type: "string" },
            contentType: { type: "string", description: "z.B. \"text/plain\" oder \"image/png\"" },
            content: { type: "string", description: "Textinhalt der Testdatei – reicht für die meisten Upload-Fehler" },
            contentBase64: { type: "string", description: "Alternativ: Base64 für binäre Testdateien" },
            extraFields: { type: "object", description: "Weitere Formularfelder neben der Datei" },
          },
          required: ["fieldName"],
        },
      },
    },
  },
  {
    name: "check_in_browser",
    description:
      `Öffnet eine Seite der LAUFENDEN Anwendung in einem echten Browser (Chromium) und meldet zurück, was dabei bricht: unbehandelte JavaScript-Fehler, im Browser fehlgeschlagene Requests, Konsolenfehler und den sichtbaren Seitentext. ` +
      `Startet dafür denselben Docker-Compose-Stack wie „Anwendung starten"/run_integration_check (dauert bis zu einigen Minuten). ` +
      `Nutze das bei ALLEM, was der Nutzer im Browser sieht: nach Frontend-Änderungen, bei Bug-Meldungen aus der Live-Anwendung („Knopf tut nichts", „Liste bleibt leer", „Upload schlägt fehl") und bevor du ein Frontend-Ticket abschließt. ` +
      `Es ist die einzige Prüfung, die den Unterschied zwischen „Server liefert die Seite aus" und „die Seite funktioniert im Browser" sieht – ein Frontend, das eine interne Adresse wie „http://backend:3000" im Browser-Code anspricht, liefert serverseitig HTTP 200 und scheitert trotzdem bei jedem Nutzer mit ERR_NAME_NOT_RESOLVED. run_integration_check würde das für in Ordnung halten. ` +
      `Mit „steps" kannst du die Seite auch bedienen (klicken, Felder ausfüllen), um eine Ansicht hinter einem Login oder einem Formular zu erreichen. ` +
      `Kann fehlschlagen, weil gerade ein anderes Projekt live ist – das ist kein Befund über deinen Code, sondern ein Grund, es später erneut zu versuchen.`,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Pfad (+Query) der zu prüfenden Seite, z.B. \"/dokumente\". Standard \"/\"." },
        waitForSelector: {
          type: "string",
          description: "Optional: CSS-Selektor, der sichtbar werden muss, bevor die Seite als geladen gilt (z.B. \"table tbody tr\").",
        },
        viewport: { type: "string", description: "\"desktop\" (Standard) oder \"mobile\" für die schmale Breite." },
        steps: {
          type: "array",
          description: "Optional: Bedienschritte nach dem Laden, in dieser Reihenfolge.",
          items: {
            type: "object",
            properties: {
              action: { type: "string", description: "click | fill | press | wait" },
              selector: { type: "string", description: "CSS-Selektor oder Textselektor, z.B. \"text=Anmelden\"" },
              value: { type: "string", description: "Bei fill der Wert, bei press die Taste (Standard Enter)" },
              ms: { type: "number", description: "Nur bei wait: Wartezeit in Millisekunden" },
            },
            required: ["action"],
          },
        },
      },
    },
  },
];

/// Das Werkzeug, das die Schleife beendet – wird nicht über `executeTool`
/// ausgeführt, sondern von worker/agentToolLoop.ts direkt erkannt und
/// validiert (siehe dort). Trotzdem hier definiert, damit alle Tool-Schemas
/// an einer Stelle stehen.
export const FINISH_TOOL: ToolDef = {
  name: "finish",
  description:
    "Beendet die Bearbeitung dieses Tickets. Erst aufrufen, wenn alle nötigen Änderungen über edit_file/write_file gemacht sind (oder, falls nichts zu ändern war, nachdem geprüft wurde).",
  inputSchema: {
    type: "object",
    properties: {
      commitMessage: { type: "string", description: "Betreffzeile im Imperativ, max. 72 Zeichen" },
      summary: { type: "string", description: "2-4 Sätze für den Auftraggeber: was jetzt anders ist und warum" },
      notes: { type: "string", description: "Optional: offene Punkte oder Annahmen" },
      clarification: {
        type: "string",
        description: "Optional: eine einzelne Frage an den Auftraggeber, NUR wenn wirklich nicht selbst entscheidbar",
      },
      clarificationOptions: {
        type: "array",
        description: "Nur zusammen mit clarification: 2-4 fachliche Wege",
        items: {
          type: "object",
          properties: { label: { type: "string" }, detail: { type: "string" } },
          required: ["label"],
        },
      },
    },
    required: ["commitMessage", "summary"],
  },
};

export const ALL_TOOLS: ToolDef[] = [...IMPLEMENTATION_TOOLS, FINISH_TOOL];

export async function executeTool(name: string, input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  switch (name) {
    case "read_file": {
      const relPath = str(input, "path");
      if (!relPath) return err(`Parameter „path" fehlt.`);
      try {
        const content = await readRepoFile(ctx.dir, relPath);
        return content === null ? err(`Datei existiert nicht: ${relPath}`) : ok(content);
      } catch (error) {
        return err(messageOf(error));
      }
    }

    case "list_files": {
      const files = await listTrackedFiles(ctx.dir);
      return ok(files.length > 0 ? files.join("\n") : "(Repository ist noch leer)");
    }

    case "search_files": {
      const query = str(input, "query");
      if (!query) return err(`Parameter „query" fehlt.`);
      return ok(await searchRepo(ctx.dir, query));
    }

    case "write_file": {
      const relPath = str(input, "path");
      const content = str(input, "content");
      if (!relPath) return err(`Parameter „path" fehlt.`);
      if (!content.trim()) return err(`Parameter „content" ist leer – eine leere Datei ist meist ein Versehen.`);
      try {
        safeRepoPath(ctx.dir, relPath);
      } catch (error) {
        return err(messageOf(error));
      }
      if (isFrozenDocPath(relPath)) {
        return err(`„${relPath}" ist eine Auftragsunterlage (Konzept/Anforderungen/Sprints) – die wird von Umsetzern nicht geändert.`);
      }
      const exists = (await readRepoFile(ctx.dir, relPath)) !== null;
      if (exists && !ctx.createdThisAttempt.has(relPath)) {
        return err(`„${relPath}" existiert bereits – für bestehende Dateien edit_file benutzen.`);
      }
      await writeFiles(ctx.dir, [{ path: relPath, content }]);
      ctx.createdThisAttempt.add(relPath);
      return ok(`„${relPath}" geschrieben (${content.length} Zeichen).`);
    }

    case "edit_file": {
      const relPath = str(input, "path");
      const search = str(input, "search");
      const replace = input.replace !== undefined ? str(input, "replace") : "";
      if (!relPath || !search) return err(`Parameter „path" und „search" sind Pflicht.`);
      try {
        safeRepoPath(ctx.dir, relPath);
      } catch (error) {
        return err(messageOf(error));
      }
      if (isFrozenDocPath(relPath)) {
        return err(`„${relPath}" ist eine Auftragsunterlage (Konzept/Anforderungen/Sprints) – die wird von Umsetzern nicht geändert.`);
      }
      const current = await readRepoFile(ctx.dir, relPath);
      if (current === null) {
        return err(`„${relPath}" existiert nicht – für neue Dateien write_file benutzen.`);
      }
      const occurrences = current.split(search).length - 1;
      if (occurrences === 0) {
        return err(`„search" wurde in „${relPath}" nicht gefunden. Lies die Datei erneut und kopiere den Ausschnitt zeichengenau, inklusive Einrückung.`);
      }
      if (occurrences > 1) {
        return err(`„search" kommt in „${relPath}" ${occurrences}-mal vor, muss aber eindeutig sein. Gib mehr umgebenden Kontext mit.`);
      }
      await writeFiles(ctx.dir, [{ path: relPath, content: current.replace(search, replace) }]);
      return ok(`„${relPath}" geändert.`);
    }

    case "run_command": {
      const command = str(input, "command");
      if (!command.trim()) return err(`Parameter „command" fehlt.`);
      if (ctx.bashTimeUsedMs >= ctx.bashTimeBudgetMs) {
        return err("Bash-Zeitbudget für dieses Ticket ist aufgebraucht – keine weiteren Befehle in diesem Anlauf.");
      }
      const cwdInput = str(input, "cwd");
      let workdir = "/workspaces";
      if (cwdInput) {
        try {
          // Nutzt dieselbe Pfadprüfung wie Datei-Werkzeuge, nur um die
          // Sandbox-Arbeitsverzeichnis-Angabe zu validieren, nicht um zu lesen.
          safeRepoPath(ctx.dir, cwdInput);
          workdir = path.posix.join("/workspaces", cwdInput);
        } catch (error) {
          return err(messageOf(error));
        }
      }
      const remainingBudget = ctx.bashTimeBudgetMs - ctx.bashTimeUsedMs;
      const requestedTimeout = 120_000;
      const timeoutMs = Math.max(1000, Math.min(requestedTimeout, remainingBudget));
      const startedAt = Date.now();
      const result = await runInSandbox(ctx.workspaceSubpath, `cd "${workdir}" && ${command}`, {
        containerNamePrefix: "scrumy-agent-bash",
        timeoutMs,
        signal: ctx.cancelSignal,
      });
      ctx.bashTimeUsedMs += Date.now() - startedAt;
      if (result.unavailable) {
        return err(`Befehl konnte nicht ausgeführt werden (Sandbox nicht erreichbar): ${result.output}`);
      }
      const status = result.timedOut ? "\n⚠ Zeitlimit erreicht, Befehl abgebrochen." : `\nExit-Code: ${result.exitCode}`;
      const body = `${result.output}${status}`;
      return result.exitCode === 0 && !result.timedOut ? ok(body) : err(body);
    }

    case "run_integration_check": {
      if (ctx.bashTimeUsedMs >= ctx.bashTimeBudgetMs) {
        return err("Bash-/Sandbox-Zeitbudget für dieses Ticket ist aufgebraucht – keine weiteren Prüfungen in diesem Anlauf.");
      }
      const relPath = str(input, "path");
      const headersInput = input.headers;
      const headers =
        headersInput && typeof headersInput === "object" && !Array.isArray(headersInput)
          ? (headersInput as Record<string, string>)
          : undefined;
      const uploadInput = input.uploadFile;
      let uploadFile: HttpProbeRequest["uploadFile"];
      if (uploadInput && typeof uploadInput === "object") {
        const upload = uploadInput as Record<string, unknown>;
        const fieldName = str(upload, "fieldName");
        if (!fieldName) return err(`„uploadFile.fieldName" fehlt.`);
        uploadFile = {
          fieldName,
          fileName: str(upload, "fileName") || undefined,
          contentType: str(upload, "contentType") || undefined,
          content: str(upload, "content") || undefined,
          contentBase64: str(upload, "contentBase64") || undefined,
          extraFields:
            upload.extraFields && typeof upload.extraFields === "object"
              ? (upload.extraFields as Record<string, string>)
              : undefined,
        };
      }
      const request: HttpProbeRequest | null = relPath
        ? { path: relPath, method: str(input, "method") || undefined, headers, bodyText: str(input, "bodyText") || undefined, uploadFile }
        : null;

      // Grosszuegigeres, aber vom selben Zeitbudget gedecktes Zeitlimit als
      // run_command: ein "docker compose up --build" braucht spuerbar laenger
      // als ein einzelner Testlauf. Nie mehr als das verbleibende Restbudget.
      const remainingBudget = ctx.bashTimeBudgetMs - ctx.bashTimeUsedMs;
      const timeoutMs = Math.max(30_000, Math.min(5 * 60_000, remainingBudget));
      const startedAt = Date.now();
      const result = await runAgentIntegrationCheck(ctx.projectId, request, { timeoutMs });
      ctx.bashTimeUsedMs += Date.now() - startedAt;

      if (!result.reachable) {
        return err(`Stack nicht erreichbar/geprüft: ${result.blockedReason ?? "unbekannter Grund"}${result.logs ? `\n\nLog:\n${result.logs}` : ""}`);
      }
      const probeText = result.probe
        ? result.probe.ok
          ? `\n\nRequest-Ergebnis: HTTP ${result.probe.status} ${result.probe.statusText ?? ""}\nAntwort:\n${result.probe.body ?? ""}`
          : `\n\nRequest fehlgeschlagen: ${result.probe.error ?? "unbekannter Fehler"}`
        : "";
      const body = `Stack erreichbar (Port ${result.port}).${probeText}\n\nService-Logs (letzte Zeilen):\n${result.logs}`;
      return result.probe && !result.probe.ok ? err(body) : ok(body);
    }

    case "check_in_browser": {
      if (ctx.bashTimeUsedMs >= ctx.bashTimeBudgetMs) {
        return err("Bash-/Sandbox-Zeitbudget für dieses Ticket ist aufgebraucht – keine weiteren Prüfungen in diesem Anlauf.");
      }
      const stepsInput = Array.isArray(input.steps) ? input.steps : [];
      const steps: BrowserStep[] = [];
      for (const entry of stepsInput) {
        if (!entry || typeof entry !== "object") continue;
        const step = entry as Record<string, unknown>;
        const action = str(step, "action").toLowerCase();
        if (action !== "click" && action !== "fill" && action !== "press" && action !== "wait") {
          return err(`Unbekannte Aktion „${action}" in „steps" – erlaubt sind click, fill, press, wait.`);
        }
        if (action !== "wait" && !str(step, "selector")) {
          return err(`„selector" fehlt bei einem „${action}"-Schritt.`);
        }
        steps.push({
          action,
          selector: str(step, "selector") || undefined,
          value: str(step, "value") || undefined,
          ms: typeof step.ms === "number" ? step.ms : undefined,
        });
      }

      const viewportInput = str(input, "viewport").toLowerCase();
      // Ein Browser-Start samt Compose-Build braucht dieselbe Groessenordnung
      // wie run_integration_check und zahlt auf dasselbe Zeitbudget ein.
      const remainingBudget = ctx.bashTimeBudgetMs - ctx.bashTimeUsedMs;
      const timeoutMs = Math.max(30_000, Math.min(5 * 60_000, remainingBudget));
      const startedAt = Date.now();
      const result = await runAgentBrowserCheck(
        ctx.projectId,
        {
          path: str(input, "path") || undefined,
          waitForSelector: str(input, "waitForSelector") || undefined,
          viewport: viewportInput === "mobile" ? "mobile" : "desktop",
          steps,
        },
        { timeoutMs },
      );
      ctx.bashTimeUsedMs += Date.now() - startedAt;

      if (!result.reachable || !result.probe) {
        return err(
          `Anwendung nicht im Browser prüfbar: ${result.blockedReason ?? "unbekannter Grund"}` +
            `${result.logs ? `\n\nLog:\n${result.logs}` : ""}`,
        );
      }

      const body =
        `${formatBrowserProbe(result.probe)}\n\nService-Logs (letzte Zeilen):\n${result.logs}`;
      return browserCheckFailed(result.probe) ? err(body) : ok(body);
    }

    default:
      return err(`Unbekanntes Werkzeug: ${name}`);
  }
}

function messageOf(error: unknown): string {
  return error instanceof WorkspaceError || error instanceof Error ? error.message : String(error);
}
