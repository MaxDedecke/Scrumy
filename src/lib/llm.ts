import type { LlmProfile, LlmProvider } from "@/generated/prisma/client";

// Minimaler Chat-Client für alle vier Anbieter aus `LlmProfile`.
//
// Bewusst per fetch und ohne Anbieter-SDK: Das Datenmodell erlaubt pro Agent
// ein beliebiges Profil (Cloud oder lokaler Container), und ein SDK je Anbieter
// hieße vier Codepfade mit vier Fehlerbildern. Genau wie bei den Icons und dem
// Rate-Limiter bleibt es hier bei einer handgeschriebenen, schmalen Lösung
// ohne zusätzliche Dependency.

export class LlmError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmError";
  }
}

type ChatProfile = Pick<LlmProfile, "name" | "provider" | "model" | "baseUrl" | "apiKeyRef">;

const PROVIDER_ENV_VAR: Record<LlmProvider, string | null> = {
  ANTHROPIC: "ANTHROPIC_API_KEY",
  OPENAI: "OPENAI_API_KEY",
  GENERIC_OPENAI_COMPAT: "LLM_API_KEY",
  OLLAMA: null, // lokal, kein Schlüssel
};

/// Löst den Schlüssel zum Profil auf.
///
/// Reihenfolge: `env:NAME` (empfohlen – der Schlüssel bleibt außerhalb der DB)
/// -> Schlüssel steht direkt im Feld (funktioniert, ist aber unverschlüsselt in
/// der Datenbank) -> anbieterspezifische Umgebungsvariable.
function resolveApiKey(profile: ChatProfile): string | null {
  const ref = profile.apiKeyRef?.trim();

  if (ref?.startsWith("env:")) {
    const name = ref.slice("env:".length).trim();
    const value = process.env[name]?.trim();
    if (!value) {
      throw new LlmError(
        `Profil „${profile.name}" verweist auf die Umgebungsvariable ${name}, die nicht gesetzt ist.`,
      );
    }
    return value;
  }

  // vault://… o.ä. kann diese App (noch) nicht auflösen – klar sagen statt
  // die Referenz als Schlüssel an den Anbieter zu schicken.
  if (ref?.includes("://")) {
    throw new LlmError(
      `Profil „${profile.name}" nutzt die Referenz „${ref}". Auflösung von Secret-Referenzen ist nicht implementiert – stattdessen „env:NAME" verwenden.`,
    );
  }

  if (ref) return ref;

  const envVar = PROVIDER_ENV_VAR[profile.provider];
  const fromEnv = envVar ? process.env[envVar]?.trim() : undefined;
  return fromEnv || null;
}

function requireApiKey(profile: ChatProfile): string {
  const key = resolveApiKey(profile);
  if (!key) {
    const envVar = PROVIDER_ENV_VAR[profile.provider];
    throw new LlmError(
      `Für Profil „${profile.name}" ist kein API-Key hinterlegt (Feld „API-Key-Referenz" oder Umgebungsvariable ${envVar}).`,
    );
  }
  return key;
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

async function postJson(url: string, headers: HeadersInit, body: unknown, timeoutMs: number) {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new LlmError(`Anbieter nicht erreichbar (${url}): ${reason}`);
  }

  const text = await response.text();
  if (!response.ok) {
    // Antwortkörper mitgeben – die Fehlermeldungen der Anbieter sind meist
    // konkret (falsches Modell, Guthaben leer, Key ungültig).
    throw new LlmError(`Anbieter antwortete mit ${response.status}: ${text.slice(0, 500)}`);
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new LlmError(`Antwort des Anbieters war kein JSON: ${text.slice(0, 300)}`);
  }
}

