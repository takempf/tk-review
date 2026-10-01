import { useEffect, useState } from "react";
import { Button, Icon, Tooltip, toasts } from "tk-design-system";
import { writeClipboard } from "../../lib/clipboard";
import css from "./CopyButton.module.css";

/** How long the check mark stays after a copy. */
const COPIED_MS = 1500;

/**
 * Puts `text` on the clipboard on `copy()`, and reports `copied` for a moment
 * after it worked. A failure is a toast: there is nothing to retry in place.
 */
export function useCopy(text: string) {
  // A time rather than a flag, so copying again restarts the check's timer.
  const [copiedAt, setCopiedAt] = useState<number | null>(null);

  useEffect(() => {
    if (copiedAt === null) return;
    const timer = setTimeout(() => setCopiedAt(null), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copiedAt]);

  function copy() {
    writeClipboard(text).then(
      () => setCopiedAt(Date.now()),
      (error: unknown) =>
        toasts.add({
          title: "Could not copy",
          description: error instanceof Error ? error.message : String(error),
          type: "danger",
        }),
    );
  }

  return { copied: copiedAt !== null, copy };
}

/**
 * An icon button that puts `text` on the clipboard, turning into a check for a
 * moment to say it worked. Sized to sit at the end of a line of print rather
 * than in a row of controls.
 */
export function CopyButton({
  text,
  label = "Copy",
  className,
}: {
  text: string;
  label?: string;
  className?: string;
}) {
  const { copied, copy } = useCopy(text);

  return (
    <Tooltip content={copied ? "Copied" : label}>
      <Button
        variant="ghost"
        size="sm"
        square
        className={className ? `${css.copy} ${className}` : css.copy}
        onClick={copy}
        disabled={!text.trim()}
        aria-label={copied ? "Copied" : label}
        data-copied={copied || undefined}
      >
        <Icon name={copied ? "check" : "copy"} />
      </Button>
    </Tooltip>
  );
}
