"use server";

// Start/Stop-Knöpfe der Frontend-Vorschau. Die eigentliche Arbeit steckt in
// src/lib/preview.ts – hier nur das übliche dünne Formular-/Revalidate-Kleid.
import { fail, type ActionResult } from "@/lib/actions/result";
import { startPreview, stopPreview } from "@/lib/preview";
import { revalidatePath } from "next/cache";

function str(formData: FormData, key: string): string | null {
  const value = String(formData.get(key) ?? "").trim();
  return value.length > 0 ? value : null;
}

export async function startPreviewAction(formData: FormData): Promise<ActionResult> {
  const projectId = str(formData, "projectId");
  if (!projectId) return fail("Kein Projekt angegeben.");

  const result = await startPreview(projectId);
  revalidatePath(`/projects/${projectId}/preview`);
  return result;
}

export async function stopPreviewAction(formData: FormData): Promise<ActionResult> {
  const projectId = str(formData, "projectId");
  if (!projectId) return fail("Kein Projekt angegeben.");

  const result = await stopPreview(projectId);
  revalidatePath(`/projects/${projectId}/preview`);
  return result;
}
