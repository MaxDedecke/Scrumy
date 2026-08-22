# Agentenfähigkeiten – offene Punkte

Bestandsaufnahme vom 22.08.2026: Was die Agenten heute können, wo die Lücken
sind, und in welcher Reihenfolge sie sich zu schließen lohnen. Grundlage ist
der Code, nicht die Absicht: `worker/agentTools.ts`, `worker/agentToolLoop.ts`,
`worker/tasks/*`, `src/lib/testRun.ts`, `src/lib/liveStack.ts`, `src/lib/team.ts`.

## Ist-Stand

Werkzeuge des Umsetzer-Agenten (`IMPLEMENTATION_TOOLS`): `read_file`,
`list_files`, `search_files`, `write_file`, `edit_file`, `run_command`
(Docker-Sandbox), `run_integration_check` (echter Compose-Stack + HTTP-Probe),
`finish`. Git-Commit/Push macht der Worker außerhalb der Sandbox, nicht der
Agent selbst.

## Werkzeuge

### 1. Browser-Prüfung – IN ARBEIT

`run_integration_check` fährt nur einen HTTP-Request gegen den Stack. Kein
gerendertes DOM, keine Browser-Konsolenfehler, keine fehlgeschlagenen
Browser-Requests, kein Screenshot. Genau deshalb musste der
`backend:3000`-Vorfall per Grep-Heuristik (`findInternalHostnameLeaks`)
abgefangen werden: Ein Fehler, der sich im Browser als
`ERR_NAME_NOT_RESOLVED` zeigt, liefert serverseitig ein sauberes 200.
Kein Agent hat je die Oberfläche gesehen – auch der DESIGN-Agent reviewt nur
Diffs, obwohl Sidebar-Pflicht und shadcn-Standard in den Grundregeln stehen.

Phase 1 (umgesetzt): Werkzeug `check_in_browser` – echter Chromium im
Sibling-Container gegen den laufenden Compose-Stack, liefert Konsolenfehler,
fehlgeschlagene Netzwerk-Requests, unbehandelte Seitenfehler, sichtbaren
Seitentext und einfache Interaktionsschritte (click/fill/wait).

Phase 2 (offen):
- Screenshot aufnehmen und im UI an der Nachweis-Zeile anzeigen (braucht einen
  Ablageort außerhalb des Repos, damit nichts mitcommittet wird).
- DESIGN-Review und QA-Gate den Browser-Check nutzen lassen, statt nur den Diff
  zu lesen.
- `findInternalHostnameLeaks` zurückbauen, sobald der Browser-Check die
  Fehlerklasse zuverlässig fängt.

### 2. Sandbox kann fast nichts

`docker/preview-runner.Dockerfile` ist `node:22-alpine` – **kein git, kein
python, kein psql, kein go/java**. Folgen:
- Nicht-JS-Projekte kann der Agent nicht testen.
- Der Agent kann seinen eigenen kumulierten Diff nicht ansehen, bevor er
  `finish` ruft. `gitLog`/`gitShow` gibt es in `src/lib/workspace.ts`, aber nur
  für die UI, nicht als Werkzeug.

Zu tun: git ins Runner-Image, Werkzeug `show_diff` (eigener Arbeitsstand) und
`show_history` (was frühere Tickets an dieser Datei gemacht haben).

### 3. Kein Zugriff auf die laufende Datenbank

Bei „Upload gespeichert, aber Liste leer" kann der Agent nicht nachsehen, ob die
Zeile in Postgres steht. `run_integration_check` sollte ein `sql`-Feld bekommen
(nur lesend, gegen den DB-Container des Compose-Stacks).

### 4. Kein Web-/Doku-Zugriff

`npm install` hat Internet, der Agent selbst nicht. Keine Bibliotheksdoku, kein
API-Schema, keine Fehlermeldung nachschlagbar – bei schwächeren Modellen ein
Hauptgrund für erfundene APIs.

### 5. Keine Frage an einen Kollegen im laufenden Anlauf

Einziger Ausweg ist eine Klärung, die den Anlauf beendet und beim PO landet. Ein
billiges `ask_teammate(role, frage)` (ein LLM-Turn des Design-/Backend-Agenten
mit dessen Kontext) würde einen Großteil der Eskalationen abfangen.

## Mechanismen

### 6. Kein Gedächtnis über Tickets hinweg

Jeder Anlauf baut den Kontext aus Konzept + Repo neu. Was ein Agent gestern
gelernt hat (`--legacy-peer-deps` nötig, dieser Test ist flaky), ist weg. Eine
Projekt-Wissensdatei, die Agenten selbst fortschreiben und die in jeden Prompt
geht, ist der billigste Qualitätshebel.

### 7. Kein Token-/Kostentracking

Im Schema gibt es kein Verbrauchsfeld – nur `sprintBudget` (Anzahl Tickets) und
`attemptBudget` (Anzahl Anläufe). „Was hat dieses Projekt gekostet" ist für eine
abrechnende Beratungsplattform eine Kernfrage und aktuell nicht beantwortbar.

### 8. Kein Release-Schritt

Kein Tag, kein Changelog, keine Deployment-Übergabe – am Sprintende gibt es nur
eine Zusammenfassung.

### 9. Keine Regressions-Absicherung über den Sprint hinweg

Die Prüfung ist ticketlokal. Nichts stellt fest, dass Sprint 4 kaputtgemacht
hat, was Sprint 2 gebaut hat, außer die Testsuite ist zufällig gut.

## Rollen

### 10. Zwei tote Rollen

`REVIEWER` (wird als „Rita Sommer" geseedet) und `DEVOPS` werden von **keinem**
Worker-Task angefordert. Sie greifen nur, wenn die Sprint-Planung einem Ticket
zufällig diese Rolle zuweist; einen eigenen Ablauf haben sie nicht. Entweder mit
Leben füllen (REVIEWER = Vier-Augen-Prinzip vor QA, DEVOPS = Compose/CI/
Migrationen als Zuständigkeit) oder streichen.

### 11. Fehlende Rolle: SECURITY

Kein Agent prüft je auf Secrets im Repo, fehlende Autorisierung,
SQL-Injection oder verwundbare Abhängigkeiten. Bei Individualsoftware für
zahlende Kunden die Lücke mit dem größten Haftungsrisiko. Als Gate nach QA
einhängbar, genau wie DESIGN.

### Bewusst nicht vorgesehen

Architekt-, Refactoring- und Doku-Agent. Mehr Rollen heißen mehr LLM-Aufrufe und
mehr Abstimmungsschleifen; die bestehenden Agenten könnten das, wenn sie
bessere Werkzeuge hätten.
