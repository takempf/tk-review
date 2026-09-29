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
  placeholder?: string;
  disabled?: boolean;
  /** The look: each call site keeps its own, this component brings behaviour. */
  className?: string;
  ariaLabel?: string;
  /** Focus on mount, for a field that appears because the user asked for it. */
  autoFocus?: boolean;
  onBlur?: () => void;
}

/**
 * The app's one multi-line text field. Every textarea goes through it so that
 * Shift+Enter means the same thing in all of them — a newline, never a send —
 * and so that all of them size to their text the same way (see the CSS).
 */
export function Textarea({
  value,
  onChange,
  onSubmit,
  submitOn = "mod-enter",
  canSubmit = true,
  placeholder,
  disabled = false,
  className,
  ariaLabel,
  autoFocus,
  onBlur,
}: TextareaProps) {
  return (
    <textarea
      className={className ? `${css.textarea} ${className}` : css.textarea}
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
      // biome-ignore lint/a11y/noAutofocus: only set when a click just revealed the field
      autoFocus={autoFocus}
      onBlur={onBlur}
    />
  );
}
