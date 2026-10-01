import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { flushSync } from "react-dom";
import {
  Button,
  Eyebrow,
  Icon,
  Input,
  morph,
  Panel,
  Reveal,
  SceneryWindow,
  Tabs,
} from "tk-design-system";
import { errorMessage, type PrListFilter, type PrSummary, toAppError } from "../../ipc/git";
import { chooseFolder } from "../../lib/chooseFolder";
import { invalidatePrLists, prListQuery } from "../../lib/queries";
import { prMorphKey, ScreenMorph } from "../../lib/screenTransition";
import { buildStacks, groupStacks } from "../../lib/stacks";
import { relativeTime } from "../../lib/time";
import { warmHighlighter } from "../../lib/warmHighlighter";
import { useAppStore } from "../../store/appStore";
import { type ReviewedPr, readReviewedPrs } from "../../store/history";
import type { PrPreview } from "../../store/tabStore";
import { ErrorNotice } from "../ErrorNotice/ErrorNotice";
import { ColumnMenu, type PrRow, PrTable, useColumnVisibility } from "../PrTable/PrTable";
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
function usePrListings(root: string, shown: PrListFilter) {
  // Stacks come from the full list too: a filtered tab can leave out the PR
  // another one is stacked on.
  const listing = (filter: PrListFilter) => ({
    ...prListQuery(root, filter),
    enabled: filter === shown || filter === "all",
  });
  return {
    reviewRequested: useQuery(listing("reviewRequested")),
    mine: useQuery(listing("mine")),
    all: useQuery(listing("all")),
  } satisfies Record<PrListFilter, unknown>;
}

interface Reviewed {
  /** Most recent review first. */
  list: ReviewedPr[];
  byNumber: Map<number, ReviewedPr>;
}

/** The latest review of each PR, keyed by number, for the badges on every tab. */
function useReviewed(root: string): Reviewed {
  // Read once per visit: reviews are only written from the review screen.
  return useMemo(() => {
    const reviewed = readReviewedPrs(root);
    return { list: reviewed, byNumber: new Map(reviewed.map((entry) => [entry.number, entry])) };
  }, [root]);
}

