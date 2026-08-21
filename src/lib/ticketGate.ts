// Dünner Re-Export für App-Seiten (z.B. das Scrum-Board): Sie sollen die
// „Backend vor Frontend"-Regel anzeigen können, ohne selbst tief in worker/
// zu importieren – die eigentliche Regel lebt in worker/clarification.ts,
// zusammen mit den anderen Gründen, warum ein Ticket liegen bleibt.
export { backendGatedTicketIds } from "../../worker/clarification";
