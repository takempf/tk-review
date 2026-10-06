import {
  type ColumnVisibilityState,
  columnVisibilityFeature,
  createColumnHelper,
  createSortedRowModel,
  rowSortingFeature,
  type SortingState,
  sortFn_alphanumeric,
  sortFn_basic,
  sortFn_text,
  tableFeatures,
  useTable,
} from "@tanstack/react-table";
import { createContext, useContext, useMemo, useState } from "react";
import { Badge, Button, Icon, Menu } from "tk-design-system";
import type { PrLabel, PrSummary, ReviewEngine } from "../../ipc/git";
import { prStatus, STATUS_LABELS, STATUSES } from "../../lib/prStatus";
import { prMorphKey, ScreenMorph } from "../../lib/screenTransition";
import type { StackLinks } from "../../lib/stacks";
import { absoluteTime, shortTime } from "../../lib/time";
import type { ReviewedPr } from "../../store/history";
import { Author, githubHost } from "../Author/Author";
import { useCarries } from "./carry";
import css from "./PrTable.module.css";

/**
 * One row: a pull request GitHub lists as open, one reviewed here that it no
 * longer lists, or both. `pr` is null for a reviewed PR that has closed, or
 * whose listing has not loaded yet.
 */
export interface PrRow {
  number: number;
  title: string;
  author: string | null;
  authorName?: string | null;
  url: string | null;
  pr: PrSummary | null;
  reviewed: ReviewedPr | undefined;
  stack: StackLinks | undefined;
  /** How many of the stacked PRs above it are its ancestors, in the list's own order. */
  depth: number;
}

/** What the cells need beyond their own row. */
interface TableContext {
  root: string;
  /** Whether GitHub's open list has loaded, so a PR missing from it has closed. */
  listed: boolean;
  /** Stacks only indent in the list's own order; a sorted column breaks them up. */
  grouped: boolean;
}

const Context = createContext<TableContext | null>(null);

function useTableContext(): TableContext {
  const context = useContext(Context);
  if (!context) throw new Error("PrTable cells render inside PrTable");
  return context;
}

const ENGINES: Record<ReviewEngine, string> = { claude: "Claude Code", codex: "Codex" };

/** Ascending: what most needs a reviewer's attention first. */
function statusRank(pr: PrSummary | null): number | undefined {
  return pr ? STATUSES.indexOf(prStatus(pr)) : undefined;
}

function timestamp(iso: string | null | undefined): number | undefined {
  const time = iso ? Date.parse(iso) : Number.NaN;
  return Number.isNaN(time) ? undefined : time;
}

function Empty() {
  return <span className={css.empty}>—</span>;
}

function When({ iso, stale = false }: { iso: string | undefined; stale?: boolean }) {
  if (!iso || timestamp(iso) == null) return <Empty />;
  return (
    <time
      dateTime={iso}
      title={stale ? `${absoluteTime(iso)}: new commits since the review` : absoluteTime(iso)}
      className={css.when}
      data-stale={stale || undefined}
    >
      {shortTime(iso)}
    </time>
  );
}

/** Whether the PR has moved on from the commit its review read. */
function hasNewCommits(row: PrRow): boolean {
  const reviewed = row.reviewed?.headSha;
  return row.pr != null && reviewed != null && reviewed !== row.pr.headSha;
}

const HEX = /^[0-9a-f]{6}$/i;

/** A label's colour as CSS, from GitHub's six hex digits. */
export function labelColor(color: string | undefined): string {
  return color && HEX.test(color) ? `#${color}` : "var(--tk-fg-subtle)";
}

function Label({ label }: { label: PrLabel }) {
  return (
    <Badge
      className={css.label}
      style={{ "--label": labelColor(label.color) } as React.CSSProperties}
    >
      {label.name}
    </Badge>
  );
}

function NumberCell({ row }: { row: PrRow }) {
  const { root } = useTableContext();
  const carries = useCarries(root, row.number, row.url);
  return (
    <ScreenMorph id={prMorphKey(root, row.number)} part="number" active={carries}>
      <span className={css.number}>#{row.number}</span>
    </ScreenMorph>
  );
}

