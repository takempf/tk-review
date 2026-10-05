import { useLayoutEffect, useRef, useState } from "react";
import { Button, Icon, Tooltip } from "tk-design-system";
import { Author } from "../Author/Author";
import { useCopy } from "../CopyButton/CopyButton";
import css from "./PrBranches.module.css";

/**
 * Whether `content` fits inside `frame` at its natural width. The frame is
 * sized by the space around it — the content keeps its size, hidden or not —
 * so the answer never feeds back into the layout it measures.
 */
function useFits() {
  const frame = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const [fits, setFits] = useState(true);

  useLayoutEffect(() => {
    const frameElement = frame.current;
    const contentElement = content.current;
    if (!frameElement || !contentElement) return;
    const measure = () => {
      // Half a pixel of slack: the frame's own width is this content's,
      // rounded, whenever nothing is squeezing it.
      const needed = contentElement.getBoundingClientRect().width;
      setFits(needed <= frameElement.getBoundingClientRect().width + 0.5);
    };
    // The observer's first report comes after layout, before paint, so it
    // measures without forcing a layout of its own mid-render (inside a screen
    // change's update, say).
    const observer = new ResizeObserver(measure);
    observer.observe(frameElement);
    observer.observe(contentElement);
    return () => observer.disconnect();
  }, []);

  return { frame, content, fits };
}

/** A branch name that copies itself on a click. */
function Branch({ name, side }: { name: string; side: "head" | "base" }) {
  const { copied, copy } = useCopy(name);
  return (
    <Tooltip content={copied ? "Copied" : `Copy ${side} branch`}>
      <Button
        variant="ghost"
        size="sm"
        className={css.branch}
        onClick={copy}
        aria-label={copied ? "Copied" : `Copy ${side} branch ${name}`}
        data-copied={copied || undefined}
      >
        <span className={css.name}>{name}</span>
        <Icon name={copied ? "check" : "copy"} />
      </Button>
    </Tooltip>
  );
}

/**
 * Who opened a PR, then its head and base branches, `head → base` as its row
 * in the list reads. They are the first thing the header gives up: out of
 * room, they hide whole rather than squeeze the title.
 */
export function PrBranches({
  author,
  host,
  headRef,
  baseRef,
}: {
  /** Unknown while a PR opened from a recent entry loads. */
  author: string | null;
  host: string;
  headRef: string;
  baseRef: string;
}) {
  const { frame, content, fits } = useFits();
  return (
    <div ref={frame} className={css.frame}>
      <div ref={content} className={css.branches} data-hidden={!fits || undefined}>
        {author ? <Author login={author} host={host} className={css.author} /> : null}
        <Branch name={headRef} side="head" />
        <Icon name="arrow-right" className={css.arrow} />
        <Branch name={baseRef} side="base" />
      </div>
    </div>
  );
}
