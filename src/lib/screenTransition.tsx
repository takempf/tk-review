import {
  type CSSProperties,
  cloneElement,
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useState,
} from "react";
import { Morph, type MorphProps, morph } from "tk-design-system";
import css from "./screenTransition.module.css";

/**
 * Switching between the pull-request list and the review, and between tabs: a
 * PR's number and title — shown in its row and its tab — glide from one to the
 * other as shared elements of a view transition, and the tabs slide as others
 * come and go, while the screens themselves crossfade as live layers
 * underneath.
 *
 * The screens are never snapshotted. WebKit's snapshot of the review screen
 * costs more per frame the bigger the diff — hundreds of ms on a large PR —
 * whereas a live layer fading is composited. Only `<Morph>`s in this scope take
 * part, so the list's own morphs stay out of it. Their timing is in global.css,
 * under the transition's `screen` type.
 */
const SCREEN_SCOPE = "screen";

/**
 * The parts that move between screens: a tab's, and the list's "Pull requests"
 * heading, which becomes the review's way back to it (`id` "home").
 */
type ScreenPart = "number" | "title" | "tab" | "heading";

/**
 * FNV-1a: a short, stable name for a repository path, which can't go into a
 * view-transition name as it is.
 */
function hash(text: string): string {
  let value = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 0x01000193);
  }
  return (value >>> 0).toString(36);
}

/**
 * What a PR's parts are named by, wherever they show. The same PR's row on the
 * list and its tab share it, so either can carry its number and title into the
 * review, before the tab has an id of its own.
 */
export function prMorphKey(root: string, number: number): string {
  return `pr-${hash(root)}-${number}`;
}

/** The crossfade, in ms. The screen arriving takes longer than the one leaving. */
export const SCREEN_FADE = { out: 180, in: 300 } as const;

/** When the running screen change has settled, while one is running. */
let settling: Promise<void> | null = null;

/** The running screen change's settling, for background work to wait out. */
export const screenSettling = (): Promise<void> | null => settling;

/** Runs `update` inside the screen transition; resolves once the new screen has rendered. */
export function transitionScreen(update: () => void): Promise<void> {
  // `morph` runs the update a frame later, after capturing the old screen.
  // Callers keep working with the store once it has run, so wait for it.
  return new Promise((resolve) => {
    let startFade = () => {};
    const faded = new Promise<void>((done) => {
      startFade = () => setTimeout(done, SCREEN_FADE.in);
    });
    const transition = morph(
      () => {
        update();
        startFade();
        resolve();
      },
      { scope: SCREEN_SCOPE, type: "screen" },
    );
    if (!transition) return;
    // Set before the update runs, so the new screen renders knowing it is
    // mid-change. Settled once the titles have landed and the screen has faded
    // in; a skipped transition still finishes, and still runs the update.
    const settled = Promise.all([transition.finished.catch(() => {}), faded]).then(() => {});
    settling = settled;
    void settled.then(() => {
      if (settling === settled) settling = null;
    });
  });
}

/**
 * False until the screen change that mounted this component has settled. Heavy
 * content waits on it: rendered mid-change, it would hold the main thread and
 * stall the animation. Content that was already mounted keeps rendering.
 */
export function useScreenSettled(): boolean {
  const [pending] = useState(() => settling);
  const [settled, setSettled] = useState(pending === null);

  useEffect(() => {
    if (!pending) return;
    let live = true;
    void pending.then(() => {
      if (live) setSettled(true);
    });
    return () => {
      live = false;
    };
  }, [pending]);

  return settled;
}

/** True inside the screen that is fading out. */
const LeavingContext = createContext(false);

/**
 * Shows `render(screen)`. When `screen` changes inside `transitionScreen`, the
 * old screen stays mounted, fading out over the new one fading in, until the
 * change settles. Any other change — the swipe gesture, which animates itself,
 * or reduced motion — swaps at once.
 */
export function ScreenStack<K extends string>({
  screen,
  render,
}: {
  screen: K;
  render: (screen: K) => ReactNode;
}) {
  const [shown, setShown] = useState(screen);
  const [leaving, setLeaving] = useState<{ screen: K; until: Promise<void> } | null>(null);

  // Derived during render, so both screens mount in the same commit the view
  // transition captures as its new state.
  if (screen !== shown) {
    setShown(screen);
    setLeaving(settling ? { screen: shown, until: settling } : null);
  }

  useEffect(() => {
    if (!leaving) return;
    let live = true;
    void leaving.until.then(() => {
      if (live) setLeaving(null);
    });
    return () => {
      live = false;
    };
  }, [leaving]);

  // A fixed order, so neither screen's DOM moves (and resets its scroll) as the
  // other comes and goes.
  const screens = leaving ? [shown, leaving.screen].sort() : [shown];
  const timing = {
    "--screen-fade-out": `${SCREEN_FADE.out}ms`,
    "--screen-fade-in": `${SCREEN_FADE.in}ms`,
  } as CSSProperties;

  return (
    <div className={css.stack} style={timing}>
      {screens.map((key) => {
        const fading = leaving ? (key === leaving.screen ? css.leaving : css.entering) : "";
        const isLeaving = key === leaving?.screen;
        return (
          <div key={key} className={`${css.layer} ${fading}`} inert={isLeaving}>
            <LeavingContext value={isLeaving}>{render(key)}</LeavingContext>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Marks an element as one of a tab's shared parts: `id` is the tab's
 * `morphKey`. A name may be held by one element at a time, so every holder but
 * one turns itself off with `active`.
 */
export function ScreenMorph({
  id,
  part,
  active = true,
  children,
}: {
  id: string;
  part: ScreenPart;
  active?: boolean;
  children: MorphProps["children"];
}) {
  const leaving = useContext(LeavingContext);
  if (leaving) {
    // In the screen fading out, the part whose copy is gliding to the new
    // screen keeps its space but not its text; the rest fade with the screen.
    if (!active) return children;
    return cloneElement(children, { style: { ...children.props.style, visibility: "hidden" } });
  }
  return (
    <Morph
      name={`screen-${id}-${part}`}
      scope={SCREEN_SCOPE}
      // Text glides at its true size, so nothing needs to scale. The tab
      // itself is a box, sliding over as the tabs around it come and go, and
      // the list's heading scales down into the back button's label.
      fit={part === "tab" || part === "heading" ? "box" : "text"}
      active={active}
    >
      {children}
    </Morph>
  );
}
