import { prStatus, STATUS_LABELS, STATUSES } from "../../lib/prStatus";
import type { PrRow } from "../PrTable/PrTable";

export const FACETS = ["author", "status", "label"] as const;
export type Facet = (typeof FACETS)[number];

/**
 * What the list is narrowed to. A row passes a filter holding any of its
 * values, and has to pass every filter that holds something.
 */
export type PrFilters = Record<Facet, string[]>;

export const NO_FILTERS: PrFilters = { author: [], status: [], label: [] };

export function isFiltering(filters: PrFilters): boolean {
  return FACETS.some((facet) => filters[facet].length > 0);
}

/**
 * A row's values for each filter. A reviewed PR missing from GitHub's open list
 * has closed, but only once that list has loaded (`listed`); until then its
 * status is unknown and no status filter lets it through.
 */
function valuesOf(row: PrRow, listed: boolean): PrFilters {
  return {
    author: row.author ? [row.author] : [],
    status: row.pr ? [prStatus(row.pr)] : listed ? ["closed"] : [],
    label: row.pr?.labels.map((label) => label.name) ?? [],
  };
}

function passes(values: PrFilters, filters: PrFilters, except?: Facet): boolean {
  return FACETS.every(
    (facet) =>
      facet === except ||
      filters[facet].length === 0 ||
      values[facet].some((value) => filters[facet].includes(value)),
  );
}

export function filterRows(rows: PrRow[], filters: PrFilters, listed: boolean): PrRow[] {
  if (!isFiltering(filters)) return rows;
  return rows.filter((row) => passes(valuesOf(row, listed), filters));
}

const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "base" });

export const FACET_INFO: Record<
  Facet,
  { title: string; name: (value: string) => string; order: typeof byName }
> = {
  author: {
    title: "Author",
    name: (login) => `@${login}`,
    order: byName,
  },
  status: {
    title: "Status",
    name: (status) => STATUS_LABELS[status as keyof typeof STATUS_LABELS] ?? status,
    order: (a, b) =>
      STATUSES.indexOf(a as (typeof STATUSES)[number]) -
      STATUSES.indexOf(b as (typeof STATUSES)[number]),
  },
  label: {
    title: "Label",
    name: (label) => label,
    order: byName,
  },
};

export interface FilterOption {
  value: string;
  /** How many rows it would show, given the other filters. */
  count: number;
}

/**
 * What one filter offers: every value among the rows the other filters let
 * through, so its counts say what choosing each would show. Keep chosen values
 * in the collection, even at zero, so their chips survive tabs without matches.
 */
export function optionsFor(
  facet: Facet,
  rows: PrRow[],
  filters: PrFilters,
  listed: boolean,
): FilterOption[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const values = valuesOf(row, listed);
    if (!passes(values, filters, facet)) continue;
    for (const value of new Set(values[facet])) counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  for (const value of filters[facet]) if (!counts.has(value)) counts.set(value, 0);
  return [...counts]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => FACET_INFO[facet].order(a.value, b.value));
}

/** A facet prefix scopes autocomplete without filtering the PR titles by the prefix. */
export function filterQuery(query: string): { facet: Facet | null; text: string } {
  const match = /^\s*(author|status|label):\s*(.*)$/i.exec(query);
  return match?.[1] && match[2] !== undefined
    ? { facet: match[1].toLowerCase() as Facet, text: match[2] }
    : { facet: null, text: query };
}

export function textQuery(query: string): string {
  return filterQuery(query).facet ? "" : query;
}
