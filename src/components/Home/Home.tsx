import { useInfiniteQuery } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { Button, Eyebrow, Icon, morph, Panel, Reveal, SceneryWindow, Tabs } from "tk-design-system";
import { errorMessage, type PrListFilter, type PrSummary, toAppError } from "../../ipc/git";
import { chooseFolder } from "../../lib/chooseFolder";
import { invalidatePrLists, prListQuery } from "../../lib/queries";
import {
  ScreenMorph,
  screenSettling,
  useScreenShown,
  useScreenVisit,
} from "../../lib/screenTransition";
import { buildStacks, groupStacks } from "../../lib/stacks";
import type { SearchDocument } from "../../lib/textSearch";
import { relativeTime } from "../../lib/time";
import { warmHighlighter } from "../../lib/warmHighlighter";
import { storageRoot } from "../../store/account";
import { useAppStore } from "../../store/appStore";
import { type ReviewedPr, readReviewedPrs } from "../../store/history";
import type { PrPreview } from "../../store/tabStore";
import { ErrorNotice } from "../ErrorNotice/ErrorNotice";
import {
  filterRows,
  isFiltering,
  NO_FILTERS,
  type PrFilters,
  textQuery,
} from "../PrFilters/PrFilters";
import { PrOmnibar } from "../PrFilters/PrOmnibar";
import { useOpening } from "../PrTable/carry";
import { ColumnMenu, type PrRow, PrTable, useColumnVisibility } from "../PrTable/PrTable";
import { useSearchDocuments } from "../Search/Search";
import { Spinner } from "../Spinner/Spinner";
import css from "./Home.module.css";

type HomeTab = PrListFilter | "reviewed";

const TABS: { value: HomeTab; label: string }[] = [
  { value: "reviewRequested", label: "Review requested" },
  { value: "mine", label: "Mine" },
  { value: "all", label: "All open" },
  { value: "reviewed", label: "Reviewed" },
];

const TAB_KEY = "tk-review:home-tab";

function readTab(): HomeTab {
  try {
    const stored = localStorage.getItem(TAB_KEY);
    return TABS.some((tab) => tab.value === stored) ? (stored as HomeTab) : "reviewRequested";
  } catch {
    return "reviewRequested";
  }
}

