import { useMemo } from "react";
import { Button, Icon, Menu } from "tk-design-system";
import { prStatus, STATUS_LABELS, STATUSES } from "../../lib/prStatus";
import { labelColor, type PrRow } from "../PrTable/PrTable";
import css from "./PrFilters.module.css";

const FACETS = ["author", "status", "label"] as const;
type Facet = (typeof FACETS)[number];

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

const FACET_INFO: Record<
  Facet,
  { title: string; none: string; name: (value: string) => string; order: typeof byName }
> = {
  author: {
    title: "Author",
    none: "No authors in this list",
    name: (login) => `@${login}`,
    order: byName,
  },
  status: {
    title: "Status",
    none: "No statuses in this list",
    name: (status) => STATUS_LABELS[status as keyof typeof STATUS_LABELS] ?? status,
    order: (a, b) =>
      STATUSES.indexOf(a as (typeof STATUSES)[number]) -
      STATUSES.indexOf(b as (typeof STATUSES)[number]),
  },
  label: {
    title: "Label",
    none: "No labels in this list",
    name: (label) => label,
    order: byName,
  },
};

interface Option {
  value: string;
  /** How many rows it would show, given the other filters. */
  count: number;
}

/**
 * What one filter offers: every value among the rows the other filters let
 * through, so its counts say what choosing each would show. A value already
 * chosen stays on offer, at zero if need be, so it can be unchosen.
 */
function optionsFor(facet: Facet, rows: PrRow[], filters: PrFilters, listed: boolean): Option[] {
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

function FilterMenu({
  facet,
  options,
  chosen,
  colors,
  onChange,
}: {
  facet: Facet;
  options: Option[];
  chosen: string[];
  colors: Map<string, string>;
  onChange: (next: string[]) => void;
}) {
  const { title, none, name } = FACET_INFO[facet];
  const [only] = chosen;
  return (
    <Menu.Root>
      <Menu.Trigger render={<Button size="sm" variant={only ? "default" : "ghost"} />}>
        {title}
        {only ? (
          <span className={css.chosen}>{chosen.length === 1 ? name(only) : chosen.length}</span>
        ) : null}
        <Icon name="chevron-down" className={css.chevron} />
      </Menu.Trigger>
      <Menu.Popup size="sm" align="end">
        {options.length === 0 ? <Menu.Item disabled>{none}</Menu.Item> : null}
        {options.map(({ value, count }) => (
          <Menu.CheckboxItem
            key={value}
            checked={chosen.includes(value)}
            onCheckedChange={(checked) =>
              onChange(checked ? [...chosen, value] : chosen.filter((other) => other !== value))
            }
            closeOnClick={false}
          >
            <span className={css.option}>
              {facet === "label" ? (
                <span
                  className={css.swatch}
                  style={{ "--label": labelColor(colors.get(value)) } as React.CSSProperties}
                />
              ) : null}
              <span className={css.optionName}>{name(value)}</span>
              <span className={css.optionCount}>{count}</span>
            </span>
          </Menu.CheckboxItem>
        ))}
        {only ? (
          <>
            <Menu.Separator />
            <Menu.Item icon="close" onClick={() => onChange([])}>
              Clear
            </Menu.Item>
          </>
        ) : null}
      </Menu.Popup>
    </Menu.Root>
  );
}

/**
 * A menu per filter, offering what the tab's rows hold: whatever pages of the
 * list have loaded, which the list keeps loading while a filter leaves it short.
 */
export function PrFilterMenus({
  rows,
  listed,
  filters,
  onChange,
}: {
  /** The tab's rows before these filters. */
  rows: PrRow[];
  listed: boolean;
  filters: PrFilters;
  onChange: (next: PrFilters) => void;
}) {
  const options = useMemo(
    () =>
      Object.fromEntries(
        FACETS.map((facet) => [facet, optionsFor(facet, rows, filters, listed)]),
      ) as Record<Facet, Option[]>,
    [rows, filters, listed],
  );
  const colors = useMemo(
    () =>
      new Map(
        rows.flatMap(
          (row) => row.pr?.labels.map((label) => [label.name, label.color] as const) ?? [],
        ),
      ),
    [rows],
  );
  return (
    <>
      {FACETS.map((facet) => (
        <FilterMenu
          key={facet}
          facet={facet}
          options={options[facet]}
          chosen={filters[facet]}
          colors={colors}
          onChange={(next) => onChange({ ...filters, [facet]: next })}
        />
      ))}
    </>
  );
}
