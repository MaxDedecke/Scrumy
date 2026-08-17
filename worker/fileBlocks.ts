// Antwortformat für Code liefernde Agenten.
//
// Warum kein JSON: Eine Datei in einen JSON-String zu pressen heißt, jeden
// Zeilenumbruch, jedes Anführungszeichen und jeden Backslash korrekt zu
// escapen – über hunderte Zeilen Code, ohne Fehler. Modelle scheitern daran
// regelmäßig, und dann ist die gesamte Antwort unbrauchbar, obwohl der Code
// selbst in Ordnung war. Ein zeilenbasiertes Blockformat kennt dieses Problem
// nicht: Inhalt wird wörtlich übernommen, bis die nächste Markierung kommt.
//
// Erwartetes Format:
//
//   COMMIT: Betreffzeile
//   ZUSAMMENFASSUNG: Was jetzt anders ist
//   OFFEN: offene Punkte (optional)
//   KLÄRUNG: Frage an den Auftraggeber, die der Agent selbst nicht entscheiden
//            darf (optional – siehe worker/clarification.ts)
//   WEGE: die Antwortmöglichkeiten zu dieser Frage, eine je Zeile
//         (optional, nur zusammen mit KLÄRUNG)
//   --- EDIT: src/beispiel.ts ---
//   <<< SEARCH
//   <vorhandener, eindeutig vorkommender Ausschnitt>
//   === REPLACE
//   <neuer Ausschnitt>
//   >>> END EDIT
//   --- DATEI: src/neu.ts ---
//   <vollständiger Inhalt einer NEUEN Datei>
//   --- DATEI: docs/weiteres.md ---
//   <vollständiger Dateiinhalt>
//   --- ENDE ---

export interface ParsedImplementation {
  commitMessage: string;
  summary: string;
  notes: string;
  /** Frage, die der Agent nicht selbst entscheiden will (leer = keine). */
  clarification: string;
  /**
   * Die Wege, die der Agent zu seiner Frage sieht – Rohtext, eine Zeile je Weg.
   * Ohne sie bekäme der Auftraggeber zu einer fachlichen Frage nur die
   * allgemeinen Standardwege angeboten (siehe optionsFromAgent).
   */
  clarificationOptions: string;
  /** Kompakte Änderungen an bestehenden Dateien. */
  edits: { path: string; search: string; replace: string }[];
  /** Neue Dateien; vollständige Inhalte sind nur hier nötig. */
  files: { path: string; content: string }[];
}

const FILE_MARKER = /^\s*-{2,}\s*DATEI:\s*(.+?)\s*-{2,}\s*$/i;
const EDIT_MARKER = /^\s*-{2,}\s*EDIT:\s*(.+?)\s*-{2,}\s*$/i;
const END_MARKER = /^\s*-{2,}\s*ENDE\s*-{2,}\s*$/i;
const SEARCH_MARKER = /^\s*<{3}\s*SEARCH\s*$/i;
const REPLACE_MARKER = /^\s*={3}\s*REPLACE\s*$/i;
const END_EDIT_MARKER = /^\s*>{3}\s*END\s+EDIT\s*$/i;
// KLAERUNG ohne Umlaut wird mitgelesen: Modelle schreiben Feldnamen gern
// transliteriert, und daran soll eine Frage ans Team nicht scheitern.
const FIELD = /^\s*(COMMIT|ZUSAMMENFASSUNG|OFFEN|KLÄRUNG|KLAERUNG|WEGE)\s*:\s*(.*)$/i;

/// Entfernt einen Code-Fence, den ein Modell um den Dateiinhalt gelegt hat.
/// Der Fence gehört nie zur Datei – bliebe er stehen, wäre die Datei kaputt.
function stripCodeFence(lines: string[]): string[] {
  const start = lines.findIndex((line) => line.trim().length > 0);
  if (start === -1) return lines;

  const last = lines.reduce((found, line, index) => (line.trim().length > 0 ? index : found), -1);
  if (!lines[start].trim().startsWith("```")) return lines;
  if (last <= start || !lines[last].trim().startsWith("```")) return lines;

  return lines.slice(start + 1, last);
}

