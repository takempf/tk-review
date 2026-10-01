import { createAsyncStoragePersister } from "@tanstack/query-async-storage-persister";
import {
  focusManager,
  type InfiniteData,
  infiniteQueryOptions,
  QueryClient,
} from "@tanstack/react-query";
import type { PersistQueryClientProviderProps } from "@tanstack/react-query-persist-client";
import { gitApi, type PrListFilter, type PrPage, type PrSummary } from "../ipc/git";

/**
 * What the app reads from GitHub, cached. A screen shows what it last saw the
 * moment it mounts, and fetches the current version behind it, rather than
 * starting empty on every visit and waiting out the `gh` round trip. The cache
 * is persisted to localStorage, so that holds across launches too.
 */

/**
 * How long a fetch counts as current. Long enough that hopping into a review
 * and straight back doesn't re-list; short enough that coming back later, or
 * to the window, always does.
 */
const FRESH_MS = 30_000;

/**
 * How long data is kept without being looked at, in memory and on disk. A
 * week rather than a day, so Friday's list is still there on Monday morning to
 * show while Monday's loads.
 */
const KEEP_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Bump whenever a cached shape (`PrSummary`) changes, so a cache written by an
 * older build is dropped rather than read as the new one.
 */
const CACHE_VERSION = "4";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: FRESH_MS,
      gcTime: KEEP_MS,
      // `gh` failures mostly last — not installed, signed out, no GitHub
      // remote — so retrying only delays the message. The next mount or focus
      // tries again anyway.
      retry: false,
      // These are IPC calls into `gh`, not browser fetches: it reports being
      // offline itself, and a webview's guess at connectivity shouldn't park them.
      networkMode: "always",
    },
  },
});

/**
 * "Refetch on window focus" should mean the window coming forward. TanStack
 * Query only watches `visibilitychange`, and a desktop window that is merely
 * behind another app's stays visible, so switching back to it would not count.
 */
focusManager.setEventListener((handleFocus) => {
  const onFocus = () => handleFocus();
  window.addEventListener("focus", onFocus);
  window.addEventListener("visibilitychange", onFocus);
  return () => {
    window.removeEventListener("focus", onFocus);
    window.removeEventListener("visibilitychange", onFocus);
  };
});

export const persistOptions: PersistQueryClientProviderProps["persistOptions"] = {
  persister: createAsyncStoragePersister({
    storage: window.localStorage,
    key: "tk-review:query-cache",
  }),
  maxAge: KEEP_MS,
  buster: CACHE_VERSION,
  dehydrateOptions: {
    // Anything with data, including a list whose last refresh failed: only
    // successes are kept by default, so one offline Refresh would otherwise
    // take the list off disk and leave the next launch with nothing to show.
    shouldDehydrateQuery: (query) => query.state.data !== undefined,
  },
};

/** Every cached pull-request list for one repository. */
const prListsKey = (root: string) => ["prs", root] as const;

/** A list as the screens read it: every page loaded so far, as one. */
export interface PrListing {
  prs: PrSummary[];
  /** How many the whole list holds, loaded or not. */
  total: number;
}

/**
 * Pages run in GitHub's order, so a PR updated between two page loads can turn
 * up on both. The first sighting is the newer one.
 */
function flatten(data: InfiniteData<PrPage>): PrListing {
  const seen = new Set<number>();
  const prs = data.pages.flatMap((page) =>
    page.prs.filter((pr) => !seen.has(pr.number) && seen.add(pr.number)),
  );
  return { prs, total: Math.max(data.pages[0]?.total ?? 0, prs.length) };
}

/**
 * One list of open PRs, a page at a time, cached per repository, account and
 * filter: "Mine" and "Review requested" are whoever `gh` is signed in as. The
 * list asks for the next page as it is scrolled to the end; a refetch reloads
 * every page it has.
 */
export function prListQuery(root: string, login: string | null, filter: PrListFilter) {
  return infiniteQueryOptions({
    queryKey: [...prListsKey(root), login, filter] as const,
    queryFn: ({ pageParam }) => gitApi.listPrs(root, filter, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next,
    select: flatten,
  });
}

/**
 * Marks a repository's lists out of date — after something changed them on
 * GitHub, or when asked to — so each refetches now if it is on screen, and
 * the next time it is shown otherwise, however recently it was fetched.
 */
export function invalidatePrLists(root: string): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: prListsKey(root) });
}