/** Under the title: the PR's branch and the one it merges into. */
function Branches({ pr }: { pr: PrSummary }) {
  return (
    <span className={css.branches} title={`${pr.headRef} into ${pr.baseRef}`}>
      <span className={css.branch}>{pr.headRef}</span>
      <Icon name="arrow-right" className={css.into} />
      <span className={css.branch}>{pr.baseRef}</span>
    </span>
  );
}

function TitleCell({ row }: { row: PrRow }) {
  const { root, grouped } = useTableContext();
  const carries = useCarries(root, row.number, row.url);
  const depth = grouped ? row.depth : 0;
  // Grouped, the rows themselves draw the stack: a child sits indented under
  // its parent. Badges only say what the rows can't: a parent that isn't listed
  // above, or the whole stack once a sort has laid the rows flat.
  const parent = depth === 0 ? row.stack?.parent : undefined;
  const children = grouped ? [] : (row.stack?.children ?? []);
  return (
    <div
      className={css.titleCell}
      data-stacked={depth > 0 || undefined}
      style={depth > 0 ? ({ "--stack-depth": depth } as React.CSSProperties) : undefined}
    >
      {/* The row's keyboard route: a click anywhere on the row does the same. */}
      <button
        type="button"
        className={css.titleButton}
        disabled={!row.url}
        title={row.url ? undefined : "Load the open pull requests to reopen this one"}
      >
        <ScreenMorph id={prMorphKey(root, row.number)} part="title" active={carries}>
          <span>{row.title}</span>
        </ScreenMorph>
      </button>
      {row.pr ? <Branches pr={row.pr} /> : null}
      {parent || children.length > 0 ? (
        <span className={css.titleMeta}>
          {parent ? (
            <Badge title={`Targets #${parent.number}: ${parent.title}`}>
              Stacked on #{parent.number}
            </Badge>
          ) : null}
          {children.length > 0 ? (
            <Badge title={children.map((child) => `#${child.number}: ${child.title}`).join("\n")}>
              {children.map((child) => `#${child.number}`).join(", ")} on top
            </Badge>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}

function StatusCell({ pr }: { pr: PrSummary | null }) {
  const { listed } = useTableContext();
  if (!pr) return listed ? <span className={css.muted}>{STATUS_LABELS.closed}</span> : <Empty />;
  const status = prStatus(pr);
  const label = STATUS_LABELS[status];
  switch (status) {
    case "draft":
      return <Badge>{label}</Badge>;
    case "approved":
      return <Badge tone="success">{label}</Badge>;
    case "changesRequested":
      return <Badge tone="danger">{label}</Badge>;
    case "reviewRequired":
      return <span className={css.muted}>{label}</span>;
    case "noReview":
      return <Empty />;
  }
}

function ReviewedCell({ row }: { row: PrRow }) {
  const reviewed = row.reviewed;
  if (!reviewed) return <Empty />;
  const findings =
    reviewed.findings === 0
      ? "Clean"
      : `${reviewed.findings} finding${reviewed.findings === 1 ? "" : "s"}`;
  return (
    <div
      className={css.twoLine}
      title={`Reviewed ${absoluteTime(reviewed.createdAt)} with ${ENGINES[reviewed.engine] ?? reviewed.engine}`}
    >
      <time dateTime={reviewed.createdAt} className={css.when} data-reviewed>
        {shortTime(reviewed.createdAt)}
      </time>
      <span className={css.secondary}>{findings}</span>
    </div>
  );
}

function SizeCell({ pr }: { pr: PrSummary | null }) {
  if (!pr) return <Empty />;
  return (
    <div className={css.twoLine} data-align="end">
      <span className={css.stats}>
        <span className={css.added}>+{pr.additions}</span>
        <span className={css.deleted}>−{pr.deletions}</span>
      </span>
      <span className={css.secondary}>
        {pr.changedFiles} file{pr.changedFiles === 1 ? "" : "s"}
      </span>
    </div>
  );
}

const features = tableFeatures({
  rowSortingFeature,
  columnVisibilityFeature,
  sortedRowModel: createSortedRowModel(),
});

const column = createColumnHelper<typeof features, PrRow>();

/**
 * Every column sorts. Each names its first direction rather than leaving it to
 * TanStack's guess from the first row, which flips with whatever that row
 * holds: dates and sizes start newest and biggest, text starts at A. Empty
 * cells sort last either way.
 */
const columns = column.columns([
  column.accessor("number", {
    header: "#",
    sortFn: sortFn_basic,
    sortDescFirst: true,
    enableHiding: false,
    cell: ({ row }) => <NumberCell row={row.original} />,
  }),
  column.accessor("title", {
    header: "Title",
    sortFn: sortFn_alphanumeric,
    sortDescFirst: false,
    enableHiding: false,
    cell: ({ row }) => <TitleCell row={row.original} />,
  }),
  column.accessor((row) => row.author ?? undefined, {
    id: "author",
    header: "Author",
    sortFn: sortFn_text,
    sortDescFirst: false,
    sortUndefined: "last",
    cell: ({ row }) =>
      row.original.author ? (
        <Author
          login={row.original.author}
          host={githubHost(row.original.url)}
          className={css.author}
        />
      ) : (
        <Empty />
      ),
  }),
  column.accessor((row) => row.pr?.labels.map((label) => label.name).join(" ") || undefined, {
    id: "labels",
    header: "Labels",
    sortFn: sortFn_text,
    sortDescFirst: false,
    sortUndefined: "last",
    cell: ({ row }) => {
      const labels = row.original.pr?.labels ?? [];
      if (labels.length === 0) return <Empty />;
      return (
        <span className={css.labels}>
          {labels.map((label) => (
            <Label key={label.name} label={label} />
          ))}
        </span>
      );
    },
  }),
  column.accessor((row) => statusRank(row.pr), {
    id: "status",
    header: "Status",
    sortFn: sortFn_basic,
    sortDescFirst: false,
    sortUndefined: "last",
    cell: ({ row }) => <StatusCell pr={row.original.pr} />,
  }),
  column.accessor((row) => (row.pr ? row.pr.additions + row.pr.deletions : undefined), {
    id: "size",
    header: "Size",
    sortFn: sortFn_basic,
    sortDescFirst: true,
    sortUndefined: "last",
    cell: ({ row }) => <SizeCell pr={row.original.pr} />,
  }),
  // Beside Updated, so a PR that has moved on since its review shows as a later
  // time there, set in the warning colour.
  column.accessor((row) => timestamp(row.reviewed?.createdAt), {
    id: "reviewed",
    header: "Reviewed",
    sortFn: sortFn_basic,
    sortDescFirst: true,
    sortUndefined: "last",
    cell: ({ row }) => <ReviewedCell row={row.original} />,
  }),
  column.accessor((row) => timestamp(row.pr?.updatedAt), {
    id: "updated",
    header: "Updated",
    sortFn: sortFn_basic,
    sortDescFirst: true,
    sortUndefined: "last",
    cell: ({ row }) => (
      <When iso={row.original.pr?.updatedAt} stale={hasNewCommits(row.original)} />
    ),
  }),
  column.accessor((row) => timestamp(row.pr?.createdAt), {
    id: "created",
    header: "Opened",
    sortFn: sortFn_basic,
    sortDescFirst: true,
    sortUndefined: "last",
    cell: ({ row }) => <When iso={row.original.pr?.createdAt} />,
  }),
]);

/** The columns a viewer can hide, in table order, for the toolbar's menu. */
const HIDEABLE = columns
  .filter((def) => def.enableHiding !== false)
  .map((def) => ({
    id: def.id ?? ("accessorKey" in def ? String(def.accessorKey) : ""),
    label: String(def.header),
  }));

function readStored<T>(key: string, valid: (value: unknown) => value is T, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    const value: unknown = raw ? JSON.parse(raw) : null;
    return valid(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

function writeStored(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Remembered sorting and columns are conveniences, never dependencies.
  }
}

const SORT_KEY = "tk-review:home-sort";
const COLUMNS_KEY = "tk-review:home-columns";

const isSorting = (value: unknown): value is SortingState =>
  Array.isArray(value) &&
  value.every((sort) => typeof sort?.id === "string" && typeof sort?.desc === "boolean");

const isVisibility = (value: unknown): value is ColumnVisibilityState =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Which columns show, remembered across launches. Shared by the table and its menu. */
export function useColumnVisibility() {
  const [visibility, setVisibility] = useState<ColumnVisibilityState>(() =>
    readStored(COLUMNS_KEY, isVisibility, {}),
  );
  const update = (next: ColumnVisibilityState) => {
    setVisibility(next);
    writeStored(COLUMNS_KEY, next);
  };
  return [visibility, update] as const;
}

export function ColumnMenu({
  visibility,
  onChange,
}: {
  visibility: ColumnVisibilityState;
  onChange: (next: ColumnVisibilityState) => void;
}) {
  return (
    <Menu.Root>
      <Menu.Trigger render={<Button size="sm" variant="ghost" />}>
        <Icon name="columns" /> Columns
      </Menu.Trigger>
      <Menu.Popup size="sm" align="end">
        {HIDEABLE.map(({ id, label }) => (
          <Menu.CheckboxItem
            key={id}
            checked={visibility[id] !== false}
            onCheckedChange={(checked) => onChange({ ...visibility, [id]: checked })}
            closeOnClick={false}
          >
            {label}
          </Menu.CheckboxItem>
        ))}
      </Menu.Popup>
    </Menu.Root>
  );
}

const SORT_ICONS = { asc: "chevron-up", desc: "chevron-down" } as const;

/**
 * The Size column's two slots, each as wide as its longest count among the
 * rows (sign included), so every row's additions and deletions sit in the same
 * places, right-aligned, and read down the column as two.
 */
function sizeSlots(rows: PrRow[]): React.CSSProperties {
  // Room for four digits from the start, so a page of bigger PRs arriving
  // rarely widens the column (and rewraps every title beside it).
  let added = 4;
  let deleted = 4;
  for (const { pr } of rows) {
    if (!pr) continue;
    added = Math.max(added, String(pr.additions).length);
    deleted = Math.max(deleted, String(pr.deletions).length);
  }
  return {
    "--added-width": `${added + 1}ch`,
    "--deleted-width": `${deleted + 1}ch`,
  } as React.CSSProperties;
}

/**
 * The pull requests as a table: every column sorts (shift-click to add a
 * second), and a sort clicked off returns the list to its own order, with
 * stacks grouped. The sort is remembered across tabs and launches.
 */
export function PrTable({
  rows,
  visibility,
  onOpen,
  ...context
}: Omit<TableContext, "grouped"> & {
  rows: PrRow[];
  visibility: ColumnVisibilityState;
  onOpen: (row: PrRow) => void;
}) {
  const [sorting, setSorting] = useState<SortingState>(() => readStored(SORT_KEY, isSorting, []));

  const table = useTable({
    features,
    columns,
    data: rows,
    getRowId: (row) => String(row.number),
    state: { sorting, columnVisibility: visibility },
    onSortingChange: (updater) => {
      const next = typeof updater === "function" ? updater(sorting) : updater;
      setSorting(next);
      writeStored(SORT_KEY, next);
    },
  });

  const slots = useMemo(() => sizeSlots(rows), [rows]);
  const grouped = sorting.length === 0;
  const value = useMemo(
    () => ({ root: context.root, listed: context.listed, grouped }),
    [context.root, context.listed, grouped],
  );

  return (
    <Context value={value}>
      <table className={css.table} style={slots}>
        <thead>
          {table.getHeaderGroups().map((group) => (
            <tr key={group.id}>
              {group.headers.map((header) => {
                const sorted = header.column.getIsSorted();
                return (
                  <th
                    key={header.id}
                    data-column={header.column.id}
                    aria-sort={
                      sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : undefined
                    }
                  >
                    <button
                      type="button"
                      className={css.sort}
                      data-sorted={sorted || undefined}
                      onClick={header.column.getToggleSortingHandler()}
                    >
                      <table.FlexRender header={header} />
                      <Icon
                        name={sorted ? SORT_ICONS[sorted] : "chevron-updown"}
                        className={css.sortIcon}
                      />
                    </button>
                  </th>
                );
              })}
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows.map((row) => {
            const { url } = row.original;
            // The title's button is the row's keyboard route; the row widens its pointer target.
            return (
              <tr
                key={row.id}
                // What the list holds its place by as rows come and go (Home's `useHeldPlace`).
                data-pr={row.original.number}
                className={css.row}
                data-disabled={!url || undefined}
                onClick={() => url && onOpen(row.original)}
              >
                {row.getVisibleCells().map((cell) => (
                  <td key={cell.id} data-column={cell.column.id}>
                    <table.FlexRender cell={cell} />
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </Context>
  );
}
