// Das Auge des Teams: ein echter Chromium, der die laufende Anwendung eines
// Projekts so aufruft, wie ein Mensch sie aufruft – Gegenstueck zu
// runAgentIntegrationCheck in src/lib/liveStack.ts, das nur einen HTTP-Request
// von aussen faehrt.
//
// Warum das eine eigene Pruefung ist und nicht in der HTTP-Probe aufgeht: Ein
// Frontend, das im Browser-JavaScript einen internen Compose-Servicenamen fest
// verdrahtet ("http://backend:3000"), liefert serverseitig ein sauberes HTTP
// 200 – das Dokument wird ja ausgeliefert. Kaputt ist erst der Nachladeversuch
// IM Browser des Nutzers ("ERR_NAME_NOT_RESOLVED"), und den sieht nur, wer die
// Seite wirklich rendert. Dasselbe gilt fuer jeden JavaScript-Fehler, jede
// leere Ansicht und jeden fehlgeschlagenen fetch nach dem ersten Rendern.
//
// Laeuft im selben Muster wie runHttpProbe: eigener, ressourcenbegrenzter
// Sibling-Container aus einem festen Image (docker/browser-runner.Dockerfile)
// mit "--network host", damit der veroeffentlichte Port des Compose-Stacks
// ueber 127.0.0.1 erreichbar ist. Kein Workspace-Volume – der Browser liest
// keine Projektdateien, er ruft nur eine Adresse auf.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { withRunningStack } from "@/lib/liveStack";

const execFileAsync = promisify(execFile);

function browserRunnerImage(): string {
  return process.env.BROWSER_RUNNER_IMAGE || "scrumy-browser-runner";
}

/// Ein einzelner Bedienschritt nach dem Laden der Seite. Bewusst klein
/// gehalten: Es geht darum, eine Ansicht ueberhaupt zu erreichen (einloggen,
/// Formular abschicken, Tab oeffnen), nicht darum, eine vollstaendige
/// E2E-Testsprache nachzubauen – dafuer gibt es die Testsuite im Projekt.
export interface BrowserStep {
  action: "click" | "fill" | "press" | "wait";
  /// CSS-Selektor oder Playwright-Textselektor, z.B. "text=Anmelden".
  selector?: string;
  /// Bei "fill" der einzutragende Wert, bei "press" die Taste (z.B. "Enter").
  value?: string;
  /// Nur bei "wait": Wartezeit in Millisekunden.
  ms?: number;
}

export interface BrowserProbeRequest {
  /// Pfad + Query, z.B. "/dokumente?tab=neu". Standard "/".
  path?: string;
  /// Auf dieses Element warten, bevor die Seite als geladen gilt.
  waitForSelector?: string;
  steps?: BrowserStep[];
  /// "mobile" prueft die schmale Breite (Sidebar eingeklappt/Off-Canvas).
  viewport?: "desktop" | "mobile";
}

export interface BrowserProbeResult {
  /// Seite geladen, Dokument-Status < 400, keine unbehandelten Seitenfehler
  /// und kein fehlgeschlagener Bedienschritt. Konsolen-/Netzwerkfehler machen
  /// die Pruefung NICHT automatisch rot – die bewertet der Agent selbst, weil
  /// ein einzelner 404 auf ein Favicon kein Mangel ist.
  ok: boolean;
  /// Gesetzt, wenn ueberhaupt kein Ergebnis zustande kam (Browser nicht
  /// startbar, Zeitlimit) – wie `unavailable` anderswo: kein Befund ueber den
  /// Code, sondern ueber die Umgebung.
  error?: string;
  url?: string;
  status?: number;
  title?: string;
  /// Sichtbarer Text der Seite, gekuerzt – zeigt dem Agenten, ob die Ansicht
  /// wirklich Inhalt hat oder nur ein leeres Grundgeruest.
  text?: string;
  consoleErrors: string[];
  pageErrors: string[];
  failedRequests: string[];
  stepResults: string[];
}

