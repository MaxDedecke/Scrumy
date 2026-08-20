"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ChevronRightIcon, FileIcon, FolderIcon, SearchIcon } from "@/components/icons";

type TreeNode =
  | { type: "file"; name: string; path: string }
  | { type: "folder"; name: string; path: string; children: TreeNode[] };

// Baut aus der flachen `git ls-files`-Liste (siehe listTrackedFiles) einen
// Baum. Ordner tauchen dabei implizit auf – das Repo kennt selbst keine
// leeren Verzeichnisse, nur Dateipfade.
function buildTree(files: string[]): TreeNode[] {
  const root: TreeNode[] = [];
  const folders = new Map<string, TreeNode & { type: "folder" }>();

  for (const file of files) {
    const parts = file.split("/").filter(Boolean);
    let siblings = root;
    let prefix = "";
    parts.forEach((part, index) => {
      prefix = prefix ? `${prefix}/${part}` : part;
      const isFile = index === parts.length - 1;
      if (isFile) {
        siblings.push({ type: "file", name: part, path: prefix });
        return;
      }
      let folder = folders.get(prefix);
      if (!folder) {
        folder = { type: "folder", name: part, path: prefix, children: [] };
        folders.set(prefix, folder);
        siblings.push(folder);
      }
      siblings = folder.children;
    });
  }

  sortTree(root);
  return root;
}

function sortTree(nodes: TreeNode[]): void {
  nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const node of nodes) if (node.type === "folder") sortTree(node.children);
}

function ancestorsOf(filePath?: string): string[] {
  if (!filePath) return [];
  const parts = filePath.split("/");
  const result: string[] = [];
  let prefix = "";
  for (let i = 0; i < parts.length - 1; i++) {
    prefix = prefix ? `${prefix}/${parts[i]}` : parts[i];
    result.push(prefix);
  }
  return result;
}

// Dateibaum des Projekt-Repos: links im Code-Tab, rechts daneben zeigt die
// Seite den Inhalt der über einen Link gewählten Datei (Server-gerendert,
// kein Client-Fetch nötig – ein Klick ist einfach eine Navigation).
export function FileTreePanel({
  projectId,
  files,
  selectedPath,
}: {
  projectId: string;
  files: string[];
  /** Der aktuell in der URL stehende Dateipfad, für Hervorhebung + Auto-Aufklappen. */
  selectedPath?: string;
}) {
  const [query, setQuery] = useState("");

  const visibleFiles = useMemo(() => {
    const term = query.trim().toLowerCase();
    return term ? files.filter((file) => file.toLowerCase().includes(term)) : files;
  }, [files, query]);

  const tree = useMemo(() => buildTree(visibleFiles), [visibleFiles]);
  const filtering = query.trim().length > 0;

  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(ancestorsOf(selectedPath)));

  // Ein Klick auf eine Datei in einem noch eingeklappten Ordner (z.B. über die
  // Suche oder einen geteilten Link) muss dessen Vorfahren aufklappen, ohne
  // andere, vom Menschen bereits geöffnete Ordner wieder zuzuklappen.
  useEffect(() => {
    const ancestors = ancestorsOf(selectedPath);
    if (ancestors.length === 0) return;
    setExpanded((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const ancestor of ancestors) {
        if (!next.has(ancestor)) {
          next.add(ancestor);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [selectedPath]);

  const toggle = (path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-hairline p-2.5">
        <div className="flex items-center gap-2 rounded-lg bg-surface-2 px-2.5 py-1.5">
          <SearchIcon className="h-3.5 w-3.5 shrink-0 text-ink-4" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Dateien durchsuchen…"
            aria-label="Dateien durchsuchen"
            className="w-full min-w-0 bg-transparent text-sm text-ink placeholder:text-ink-4 focus:outline-none"
          />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {tree.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-ink-3">
            {filtering ? "Keine Treffer." : "Repository ist noch leer."}
          </p>
        ) : (
          <TreeList
            nodes={tree}
            depth={0}
            projectId={projectId}
            selectedPath={selectedPath}
            expanded={expanded}
            filtering={filtering}
            onToggle={toggle}
          />
        )}
      </div>
    </div>
  );
}

function TreeList({
  nodes,
  depth,
  projectId,
  selectedPath,
  expanded,
  filtering,
  onToggle,
}: {
  nodes: TreeNode[];
  depth: number;
  projectId: string;
  selectedPath?: string;
  expanded: Set<string>;
  /** Während gefiltert wird, stehen alle Ordner offen – die Treffer sollen
   *  nicht in eingeklappten Ordnern verschwinden. */
  filtering: boolean;
  onToggle: (path: string) => void;
}) {
  return (
    <ul>
      {nodes.map((node) => {
        const indent = { paddingLeft: `${0.75 + depth * 1}rem` };
        if (node.type === "file") {
          const isSelected = selectedPath === node.path;
          return (
            <li key={node.path}>
              <Link
                href={`/projects/${projectId}/code/${node.path.split("/").map(encodeURIComponent).join("/")}`}
                title={node.path}
                aria-current={isSelected ? "page" : undefined}
                style={{ paddingLeft: `${0.75 + depth * 1 + 1.125}rem` }}
                className={`flex items-center gap-1.5 py-1 pr-3 text-sm transition-colors hover:bg-surface-2 ${
                  isSelected ? "bg-surface-3 font-medium text-ink" : "text-ink-2"
                }`}
              >
                <FileIcon className="h-4 w-4 shrink-0 text-ink-4" />
                <span className="truncate">{node.name}</span>
              </Link>
            </li>
          );
        }

        const isOpen = filtering || expanded.has(node.path);
        return (
          <li key={node.path}>
            <button
              type="button"
              onClick={() => onToggle(node.path)}
              aria-expanded={isOpen}
              style={indent}
              className="flex w-full items-center gap-1.5 py-1 pr-3 text-left text-sm text-ink-2 transition-colors hover:bg-surface-2"
            >
              <ChevronRightIcon
                className={`h-3 w-3 shrink-0 text-ink-4 transition-transform ${isOpen ? "rotate-90" : ""}`}
              />
              <FolderIcon className="h-4 w-4 shrink-0 text-ink-4" />
              <span className="truncate">{node.name}</span>
            </button>
            {isOpen && (
              <TreeList
                nodes={node.children}
                depth={depth + 1}
                projectId={projectId}
                selectedPath={selectedPath}
                expanded={expanded}
                filtering={filtering}
                onToggle={onToggle}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}
