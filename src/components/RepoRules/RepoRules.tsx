import { Tabs } from "@base-ui/react/tabs";
import { Fragment, useEffect, useState } from "react";
import { Button, Dialog, Icon } from "tk-design-system";
import { type AppError, gitApi, type RepoRules, type RuleSlot, toAppError } from "../../ipc/git";
import { CommentEditor } from "../CommentEditor/CommentEditor";
import { ErrorNotice } from "../ErrorNotice/ErrorNotice";
import { Spinner } from "../Spinner/Spinner";
import css from "./RepoRules.module.css";

/**
 * Opens the rules every review of this repository follows. They are kept on
 * this computer rather than in the repository, so they can hold what is
 * specific or private to the team that owns it, and they are keyed by the
 * GitHub repository, so every clone and worktree of it shares them.
 */
export function RepoRulesButton({ root }: { root: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger
        render={<Button variant="ghost" size="sm" />}
        title="Rules every review of this repository follows"
      >
        <Icon name="rows" />
        Rules
      </Dialog.Trigger>
      <Dialog.Popup size="lg" aria-label="Review rules">
        <RulesForm root={root} onDone={() => setOpen(false)} />
      </Dialog.Popup>
    </Dialog.Root>
  );
}

/** Text with `code` spans, as the backend writes a reviewer's description. */
function WithCode({ text }: { text: string }) {
  let at = 0;
  return text.split("`").map((part, index) => {
    // Keyed by where each part starts, which no two share.
    const key = at;
    at += part.length + 1;
    // Odd parts sat between backticks.
    return index % 2 ? <code key={key}>{part}</code> : <Fragment key={key}>{part}</Fragment>;
  });
}

/**
 * Mounted each time the dialog opens, so it always starts from what is saved.
 * Each reviewer keeps its own rules: the lead reviewer's go into every review,
 * and each specialist's only to that specialist, so the list shows whose are
 * set and the editor shows one reviewer's at a time.
 */
function RulesForm({ root, onDone }: { root: string; onDone: () => void }) {
  const [repo, setRepo] = useState<string | null>(null);
  const [file, setFile] = useState<string | null>(null);
  const [reviewers, setReviewers] = useState<RuleSlot[]>([]);
  const [rules, setRules] = useState<RepoRules | null>(null);
  const [selected, setSelected] = useState("review");
  const [error, setError] = useState<AppError | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let current = true;
    gitApi.getRepoRules(root).then(
      (entry) => {
        if (!current) return;
        setRepo(entry.repo);
        setFile(entry.file);
        setReviewers(entry.reviewers);
        setRules(entry.rules);
      },
      (cause) => current && setError(toAppError(cause, "Couldn't read the rules")),
    );
    return () => {
      current = false;
    };
  }, [root]);

  const save = () => {
    if (!rules || saving) return;
    setSaving(true);
    setError(null);
    gitApi.setRepoRules(root, rules).then(onDone, (cause) => {
      setSaving(false);
      setError(toAppError(cause, "Couldn't save the rules"));
    });
  };

  return (
    <>
      <Dialog.Title>Review rules</Dialog.Title>
      <Dialog.Description>
        Every review of {repo ? <code>{repo}</code> : "this repository"} follows these, on top of
        the app's own guidance: the lead reviewer's always, and each specialist's when a review
        launches it. They're kept on this computer, not in the repository.
      </Dialog.Description>

      {error ? <ErrorNotice error={error} onDismiss={() => setError(null)} /> : null}

      {rules ? (
        <Tabs.Root
          className={css.reviewers}
          orientation="vertical"
          value={selected}
          onValueChange={(value) => setSelected(String(value))}
        >
          <Tabs.List className={css.list} aria-label="Reviewers">
            {reviewers.map((reviewer) => (
              <Tabs.Tab key={reviewer.key} value={reviewer.key} className={css.tab}>
                {reviewer.label}
                {rules[reviewer.key]?.trim() ? (
                  <span className={css.kept} title="Has rules" aria-hidden />
                ) : null}
              </Tabs.Tab>
            ))}
          </Tabs.List>
          {reviewers.map((reviewer) => (
            // Kept mounted, so each field keeps its undo history across tabs.
            <Tabs.Panel key={reviewer.key} value={reviewer.key} keepMounted className={css.field}>
              <span className={css.hint}>
                <WithCode text={reviewer.about} />
              </span>
              <CommentEditor
                ariaLabel={`${reviewer.label} rules`}
                value={rules[reviewer.key] ?? ""}
                onChange={(text) => setRules({ ...rules, [reviewer.key]: text })}
                onSubmit={save}
                placeholder={reviewer.placeholder}
                className={css.input}
              />
            </Tabs.Panel>
          ))}
        </Tabs.Root>
      ) : error ? null : (
        <p className={css.loading}>
          <Spinner /> Reading the rules…
        </p>
      )}

      <div className={css.footer}>
        <span className={css.file} title={file ?? undefined}>
          {/* Isolated, so the right-to-left box that ellipsizes the start of
              the path doesn't reorder its punctuation. */}
          <span dir="ltr">{file}</span>
        </span>
        <Dialog.Close render={<Button variant="ghost" size="sm" />}>Cancel</Dialog.Close>
        <Button size="sm" onClick={save} disabled={!rules || saving}>
          {saving ? <Spinner /> : <Icon name="check" />}
          Save
        </Button>
      </div>
    </>
  );
}
