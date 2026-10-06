import { type CSSProperties, useMemo } from "react";
import { Combobox, type ComboboxGroup, Icon } from "tk-design-system";
import { useScreenShown } from "../../lib/screenTransition";
import { Author, githubHost } from "../Author/Author";
import { labelColor, type PrRow } from "../PrTable/PrTable";
import {
  FACET_INFO,
  FACETS,
  type Facet,
  type FilterOption,
  filterQuery,
  filterRows,
  NO_FILTERS,
  optionsFor,
  type PrFilters,
} from "./PrFilters";
import css from "./PrFilters.module.css";

interface FilterItem extends FilterOption {
  kind: "filter";
  facet: Facet;
}

interface PrItem {
  kind: "pr";
  row: PrRow;
}

type OmnibarItem = FilterItem | PrItem;

const itemName = (item: OmnibarItem) =>
  item.kind === "pr"
    ? `#${item.row.number} ${item.row.title}`
    : FACET_INFO[item.facet].name(item.value);
const itemKey = (item: OmnibarItem) =>
  item.kind === "pr"
    ? JSON.stringify(["pr", item.row.url])
    : JSON.stringify([item.facet, item.value]);
const sameItem = (a: OmnibarItem, b: OmnibarItem) => itemKey(a) === itemKey(b);

/** One field for text, PR links, and any combination of facet filters. */
export function PrOmnibar({
  rows,
  listed,
  filters,
  onChange,
  query,
  onQueryChange,
  onSubmit,
  onOpenPr,
}: {
  rows: PrRow[];
  listed: boolean;
  filters: PrFilters;
  onChange: (next: PrFilters) => void;
  query: string;
  onQueryChange: (next: string) => void;
  onSubmit: () => void;
  onOpenPr: (row: PrRow) => void;
}) {
  const shown = useScreenShown();

  const filterGroups = useMemo(
    () =>
      FACETS.map((facet) => ({
        id: facet,
        label: FACET_INFO[facet].title,
        items: optionsFor(facet, rows, filters, listed).map(
          (option): FilterItem => ({ ...option, facet, kind: "filter" }),
        ),
      })),
    [rows, filters, listed],
  );
  const groups = useMemo<ComboboxGroup<OmnibarItem>[]>(
    () => [
      ...filterGroups,
      {
        id: "pr",
        label: "Pull requests",
        items: filterRows(rows, filters, listed)
          .filter((row) => row.url)
          .map((row): PrItem => ({ kind: "pr", row })),
      },
    ],
    [filterGroups, rows, filters, listed],
  );
  const selected = filterGroups.flatMap((group) =>
    group.items.filter((item) => filters[item.facet].includes(item.value)),
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
  const host = githubHost(rows.find((row) => row.url)?.url);
  const authorNames = useMemo(
    () =>
      new Map(
        rows.flatMap((row) =>
          row.author && row.authorName ? [[row.author, row.authorName] as const] : [],
        ),
      ),
    [rows],
  );
  const scope = filterQuery(query).facet;

  function content(item: FilterItem) {
    if (item.facet === "author") return <Author login={item.value} host={host} />;
    return (
      <>
        {item.facet === "label" ? (
          <span
            className={css.swatch}
            style={{ "--label": labelColor(colors.get(item.value)) } as CSSProperties}
          />
        ) : null}
        <span className={css.optionName}>{itemName(item)}</span>
      </>
    );
  }

  return (
    <Combobox<OmnibarItem>
      variant="input"
      size="sm"
      disabled={!shown}
      minQueryLength={1}
      groups={groups}
      value={selected}
      inputValue={query}
      onInputValueChange={onQueryChange}
      placeholder="Filter, or paste a PR link"
      selectedPlaceholder="Add a filter…"
      aria-label="Filter pull requests, or paste a pull request link"
      chipsLabel="Pull request filters"
      itemToStringLabel={itemName}
      itemToStringValue={itemKey}
      isItemEqualToValue={sameItem}
      chipAriaLabel={(item) =>
        item.kind === "filter"
          ? `${FACET_INFO[item.facet].title}: ${itemName(item)}`
          : itemName(item)
      }
      removeAriaLabel={(item) =>
        item.kind === "filter"
          ? `Remove ${item.facet} ${itemName(item)}`
          : `Remove ${itemName(item)}`
      }
      itemAriaLabel={(item) => {
        if (item.kind === "pr") return `Open pull request ${itemName(item)}`;
        const name =
          item.facet === "author"
            ? [item.value, authorNames.get(item.value)].filter(Boolean).join(" ")
            : itemName(item);
        return `${name} ${item.count}`;
      }}
      emptyMessage={
        scope
          ? `No matching ${FACET_INFO[scope].title.toLowerCase()} filters.`
          : "No matching filters or pull requests."
      }
      onSubmit={() => {
        if (!scope) onSubmit();
      }}
      filter={(item, query) => {
        const { facet, text } = filterQuery(query);
        if (item.kind === "pr") {
          const needle = text.trim().toLowerCase().replace(/^#/, "");
          return (
            !facet &&
            needle !== "" &&
            [
              item.row.number,
              item.row.title,
              item.row.author,
              item.row.authorName,
              item.row.pr?.headRef,
              item.row.pr?.baseRef,
            ].some((field) => field != null && String(field).toLowerCase().includes(needle))
          );
        }
        if (filters[item.facet].includes(item.value)) return false;
        if (facet && facet !== item.facet) return false;
        const needle = text.trim().toLowerCase().replace(/^@/, "");
        const name = item.facet === "author" ? (authorNames.get(item.value) ?? "") : "";
        return `${FACET_INFO[item.facet].title} ${itemName(item)} ${name}`
          .toLowerCase()
          .includes(needle);
      }}
      onValueChange={(next, details) => {
        const pr = next.find((item) => item.kind === "pr");
        if (pr?.kind === "pr") {
          details.cancel();
          onQueryChange("");
          onOpenPr(pr.row);
          return;
        }
        const filters: PrFilters = { ...NO_FILTERS };
        for (const facet of FACETS)
          filters[facet] = next.flatMap((item) =>
            item.kind === "filter" && item.facet === facet ? [item.value] : [],
          );
        onChange(filters);
      }}
      renderChip={(item) =>
        item.kind === "filter" ? (
          <>
            <span className={css.chipKind}>{FACET_INFO[item.facet].title}</span>
            {content(item)}
          </>
        ) : (
          itemName(item)
        )
      }
      renderItem={(item) =>
        item.kind === "pr" ? (
          <>
            <Icon name="pull-request" className={css.prIcon} />
            <span className={css.prDetails}>
              <span className={css.prTitle}>
                <span className={css.prNumber}>#{item.row.number}</span>
                {item.row.title}
              </span>
              {item.row.pr ? (
                <span className={css.prBranch}>
                  {item.row.pr.headRef} → {item.row.pr.baseRef}
                </span>
              ) : null}
            </span>
          </>
        ) : (
          <>
            {content(item)}
            {item.facet === "author" && authorNames.get(item.value) ? (
              <span className={css.optionName}>{authorNames.get(item.value)}</span>
            ) : null}
            <span className={css.optionCount}>{item.count}</span>
          </>
        )
      }
    />
  );
}