/** Something the search box can hand straight to `open_pr`. */
const PR_REFERENCE = /(?:\/pulls?\/\d+)|(?:^[\w.-]+\/[\w.-]+#\d+$)/;

/**
 * One `gh pr list` per filter, from the query cache (queries.ts): each shows
 * what it last listed — this visit, an earlier one, or a previous launch — and
 * refetches behind that once it is more than a moment old. Only the tab on
 * show and the full list fetch; the others read the cache for their counts,
 * and fetch when opened.
 */
function usePrListings(root: string, login: string | null, shown: PrListFilter, onScreen: boolean) {
  // Stacks come from the full list too: a filtered tab can leave out the PR
  // another one is stacked on.
  const listing = (filter: PrListFilter) => ({
    ...prListQuery(root, login, filter),
    enabled: onScreen && (filter === shown || filter === "all"),
  });
  return {
    reviewRequested: useInfiniteQuery(listing("reviewRequested")),
    mine: useInfiniteQuery(listing("mine")),
    all: useInfiniteQuery(listing("all")),
  } satisfies Record<PrListFilter, unknown>;
}

interface Reviewed {
  /** Most recent review first. */
  list: ReviewedPr[];
  byNumber: Map<number, ReviewedPr>;
}

/**
 * The latest review of each PR, keyed by number, for the badges on every tab.
 * `scope` is the repository's storage root, so it is the signed-in account's.
 */
function useReviewed(scope: string, visit: number): Reviewed {
  // Read once per visit: reviews are only written from the review screen.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `visit` is the reason to read again
  return useMemo(() => {
    const reviewed = readReviewedPrs(scope);
    return { list: reviewed, byNumber: new Map(reviewed.map((entry) => [entry.number, entry])) };
  }, [scope, visit]);
}

function matches(query: string, ...fields: (string | number | null | undefined)[]): boolean {
  const needle = query.trim().toLowerCase().replace(/^#/, "");
  if (!needle) return true;
  return fields.some((field) => field != null && String(field).toLowerCase().includes(needle));
}

const NO_PRS: PrSummary[] = [];

/**
 * Which PRs stack on which. From the tab's own PRs as well as everyone's: "All
 * open" is only what has loaded so far, so an older stack listed under "Mine"
 * would otherwise have no links at all. Newest first, as `buildStacks` expects.
 */
function stacksOf(openPrs: PrSummary[], allPrs: PrSummary[], defaultBranch: string | null) {
  const known = new Map([...allPrs, ...openPrs].map((pr) => [pr.number, pr]));
  return buildStacks(
    [...known.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    defaultBranch,
  );
}

type Stacks = ReturnType<typeof stacksOf>;

/**
 * One tab's rows that match the search, before the filters and with stacks not
 * yet grouped. The open tabs list GitHub's pull requests; "Reviewed" lists the
 * review history, filled in from GitHub's list wherever the PR is still open.
 */
function buildRows(
  tab: HomeTab,
  query: string,
  openPrs: PrSummary[],
  reviewed: Reviewed,
  stacks: Stacks,
): PrRow[] {
  const labelNames = (pr: PrSummary | null | undefined) =>
    pr?.labels.map((label) => label.name) ?? [];

  if (tab !== "reviewed") {
    return openPrs
      .filter((pr) => matches(query, pr.number, pr.title, pr.author, pr.headRef, ...labelNames(pr)))
      .map((pr) => ({
        number: pr.number,
        title: pr.title,
        author: pr.author,
        url: pr.url,
        pr,
        reviewed: reviewed.byNumber.get(pr.number),
        stack: stacks.get(pr.number),
        depth: 0,
      }));
  }

  const openByNumber = new Map(openPrs.map((pr) => [pr.number, pr]));
  // Any open PR's URL gives the repository's; older history entries lack their own.
  const urlFor = (number: number) =>
    openPrs[0]?.url.replace(/\/pull\/\d+$/, `/pull/${number}`) ?? null;
  return reviewed.list.flatMap((entry): PrRow[] => {
    const live = openByNumber.get(entry.number) ?? null;
    const row: PrRow = {
      number: entry.number,
      title: live?.title ?? entry.title ?? `Pull request #${entry.number}`,
      author: live?.author ?? entry.author,
      url: live?.url ?? entry.url ?? urlFor(entry.number),
      pr: live,
      reviewed: entry,
      stack: live ? stacks.get(live.number) : undefined,
      depth: 0,
    };
    const shown = matches(
      query,
      row.number,
      row.title,
      row.author,
      live?.headRef,
      ...labelNames(live),
    );
    return shown ? [row] : [];
  });
}

/**
 * An open tab's rows in the list's own order with each stack grouped, read
 * bottom-up. Grouped after filtering, so a member filtered out leaves the rest
 * of its stack intact rather than a child indented under the wrong row.
 */
function groupRows(rows: PrRow[], stacks: Stacks): PrRow[] {
  const byNumber = new Map(rows.map((row) => [row.number, row]));
  const prs = rows.flatMap((row) => (row.pr ? [row.pr] : []));
  return groupStacks(prs, stacks).flatMap(({ pr, depth }) => {
    const row = byNumber.get(pr.number);
    return row ? [{ ...row, depth }] : [];
  });
}

/**
 * Keeps the reader's place while the list's rows change under them. A page
 * arriving can pull a stacked PR up beside its newly listed parent, or widen a
 * column so the titles above rewrap, and WebKit doesn't anchor scrolling the
 * way Chromium does, so everything in view would lurch. The row at the top of
 * the view is held where it was instead.
 */
function useHeldPlace(scroller: HTMLElement | null, rows: unknown) {
  const held = useRef<{ scroller: HTMLElement; pr: string; top: number } | null>(null);

  // Which row is at the top of the view, just under the sticky header, and
  // how far down it sits.
  const note = useRef(() => {});
  note.current = () => {
    if (!scroller || scroller.scrollTop <= 0) {
      held.current = null;
      return;
    }
    const view = scroller.getBoundingClientRect();
    // The header's cells stick, not the header itself, which scrolls away.
    const under = scroller.querySelector("thead th")?.getBoundingClientRect().bottom ?? view.top;
    const row = document
      .elementFromPoint(view.left + view.width / 2, under + 1)
      ?.closest<HTMLElement>("tr[data-pr]");
    held.current = row?.dataset.pr
      ? { scroller, pr: row.dataset.pr, top: row.getBoundingClientRect().top - view.top }
      : null;
  };

  useEffect(() => {
    if (!scroller) return;
    const onScroll = () => note.current();
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => scroller.removeEventListener("scroll", onScroll);
  }, [scroller]);

  // After the rows have changed, before they paint: put that row back.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `rows` changing is the reason to run
  useLayoutEffect(() => {
    const place = held.current;
    if (scroller && place?.scroller === scroller) {
      const row = scroller.querySelector(`tr[data-pr="${place.pr}"]`);
      if (row) {
        const top = row.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
        scroller.scrollTop += top - place.top;
      }
    }
    note.current();
  }, [scroller, rows]);
}

/**
 * The end of a list with more on GitHub: coming within a screen of it loads the
 * next page, and keeps loading while it stays in reach (a filter matching few
 * of the rows loaded, say). A page that fails says so, and can be tried again.
 */
function MorePrs({ listing }: { listing: ReturnType<typeof usePrListings>["all"] }) {
  const end = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);
  const { hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage } = listing;

  useEffect(() => {
    const element = end.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      ([entry]) => setNear(entry?.isIntersecting ?? false),
      {
        root: element.closest(`.${css.listScroll}`),
        rootMargin: "0px 0px 100% 0px",
      },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (near && hasNextPage && !isFetchingNextPage && !isFetchNextPageError) void fetchNextPage();
  }, [near, hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage]);

  if (!hasNextPage) return null;
  return (
    <div ref={end} className={css.more} role="status">
      {isFetchNextPageError ? (
        <>
          Could not load more pull requests.{" "}
          <Button variant="ghost" size="sm" onClick={() => void fetchNextPage()}>
            Try again
          </Button>
        </>
      ) : (
        <>
          <Spinner /> Loading more…
        </>
      )}
    </div>
  );
}

function ListMessage({ children }: { children: React.ReactNode }) {
  return <p className={css.message}>{children}</p>;
}

function PrBrowser({ root, login }: { root: string; login: string | null }) {
  const openPr = useAppStore((state) => state.openPr);
  const compareBranches = useAppStore((state) => state.compareBranches);
  const [tab, setTab] = useState<HomeTab>(readTab);
  const [query, setQuery] = useState("");
  // Held while the list is out of sight, so they're still set on coming back
  // from a review; a new launch or another repository starts unfiltered.
  const [filters, setFilters] = useState<PrFilters>(NO_FILTERS);
  const [columns, setColumns] = useColumnVisibility();
  const defaultBranch = useAppStore((state) => state.repo?.defaultBranch ?? null);
  // The list stays mounted between visits; each one reads the history afresh.
  const visit = useScreenVisit();
  const reviewed = useReviewed(storageRoot({ root, githubLogin: login }), visit);
  // Out of sight, the lists keep what they last showed but fetch nothing.
  const shown = useScreenShown();
  const heading = useAppStore((state) => state.screenChange?.heading ?? false);

  // The reviewed tab reads its open/closed state and freshness from the full list.
  const needed: PrListFilter = tab === "reviewed" ? "all" : tab;
  const listings = usePrListings(root, login, needed, shown);
  const listing = listings[needed];
  const all = listings.all;
  // Rows already on screen stay up while their lists refetch; only the
  // Refresh button says so, and a failed refetch leaves them where they are.
  const refreshing = listing.isFetching || all.isFetching;
  const refreshFailed = listing.isError && !listing.isFetching && listing.data != null;

  // Once the list is up, spend the idle time compiling the highlighter's
  // grammars, so the first diff opened doesn't pay for it (warmHighlighter.ts).
  const ready = listing.data != null;
  useEffect(() => {
    if (ready) warmHighlighter();
  }, [ready]);

  function selectTab(next: HomeTab) {
    morph(() => setTab(next), { scope: "home-list" });
    try {
      localStorage.setItem(TAB_KEY, next);
    } catch {
      // The remembered tab is a convenience, never a dependency.
    }
  }

  /**
   * With a `preview` — a row's number and title — the review shows at once and
   * loads in place; a pasted link has neither, so it waits here, "Opening…".
   */
  async function open(url: string, preview?: PrPreview) {
    // Committed before the screen changes, so the transition captures this
    // row's number and title and carries them into the PR's tab.
    flushSync(() => useOpening.setState({ url }));
    const ok = await openPr(url, { preview });
    // On success the list has gone out of sight, but stays mounted; once the
    // change settles, nothing is opening any more.
    if (ok) await (screenSettling() ?? Promise.resolve());
    if (useOpening.getState().url === url) useOpening.setState({ url: null });
  }

  const openPrs = listing.data?.prs ?? NO_PRS;
  const allPrs = all.data?.prs ?? openPrs;
  const listed = listing.data != null;
  const stacks = useMemo(
    () => stacksOf(openPrs, allPrs, defaultBranch),
    [openPrs, allPrs, defaultBranch],
  );
  const candidates = useMemo(
    () => buildRows(tab, "", openPrs, reviewed, stacks),
    [tab, openPrs, reviewed, stacks],
  );
  const searched = useMemo(
    () =>
      candidates.filter((row) =>
        matches(
          textQuery(query),
          row.number,
          row.title,
          row.author,
          row.pr?.headRef,
          row.pr?.baseRef,
          ...(row.pr?.labels.map((label) => label.name) ?? []),
        ),
      ),
    [candidates, query],
  );
  const rows = useMemo(() => {
    const kept = filterRows(searched, filters, listed);
    return tab === "reviewed" ? kept : groupRows(kept, stacks);
  }, [tab, searched, filters, listed, stacks]);
  const searchDocuments = useMemo<SearchDocument[]>(() => {
    const known = new Map(
      [
        ...buildRows("all", "", allPrs, reviewed, stacks),
        ...buildRows("reviewed", "", allPrs, reviewed, stacks),
      ].map((row) => [row.number, row]),
    );
    return [...known.values()].map((row) => ({
      id: `pr:${row.number}`,
      scope: "pullRequests",
      title: row.title,
      text: `#${row.number} ${row.title} ${row.author ?? ""} ${row.pr?.headRef ?? ""} ${row.pr?.labels.map((label) => label.name).join(" ") ?? ""}`,
      detail: `#${row.number}`,
      activate: () => {
        if (row.url)
          void openPr(row.url, {
            preview: { number: row.number, title: row.title, author: row.author },
          });
      },
    }));
  }, [allPrs, reviewed, stacks, openPr]);
  useSearchDocuments(searchDocuments);
  const filtering = isFiltering(filters);
  // A tab's list scrolls in an area of its own, made afresh for each tab.
  const [listScroll, setListScroll] = useState<HTMLDivElement | null>(null);
  useHeldPlace(listScroll, rows);

  function openRow(row: PrRow) {
    if (!row.url) return;
    void open(row.url, {
      number: row.number,
      title: row.title,
      author: row.author,
      headRef: row.pr?.headRef,
      baseRef: row.pr?.baseRef,
    });
  }

  const reference = PR_REFERENCE.test(query.trim()) ? query.trim() : null;
  const hasMore = tab !== "reviewed" && listing.hasNextPage;

  function submitSearch() {
    if (reference) void open(reference);
    else if (rows.length === 1 && rows[0]) openRow(rows[0]);
  }

  return (
    <div className={css.browser}>
      <header className={css.browserHeader}>
        <div className={css.titleBlock}>
          <h1 className={css.title}>
            {/* Becomes the review's back button, and comes back out of it. */}
            <ScreenMorph id="home" part="heading" active={heading}>
              <span className={css.titleText}>Pull requests</span>
            </ScreenMorph>
          </h1>
        </div>
        <div className={css.headerActions}>
          <Button variant="ghost" onClick={() => void compareBranches()}>
            <Icon name="branch" /> Compare branches
          </Button>
          <Button onClick={() => void invalidatePrLists(root)} disabled={refreshing}>
            {refreshing ? (
              <>
                <Spinner /> {listing.data ? "Refreshing…" : "Loading…"}
              </>
            ) : (
              <>
                <Icon name="refresh" /> Refresh
              </>
            )}
          </Button>
        </div>
      </header>

      <Tabs.Root
        value={tab}
        onValueChange={(value) => selectTab(value as HomeTab)}
        className={css.tabs}
      >
        <div className={css.toolbar}>
          <Tabs.List className={css.tabList}>
            {TABS.map(({ value, label }) => {
              const count =
                value === "reviewed" ? reviewed.list.length : (listings[value].data?.total ?? null);
              return (
                <Tabs.Tab key={value} value={value} className={css.tab}>
                  {label}
                  {count != null ? <span className={css.count}>{count}</span> : null}
                </Tabs.Tab>
              );
            })}
          </Tabs.List>
          <div className={css.toolbarEnd}>
            <PrOmnibar
              rows={candidates}
              listed={listed}
              filters={filters}
              onChange={setFilters}
              query={query}
              onQueryChange={setQuery}
              onSubmit={submitSearch}
              onOpenPr={openRow}
            />
            <ColumnMenu visibility={columns} onChange={setColumns} />
          </div>
        </div>

        {/* The scroll area is what rises in and sinks away, not the list inside
            it: a view transition snapshots a named element whole, unclipped, so
            a list scrolled down would paint its hidden rows over the header. A
            tab of its own also starts at the top. */}
        <Reveal key={tab} scope="home-list">
          <div ref={setListScroll} className={css.listScroll}>
            {reference ? (
              <button type="button" className={css.pasted} onClick={() => void open(reference)}>
                <Icon name="external" />
                <span>
                  Open <code>{reference}</code>
                </span>
                <span className={css.pastedHint}>Enter</span>
              </button>
            ) : null}

            {refreshFailed ? (
              <p className={css.refreshFailed} role="status">
                Could not refresh: {errorMessage(listing.error)} Showing what was listed{" "}
                {relativeTime(new Date(listing.dataUpdatedAt).toISOString())}.
              </p>
            ) : null}

            {listing.isError && !listing.isFetching && !listing.data && tab !== "reviewed" ? (
              <ErrorNotice
                error={toAppError(listing.error, "Could not list pull requests")}
                className={css.listError}
              >
                Pasting a PR link above still works.
              </ErrorNotice>
            ) : tab !== "reviewed" && !listing.data ? (
              // Only with nothing cached: no earlier visit or launch has listed this tab.
              <ListMessage>
                <Spinner /> Loading pull requests…
              </ListMessage>
            ) : (
              <>
                {rows.length > 0 ? (
                  <PrTable
                    rows={rows}
                    root={root}
                    listed={listed}
                    visibility={columns}
                    onOpen={openRow}
                  />
                ) : filtering ? (
                  <ListMessage>
                    Nothing {hasMore ? "loaded yet " : ""}matches these filters.{" "}
                    <Button variant="ghost" size="sm" onClick={() => setFilters(NO_FILTERS)}>
                      Clear filters
                    </Button>
                  </ListMessage>
                ) : (
                  <ListMessage>
                    {query
                      ? "Nothing matches that filter."
                      : tab === "reviewed"
                        ? "Nothing reviewed in this repository yet. Reviews you run show up here."
                        : tab === "reviewRequested"
                          ? "No open pull requests are waiting on your review."
                          : tab === "mine"
                            ? "You have no open pull requests here."
                            : "No open pull requests."}
                  </ListMessage>
                )}
                {/* Under an empty list too, so a filter matching nothing loaded
                    so far keeps looking through the pages still on GitHub. */}
                {hasMore ? <MorePrs listing={listing} /> : null}
              </>
            )}
          </div>
        </Reveal>
      </Tabs.Root>
    </div>
  );
}

function Welcome() {
  const loading = useAppStore((state) => state.loadingRepo);
  const openRepo = useAppStore((state) => state.openRepo);

  async function pick() {
    const path = await chooseFolder();
    if (path) await openRepo(path);
  }

  return (
    <div className={css.welcome}>
      <Panel className={css.hero}>
        <SceneryWindow />
        <Eyebrow>TK Review</Eyebrow>
        <p className={css.heroTitle}>Read the change before you judge it.</p>
        <p className={css.heroText}>
          Open a local checkout to see its pull requests, review one with Claude Code or Codex, and
          send what matters back to GitHub.
        </p>
        <div>
          <Button variant="primary" size="lg" onClick={() => void pick()} disabled={loading}>
            {loading ? (
              <>
                <Spinner /> Opening…
              </>
            ) : (
              <>
                <Icon name="folder" /> Open repository…
              </>
            )}
          </Button>
        </div>
      </Panel>
    </div>
  );
}

/** The first screen: the open repository's pull requests, or a way to open one. */
export function Home() {
  const repo = useAppStore((state) => state.repo);
  const error = useAppStore((state) => state.error);
  const dismissError = useAppStore((state) => state.dismissError);

  return (
    <main className={css.home}>
      {error ? <ErrorNotice error={error} onDismiss={dismissError} className={css.error} /> : null}
      {repo ? (
        <PrBrowser key={storageRoot(repo)} root={repo.root} login={repo.githubLogin} />
      ) : (
        <Welcome />
      )}
    </main>
  );
}
