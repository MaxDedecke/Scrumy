import { prisma } from "@/lib/prisma";
import { LLM_PROVIDER_LABEL } from "@/lib/labels";
import { ActionForm } from "@/components/ActionForm";
import { ConfirmButton } from "@/components/ConfirmButton";
import { PageHeader } from "@/components/PageHeader";
import { EmptyHint } from "@/components/Section";
import { Disclosure, formGridClass } from "@/components/Disclosure";
import { ChevronRightIcon, TrashIcon } from "@/components/icons";
import { createLlmProfile, deleteLlmProfile, updateLlmProfile } from "@/lib/actions/llm-profiles";
import { buttonPrimaryClass, iconButtonDangerClass, inputClass, labelClass, pageClass } from "@/lib/ui";
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
    <main className={pageClass}>
      <PageHeader
        backHref="/"
        backLabel="Kunden"
        context="Einstellungen"
        title="LLM-Profile"
        description="Global für die gesamte Beratung – nicht pro Kunde. Cloud-Modelle oder ein lokaler Ollama-Container, die Agenten in beliebigen Kundenprojekten zugewiesen werden können."
      />

      <div className="mb-4 space-y-2">
        {profiles.map((profile) => (
          <details key={profile.id} className="group card overflow-hidden">
            <summary className="flex cursor-pointer select-none list-none items-center gap-3 px-4 py-3">
              <ChevronRightIcon className="h-4 w-4 shrink-0 text-ink-4 transition-transform group-open:rotate-90" />
              <span className="flex min-w-0 flex-1 flex-wrap items-center gap-2 text-sm">
                <span className="font-medium text-ink">{profile.name}</span>
                <span className="pill pill-neutral">{LLM_PROVIDER_LABEL[profile.provider]}</span>
                <span className="font-mono text-xs text-ink-3">{profile.model}</span>
                {profile.isDefault && <span className="pill pill-good pill-dot">Standard</span>}
              </span>
              <span className="shrink-0 text-xs text-ink-3">
                {profile._count.agents} Agent{profile._count.agents === 1 ? "" : "en"}
              </span>
            </summary>
            <div className="border-t border-hairline bg-surface-2/40 p-4">
              <ActionForm action={updateLlmProfile} className={formGridClass}>
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
                <label className="flex items-center gap-2 text-sm text-ink-2 sm:col-span-2">
                  <input type="checkbox" name="isDefault" defaultChecked={profile.isDefault} className="accent-accent-solid" />
                  Als Standardprofil für neue Agenten verwenden
                </label>
                <div className="sm:col-span-2">
                  <button type="submit" className={buttonPrimaryClass}>
                    Speichern
                  </button>
                </div>
              </ActionForm>
              {/* Löschen als Papierkorb am rechten Rand: dieselbe Geste wie in
                  allen anderen Listen der App – die Sicherheitsabfrage nennt
                  weiter die Folgen im Klartext. */}
              <ActionForm action={deleteLlmProfile} className="mt-4 flex justify-end border-t border-hairline pt-3">
                <input type="hidden" name="id" value={profile.id} />
                <ConfirmButton
                  confirmText={`Profil "${profile.name}" löschen? ${profile._count.agents} Agent(en) verlieren dadurch die Zuweisung.`}
                  title={`Profil „${profile.name}" löschen`}
                  className={iconButtonDangerClass}
                >
                  <TrashIcon className="h-4 w-4" />
                </ConfirmButton>
              </ActionForm>
            </div>
          </details>
        ))}
        {profiles.length === 0 && <EmptyHint>Noch keine LLM-Profile angelegt.</EmptyHint>}
      </div>

      <Disclosure label="Neues LLM-Profil">
        <ActionForm action={createLlmProfile} className={formGridClass}>
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
          <label className="flex items-center gap-2 text-sm text-ink-2 sm:col-span-2">
            <input type="checkbox" name="isDefault" className="accent-accent-solid" />
            Als Standardprofil für neue Agenten verwenden
          </label>
          <div className="sm:col-span-2">
            <button type="submit" className={buttonPrimaryClass}>
              Profil anlegen
            </button>
          </div>
        </ActionForm>
      </Disclosure>
    </main>
  );
}
