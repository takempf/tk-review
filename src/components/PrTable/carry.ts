import { create } from "zustand";
import { prMorphKey } from "../../lib/screenTransition";
import { useAppStore } from "../../store/appStore";

/**
 * The pull request being opened from the list, while one is. Its row carries
 * its number and title into the review, which shows its own loading state. A
 * store of its own, so setting it re-renders that row and nothing else on the
 * list.
 */
export const useOpening = create<{ url: string | null }>(() => ({ url: null }));

/**
 * Whether a row carries its number and title into the review, or takes them
 * back from a tab closing on the way to the list, as `ScreenMorph`'s `active`.
 * A PR already open in a tab is carried by its tab rather than its row: one
 * name, one holder. Each row subscribes to its own answer.
 */
export function useCarries(root: string, number: number, url: string | null): boolean {
  const returning = useAppStore((state) => state.returning === prMorphKey(root, number));
  const inTab = useAppStore((state) =>
    state.tabs.some((tab) => tab.root === root && tab.number === number),
  );
  const opening = useOpening((state) => url != null && state.url === url);
  return returning || (opening && !inTab);
}
