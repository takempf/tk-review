import { useEffect, useRef, useState } from "react";
import type { ChangeStatus, FileChange } from "../../ipc/git";
import type { TreeNode } from "../../lib/fileChange";
import { buildFileTree, describeChange, STATUS_META, splitPath } from "../../lib/fileChange";
import { useReviewStore } from "../../store/reviewStore";
import css from "./FileList.module.css";

// `satisfies` keeps every status accounted for while allowing the class values,
// which CSS-module typings widen to `string | undefined`, to infer.
const BADGE_CLASS = {
  added: css.badgeAdded,
  modified: css.badgeModified,
  deleted: css.badgeDeleted,
  renamed: css.badgeRenamed,
  copied: css.badgeRenamed,
  typeChanged: css.badgeOther,
  unmerged: css.badgeOther,
  unknown: css.badgeOther,
} satisfies Record<ChangeStatus, string | undefined>;

/** Each level steps in far enough to read as nesting without eating the row. */
const INDENT_STEP = 12;

function indent(depth: number) {
  return { paddingLeft: `calc(var(--space-2) + ${depth * INDENT_STEP}px)` };
}

interface RowProps {
  file: FileChange;
  depth: number;
  selected: boolean;
  viewed: boolean;
  onSelect: () => void;
  onToggleViewed: () => void;
}

function Row({ file, depth, selected, viewed, onSelect, onToggleViewed }: RowProps) {
  const ref = useRef<HTMLLIElement>(null);

  // Keyboard navigation can move the selection off screen.
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const { name } = splitPath(file.path);

  return (
    <li ref={ref} className={selected ? css.itemSelected : css.item}>
      {/* The name alone is ambiguous across folders, so the tooltip carries the
          full path. */}
      <button
        type="button"
        className={css.row}
        style={indent(depth)}
        onClick={onSelect}
        title={`${file.path}\n${describeChange(file)}`}
      >
        <span className={BADGE_CLASS[file.status]} aria-hidden="true">
          {STATUS_META[file.status].letter}
        </span>
        <span className={viewed ? css.nameViewed : css.name}>{name}</span>
        {file.isGenerated ? (
          <span className={css.generated} title="Marked linguist-generated in .gitattributes">
            gen
          </span>
        ) : null}
        <span className={css.counts}>
          {file.isBinary ? (
            <span className={css.binary}>bin</span>
          ) : (
            <>
              <span className={css.additions}>+{file.additions}</span>{" "}
              <span className={css.deletions}>−{file.deletions}</span>
            </>
          )}
        </span>
      </button>
      <input
        type="checkbox"
        className={css.viewed}
        checked={viewed}
        onChange={onToggleViewed}
        title="Mark as viewed"
        aria-label={`Mark ${file.path} as viewed`}
      />
    </li>
  );
}

interface NodesProps {
  nodes: TreeNode[];
  depth: number;
  collapsed: Set<string>;
  onToggleCollapsed: (path: string) => void;
}

function Nodes({ nodes, depth, collapsed, onToggleCollapsed }: NodesProps) {
  const selectedPath = useReviewStore((state) => state.selectedPath);
  const viewed = useReviewStore((state) => state.viewed);
  const selectFile = useReviewStore((state) => state.selectFile);
  const toggleViewed = useReviewStore((state) => state.toggleViewed);

  return (
    <ul className={css.list}>
      {nodes.map((node) =>
        node.kind === "file" ? (
          <Row
            key={node.file.path}
            file={node.file}
            depth={depth}
            selected={node.file.path === selectedPath}
            viewed={viewed.has(node.file.path)}
            onSelect={() => selectFile(node.file.path)}
            onToggleViewed={() => toggleViewed(node.file.path)}
          />
        ) : (
          <li key={node.path} className={css.group}>
            <button
              type="button"
              className={css.dir}
              style={indent(depth)}
              onClick={() => onToggleCollapsed(node.path)}
              aria-expanded={!collapsed.has(node.path)}
            >
              {/* Same equilateral triangle the comboboxes use, turned a quarter
                  turn to the right while the folder is shut. */}
              <svg
                className={collapsed.has(node.path) ? css.chevronShut : css.chevron}
                viewBox="0 0 10 8.6603"
                aria-hidden="true"
              >
                <polygon points="0,0 10,0 5,8.6603" />
              </svg>
              <svg className={css.folder} viewBox="0 0 16 16" aria-hidden="true">
                <path d="M1.5 3.5a1 1 0 0 1 1-1h3.3a1 1 0 0 1 .7.3l1.2 1.2h6.8a1 1 0 0 1 1 1v7.5a1 1 0 0 1-1 1h-12a1 1 0 0 1-1-1z" />
              </svg>
              <span className={css.dirLabel}>{node.label}</span>
              {collapsed.has(node.path) ? (
                <span className={css.hidden}>{countFiles(node)}</span>
              ) : null}
            </button>
            {collapsed.has(node.path) ? null : (
              <Nodes
                nodes={node.children}
                depth={depth + 1}
                collapsed={collapsed}
                onToggleCollapsed={onToggleCollapsed}
              />
            )}
          </li>
        ),
      )}
    </ul>
  );
}

function countFiles(node: TreeNode): number {
  if (node.kind === "file") return 1;
  return node.children.reduce((total, child) => total + countFiles(child), 0);
}

export function FileList() {
  const summary = useReviewStore((state) => state.summary);
  const loading = useReviewStore((state) => state.loadingDiff);
  const selectedPath = useReviewStore((state) => state.selectedPath);
  const viewed = useReviewStore((state) => state.viewed);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  // Keyboard navigation walks the flat file order, so it can land inside a
  // folder that is folded shut: reopen the ancestors rather than lose the row.
  useEffect(() => {
    if (!selectedPath) return;
    const segments = selectedPath.split("/").slice(0, -1);
    const ancestors = segments.map((_, index) => segments.slice(0, index + 1).join("/"));
    setCollapsed((current) => {
      if (!ancestors.some((path) => current.has(path))) return current;
      const next = new Set(current);
      for (const path of ancestors) next.delete(path);
      return next;
    });
  }, [selectedPath]);

  if (loading && !summary) return <p className={css.empty}>Comparing…</p>;
  if (!summary) return null;

  if (summary.files.length === 0) {
    return <p className={css.empty}>No differences between these refs.</p>;
  }

  const toggleCollapsed = (path: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (!next.delete(path)) next.add(path);
      return next;
    });

  return (
    <div className={css.wrap}>
      <div className={css.heading}>
        <span>Files</span>
        <span className={css.progress}>
          {viewed.size}/{summary.files.length} viewed
        </span>
      </div>
      <div className={css.scroll}>
        <Nodes
          nodes={buildFileTree(summary.files)}
          depth={0}
          collapsed={collapsed}
          onToggleCollapsed={toggleCollapsed}
        />
      </div>
    </div>
  );
}
