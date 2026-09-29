import type { CSSProperties, ReactNode } from "react";
import css from "./Skeleton.module.css";

/** A bar standing in for a line of content that is on its way. */
export function Skeleton({
  width,
  className,
}: {
  width?: CSSProperties["width"];
  className?: string;
}) {
  return <span className={className ? `${css.bar} ${className}` : css.bar} style={{ width }} />;
}

/**
 * A group of skeletons, announced once as loading rather than as a run of
 * empty shapes. Fades in after a beat, so a load that is nearly done never
 * flashes one — unless `instant`, for a group taking over from another.
 */
export function SkeletonGroup({
  label,
  instant = false,
  className,
  children,
}: {
  label: string;
  instant?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const classes = [css.group, instant ? css.instant : null, className].filter(Boolean).join(" ");
  return (
    <div className={classes} role="status" aria-busy="true" aria-label={label}>
      {children}
    </div>
  );
}
