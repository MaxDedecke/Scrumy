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
//   PORT          – Port, auf dem von außen erreichbar sein soll (bei KIND=npm
//                   nur ein Angebot per Env – ignoriert der Dev-Server es,
//                   proxied `watchForActualPort` unten auf den echten Port)
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const { createServer: createNetServer, connect: netConnect } = require("node:net");
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
    // Nicht "inherit": wir muessen die Ausgabe mitlesen (siehe unten), reichen
    // sie aber unveraendert an stdout/stderr weiter, damit `docker logs`
    // weiterhin alles zeigt.
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PORT: String(targetPort), HOST: "0.0.0.0", BROWSER: "none", CI: "true" },
  });
  forwardSignalsTo(child);
  watchForActualPort(child, targetPort);
}

// PORT/HOST oben sind nur ein Angebot – viele Dev-Server ignorieren sie
// (Vite z.B. lauscht nur ueber --port/--host, nicht per Env, und bindet ohne
// diese Flags an seinen eigenen Default-Port, meist nur auf localhost). Statt
// Flags pro Tool zu erraten (die Namen unterscheiden sich: Next.js nutzt
// z.B. --hostname statt --host), lesen wir mit, wohin der Server laut seiner
// eigenen Ausgabe tatsaechlich gebunden hat ("Local: http://localhost:5173/"
// o.ae.), und bauen im Bedarfsfall einen TCP-Proxy vom veroeffentlichten
// PORT zu diesem echten internen Port. Das funktioniert unabhaengig vom
// Tool und selbst wenn der Server nur auf localhost lauscht, weil der Proxy
// im selben Netzwerk-Namespace laeuft wie der Dev-Server.
const LOCAL_ADDR_PORT = /(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0):(\d{2,5})\b/i;
// Farbcodes wie in Vites eigener Ausgabe stehen oft MITTEN im Port ("localhost:
// \x1b[1m5173\x1b[22m/") – vorm Suchen raus, sonst reisst das die Ziffern vom
// vorangehenden ":" ab und die Regex oben trifft nie.
const ANSI_ESCAPE = /\x1b\[[0-9;]*m/g;

function watchForActualPort(child, targetPort) {
  let done = false;
  // Die Zeile mit der Adresse kann ueber zwei Chunks der Pipe zerrissen
  // ankommen – deshalb ueber einen rollenden Puffer matchen statt pro Chunk
  // isoliert (der waere sonst blind fuer genau diesen Fall).
  let buffer = "";
  const scan = (chunk) => {
    if (done) return;
    buffer = (buffer + chunk.toString("utf8")).replace(ANSI_ESCAPE, "").slice(-4096);
    const match = buffer.match(LOCAL_ADDR_PORT);
    if (!match) return;
    done = true;
    proxyToActualPort(targetPort, Number(match[1]));
  };
  child.stdout.on("data", (chunk) => {
    process.stdout.write(chunk);
    scan(chunk);
  });
  child.stderr.on("data", (chunk) => {
    process.stderr.write(chunk);
    scan(chunk);
  });
}

/// Versucht, auf dem veroeffentlichten Port selbst zu lauschen und alles zum
/// tatsaechlichen internen Port des Dev-Servers durchzureichen. Laeuft der
/// Dev-Server (entgegen PORT/HOST oben) bereits direkt auf 0.0.0.0:targetPort,
/// schlaegt das Binden mit EADDRINUSE fehl – dann ist kein Proxy noetig, das
/// ist kein Fehlerfall.
function proxyToActualPort(targetPort, actualPort) {
  const server = createNetServer((socket) => {
    // "localhost" statt fest "127.0.0.1": manche Dev-Server (z.B. Vite ohne
    // --host) binden nur auf IPv6-Loopback ("::1"), nicht IPv4 – Node loest
    // "localhost" ueber beide Familien auf (Happy Eyeballs) statt sich auf
    // eine einzelne IP festzulegen, die es vielleicht gar nicht gibt.
    const upstream = netConnect({ host: "localhost", port: actualPort });
    socket.pipe(upstream);
    upstream.pipe(socket);
    const cleanup = () => {
      socket.destroy();
      upstream.destroy();
    };
    socket.on("error", cleanup);
    upstream.on("error", cleanup);
  });
  server.once("error", (error) => {
    if (error.code === "EADDRINUSE") {
      console.log(`Kein Proxy noetig: Port ${targetPort} ist bereits belegt.`);
    } else {
      console.error(`Proxy zu Port ${actualPort} fehlgeschlagen: ${error.message}`);
    }
  });
  server.listen(targetPort, "0.0.0.0", () => {
    console.log(`Proxy: 0.0.0.0:${targetPort} -> 127.0.0.1:${actualPort}`);
  });
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