/// Laeuft IM Container (per "node -e"). Konfiguration kommt ueber Environment,
/// das Ergebnis als eine JSON-Zeile auf stdout – dasselbe Muster wie
/// PROBE_SCRIPT in src/lib/liveStack.ts.
const BROWSER_SCRIPT = `
const { chromium } = require("playwright-core");

const config = JSON.parse(Buffer.from(process.env.CHECK_CONFIG_B64 || "", "base64").toString("utf8"));
const MAX_TEXT = 3000;
const MAX_ITEMS = 25;

function clip(list) {
  const unique = [...new Set(list)];
  if (unique.length <= MAX_ITEMS) return unique;
  return unique.slice(0, MAX_ITEMS).concat(["… (" + (unique.length - MAX_ITEMS) + " weitere)"]);
}

async function main() {
  const consoleErrors = [];
  const pageErrors = [];
  const failedRequests = [];
  const stepResults = [];
  let browser;

  try {
    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium-browser",
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    const context = await browser.newContext({
      viewport: config.viewport === "mobile" ? { width: 390, height: 844 } : { width: 1280, height: 800 },
    });
    const page = await context.newPage();

    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (error) => pageErrors.push(String(error && error.message ? error.message : error)));
    page.on("requestfailed", (request) => {
      const failure = request.failure();
      failedRequests.push(request.method() + " " + request.url() + " – " + (failure ? failure.errorText : "unbekannt"));
    });

    const response = await page.goto(config.url, { waitUntil: "domcontentloaded", timeout: config.gotoTimeoutMs });
    const status = response ? response.status() : undefined;

    if (config.waitForSelector) {
      try {
        await page.waitForSelector(config.waitForSelector, { timeout: 10000, state: "visible" });
      } catch (error) {
        stepResults.push('✗ warten auf "' + config.waitForSelector + '": nicht innerhalb von 10s sichtbar geworden');
      }
    }

    // Kurz nachlaufen lassen: Die interessanten Fehler (fetch nach dem ersten
    // Rendern, Hydration, verzoegerte Konsolenausgaben) entstehen erst NACH
    // "domcontentloaded". "networkidle" waere hier falsch – eine Anwendung mit
    // Polling oder offener WebSocket-Verbindung wird nie idle.
    await page.waitForTimeout(2000);

    for (const step of config.steps || []) {
      const label = step.action + (step.selector ? ' "' + step.selector + '"' : "");
      try {
        if (step.action === "wait") {
          await page.waitForTimeout(Math.min(Number(step.ms) || 1000, 15000));
        } else if (step.action === "click") {
          await page.click(step.selector, { timeout: 10000 });
        } else if (step.action === "fill") {
          await page.fill(step.selector, step.value == null ? "" : String(step.value), { timeout: 10000 });
        } else if (step.action === "press") {
          await page.press(step.selector, step.value || "Enter", { timeout: 10000 });
        } else {
          stepResults.push("✗ " + label + ": unbekannte Aktion");
          continue;
        }
        await page.waitForTimeout(750);
        stepResults.push("✓ " + label);
      } catch (error) {
        stepResults.push("✗ " + label + ": " + (error && error.message ? error.message.split("\\n")[0] : String(error)));
      }
    }

    let text = "";
    try {
      text = await page.locator("body").innerText({ timeout: 5000 });
    } catch (error) {
      text = "(kein sichtbarer Text – Seite hat keinen gerenderten Body)";
    }
    if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT) + "\\n… (gekürzt)";

    const failedStep = stepResults.some((entry) => entry.startsWith("✗"));
    console.log(JSON.stringify({
      ok: Boolean(response) && (status === undefined || status < 400) && pageErrors.length === 0 && !failedStep,
      url: page.url(),
      status,
      title: await page.title().catch(() => ""),
      text,
      consoleErrors: clip(consoleErrors),
      pageErrors: clip(pageErrors),
      failedRequests: clip(failedRequests),
      stepResults,
    }));
  } catch (error) {
    console.log(JSON.stringify({
      ok: false,
      error: error && error.message ? error.message : String(error),
      consoleErrors: clip(consoleErrors),
      pageErrors: clip(pageErrors),
      failedRequests: clip(failedRequests),
      stepResults,
    }));
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

main();
`;

function emptyResult(error: string): BrowserProbeResult {
  return { ok: false, error, consoleErrors: [], pageErrors: [], failedRequests: [], stepResults: [] };
}

