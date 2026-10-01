import { useEffect } from "react";
import { type AppView, useAppStore } from "../store/appStore";

interface ScreenEntry {
  view: AppView;
}

function entryView(state: unknown): AppView | null {
  const view = (state as Partial<ScreenEntry> | null)?.view;
  return view === "home" || view === "review" ? view : null;
}

/**
 * Keeps the webview's history in step with the screen, so the trackpad's
 * back/forward swipe (enabled natively in `src-tauri/src/lib.rs`) moves between
 * the pull-request list and the review.
 *
 * History holds at most two entries: the list, and the review in front of it.
 * Entering the review pushes; leaving it from inside the app goes back, so a
 * forward swipe can return to it. Tabs are not entries: switching between them
 * stays on the review, and forward returns to whichever was shown last.
 */
export function useScreenHistory() {
  useEffect(() => {
    history.replaceState({ view: useAppStore.getState().view } satisfies ScreenEntry, "");

    const unsubscribe = useAppStore.subscribe((state, previous) => {
      if (state.view === previous.view) return;
      // Already there: the change came from history itself.
      if (entryView(history.state) === state.view) return;
      if (state.view === "review") {
        history.pushState({ view: "review" } satisfies ScreenEntry, "");
      } else {
        history.back();
      }
    });

    function onPopState(event: PopStateEvent) {
      const view = entryView(event.state) ?? "home";
      const { view: current, goHome, showReview } = useAppStore.getState();
      // Our own `history.back()` catching up with a screen already left.
      if (view === current) return;
      // A swipe slides WebKit's own snapshot of the screen; animating on top of
      // it would play the change twice. Only a browser that says it drew nothing
      // (Chrome's back button, in the dev harness) gets the screen transition.
      const { hasUAVisualTransition } = event as PopStateEvent & {
        hasUAVisualTransition?: boolean;
      };
      const animate = hasUAVisualTransition === false;

      if (view === "home") {
        goHome({ animate });
        return;
      }
      void showReview({ animate }).then((shown) => {
        // The tab this review belonged to has since been closed.
        if (!shown) history.replaceState({ view: "home" } satisfies ScreenEntry, "");
      });
    }

    window.addEventListener("popstate", onPopState);
    return () => {
      unsubscribe();
      window.removeEventListener("popstate", onPopState);
    };
  }, []);
}
