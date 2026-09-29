import { createAsyncStoragePersister } from "@tanstack/query-async-storage-persister";
import { focusManager, QueryClient, queryOptions } from "@tanstack/react-query";
import type { PersistQueryClientProviderProps } from "@tanstack/react-query-persist-client";
import { gitApi, type PrListFilter } from "../ipc/git";

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
const CACHE_VERSION = "1";

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

/** One `gh pr list`, cached per repository and filter. */
export function prListQuery(root: string, filter: PrListFilter) {
  return queryOptions({
    queryKey: [...prListsKey(root), filter] as const,
    queryFn: () => gitApi.listPrs(root, filter),
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
