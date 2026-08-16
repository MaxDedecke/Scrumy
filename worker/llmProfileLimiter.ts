// Kleiner Concurrency-Limiter pro LlmProfile.
//
// Grund: `queue.ts` serialisiert Jobs pro AGENT (kein Doppel-Run desselben
// Agenten), aber mehrere verschiedene Agenten koennen dasselbe globale
// LlmProfile (z.B. denselben Anthropic-Key oder den einen Ollama-Container)
// zugewiesen haben und wuerden sonst parallel denselben Provider fluten.
// `withLlmProfileLimit` kappt das auf `maxConcurrent` gleichzeitige Aufrufe
// je `llmProfileId`.
//
// Bewusst ohne neue Dependency (z.B. p-limit) geschrieben, analog zu den
// handgeschriebenen Icons in src/components/icons.tsx statt einer weiteren
// Mini-Library.
//
// Wichtig: Das gilt nur PRO WORKER-PROZESS. Bei mehreren Worker-Replicas
// (siehe docker-compose.yml, `--scale worker=N`) hat jeder Prozess seinen
// eigenen Zaehler – der Provider sieht also bis zu `maxConcurrent * Anzahl
// Worker-Replicas` gleichzeitige Aufrufe. Fuer echte, prozessuebergreifende
// Ratenbegrenzung braucht es spaeter einen verteilten Limiter (z.B. ueber
// eine Postgres-Advisory-Lock-Zaehlung oder Redis) – hier bewusst nicht
// vorgezogen, solange es noch keine echten LLM-Aufrufe gibt.
const DEFAULT_MAX_CONCURRENT = 3;

const active = new Map<string, number>();
const waiters = new Map<string, Array<() => void>>();

async function acquire(llmProfileId: string, maxConcurrent: number): Promise<void> {
  const current = active.get(llmProfileId) ?? 0;
  if (current < maxConcurrent) {
    active.set(llmProfileId, current + 1);
    return;
  }
  await new Promise<void>((resolve) => {
    const queue = waiters.get(llmProfileId) ?? [];
    queue.push(resolve);
    waiters.set(llmProfileId, queue);
  });
  active.set(llmProfileId, (active.get(llmProfileId) ?? 0) + 1);
}

function release(llmProfileId: string): void {
  const current = active.get(llmProfileId) ?? 0;
  active.set(llmProfileId, Math.max(0, current - 1));

  const queue = waiters.get(llmProfileId);
  const next = queue?.shift();
  if (next) next();
}

export async function withLlmProfileLimit<T>(
  llmProfileId: string,
  fn: () => Promise<T>,
  maxConcurrent = DEFAULT_MAX_CONCURRENT,
): Promise<T> {
  await acquire(llmProfileId, maxConcurrent);
  try {
    return await fn();
  } finally {
    release(llmProfileId);
  }
}