function matches(query: string, ...fields: (string | number | null | undefined)[]): boolean {
  const needle = query.trim().toLowerCase().replace(/^#/, "");
  if (!needle) return true;
  return fields.some((field) => field != null && String(field).toLowerCase().includes(needle));
}

const NO_PRS: PrSummary[] = [];

/**
 * One tab's rows. The open tabs list GitHub's pull requests with their stacks
 * grouped; "Reviewed" lists the review history, filled in from GitHub's list
 * wherever the PR is still open.
 */
function buildRows(
  tab: HomeTab,
  query: string,
  openPrs: PrSummary[],
  allPrs: PrSummary[],
  reviewed: Reviewed,
  defaultBranch: string | null,
): PrRow[] {
  // The tab's own PRs as well as everyone's: "All open" is only the most
  // recently updated few dozen, so an older stack listed under "Mine" would
  // otherwise have no links at all. Newest first, as `buildStacks` expects.
  const known = new Map([...allPrs, ...openPrs].map((pr) => [pr.number, pr]));
  const stacks = buildStacks(
    [...known.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    defaultBranch,
  );
  const labelNames = (pr: PrSummary | null | undefined) =>
    pr?.labels.map((label) => label.name) ?? [];

  if (tab !== "reviewed") {
    const visible = openPrs.filter((pr) =>
      matches(query, pr.number, pr.title, pr.author, pr.headRef, ...labelNames(pr)),
    );
    return groupStacks(visible, stacks).map(({ pr, depth }) => ({
      number: pr.number,
      title: pr.title,
      author: pr.author,
      url: pr.url,
      pr,
      reviewed: reviewed.byNumber.get(pr.number),
      stack: stacks.get(pr.number),
      depth,
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

function ListMessage({ children }: { children: React.ReactNode }) {
  return <p className={css.message}>{children}</p>;
}

function PrBrowser({ root, name }: { root: string; name: string }) {
  const openPr = useAppStore((state) => state.openPr);
  const compareBranches = useAppStore((state) => state.compareBranches);
  const tabs = useAppStore((state) => state.tabs);
  const returning = useAppStore((state) => state.returning);
  const [tab, setTab] = useState<HomeTab>(readTab);
  const [query, setQuery] = useState("");
  const [opening, setOpening] = useState<string | null>(null);
  const [columns, setColumns] = useColumnVisibility();
  const defaultBranch = useAppStore((state) => state.repo?.defaultBranch ?? null);
  const reviewed = useReviewed(root);
  // A PR already open in a tab is carried into the review by its tab, from the
  // tab bar, rather than by its row: one name, one holder. One whose tab closed
  // on the way here gets its number and title back from that tab.
  const inTabs = useMemo(
    () => new Set(tabs.filter((open) => open.root === root).map((open) => open.number)),
    [tabs, root],
  );
  const carries = (number: number, url: string | null) =>
    prMorphKey(root, number) === returning ||
    (url != null && opening === url && !inTabs.has(number));

  // The reviewed tab reads its open/closed state and freshness from the full list.
  const needed: PrListFilter = tab === "reviewed" ? "all" : tab;
  const listings = usePrListings(root, needed);
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
    flushSync(() => setOpening(url));
    const ok = await openPr(url, { preview });
    // On success the app has moved to the review screen and this unmounts.
    if (!ok) setOpening(null);
  }

  const openPrs = listing.data ?? NO_PRS;
  const allPrs = all.data ?? openPrs;
  const rows = useMemo(
    () => buildRows(tab, query, openPrs, allPrs, reviewed, defaultBranch),
    [tab, query, openPrs, allPrs, reviewed, defaultBranch],
  );

  function openRow(row: PrRow) {
    if (!row.url) return;
    void open(row.url, {
      number: row.number,
      title: row.title,
      headRef: row.pr?.headRef,
      baseRef: row.pr?.baseRef,
    });
  }

  const reference = PR_REFERENCE.test(query.trim()) ? query.trim() : null;

  function onSearchKey(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Enter") return;
    if (reference) void open(reference);
    else if (rows.length === 1 && rows[0]) openRow(rows[0]);
  }

  return (
    <div className={css.browser}>
      <header className={css.browserHeader}>
        <div className={css.titleBlock}>
          <Eyebrow>{name}</Eyebrow>
          <h1 className={css.title}>
            {/* Becomes the review's back button, and comes back out of it. */}
            <ScreenMorph id="home" part="heading">
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
                value === "reviewed"
                  ? reviewed.list.length
                  : (listings[value].data?.length ?? null);
              return (
                <Tabs.Tab key={value} value={value} className={css.tab}>
                  {label}
                  {count != null ? <span className={css.count}>{count}</span> : null}
                </Tabs.Tab>
              );
            })}
          </Tabs.List>
          <div className={css.toolbarEnd}>
            <div className={css.search}>
              <Icon name="search" className={css.searchIcon} />
              <Input
                size="sm"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={onSearchKey}
                placeholder="Filter, or paste a PR link"
                aria-label="Filter pull requests, or paste a pull request link"
                className={css.searchInput}
              />
            </div>
            <ColumnMenu visibility={columns} onChange={setColumns} />
          </div>
        </div>

        {/* The scroll area is what rises in and sinks away, not the list inside
            it: a view transition snapshots a named element whole, unclipped, so
            a list scrolled down would paint its hidden rows over the header. A
            tab of its own also starts at the top. */}
        <Reveal key={tab} scope="home-list">
          <div className={css.listScroll}>
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
            ) : rows.length === 0 ? (
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
            ) : (
              <PrTable
                rows={rows}
                root={root}
                opening={opening}
                listed={listing.data != null}
                carries={carries}
                visibility={columns}
                onOpen={openRow}
              />
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
        <Eyebrow>tk-review</Eyebrow>
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
      {repo ? <PrBrowser key={repo.root} root={repo.root} name={repo.name} /> : <Welcome />}
    </main>
  );
}
