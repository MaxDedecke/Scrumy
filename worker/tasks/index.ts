// Zentrale Task-Registry fuer graphile-worker – die Schritte, die das
// Agenten-Team ausfuehren kann. Die Payload-Typen stehen in `../taskTypes.ts`,
// damit auch die Next.js-App Jobs einreihen kann, ohne den Worker-Code zu
// laden.
//
// Ablauf: teamKickoff -> sprintPlanning -> ticketWork (je Ticket) ->
// sprintReview -> (Autopilot) sprintPlanning. teamInquiry laeuft unabhaengig
// davon, sobald der Mensch etwas wissen will.
import type { TaskList } from "graphile-worker";
import "../taskTypes";
import teamKickoff from "./teamKickoff";
import sprintPlanning from "./sprintPlanning";
import ticketWork from "./ticketWork";
import sprintReview from "./sprintReview";
import teamInquiry from "./teamInquiry";

export const taskList: TaskList = {
  teamKickoff,
  sprintPlanning,
  ticketWork,
  sprintReview,
  teamInquiry,
};
