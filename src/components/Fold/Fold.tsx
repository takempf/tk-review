import { type CSSProperties, type ReactNode, useEffect, useState } from "react";
import css from "./Fold.module.css";

/** Folding open and shut, in ms. Opening takes longer, the way arrivals do elsewhere. */
export const FOLD_MS = { open: 420, close: 280 } as const;

const prefersReducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

type Phase = "closed" | "shown" | "opening" | "closing";

/**
 * A block that unfolds from nothing when `open` turns true and folds back to
 * nothing when it turns false, so the content around it eases into place
 * rather than jumping. It stays mounted while it folds shut, then unmounts.
 * One open from its first render is simply there, unless it should `appear`.
 *
 * `className` goes on the block itself, so its padding folds away with it and
 * sibling selectors in the parent's stylesheet still match it.
 */
export function Fold({
  open,
  appear = false,
  className,
  children,
}: {
  open: boolean;
  /** Unfold on mounting open, too. */
  appear?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const [phase, setPhase] = useState<Phase>(open ? (appear ? "opening" : "shown") : "closed");
  if (open && (phase === "closed" || phase === "closing")) setPhase("opening");
  if (!open && (phase === "shown" || phase === "opening")) setPhase("closing");

  // A timer rather than `animationend`, which never fires while the block is
  // hidden (in a background tab of the panel, say) and would leave it mounted.
  useEffect(() => {
    if (phase !== "closing") return;
    const timer = setTimeout(() => setPhase("closed"), prefersReducedMotion() ? 0 : FOLD_MS.close);
    return () => clearTimeout(timer);
  }, [phase]);

  if (phase === "closed") return null;
  const timing = {
    "--fold-open": `${FOLD_MS.open}ms`,
    "--fold-close": `${FOLD_MS.close}ms`,
  } as CSSProperties;
  const motion = phase === "opening" ? css.opening : phase === "closing" ? css.closing : "";

  return (
    <div
      className={[css.fold, motion, className].filter(Boolean).join(" ")}
      style={timing}
      inert={phase === "closing"}
    >
      <div className={css.content}>{children}</div>
    </div>
  );
}
