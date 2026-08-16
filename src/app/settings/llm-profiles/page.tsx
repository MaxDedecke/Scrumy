import { prisma } from "@/lib/prisma";
import { LLM_PROVIDER_LABEL } from "@/lib/labels";
import { ConfirmButton } from "@/components/ConfirmButton";
import { createLlmProfile, deleteLlmProfile, updateLlmProfile } from "@/lib/actions/llm-profiles";
import { buttonDangerClass, buttonPrimaryClass, inputClass, labelClass } from "@/lib/ui";
import type { LlmProvider } from "@/generated/prisma/client";

// Immer live aus der DB rendern, nicht zur Build-Zeit einfrieren.
export const dynamic = "force-dynamic";

const PROVIDERS: LlmProvider[] = ["ANTHROPIC", "OPENAI", "OLLAMA", "GENERIC_OPENAI_COMPAT"];

export default async function LlmProfilesSettingsPage() {
  const profiles = await prisma.llmProfile.findMany({
    orderBy: [{ isDefault: "desc" }, { name: "asc" }],
    include: { _count: { select: { agents: true } } },
  });

  return (
    <main className="flex-1 mx-auto w-full max-w-4xl px-6 py-12">
      <header className="mb-4">
        <p className="text-sm uppercase tracking-wider text-neutral-500">Einstellungen</p>
        <h1 className="mt-1 text-3xl font-semibold">LLM-Profile</h1>
        <p className="mt-2 max-w-2xl text-neutral-400">
          Global für die gesamte Beratung – nicht pro Kunde. Cloud-Modelle oder ein lokaler
          Ollama-Container, den Agenten in beliebigen Kundenprojekten zugewiesen werden können.
        </p>
      </header>

      <div className="mb-10 space-y-3">
        {profiles.map((profile) => (
          <details key={profile.id} className="rounded-lg border border-neutral-800">
            <summary className="flex cursor-pointer select-none items-center justify-between px-5 py-3">
              <span className="flex items-center gap-2 text-sm">
                <span className="font-medium">{profile.name}</span>
                <span className="pill pill-neutral">{LLM_PROVIDER_LABEL[profile.provider]}</span>
                <span className="text-xs text-neutral-500">{profile.model}</span>
                {profile.isDefault && <span className="pill pill-good">Standard</span>}
              </span>
              <span className="text-xs text-neutral-500">
                {profile._count.agents} Agent{profile._count.agents === 1 ? "" : "en"}
              </span>
            </summary>
            <div className="border-t border-neutral-900 p-5">
              <form action={updateLlmProfile} className="grid gap-3 sm:grid-cols-2">
                <input type="hidden" name="id" value={profile.id} />
                <div>
                  <label className={labelClass}>Name</label>
                  <input name="name" defaultValue={profile.name} required className={inputClass} />
                </div>
                <div>
                  <label className={labelClass}>Anbieter</label>
                  <select name="provider" defaultValue={profile.provider} className={inputClass}>
                    {PROVIDERS.map((provider) => (
                      <option key={provider} value={provider}>
                        {LLM_PROVIDER_LABEL[provider]}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className={labelClass}>Modell</label>
                  <input
                    name="model"
                    defaultValue={profile.model}
                    required
                    className={inputClass}
                    placeholder="z.B. claude-sonnet-5 oder llama3.1:70b"
                  />
                </div>
                <div>
                  <label className={labelClass}>Base-URL (für Ollama/self-hosted)</label>
                  <input
                    name="baseUrl"
                    defaultValue={profile.baseUrl ?? ""}
                    className={inputClass}
                    placeholder="http://ollama:11434"
                  />
                </div>
                <div className="sm:col-span-2">
                  <label className={labelClass}>API-Key-Referenz (nie der Key selbst)</label>
                  <input
                    name="apiKeyRef"
                    defaultValue={profile.apiKeyRef ?? ""}
                    className={inputClass}
                    placeholder="vault://scrumy/anthropic-api-key"
                  />
                </div>
                <label className="flex items-center gap-2 text-sm text-neutral-400 sm:col-span-2">
                  <input type="checkbox" name="isDefault" defaultChecked={profile.isDefault} />
                  Als Standardprofil für neue Agenten verwenden
                </label>
                <div className="flex items-center gap-3 sm:col-span-2">
                  <button type="submit" className={buttonPrimaryClass}>
                    Speichern
                  </button>
                </div>
              </form>
              <form action={deleteLlmProfile} className="mt-4 border-t border-neutral-900 pt-4">
                <input type="hidden" name="id" value={profile.id} />
                <ConfirmButton
                  confirmText={`Profil "${profile.name}" löschen? ${profile._count.agents} Agent(en) verlieren dadurch die Zuweisung.`}
                  className={buttonDangerClass}
                >
                  Profil löschen
                </ConfirmButton>
              </form>
            </div>
          </details>
        ))}
        {profiles.length === 0 && <p className="text-sm text-neutral-600">Noch keine LLM-Profile angelegt.</p>}
      </div>

      <details className="rounded-lg border border-neutral-800 open:bg-neutral-950">
        <summary className="cursor-pointer select-none px-5 py-3 text-sm font-medium text-neutral-300">
          + Neues LLM-Profil
        </summary>
        <form action={createLlmProfile} className="grid gap-3 border-t border-neutral-900 p-5 sm:grid-cols-2">
          <div>
            <label className={labelClass}>Name</label>
            <input name="name" required className={inputClass} placeholder="z.B. Lokaler Ollama-Container" />
          </div>
          <div>
            <label className={labelClass}>Anbieter</label>
            <select name="provider" defaultValue="ANTHROPIC" className={inputClass}>
              {PROVIDERS.map((provider) => (
                <option key={provider} value={provider}>
                  {LLM_PROVIDER_LABEL[provider]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelClass}>Modell</label>
            <input name="model" required className={inputClass} placeholder="z.B. claude-sonnet-5" />
          </div>
          <div>
            <label className={labelClass}>Base-URL (für Ollama/self-hosted)</label>
            <input name="baseUrl" className={inputClass} placeholder="http://ollama:11434" />
          </div>
          <div className="sm:col-span-2">
            <label className={labelClass}>API-Key-Referenz (nie der Key selbst)</label>
            <input name="apiKeyRef" className={inputClass} placeholder="vault://scrumy/…" />
          </div>
          <label className="flex items-center gap-2 text-sm text-neutral-400 sm:col-span-2">
            <input type="checkbox" name="isDefault" />
            Als Standardprofil für neue Agenten verwenden
          </label>
          <div className="sm:col-span-2">
            <button type="submit" className={buttonPrimaryClass}>
              Profil anlegen
            </button>
          </div>
        </form>
      </details>
    </main>
  );
}