/// Der Wert eines Kopffeldes, ohne Markierungen.
///
/// Modelle setzen den Endemarker gern direkt hinter das letzte Feld
/// („KLÄRUNG: --- ENDE ---"). Bliebe das stehen, würde daraus eine Frage an den
/// Auftraggeber, die niemand gestellt hat – und ein Ticket, das auf eine
/// Antwort auf Nichts wartet.
function fieldValue(lines: string[] | undefined, separator = "\n"): string {
  if (!lines) return "";
  return lines
    .map((line) => (END_MARKER.test(line) || FILE_MARKER.test(line) ? "" : line))
    .join(separator)
    .trim();
}

export function parseImplementation(text: string): ParsedImplementation {
  const lines = text.split(/\r?\n/);

  const header: Record<string, string[]> = {};
  const files: { path: string; content: string[] }[] = [];
  const edits: { path: string; search: string[]; replace: string[] }[] = [];

  let currentField: string | null = null;
  let currentFile: { path: string; content: string[] } | null = null;
  let currentEdit: { path: string; search: string[]; replace: string[] } | null = null;
  let editPart: "search" | "replace" | null = null;

  for (const line of lines) {
    if (END_EDIT_MARKER.test(line)) {
      currentEdit = null;
      editPart = null;
      continue;
    }

    if (END_MARKER.test(line)) {
      currentFile = null;
      currentEdit = null;
      editPart = null;
      currentField = null;
      continue;
    }

    const editMatch = line.match(EDIT_MARKER);
    if (editMatch) {
      currentEdit = { path: editMatch[1].trim(), search: [], replace: [] };
      edits.push(currentEdit);
      currentFile = null;
      currentField = null;
      editPart = null;
      continue;
    }

    const fileMatch = line.match(FILE_MARKER);
    if (fileMatch) {
      currentFile = { path: fileMatch[1].trim(), content: [] };
      files.push(currentFile);
      currentEdit = null;
      editPart = null;
      currentField = null;
      continue;
    }

    if (currentEdit) {
      if (SEARCH_MARKER.test(line)) {
        editPart = "search";
      } else if (REPLACE_MARKER.test(line)) {
        editPart = "replace";
      } else if (editPart) {
        currentEdit[editPart].push(line);
      }
      continue;
    }

    if (currentFile) {
      currentFile.content.push(line);
      continue;
    }

    const fieldMatch = line.match(FIELD);
    if (fieldMatch) {
      currentField = fieldMatch[1].toUpperCase();
      header[currentField] = fieldMatch[2].trim().length > 0 ? [fieldMatch[2].trim()] : [];
      continue;
    }

    // Fortsetzungszeile eines mehrzeiligen Feldes (z.B. eine Zusammenfassung
    // über mehrere Absätze).
    if (currentField) header[currentField].push(line);
  }

  return {
    commitMessage: fieldValue(header.COMMIT, " "),
    summary: fieldValue(header.ZUSAMMENFASSUNG),
    notes: fieldValue(header.OFFEN),
    clarification: fieldValue(header["KLÄRUNG"] ?? header.KLAERUNG),
    clarificationOptions: fieldValue(header.WEGE),
    edits: edits
      .map((edit) => ({
        path: edit.path,
        search: stripCodeFence(edit.search).join("\n"),
        replace: stripCodeFence(edit.replace).join("\n"),
      }))
      // Leeres REPLACE ist erlaubt (gezieltes Entfernen), leeres SEARCH nicht.
      .filter((edit) => edit.path.length > 0 && edit.search.length > 0),
    files: files
      .filter((file) => file.path.length > 0)
      .map((file) => ({ path: file.path, content: stripCodeFence(file.content).join("\n").trim() }))
      // Ein Block ohne Inhalt ist ein Versehen des Modells – eine Datei mit
      // dem leeren String zu ueberschreiben waere schlimmer als ihn zu
      // ignorieren.
      .filter((file) => file.content.length > 0),
  };
}
