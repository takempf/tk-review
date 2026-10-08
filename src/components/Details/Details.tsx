import { type ReactNode, useId, useLayoutEffect, useRef, useState } from "react";
import { Button, holdScenery, Panel, SceneryWindow } from "tk-design-system";
import css from "./Details.module.css";

/** An in-flow panel that grows from its own trigger, keeping the scenery still during motion. */
export function Details({
  open,
  onOpenChange,
  trigger,
  disabled = false,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trigger: ReactNode;
  disabled?: boolean;
  children: ReactNode;
}) {
  const id = useId();
  const slot = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const animation = useRef<Animation | null>(null);
  const wasOpen = useRef(open);
  const [mounted, setMounted] = useState(open);
  if (open && !mounted) setMounted(true);
  // Pointed at, or focused from the keyboard, the closed trigger shows the
  // scenery faintly: a preview of the panel it opens into.
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const lit = !disabled && (hovered || focused);
  // The scenery stays mounted until it has faded out, after both have ended.
  const [scenery, setScenery] = useState(open);
  const sceneryWanted = open || lit;
  if (sceneryWanted && !scenery) setScenery(true);

  useLayoutEffect(() => {
    if (sceneryWanted || !scenery) return;
    // Asking for the animations settles the style first, so the fade that the
    // attribute change just started is among them. With none, it goes now.
    const fades = frame.current?.querySelector(".tk-scenery")?.getAnimations() ?? [];
    let cancelled = false;
    void Promise.all(fades.map((fade) => fade.finished)).then(
      () => {
        if (!cancelled) setScenery(false);
      },
      // Interrupted by a return of the pointer, which keeps it.
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [sceneryWanted, scenery]);

  useLayoutEffect(() => {
    const container = slot.current;
    const panel = frame.current;
    const content = inner.current;
    const triggerButton = button.current;
    if (!container || !panel || !content || !triggerButton) return;
    let disposed = false;
    let reveal = open && !wasOpen.current;

    function resize() {
      if (!container || !panel || !content || !triggerButton) return;
      // Hidden panel tabs have no layout; leave their measured bounds intact.
      if (!container.clientWidth) {
        if (!open) setMounted(false);
        return;
      }
      const before = panel.getBoundingClientRect();
      const border = panel.offsetWidth - panel.clientWidth;
      content.style.width = `${Math.max(0, container.clientWidth - border)}px`;
      const width = open ? container.clientWidth : triggerButton.offsetWidth + border;
      const height = (open ? content.offsetHeight : triggerButton.offsetHeight) + border;
      // Keep the canvas at the final expanded bounds. Only the clipping frame
      // resizes per animation frame, so scenery's ResizeObserver stays quiet.
      const scenery = panel.querySelector<HTMLElement>(".tk-scenery");
      if (scenery && open) {
        scenery.style.width = `${width - border}px`;
        scenery.style.height = `${height - border}px`;
      }
      const targetWidth = `${width}px`;
      const targetHeight = `${height}px`;
      if (panel.style.width === targetWidth && panel.style.height === targetHeight) return;
      animation.current?.cancel();
      panel.style.width = targetWidth;
      panel.style.height = targetHeight;

      const finish = () => {
        if (disposed) return;
        if (!open) setMounted(false);
        if (reveal) {
          reveal = false;
          panel.scrollIntoView({ block: "nearest" });
          content.querySelector("textarea")?.focus({ preventScroll: true });
        }
      };
      if (
        !panel.dataset.measured ||
        window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
        (Math.abs(before.width - width) < 1 && Math.abs(before.height - height) < 1)
      ) {
        panel.dataset.measured = "true";
        finish();
        return;
      }
      const transition = panel.animate(
        [
          { width: `${before.width}px`, height: `${before.height}px` },
          { width: targetWidth, height: targetHeight },
        ],
        {
          duration: 180,
          easing: getComputedStyle(panel).getPropertyValue("--tk-ease-morph").trim() || "ease",
        },
      );
      animation.current = transition;
      // Cancellation settles `finished` too, including reversals and unmounts.
      holdScenery(transition.finished);
      void transition.finished.then(finish, () => {});
    }

    resize();
    if (open && !wasOpen.current) content.querySelector("textarea")?.focus({ preventScroll: true });
    if (!open && wasOpen.current) triggerButton.focus({ preventScroll: true });
    wasOpen.current = open;
    let observedWidth = container.clientWidth;
    const observer = new ResizeObserver((entries) => {
      // The slot's height follows our animation. Only its width or the natural
      // content size can change the target; ignore our own intermediate heights.
      const changed = entries.some(
        (entry) => entry.target === content || entry.contentRect.width !== observedWidth,
      );
      if (!changed) return;
      observedWidth = container.clientWidth;
      resize();
    });
    observer.observe(container);
    observer.observe(content);
    return () => {
      disposed = true;
      observer.disconnect();
      // Preserve the visible dimensions when reversing an in-flight animation.
      const current = panel.getBoundingClientRect();
      panel.style.width = `${current.width}px`;
      panel.style.height = `${current.height}px`;
      animation.current?.cancel();
      animation.current = null;
    };
  }, [open]);

  return (
    <div ref={slot} className={css.slot}>
      <Panel
        ref={frame}
        className={css.frame}
        data-open={open || undefined}
        data-lit={lit || undefined}
      >
        {scenery ? <SceneryWindow className={css.scenery} /> : null}
        <div ref={inner} className={css.inner}>
          <Button
            ref={button}
            variant="ghost"
            size="sm"
            aria-expanded={open}
            aria-controls={id}
            disabled={disabled}
            onClick={() => onOpenChange(!open)}
            onPointerEnter={() => setHovered(true)}
            onPointerLeave={() => setHovered(false)}
            onFocus={(event) => setFocused(event.currentTarget.matches(":focus-visible"))}
            onBlur={() => setFocused(false)}
            className={css.trigger}
          >
            {trigger}
          </Button>
          {mounted ? (
            <div id={id} className={css.content} inert={!open} aria-hidden={!open}>
              {children}
            </div>
          ) : null}
        </div>
      </Panel>
    </div>
  );
}
