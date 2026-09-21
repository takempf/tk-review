import { useCallback, useRef, useState } from "react";
import css from "./ResizeHandle.module.css";

/** Nudge per arrow-key press when the handle has focus. */
const KEYBOARD_STEP = 16;

interface StoredSizeOptions {
  storageKey: string;
  min: number;
  max: number;
  fallback: number;
}

/**
 * A pane dimension the user can drag, remembered across launches. The stored
 * value is written only when a drag ends, rather than on every pointer move.
 */
export function useStoredSize({ storageKey, min, max, fallback }: StoredSizeOptions) {
  const clamp = useCallback((size: number) => Math.min(Math.max(size, min), max), [min, max]);

  const [size, setSize] = useState(() => {
    try {
      const stored = Number(localStorage.getItem(storageKey));
      return Number.isFinite(stored) && stored > 0 ? clamp(stored) : fallback;
    } catch {
      return fallback;
    }
  });

  const persist = useCallback(
    (next: number) => {
      try {
        localStorage.setItem(storageKey, String(next));
      } catch {
        // An unavailable localStorage shouldn't stop the pane from resizing.
      }
    },
    [storageKey],
  );

  const resize = useCallback((next: number) => setSize(clamp(next)), [clamp]);

  const resizeAndPersist = useCallback(
    (next: number) => {
      const clamped = clamp(next);
      setSize(clamped);
      persist(clamped);
    },
    [clamp, persist],
  );

  const reset = useCallback(() => {
    setSize(fallback);
    persist(fallback);
  }, [fallback, persist]);

  return { size, min, max, resize, resizeAndPersist, reset };
}

interface ResizeHandleProps {
  /** Which dimension the drag changes. */
  axis: "width" | "height";
  /**
   * Which edge of the pane the handle sits on. Dragging away from the pane
   * grows it, so a handle on the start edge (left or top) inverts the delta.
   */
  edge: "start" | "end";
  label: string;
  size: number;
  min: number;
  max: number;
  onResize: (size: number) => void;
  onResizeEnd: (size: number) => void;
  onReset: () => void;
}

/**
 * A draggable pane boundary. Straddles the pane's edge so the grab target is
 * forgiving without shifting the layout; the parent must be positioned.
 */
export function ResizeHandle({
  axis,
  edge,
  label,
  size,
  min,
  max,
  onResize,
  onResizeEnd,
  onReset,
}: ResizeHandleProps) {
  const drag = useRef<{ start: number; startSize: number; latest: number } | null>(null);
  const horizontal = axis === "width";
  const sign = edge === "end" ? 1 : -1;
  const clamp = (value: number) => Math.min(Math.max(value, min), max);
  const bodyClass = (horizontal ? css.resizingX : css.resizingY) ?? "";
  const [shrinkKey, growKey] = horizontal ? ["ArrowLeft", "ArrowRight"] : ["ArrowUp", "ArrowDown"];

  return (
    // An <hr> already carries the separator role; focusing it and handling arrow
    // keys turns it into the APG window-splitter widget.
    <hr
      className={[
        css.handle,
        horizontal ? css.horizontal : css.vertical,
        edge === "end" ? css.end : css.start,
      ].join(" ")}
      // Orientation describes the separator line itself, not the drag direction.
      aria-orientation={horizontal ? "vertical" : "horizontal"}
      aria-label={label}
      aria-valuenow={Math.round(size)}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onDoubleClick={onReset}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        const start = horizontal ? event.clientX : event.clientY;
        drag.current = { start, startSize: size, latest: size };
        // Capture keeps move events coming even when the pointer outruns the
        // handle, which it will during a fast drag.
        event.currentTarget.setPointerCapture(event.pointerId);
        document.body.classList.add(bodyClass);
      }}
      onPointerMove={(event) => {
        const state = drag.current;
        if (!state) return;
        const position = horizontal ? event.clientX : event.clientY;
        state.latest = clamp(state.startSize + sign * (position - state.start));
        onResize(state.latest);
      }}
      onPointerUp={(event) => {
        const state = drag.current;
        if (!state) return;
        drag.current = null;
        event.currentTarget.releasePointerCapture(event.pointerId);
        document.body.classList.remove(bodyClass);
        onResizeEnd(state.latest);
      }}
      onKeyDown={(event) => {
        // Arrow keys follow the handle's on-screen movement, whichever edge it is on.
        if (event.key === shrinkKey) onResizeEnd(size - sign * KEYBOARD_STEP);
        else if (event.key === growKey) onResizeEnd(size + sign * KEYBOARD_STEP);
        else return;
        event.preventDefault();
      }}
    />
  );
}
