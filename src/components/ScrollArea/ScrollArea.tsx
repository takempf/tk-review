import { ScrollArea as BaseScrollArea } from "@base-ui/react/scroll-area";
import type { ReactNode, Ref } from "react";
import { cx } from "tk-design-system";
import css from "./ScrollArea.module.css";

/** Native scrolling with draggable bars over the content, without a gutter. */
export function ScrollArea({
  children,
  label,
  className,
  viewportClassName,
  viewportRef,
  renderViewport,
  horizontal = false,
}: {
  children?: ReactNode;
  label: string;
  className?: string;
  viewportClassName?: string;
  viewportRef?: Ref<HTMLDivElement>;
  renderViewport?: BaseScrollArea.Viewport.Props["render"];
  horizontal?: boolean;
}) {
  return (
    <BaseScrollArea.Root className={cx(css.root, className)} data-scroll-area={label}>
      <BaseScrollArea.Viewport
        ref={viewportRef}
        render={renderViewport}
        className={cx(css.viewport, viewportClassName)}
        style={{ overflowX: horizontal ? "auto" : "hidden", overflowY: "auto" }}
        role="region"
        aria-label={label}
        data-scroll-viewport=""
      >
        <BaseScrollArea.Content
          className={css.content}
          style={{ minWidth: horizontal ? "fit-content" : 0 }}
          data-scroll-content=""
        >
          {children}
        </BaseScrollArea.Content>
      </BaseScrollArea.Viewport>
      <BaseScrollArea.Scrollbar className={css.scrollbar} aria-label={`Scroll ${label}`}>
        <BaseScrollArea.Thumb className={css.thumb} />
      </BaseScrollArea.Scrollbar>
      {horizontal ? (
        <>
          <BaseScrollArea.Scrollbar
            orientation="horizontal"
            className={css.scrollbar}
            aria-label={`Scroll ${label} horizontally`}
          >
            <BaseScrollArea.Thumb className={css.thumb} />
          </BaseScrollArea.Scrollbar>
          <BaseScrollArea.Corner />
        </>
      ) : null}
    </BaseScrollArea.Root>
  );
}
