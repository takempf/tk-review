import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { flushSync } from "react-dom";
import {
  Badge,
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
import { errorMessage, type PrListFilter, type PrSummary } from "../../ipc/git";
import { chooseFolder } from "../../lib/chooseFolder";
import { invalidatePrLists, prListQuery } from "../../lib/queries";
import { ScreenMorph } from "../../lib/screenTransition";
import { buildStacks, groupStacks, type StackLinks } from "../../lib/stacks";
import { absoluteTime, relativeTime } from "../../lib/time";
import { warmHighlighter } from "../../lib/warmHighlighter";
import { type ReviewedPr, readReviewedPrs } from "../../store/history";
import { type PrPreview, useReviewStore } from "../../store/reviewStore";
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

/** The latest review of each PR, keyed by number, for the badges on every tab. */
function useReviewed(root: string) {
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

function ReviewState({ reviewed, headSha }: { reviewed: ReviewedPr; headSha: string | null }) {
  const stale = headSha != null && reviewed.headSha != null && reviewed.headSha !== headSha;
  const findings =
    reviewed.findings === 0
      ? "clean"
      : `${reviewed.findings} finding${reviewed.findings === 1 ? "" : "s"}`;
  return (
    <span
      className={css.reviewState}
      title={`Reviewed ${absoluteTime(reviewed.createdAt)} via ${reviewed.engine}`}
    >
      {stale ? (
        <Badge tone="warning">New commits</Badge>
      ) : (
        <Badge tone="accent">
          <Icon name="check" /> Reviewed
        </Badge>
      )}
      <span className={css.reviewMeta}>
        {relativeTime(reviewed.createdAt)} · {findings}
      </span>
    </span>
  );
}

function Decision({ decision }: { decision: string | null }) {
  if (decision === "APPROVED") return <Badge tone="accent">Approved</Badge>;
  if (decision === "CHANGES_REQUESTED") return <Badge tone="danger">Changes requested</Badge>;
  return null;
}

function PrRow({
  pr,
  reviewed,
  stack,
  depth = 0,
  opening,
  onOpen,
}: {
  pr: PrSummary;
  reviewed: ReviewedPr | undefined;
  stack: StackLinks | undefined;
  /** Indent under the stacked PRs listed above it. */
  depth?: number;
  opening: boolean;
  onOpen: () => void;
}) {
  const parent = stack?.parent;
  const children = stack?.children ?? [];
  return (
    <li
      className={depth > 0 ? css.stacked : undefined}
      style={depth > 0 ? ({ "--stack-depth": depth } as React.CSSProperties) : undefined}
    >
      <button
        type="button"
        className={css.row}
        onClick={onOpen}
        disabled={opening}
        aria-busy={opening || undefined}
      >
        {/* The row being opened carries its number and title into the review. */}
        <ScreenMorph part="prNumber" active={opening}>
          <span className={css.number}>#{pr.number}</span>
        </ScreenMorph>
        <span className={css.rowMain}>
          <span className={css.rowTitle}>
            <ScreenMorph part="prTitle" active={opening}>
              <span>{pr.title}</span>
            </ScreenMorph>
            {pr.isDraft ? <Badge>Draft</Badge> : null}
            {parent ? (
              <Badge title={`Targets #${parent.number}: ${parent.title}`}>
                Stacked on #{parent.number}
              </Badge>
            ) : null}
            <Decision decision={pr.reviewDecision} />
          </span>
          <span className={css.rowMeta}>
            <span>@{pr.author}</span>
            <span className={css.branch} title={`${pr.headRef} into ${pr.baseRef}`}>
              {pr.headRef} <Icon name="arrow-right" /> {pr.baseRef}
            </span>
            {children.length > 0 ? (
              <span title={children.map((child) => `#${child.number}: ${child.title}`).join("\n")}>
                {children.map((child) => `#${child.number}`).join(", ")} stacked on this
              </span>
            ) : null}
            <span title={absoluteTime(pr.updatedAt)}>updated {relativeTime(pr.updatedAt)}</span>
          </span>
        </span>
        <span className={css.rowSide}>
          {opening ? (
            <span className={css.reviewMeta}>
              <Spinner /> Opening…
            </span>
          ) : reviewed ? (
            <ReviewState reviewed={reviewed} headSha={pr.headSha} />
          ) : null}
          <span className={css.stats}>
            <span className={css.added}>+{pr.additions}</span>
            <span className={css.deleted}>−{pr.deletions}</span>
          </span>
        </span>
      </button>
    </li>
  );
}

/** A reviewed PR that GitHub no longer lists as open, or that has not loaded. */
function HistoryRow({
  reviewed,
  url,
  listed,
  opening,
  onOpen,
}: {
  reviewed: ReviewedPr;
  url: string | null;
  /** Whether GitHub's open list has loaded, so absence from it means something. */
  listed: boolean;
  opening: boolean;
  onOpen: (url: string) => void;
}) {
  return (
    <li>
      <button
        type="button"
        className={css.row}
        onClick={() => url && onOpen(url)}
        disabled={!url || opening}
        title={url ? undefined : "Load the open pull requests to reopen this one"}
      >
        <ScreenMorph part="prNumber" active={opening}>
          <span className={css.number}>#{reviewed.number}</span>
        </ScreenMorph>
        <span className={css.rowMain}>
          <span className={css.rowTitle}>
            <ScreenMorph part="prTitle" active={opening}>
              <span>{reviewed.title ?? `Pull request #${reviewed.number}`}</span>
            </ScreenMorph>
          </span>
          <span className={css.rowMeta}>
            {reviewed.author ? <span>@{reviewed.author}</span> : null}
            {listed ? <span>no longer open</span> : null}
          </span>
        </span>
        <span className={css.rowSide}>
          {opening ? (
            <span className={css.reviewMeta}>
              <Spinner /> Opening…
            </span>
          ) : (
            <ReviewState reviewed={reviewed} headSha={null} />
          )}
        </span>
      </button>
    </li>
  );
}

function ListMessage({ children }: { children: React.ReactNode }) {
  return <p className={css.message}>{children}</p>;
}

function PrBrowser({ root, name }: { root: string; name: string }) {
  const openPr = useReviewStore((state) => state.openPr);
  const showReview = useReviewStore((state) => state.showReview);
  const current = useReviewStore((state) => state.pr);
  const hasComparison = useReviewStore((state) => state.summary != null);
  const base = useReviewStore((state) => state.base);
  const compare = useReviewStore((state) => state.compare);
  const [tab, setTab] = useState<HomeTab>(readTab);
  const [query, setQuery] = useState("");
  const [opening, setOpening] = useState<string | null>(null);
  const defaultBranch = useReviewStore((state) => state.repo?.defaultBranch ?? null);
  const reviewed = useReviewed(root);

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
    // row's number and title and carries them into the review's header.
    flushSync(() => setOpening(url));
    const ok = await openPr(url, preview);
    // On success the app has moved to the review screen and this unmounts.
    if (!ok) setOpening(null);
  }

  const openPrs = listing.data ?? [];
  const openByNumber = new Map(openPrs.map((pr) => [pr.number, pr]));
  const stacks = buildStacks(all.data ?? openPrs, defaultBranch);
  // Any open PR's URL gives the repository's; older history entries lack their own.
  const urlFor = (number: number) =>
    openPrs[0]?.url.replace(/\/pull\/\d+$/, `/pull/${number}`) ?? null;

  const visible =
    tab === "reviewed"
      ? reviewed.list.filter((entry) =>
          matches(
            query,
            entry.number,
            entry.title,
            entry.author,
            openByNumber.get(entry.number)?.headRef,
          ),
        )
      : openPrs.filter((pr) => matches(query, pr.number, pr.title, pr.author, pr.headRef));

  const reference = PR_REFERENCE.test(query.trim()) ? query.trim() : null;

  function onSearchKey(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Enter") return;
    if (reference) void open(reference);
    else if (visible.length === 1) {
      const only = visible[0];
      const url = only && ("url" in only ? only.url : null);
      if (only && url) {
        void open(url, {
          number: only.number,
          title: only.title ?? `Pull request #${only.number}`,
        });
      }
    }
  }

  return (
    <div className={css.browser}>
      <header className={css.browserHeader}>
        <div className={css.titleBlock}>
          <Eyebrow>{name}</Eyebrow>
          <h1 className={css.title}>Pull requests</h1>
        </div>
        <div className={css.headerActions}>
          <Button variant="ghost" onClick={() => void showReview()}>
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

      {hasComparison ? (
        <button type="button" className={css.resume} onClick={() => void showReview()}>
          <Eyebrow as="span">Continue</Eyebrow>
          {current ? (
            // Where the review's number and title land on the way back — unless
            // a row is being opened, which then holds them instead.
            <span className={css.resumeHeading}>
              <ScreenMorph part="prNumber" active={opening == null}>
                <span className={css.resumeNumber}>#{current.number}</span>
              </ScreenMorph>
              <ScreenMorph part="prTitle" active={opening == null}>
                <span className={css.resumeTitle}>{current.title}</span>
              </ScreenMorph>
            </span>
          ) : (
            <span className={css.resumeHeading}>
              <span className={css.resumeTitle}>
                {base} … {compare}
              </span>
            </span>
          )}
          <Icon name="arrow-right" />
        </button>
      ) : null}

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
        </div>

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
            <ListMessage>
              Could not list pull requests: {errorMessage(listing.error)} Pasting a PR link above
              still works.
            </ListMessage>
          ) : tab !== "reviewed" && !listing.data ? (
            // Only with nothing cached: no earlier visit or launch has listed this tab.
            <ListMessage>
              <Spinner /> Loading pull requests…
            </ListMessage>
          ) : visible.length === 0 ? (
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
            <Reveal key={tab} scope="home-list">
              <ul className={css.list}>
                {tab === "reviewed"
                  ? (visible as ReviewedPr[]).map((entry) => {
                      const live = openByNumber.get(entry.number);
                      return live ? (
                        <PrRow
                          key={entry.number}
                          pr={live}
                          reviewed={entry}
                          stack={stacks.get(live.number)}
                          opening={opening === live.url}
                          onOpen={() => void open(live.url, live)}
                        />
                      ) : (
                        <HistoryRow
                          key={entry.number}
                          reviewed={entry}
                          url={entry.url ?? urlFor(entry.number)}
                          listed={listing.data != null}
                          opening={
                            opening != null && opening === (entry.url ?? urlFor(entry.number))
                          }
                          onOpen={(url) =>
                            void open(url, {
                              number: entry.number,
                              title: entry.title ?? `Pull request #${entry.number}`,
                            })
                          }
                        />
                      );
                    })
                  : groupStacks(visible as PrSummary[], stacks).map(({ pr, depth }) => (
                      <PrRow
                        key={pr.number}
                        pr={pr}
                        reviewed={reviewed.byNumber.get(pr.number)}
                        stack={stacks.get(pr.number)}
                        depth={depth}
                        opening={opening === pr.url}
                        onOpen={() => void open(pr.url, pr)}
                      />
                    ))}
              </ul>
            </Reveal>
          )}
        </div>
      </Tabs.Root>
    </div>
  );
}

function Welcome() {
  const loading = useReviewStore((state) => state.loadingRepo);
  const openRepo = useReviewStore((state) => state.openRepo);

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
  const repo = useReviewStore((state) => state.repo);
  const error = useReviewStore((state) => state.error);
  const dismissError = useReviewStore((state) => state.dismissError);

  return (
    <main className={css.home}>
      {error ? (
        <div className={css.error} role="alert">
          <p>{error}</p>
          <Button variant="ghost" size="sm" onClick={dismissError}>
            <Icon name="close" /> Dismiss
          </Button>
        </div>
      ) : null}
      {repo ? <PrBrowser key={repo.root} root={repo.root} name={repo.name} /> : <Welcome />}
    </main>
  );
}
