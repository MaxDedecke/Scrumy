"use server";

// Start/Terminate-Knöpfe der Live-Anwendung. Die eigentliche Arbeit steckt in
// src/lib/liveStack.ts – hier nur das übliche dünne Formular-/Revalidate-Kleid
// (siehe actions/preview.ts fürs Vorbild).
import { fail, type ActionResult } from "@/lib/actions/result";
import { startLiveStack, stopLiveStack } from "@/lib/liveStack";
import { revalidatePath } from "next/cache";

function str(formData: FormData, key: string): string | null {
  const value = String(formData.get(key) ?? "").trim();
  return value.length > 0 ? value : null;
}

export async function startLiveAction(formData: FormData): Promise<ActionResult> {
  const projectId = str(formData, "projectId");
  if (!projectId) return fail("Kein Projekt angegeben.");

  const result = await startLiveStack(projectId);
  // "layout" revalidiert den ganzen Projektrahmen (Kopf mit LiveAppControls
  // und dem "Live"-Pill steht dort, siehe src/app/projects/[projectId]/layout.tsx).
  revalidatePath(`/projects/${projectId}`, "layout");
  revalidatePath(`/projects/${projectId}/live`);
  return result;
}

export async function stopLiveAction(formData: FormData): Promise<ActionResult> {
  const projectId = str(formData, "projectId");
  if (!projectId) return fail("Kein Projekt angegeben.");

  const result = await stopLiveStack(projectId);
  revalidatePath(`/projects/${projectId}`, "layout");
  revalidatePath(`/projects/${projectId}/live`);
  return result;
}
