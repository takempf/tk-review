import { type ComponentProps, useState } from "react";
import { Tabs } from "tk-design-system";
import { GitHubMarkdown } from "../Markdown/Markdown";
import { Textarea } from "../Textarea/Textarea";
import css from "./CommentEditor.module.css";

/** The same Markdown authoring surface for PR comments, reviews and AI replies. */
export function CommentEditor({ className, ...props }: ComponentProps<typeof Textarea>) {
  const [tab, setTab] = useState("write");
  return (
    <Tabs.Root value={tab} onValueChange={setTab} className={css.editor}>
      <Tabs.List aria-label={`${props.ariaLabel ?? "Comment"} editor`} className={css.tabs}>
        <Tabs.Tab value="write">Write</Tabs.Tab>
        <Tabs.Tab value="preview">Preview</Tabs.Tab>
      </Tabs.List>
      <Tabs.Panel value="write" keepMounted className={css.body}>
        <Textarea {...props} className={className ? `${css.input} ${className}` : css.input} />
      </Tabs.Panel>
      <Tabs.Panel value="preview" className={css.preview}>
        {props.value.trim() ? (
          <GitHubMarkdown markdown={props.value} />
        ) : (
          <p className={css.empty}>Nothing to preview.</p>
        )}
      </Tabs.Panel>
    </Tabs.Root>
  );
}
