// Serialisiert schreibende Zugriffe auf denselben Projekt-Workspace.
//
// `worker/queue.ts` serialisiert Jobs nur pro AGENT (`queueName:
// agent:${agentId}`), nicht pro Projekt – zwei Kolleg:innen desselben Teams
// dürfen bewusst gleichzeitig an verschiedenen Tickets arbeiten (siehe
// worker/tasks/ticketWork.ts, "Alles bewusst in EINEM Job"). Beide sitzen
// dabei aber im selben Git-Arbeitsverzeichnis (ein Verzeichnis pro Projekt,
// nicht pro Ticket) – `write_file`/`edit_file`/`run_command` schreiben
// direkt auf die Platte, `commitAll` committet, und ein gescheiterter Anlauf
// verwirft mit `discardUncommittedChanges` (git checkout -- . + git clean
// -fd) ALLES, was seit dem letzten Commit im Verzeichnis liegt.
//
// Ohne diese Sperre kann der Discard des einen Agenten den noch unfertigen,
// aber legitimen Stand eines zweiten, parallel laufenden Agenten wegreißen –
// beobachtet im Drapbox-Projekt (siehe [[scrumy-projekt]]-Memory), wo genau
// das zusammen mit dem 429-Discard-Bug (inzwischen behoben) dafür sorgte,
// dass derselbe Dependency-Fix nie committet wurde.
//
// Reiner In-Process-Mutex: genügt, solange nur EIN Worker-Container läuft
// (docker-compose.yml, Stand 19.08.2026 – "concurrency: 5" innerhalb eines
// einzelnen Node-Prozesses). Mehrere Worker-Replicas bräuchten stattdessen
// einen verteilten Lock (z.B. über eine DB-Zeile); aktuell nicht der Fall.
const tails = new Map<string, Promise<void>>();

/// Führt `fn` erst aus, wenn kein anderer Aufruf mit demselben `dir` mehr
/// läuft – Aufrufe für denselben Workspace reihen sich ein, Aufrufe für
/// verschiedene Workspaces (verschiedene Projekte) laufen unbeeinflusst
/// parallel weiter.
export async function withWorkspaceLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const previous = tails.get(dir) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  tails.set(dir, current);

  await previous;
  try {
    return await fn();
  } finally {
    release();
    // Niemand wartet mehr auf diesen Workspace – Eintrag entfernen, sonst
    // wächst die Map über die Projektlaufzeit unbegrenzt.
    if (tails.get(dir) === current) tails.delete(dir);
  }
}
