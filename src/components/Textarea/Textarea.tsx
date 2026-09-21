import { useLayoutEffect, useRef } from "react";
import css from "./Textarea.module.css";

/**
 * Which keystroke sends the text rather than breaking the line.
 *
 * `enter` is the chat convention: the field is usually one line, sending is the
 * common act, and Shift+Enter is the escape hatch for the occasional second
 * line. `mod-enter` inverts it for fields where the text is the point and
 * sending is deliberate — Enter and Shift+Enter both break the line, and
 * Cmd/Ctrl+Enter sends. GitHub's own comment box works the second way, which is
 * why the composer that drafts for GitHub does too.
 *
 * Under either rule Cmd/Ctrl+Enter sends, so that chord means the same thing
 * everywhere in the app even though plain Enter does not.
 */
export type SubmitOn = "enter" | "mod-enter";

interface TextareaProps {
  value: string;
  onChange: (value: string) => void;
  /** Runs on the submit chord, and only while `canSubmit`. */
  onSubmit?: () => void;
  submitOn?: SubmitOn;
  /** Gates the chord the way a disabled Send button gates the click. */
  canSubmit?: boolean;
  /** Track the text's height, from `rows` up to the CSS max, then scroll. */
  autoGrow?: boolean;
  rows?: number;
  placeholder?: string;
  disabled?: boolean;
  /** The look: each call site keeps its own, this component brings behaviour. */
  className?: string;
  ariaLabel?: string;
}

/**
 * The app's one multi-line text field. Every textarea goes through it so that
 * Shift+Enter means the same thing in all of them — a newline, never a send.
 */
export function Textarea({
  value,
  onChange,
  onSubmit,
  submitOn = "mod-enter",
  canSubmit = true,
  autoGrow = false,
  rows,
  placeholder,
  disabled = false,
  className,
  ariaLabel,
}: TextareaProps) {
  const ref = useRef<HTMLTextAreaElement>(null);

  // Re-measured on every value, not only on typing: clearing the draft after a
  // send is an outside change, and the field has to shrink back for it too. The
  // height is read off the DOM the render just laid out rather than computed
  // from `value`, which is why the linter cannot see that dependency for what
  // it is — a trigger, not an input.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useLayoutEffect(() => {
    const el = ref.current;
    if (!autoGrow || !el) return;
    // Collapse first so the scroll height reports the text's own height rather
    // than whatever the field was last stretched to. `scrollHeight` covers the
    // padding but not the border, which the difference below adds back.
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
  }, [autoGrow, value]);

  return (
    <textarea
      ref={ref}
      className={className ? `${css.textarea} ${className}` : css.textarea}
      // The growing field starts at one line and the CSS caps it; a fixed one
      // is sized by its own stylesheet, so neither wants the browser default.
      rows={rows ?? (autoGrow ? 1 : undefined)}
      data-grow={autoGrow ? "" : undefined}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={(event) => {
        if (event.key !== "Enter") return;
        // Enter mid-composition picks an IME candidate. Sending there would eat
        // the keystroke the candidate needed and post a half-written comment.
        if (event.nativeEvent.isComposing) return;

        const mod = event.metaKey || event.ctrlKey;
        const sends = submitOn === "enter" ? !event.shiftKey || mod : mod;
        // Everything else — Shift+Enter above all — is left to the browser,
        // which inserts the newline itself.
        if (!sends) return;

        // Swallowed even when the send is gated, so a comment that is empty or
        // still awaiting a reply does not gain a stray blank line instead.
        event.preventDefault();
        if (canSubmit) onSubmit?.();
      }}
      placeholder={placeholder}
      disabled={disabled}
      aria-label={ariaLabel}
    />
  );
}