/// Ruft eine Seite der laufenden Anwendung in einem echten Browser auf.
/// `port` ist der veroeffentlichte Port des Compose-Stacks (siehe
/// getLiveStackInfo), erreichbar ueber 127.0.0.1 dank "--network host".
export async function runBrowserProbe(
  port: number,
  request: BrowserProbeRequest,
  timeoutMs = 60_000,
): Promise<BrowserProbeResult> {
  const relPath = request.path && request.path.trim() ? request.path.trim() : "/";
  const url = `http://127.0.0.1:${port}${relPath.startsWith("/") ? relPath : `/${relPath}`}`;
  const containerName = `scrumy-browser-${port}-${Date.now()}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 128);

  const config = {
    url,
    waitForSelector: request.waitForSelector,
    steps: request.steps ?? [],
    viewport: request.viewport ?? "desktop",
    // Das Laden selbst bekommt hoechstens die Haelfte des Gesamtbudgets, damit
    // fuer Bedienschritte und das Einsammeln der Befunde noch Zeit bleibt.
    gotoTimeoutMs: Math.max(10_000, Math.floor(timeoutMs / 2)),
  };

  const args = [
    "run",
    "--rm",
    "--name",
    containerName,
    "--network",
    "host",
    // Chromium braucht spuerbar mehr als die 256m der HTTP-Probe.
    "--memory",
    "1g",
    "--cpus",
    "2",
    "--pids-limit",
    "512",
    "-e",
    `CHECK_CONFIG_B64=${Buffer.from(JSON.stringify(config), "utf8").toString("base64")}`,
    browserRunnerImage(),
    "-e",
    BROWSER_SCRIPT,
  ];

  try {
    const { stdout } = await execFileAsync("docker", args, { timeout: timeoutMs + 10_000, maxBuffer: 4 * 1024 * 1024 });
    const line = stdout.trim().split("\n").pop() ?? "";
    return JSON.parse(line) as BrowserProbeResult;
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stdout?: string };
    // Wie bei runHttpProbe: Wenn das Skript sein Ergebnis schon geschrieben
    // hat, ist es aussagekraeftiger als der rohe docker-Fehler.
    const line = (failure.stdout ?? "").trim().split("\n").pop();
    if (line) {
      try {
        return JSON.parse(line) as BrowserProbeResult;
      } catch {
        // faellt durch zum generischen Fehler unten
      }
    }
    return emptyResult(failure.message ?? String(error));
  } finally {
    execFile("docker", ["kill", containerName], () => {});
  }
}

export interface AgentBrowserCheckResult {
  /// Kam der Stack ueberhaupt hoch? Erst dann gibt es ein `probe`-Ergebnis.
  reachable: boolean;
  /// Reiner Umgebungsgrund (anderes Projekt live, kein Compose-File …) – ein
  /// automatischer Aufrufer darf das nicht als Mangel werten. Siehe
  /// AgentIntegrationCheckResult in src/lib/liveStack.ts.
  unavailable: boolean;
  blockedReason: string | null;
  port: number | null;
  probe: BrowserProbeResult | null;
  logs: string;
}

/// Fuer worker/agentTools.ts ("check_in_browser"): startet den Compose-Stack
/// des Projekts (oder nutzt den schon laufenden) und ruft eine Seite darin im
/// echten Browser auf.
export async function runAgentBrowserCheck(
  projectId: string,
  request: BrowserProbeRequest,
  { pollIntervalMs = 4000, timeoutMs = 5 * 60 * 1000, probeTimeoutMs = 60_000 } = {},
): Promise<AgentBrowserCheckResult> {
  const outcome = await withRunningStack(projectId, { pollIntervalMs, timeoutMs }, (port) =>
    runBrowserProbe(port, request, probeTimeoutMs),
  );

  if (!outcome.ok) {
    return {
      reachable: false,
      unavailable: outcome.unavailable,
      blockedReason: outcome.reason,
      port: null,
      probe: null,
      logs: outcome.logs,
    };
  }

  return { reachable: true, unavailable: false, blockedReason: null, port: outcome.port, probe: outcome.value, logs: outcome.logs };
}

/// Ist dieses Ergebnis ein Mangel? Bewusst hier und nicht im Skript, damit
/// jeder Aufrufer (Umsetzer-Werkzeug, spaeter QA/Design) dieselbe Schwelle
/// benutzt.
///
/// Ein fehlgeschlagener Request zaehlt dazu: "requestfailed" ist eine
/// NETZWERK-Ebene-Fehlschlag (DNS, Verbindung abgelehnt), kein HTTP-Fehlercode
/// – ein 404 auf ein Favicon landet hier gar nicht. Ausgenommen ist nur
/// ERR_ABORTED, das beim Weiternavigieren regulaer auftritt.
export function browserCheckFailed(probe: BrowserProbeResult): boolean {
  const hardFailures = probe.failedRequests.filter((entry) => !entry.includes("ERR_ABORTED"));
  return !probe.ok || hardFailures.length > 0;
}

/// Fasst ein Ergebnis als Text fuers Modell zusammen (auch von QA/Design
/// nutzbar, nicht nur vom Umsetzer-Werkzeug).
export function formatBrowserProbe(probe: BrowserProbeResult): string {
  const parts: string[] = [];
  if (probe.error) parts.push(`Browser-Prüfung nicht durchführbar: ${probe.error}`);
  else parts.push(`Seite: ${probe.url ?? "(unbekannt)"} – HTTP ${probe.status ?? "?"}${probe.title ? ` – „${probe.title}"` : ""}`);

  if (probe.stepResults.length > 0) parts.push(`\nBedienschritte:\n${probe.stepResults.join("\n")}`);
  if (probe.pageErrors.length > 0) parts.push(`\nUnbehandelte JavaScript-Fehler:\n${probe.pageErrors.join("\n")}`);
  if (probe.failedRequests.length > 0) {
    parts.push(
      `\nFehlgeschlagene Requests des Browsers:\n${probe.failedRequests.join("\n")}` +
        `\n(„ERR_NAME_NOT_RESOLVED" auf einen Compose-Servicenamen heißt: Der Browser-Code adressiert einen internen Dienst direkt – das gehört über den veröffentlichten Ursprung geleitet.)`,
    );
  }
  if (probe.consoleErrors.length > 0) parts.push(`\nKonsolenfehler:\n${probe.consoleErrors.join("\n")}`);
  if (
    probe.pageErrors.length === 0 &&
    probe.failedRequests.length === 0 &&
    probe.consoleErrors.length === 0 &&
    !probe.error
  ) {
    parts.push("\nKeine JavaScript-, Netzwerk- oder Konsolenfehler im Browser.");
  }
  parts.push(`\nSichtbarer Seitentext:\n${probe.text ?? "(keiner)"}`);
  return parts.join("\n");
}