function pickString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/// Ein Frage-Antwort-Aufruf gegen das Profil. Kein Streaming: Die Aufrufe hier
/// laufen in Server-Actions, deren Ergebnis erst am Ende gerendert wird.
export async function chat({
  profile,
  system,
  prompt,
  maxTokens = 8000,
  timeoutMs = 180_000,
}: {
  profile: ChatProfile;
  system: string;
  prompt: string;
  maxTokens?: number;
  timeoutMs?: number;
}): Promise<string> {
  switch (profile.provider) {
    case "ANTHROPIC": {
      const base = trimTrailingSlash(profile.baseUrl || "https://api.anthropic.com");
      const data = (await postJson(
        `${base}/v1/messages`,
        { "x-api-key": requireApiKey(profile), "anthropic-version": "2023-06-01" },
        {
          model: profile.model,
          // Bei aktuellen Modellen denkt das Modell standardmäßig mit, und
          // max_tokens deckelt Denken UND Antwort – deshalb großzügig.
          max_tokens: Math.max(maxTokens, 16000),
          system,
          messages: [{ role: "user", content: prompt }],
        },
        timeoutMs,
      )) as { content?: { type?: string; text?: string }[]; stop_reason?: string };

      if (data.stop_reason === "refusal") {
        throw new LlmError("Das Modell hat die Anfrage abgelehnt.");
      }
      const text = (data.content ?? [])
        .filter((block) => block.type === "text")
        .map((block) => block.text ?? "")
        .join("");
      if (!text.trim()) throw new LlmError("Das Modell hat keinen Text zurückgegeben.");
      return text;
    }

    case "OLLAMA": {
      const base = trimTrailingSlash(profile.baseUrl || "http://ollama:11434");
      const data = (await postJson(
        `${base}/api/chat`,
        {},
        {
          model: profile.model,
          stream: false,
          messages: [
            { role: "system", content: system },
            { role: "user", content: prompt },
          ],
        },
        timeoutMs,
      )) as { message?: { content?: string } };

      const text = pickString(data.message?.content);
      if (!text) throw new LlmError("Ollama hat keinen Text zurückgegeben.");
      return text;
    }

    // OpenAI und alles OpenAI-kompatible (OpenRouter, vLLM, LM Studio, …)
    case "OPENAI":
    case "GENERIC_OPENAI_COMPAT": {
      const fallback = profile.provider === "OPENAI" ? "https://api.openai.com/v1" : null;
      const base = trimTrailingSlash(profile.baseUrl || fallback || "");
      if (!base) {
        throw new LlmError(`Profil „${profile.name}" braucht eine Base-URL (z.B. https://openrouter.ai/api/v1).`);
      }

      const data = (await postJson(
        `${base}/chat/completions`,
        { authorization: `Bearer ${requireApiKey(profile)}` },
        {
          model: profile.model,
          max_tokens: maxTokens,
          messages: [
            { role: "system", content: system },
            { role: "user", content: prompt },
          ],
        },
        timeoutMs,
      )) as {
        choices?: { message?: { content?: string } }[];
        error?: { message?: string };
      };

      if (data.error?.message) throw new LlmError(data.error.message);
      const text = pickString(data.choices?.[0]?.message?.content);
      if (!text) throw new LlmError("Der Anbieter hat keinen Text zurückgegeben.");
      return text;
    }
  }
}

/// Holt das erste JSON-Array aus einer Modellantwort. Modelle rahmen JSON gern
/// in ```json-Blöcke oder schreiben einen Satz davor – beides wird toleriert,
/// statt sich auf perfekte Formatbefolgung zu verlassen.
export function extractJsonArray(text: string): unknown[] {
  const withoutFences = text.replace(/```(?:json)?/gi, "");
  const start = withoutFences.indexOf("[");
  const end = withoutFences.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) {
    throw new LlmError(`Antwort enthielt keine JSON-Liste: ${text.slice(0, 300)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(withoutFences.slice(start, end + 1));
  } catch {
    throw new LlmError(`JSON-Liste war nicht lesbar: ${withoutFences.slice(start, start + 300)}`);
  }

  if (!Array.isArray(parsed)) throw new LlmError("Antwort war keine Liste.");
  return parsed;
}
