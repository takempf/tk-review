import type { ChangeStatus, FileChange } from "../ipc/git";

export const STATUS_META: Record<ChangeStatus, { letter: string; label: string }> = {
  added: { letter: "A", label: "Added" },
  modified: { letter: "M", label: "Modified" },
  deleted: { letter: "D", label: "Deleted" },
  renamed: { letter: "R", label: "Renamed" },
  copied: { letter: "C", label: "Copied" },
  typeChanged: { letter: "T", label: "Type changed" },
  unmerged: { letter: "U", label: "Unmerged" },
  unknown: { letter: "?", label: "Unknown" },
};

/** Splits a path so the directory can be dimmed and the filename emphasised. */
export function splitPath(path: string): { dir: string; name: string } {
  const index = path.lastIndexOf("/");
  if (index === -1) return { dir: "", name: path };
  return { dir: path.slice(0, index + 1), name: path.slice(index + 1) };
}

export interface TreeFile {
  kind: "file";
  file: FileChange;
}

export interface TreeDir {
  kind: "dir";
  /** Full path of the deepest folder in the node, used as its collapse key. */
  path: string;
  /** What the row shows — several folders when a chain was collapsed. */
  label: string;
  children: TreeNode[];
}

export type TreeNode = TreeFile | TreeDir;

/**
 * Builds the folder tree behind the file list. Children keep the order git gave
 * us — already sorted by path — so the tree reads the same way top to bottom
 * whether or not anything is collapsed.
 *
 * Folders with a single subfolder and nothing else are merged into one row
 * ("src/components/FileList"), which keeps deep, sparse trees from turning into
 * a staircase of near-empty levels.
 */
export function buildFileTree(files: FileChange[]): TreeNode[] {
  const root: TreeDir = { kind: "dir", path: "", label: "", children: [] };

  for (const file of files) {
    const segments = file.path.split("/").slice(0, -1);
    let dir = root;

    for (const segment of segments) {
      const path = dir.path ? `${dir.path}/${segment}` : segment;
      const existing = dir.children.find(
        (child): child is TreeDir => child.kind === "dir" && child.path === path,
      );
      if (existing) {
        dir = existing;
      } else {
        const created: TreeDir = { kind: "dir", path, label: segment, children: [] };
        dir.children.push(created);
        dir = created;
      }
    }

    dir.children.push({ kind: "file", file });
  }

  return root.children.map(collapseChains);
}

function collapseChains(node: TreeNode): TreeNode {
  if (node.kind === "file") return node;

  let current = node;
  // A lone subfolder can always be absorbed, and so can the one inside it.
  while (current.children.length === 1 && current.children[0]?.kind === "dir") {
    const only = current.children[0];
    current = {
      kind: "dir",
      path: only.path,
      label: current.label ? `${current.label}/${only.label}` : only.label,
      children: only.children,
    };
  }
  return { ...current, children: current.children.map(collapseChains) };
}

export function describeChange(file: FileChange): string {
  const status = STATUS_META[file.status].label;
  if (file.oldPath) return `${status} from ${file.oldPath}`;
  return status;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
