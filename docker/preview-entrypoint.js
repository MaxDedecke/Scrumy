#!/usr/bin/env node
"use strict";

// Läuft als PID 1 in jedem Vorschau-Container (siehe preview-runner.Dockerfile,
// gestartet von src/lib/preview.ts). Reines Node ohne Projekt-Dependencies:
// dieses Image ist generisch für JEDES Frontend, kann also nicht auf unser
// eigenes tsconfig/Pfad-Alias-Setup zurückgreifen – deshalb ist die Logik
// (u.a. der statische Fallback-Server) bewusst eigenständig, nicht aus
// src/lib/preview.ts importiert.
//
// Bekommt per Environment, was zu tun ist (von preview.ts bereits erkannt):
//   FRONTEND_DIR  – Verzeichnis im gemounteten Workspace-Volume
//   KIND          – "npm" oder "static"
//   SCRIPT_NAME   – nur bei KIND=npm: der auszuführende package.json-Script
//   PORT          – Port, auf dem der Server lauschen soll
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const dir = process.env.FRONTEND_DIR;
const kind = process.env.KIND;
const scriptName = process.env.SCRIPT_NAME;
const port = Number(process.env.PORT || 3000);

if (!dir || !fs.existsSync(dir)) {
  console.error(`FRONTEND_DIR fehlt oder existiert nicht im Container: ${dir}`);
  process.exit(1);
}

if (kind === "static") {
  startStaticServer(dir, port);
} else if (kind === "npm") {
  runNpm(dir, scriptName, port);
} else {
  console.error(`Unbekannte KIND: "${kind}" (erwartet "npm" oder "static")`);
  process.exit(1);
}

function runNpm(targetDir, script, targetPort) {
  if (!script) {
    console.error("SCRIPT_NAME fehlt für KIND=npm.");
    process.exit(1);
  }

  if (!fs.existsSync(path.join(targetDir, "node_modules"))) {
    console.log("$ npm install");
    const install = spawnSync("npm", ["install"], { cwd: targetDir, stdio: "inherit" });
    if (install.status !== 0) {
      console.error(`npm install fehlgeschlagen (Code ${install.status ?? install.signal}).`);
      process.exit(install.status ?? 1);
    }
  }

  console.log(`$ npm run ${script}`);
  const child = spawn("npm", ["run", script], {
    cwd: targetDir,
    stdio: "inherit",
    env: { ...process.env, PORT: String(targetPort), HOST: "0.0.0.0", BROWSER: "none", CI: "true" },
  });
  forwardSignalsTo(child);
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

function startStaticServer(targetDir, targetPort) {
  const root = path.resolve(targetDir);
  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://internal");
      let relative = decodeURIComponent(url.pathname);
      if (relative.endsWith("/")) relative += "index.html";
      const target = path.resolve(root, `.${relative}`);
      if (target !== root && !target.startsWith(root + path.sep)) {
        res.writeHead(403).end("Verboten");
        return;
      }

      let data;
      try {
        data = fs.readFileSync(target);
      } catch {
        // Kein Treffer, keine Dateiendung: vermutlich eine Client-Route
        // eines SPA-Routers – mit index.html beantworten statt 404.
        data = null;
        if (!path.extname(target)) {
          try {
            data = fs.readFileSync(path.join(root, "index.html"));
          } catch {
            data = null;
          }
        }
      }
      if (!data) {
        res.writeHead(404).end("Nicht gefunden");
        return;
      }
      res.writeHead(200, { "Content-Type": MIME[path.extname(target)] ?? "application/octet-stream" });
      res.end(data);
    } catch (error) {
      res.writeHead(500).end(error instanceof Error ? error.message : String(error));
    }
  });
  server.listen(targetPort, "0.0.0.0", () => console.log(`Statischer Server auf Port ${targetPort} gestartet.`));
  process.on("SIGTERM", () => server.close(() => process.exit(0)));
  process.on("SIGINT", () => server.close(() => process.exit(0)));
}

function forwardSignalsTo(child) {
  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, () => {
      try {
        child.kill(signal);
      } catch {
        /* Kind ist schon weg */
      }
    });
  }
  child.on("exit", (code) => process.exit(code ?? 0));
}
