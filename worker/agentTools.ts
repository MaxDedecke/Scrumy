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

export interface ToolContext {
  dir: string;
  projectId: string;
  /** Relative Pfade, die dieser Loop-Anlauf selbst per `write_file` angelegt
   *  hat – für die darf ein zweiter `write_file`-Aufruf überschreiben, für
   *  alles andere Bestehende ist `edit_file` Pflicht. */
  createdThisAttempt: Set<string>;
  /** Wie viel Bash-Zeit dieser Ticket-Anlauf insgesamt schon verbraucht hat. */
  bashTimeUsedMs: number;
  /** Obergrenze für die gesamte Bash-Zeit eines Anlaufs. */
  bashTimeBudgetMs: number;
}

export interface ToolResult {
  content: string;
  isError: boolean;
}

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
      const result = await runInSandbox(ctx.projectId, `cd "${workdir}" && ${command}`, {
        containerNamePrefix: "scrumy-agent-bash",
        timeoutMs,
      });
      ctx.bashTimeUsedMs += Date.now() - startedAt;
      if (result.unavailable) {
        return err(`Befehl konnte nicht ausgeführt werden (Sandbox nicht erreichbar): ${result.output}`);
      }
      const status = result.timedOut ? "\n⚠ Zeitlimit erreicht, Befehl abgebrochen." : `\nExit-Code: ${result.exitCode}`;
      const body = `${result.output}${status}`;
      return result.exitCode === 0 && !result.timedOut ? ok(body) : err(body);
    }

    default:
      return err(`Unbekanntes Werkzeug: ${name}`);
  }
}

function messageOf(error: unknown): string {
  return error instanceof WorkspaceError || error instanceof Error ? error.message : String(error);
}
