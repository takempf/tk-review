import { type ComponentProps, useState } from "react";
import { Toggle, ToggleGroup } from "tk-design-system";
import { GitHubMarkdown } from "../Markdown/Markdown";
import { Textarea } from "../Textarea/Textarea";
import css from "./CommentEditor.module.css";

type Mode = "write" | "preview";

/** The same Markdown authoring surface for PR comments, reviews and AI replies. */
export function CommentEditor({
  className,
  variant,
  ...props
}: ComponentProps<typeof Textarea> & {
  /** `scenery`: inked in the scenery's own tones, for an editor that sits on it. */
  variant?: "scenery";
}) {
  const [mode, setMode] = useState<Mode>("write");
  return (
    <div className={css.editor} data-variant={variant}>
      <ToggleGroup
        size="sm"
        aria-label={`${props.ariaLabel ?? "Comment"} editor`}
        value={[mode]}
        onValueChange={(value) => {
          const next = value[0] as Mode | undefined;
          if (next) setMode(next);
        }}
        className={css.modes}
      >
        <Toggle value="write">Write</Toggle>
        <Toggle value="preview">Preview</Toggle>
      </ToggleGroup>
      {/* Hidden rather than unmounted while previewing, so the field keeps its undo history. */}
      <div className={css.body} hidden={mode !== "write"}>
        <Textarea {...props} className={className ? `${css.input} ${className}` : css.input} />
      </div>
      {mode === "preview" ? (
        <div className={css.preview}>
          {props.value.trim() ? (
            <GitHubMarkdown markdown={props.value} />
          ) : (
            <p className={css.empty}>Nothing to preview.</p>
          )}
        </div>
      ) : null}
    </div>
  );
}
