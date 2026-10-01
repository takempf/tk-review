import { type ReactNode, useState } from "react";
import { Button, Icon } from "tk-design-system";
import type { AppError } from "../../ipc/git";
import { CopyButton } from "../CopyButton/CopyButton";
import { Fold } from "../Fold/Fold";
import css from "./ErrorNotice.module.css";

/**
 * A failure, said plainly: what failed, why in a sentence or two, and, one
 * click away, the raw output behind it for when the sentence isn't enough.
 * The raw output stays folded because it is for debugging, and a wall of JSON
 * in the reading column is what it replaces.
 */
export function ErrorNotice({
  error,
  onDismiss,
  variant = "box",
  className,
  children,
}: {
  error: AppError;
  onDismiss?: () => void;
  /** `banner` runs edge to edge under the header; `box` sits in a column. */
  variant?: "box" | "banner";
  className?: string;
  /** What the reader can still do, under the explanation. */
  children?: ReactNode;
}) {
  const [showDetail, setShowDetail] = useState(false);
  const report = [error.title, error.message, error.detail].filter(Boolean).join("\n\n");

  return (
    <div
      className={className ? `${css.notice} ${className}` : css.notice}
      data-variant={variant}
      role="alert"
    >
      <Icon name="warning" className={css.icon} />
      <div className={css.body}>
        {error.title ? <p className={css.title}>{error.title}</p> : null}
        <p className={css.message}>{error.message}</p>
        {children ? <p className={css.message}>{children}</p> : null}
        {error.detail ? (
          <div className={css.detailBar}>
            <button
              type="button"
              className={css.detailToggle}
              aria-expanded={showDetail}
              onClick={() => setShowDetail(!showDetail)}
            >
              <Icon name={showDetail ? "chevron-down" : "chevron-right"} />
              {showDetail ? "Hide details" : "Show details"}
            </button>
            <CopyButton text={report} label="Copy the error with its details" />
          </div>
        ) : null}
      </div>
      {onDismiss ? (
        <Button
          variant="ghost"
          size="sm"
          square
          className={css.dismiss}
          onClick={onDismiss}
          aria-label="Dismiss"
          title="Dismiss"
        >
          <Icon name="close" />
        </Button>
      ) : null}
      {/* Under the whole notice rather than the text column: raw output wants
          every bit of width the review column has. */}
      {error.detail ? (
        <Fold open={showDetail} className={css.detailFold}>
          <pre className={css.detail}>{error.detail}</pre>
        </Fold>
      ) : null}
    </div>
  );
}
