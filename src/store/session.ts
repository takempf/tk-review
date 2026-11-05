import type { ReviewTab } from "./appStore";
import { readJson } from "./history";
import type { PrPreview } from "./tabStore";

/** One open tab, as much of it as reopening needs. */
export type SavedTab =
  | { root: string; pr: PrPreview & { url: string } }
  | {
      root: string;
      pr: null;
      base: string | null;
      compare: string | null;
      includeUncommitted: boolean;
    };

/** The window's tabs, kept so that a reload or a relaunch reopens them. */
export interface SavedSession {
  tabs: SavedTab[];
  /** Index into `tabs` of the active tab, on screen or waiting behind the list. */
  active: number | null;
  /** Whether that tab was on screen, rather than the list. */
  reviewing: boolean;
}

const SESSION_KEY = "tk-review:session";

export function savedTab(tab: ReviewTab): SavedTab | null {
  const state = tab.store.getState();
  const pr = state.pr ?? state.pendingPr;
  if (pr) {
    const { url, number, title, author, headRef, baseRef } = pr;
    return { root: tab.root, pr: { url, number, title, author, headRef, baseRef } };
  }
  // A PR tab whose diff failed to load has let go of its PR, so there is nothing to reopen.
  if (tab.number != null) return null;
  const { base, compare, includeUncommitted } = state;
  return { root: tab.root, pr: null, base, compare, includeUncommitted };
}

export function readSession(): SavedSession {
  const saved = readJson<Partial<SavedSession> | null>(SESSION_KEY, null);
  return {
    tabs: Array.isArray(saved?.tabs)
      ? saved.tabs.filter((tab) => typeof tab?.root === "string")
      : [],
    active: typeof saved?.active === "number" ? saved.active : null,
    reviewing: saved?.reviewing === true,
  };
}

// Tab stores change far more often than what is saved of them.
let lastWritten: string | null = null;

export function writeSession(session: SavedSession): void {
  const json = JSON.stringify(session);
  if (json === lastWritten) return;
  lastWritten = json;
  try {
    localStorage.setItem(SESSION_KEY, json);
  } catch {
    // Reopening tabs is a convenience; a full localStorage must never break a review.
  }
}
