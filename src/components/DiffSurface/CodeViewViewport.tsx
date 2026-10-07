import { ScrollArea } from "@base-ui/react/scroll-area";
import {
  type ComponentPropsWithRef,
  type CSSProperties,
  cloneElement,
  type ReactElement,
  type Ref,
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useState,
} from "react";

/** Observe CodeView's full-height scaffold, including its virtualized spacers. */
function CodeViewContent({
  ref,
  viewport,
}: {
  ref?: Ref<HTMLDivElement>;
  viewport: HTMLDivElement;
}) {
  useImperativeHandle(ref, () => viewport.firstElementChild as HTMLDivElement, [viewport]);
  return null;
}

/**
 * CodeView exposes its div through containerRef, but doesn't forward DOM props.
 * Give Base UI that same scroll root, forward events through a layout-free
 * parent, and observe the renderer's own content rather than wrapping it.
 */
export function CodeViewViewport({
  viewportProps,
  children,
}: {
  viewportProps: ComponentPropsWithRef<"div">;
  children: ReactElement<{
    className?: string;
    style?: CSSProperties;
    containerRef?: Ref<HTMLDivElement>;
  }>;
}) {
  const {
    ref,
    className,
    style,
    tabIndex,
    onScroll,
    onWheel,
    onPointerMove,
    onPointerEnter,
    onKeyDown,
  } = viewportProps;
  const [viewport, setViewport] = useState<HTMLDivElement | null>(null);
  const connect = useCallback(
    (node: HTMLDivElement | null) => {
      setViewport(node);
      if (typeof ref === "function") ref(node);
      else if (ref) ref.current = node;
    },
    [ref],
  );

  useLayoutEffect(() => {
    if (!viewport) return;
    viewport.tabIndex = tabIndex ?? -1;
    const attributes = Object.entries(viewportProps).filter(
      ([name]) => name === "role" || name.startsWith("aria-") || name.startsWith("data-"),
    );
    for (const [name, value] of attributes) {
      if (value != null) viewport.setAttribute(name, String(value));
    }
    return () => {
      for (const [name] of attributes) viewport.removeAttribute(name);
    };
  }, [viewport, viewportProps, tabIndex]);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: delegates to the focusable, labelled viewport
    <div
      role="presentation"
      style={{ display: "contents" }}
      onScrollCapture={(event) => {
        if (event.target === viewport) onScroll?.(event);
      }}
      onWheel={onWheel}
      onPointerMove={onPointerMove}
      onPointerEnter={onPointerEnter}
      onKeyDown={onKeyDown}
    >
      {cloneElement(children, { containerRef: connect, className, style })}
      {viewport ? (
        <ScrollArea.Content
          render={(props) => <CodeViewContent ref={props.ref} viewport={viewport} />}
        />
      ) : null}
    </div>
  );
}
