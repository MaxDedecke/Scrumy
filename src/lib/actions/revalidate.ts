// Welche Seiten nach einer Änderung am Projekt neu geladen werden müssen.
//
// Bewusst eine Liste statt `revalidatePath("/", "layout")`: Ein Beschluss oder
// ein Team-Start ändert Board, Büro, Nachweise und Discovery gleichzeitig –
// aber nicht die halbe App. Kein "use server" hier: nur ein Helfer, keine
// Action (dort muss jeder Export eine async Funktion sein).
import { revalidatePath } from "next/cache";

export function revalidateProject(projectId: string) {
  revalidatePath(`/projects/${projectId}`);
  revalidatePath(`/projects/${projectId}/office`);
  revalidatePath(`/projects/${projectId}/records`);
  revalidatePath(`/projects/${projectId}/discovery`);
  revalidatePath(`/projects/${projectId}/preview`);
}
