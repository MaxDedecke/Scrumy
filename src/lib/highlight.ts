// Syntax-Highlighting für die Code-Ansicht (Projekt → Code). Server-seitig
// mit Shiki statt eines Client-Highlighters: die Datei wird schon als
// fertiges, eingefärbtes HTML gerendert – kein zusätzliches JS im Browser,
// kein Layout-Sprung beim Nachfärben.
//
// Eigenes Theme statt eines mitgelieferten Editor-Themes: die Farben kommen
// bewusst aus denselben Tokens wie der Rest der App (siehe globals.css /
// PRIORITY_PILL & Co. in labels.ts), damit hervorgehobener Code wie ein Teil
// von Scrumy aussieht statt wie ein eingebettetes Fremdwidget.
import path from "node:path";
import { codeToHtml } from "shiki";
import type { ThemeRegistrationRaw } from "shiki";

const SCRUMY_CODE_THEME: ThemeRegistrationRaw = {
  name: "scrumy-dark",
  type: "dark",
  colors: {
    "editor.background": "#121216", // --color-surface
    "editor.foreground": "#a9a9b6", // --color-ink-2
  },
  settings: [
    { settings: { foreground: "#a9a9b6" } }, // Default: --color-ink-2
    {
      scope: ["comment", "punctuation.definition.comment"],
      settings: { fontStyle: "italic", foreground: "#56566a" }, // --color-ink-4
    },
    {
      scope: ["keyword", "keyword.control", "storage.type", "storage.modifier", "keyword.operator.new"],
      settings: { foreground: "#c6ff0a" }, // --color-accent
    },
    {
      scope: ["string", "string.quoted", "string.template"],
      settings: { foreground: "#cf8059" }, // --color-serious
    },
    {
      scope: ["constant.numeric", "constant.language", "constant.character", "constant.other"],
      settings: { foreground: "#7093cd" }, // --color-info
    },
    {
      scope: ["entity.name.function", "support.function", "meta.function-call"],
      settings: { foreground: "#f3f3f5" }, // --color-ink
    },
    {
      scope: ["entity.name.type", "entity.name.class", "support.type", "support.class", "entity.other.inherited-class"],
      settings: { foreground: "#d2a741" }, // --color-warning
    },
    {
      scope: ["entity.name.tag"],
      settings: { foreground: "#d16168" }, // --color-critical
    },
    {
      scope: ["entity.other.attribute-name"],
      settings: { foreground: "#59a33e" }, // --color-good
    },
    {
      scope: ["variable", "variable.parameter", "variable.other"],
      settings: { foreground: "#a9a9b6" }, // --color-ink-2
    },
    {
      scope: ["punctuation", "meta.brace", "punctuation.separator", "punctuation.terminator"],
      settings: { foreground: "#78788a" }, // --color-ink-3
    },
  ],
};

// Dateiendung -> Shiki-Sprach-Id. Nur was im Projekt realistisch vorkommt;
// alles andere faellt auf reinen (aber immerhin theme-farbigen) Text zurueck.
const LANG_BY_EXTENSION: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "tsx",
  ".mts": "typescript",
  ".cts": "typescript",
  ".js": "javascript",
  ".jsx": "jsx",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".json": "json",
  ".css": "css",
  ".scss": "scss",
  ".html": "html",
  ".md": "markdown",
  ".mdx": "mdx",
  ".sql": "sql",
  ".prisma": "prisma",
  ".graphql": "graphql",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "toml",
  ".sh": "shellscript",
  ".bash": "shellscript",
  ".xml": "xml",
  ".vue": "vue",
  ".svelte": "svelte",
  ".py": "python",
  ".rb": "ruby",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".kt": "kotlin",
  ".cs": "csharp",
  ".c": "c",
  ".h": "c",
  ".cc": "cpp",
  ".cpp": "cpp",
  ".hpp": "cpp",
  ".php": "php",
  ".swift": "swift",
  ".dockerfile": "dockerfile",
};

function langForPath(filePath: string): string {
  const base = path.basename(filePath).toLowerCase();
  if (base === "dockerfile") return "dockerfile";
  if (base === ".gitignore" || base === ".env" || base === ".env.example") return "text";
  return LANG_BY_EXTENSION[path.extname(base)] ?? "text";
}

/// Rendert Dateiinhalt als eingefaerbtes HTML (<pre class="shiki">…</pre>).
/// Faellt bei unbekannter/kaputter Sprache auf reinen Text im selben Theme
/// zurueck statt die Seite mit einem Shiki-Fehler abstuerzen zu lassen.
export async function highlightFileContent(filePath: string, content: string): Promise<string> {
  const lang = langForPath(filePath);
  try {
    return await codeToHtml(content, { lang, theme: SCRUMY_CODE_THEME });
  } catch {
    return codeToHtml(content, { lang: "text", theme: SCRUMY_CODE_THEME });
  }
}
