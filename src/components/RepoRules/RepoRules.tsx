import { useEffect, useState } from "react";
import { Button, Dialog, Icon } from "tk-design-system";
import { type AppError, gitApi, type RepoRules, toAppError } from "../../ipc/git";
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

/** Mounted each time the dialog opens, so it always starts from what is saved. */
function RulesForm({ root, onDone }: { root: string; onDone: () => void }) {
  const [repo, setRepo] = useState<string | null>(null);
  const [file, setFile] = useState<string | null>(null);
  const [rules, setRules] = useState<RepoRules | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let current = true;
    gitApi.getRepoRules(root).then(
      (entry) => {
        if (!current) return;
        setRepo(entry.repo);
        setFile(entry.file);
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
        the app's own guidance. They're kept on this computer, not in the repository.
      </Dialog.Description>

      {error ? <ErrorNotice error={error} onDismiss={() => setError(null)} /> : null}

      {rules ? (
        <>
          <div className={css.field}>
            <span className={css.label}>Review rules</span>
            <span className={css.hint}>
              Conventions to hold the code to, and risks to always check for.
            </span>
            <CommentEditor
              ariaLabel="Review rules"
              value={rules.review}
              onChange={(review) => setRules({ ...rules, review })}
              onSubmit={save}
              placeholder="e.g. Money is always integer cents, never floats."
              className={css.input}
            />
          </div>
          <div className={css.field}>
            <span className={css.label}>Migration rules</span>
            <span className={css.hint}>
              For the migration reviewer, which a Claude review launches when a diff changes files
              under a <code>migrations</code> directory: which tables are large or busy, the
              triggers that fire, house conventions.
            </span>
            <CommentEditor
              ariaLabel="Migration rules"
              value={rules.migrations}
              onChange={(migrations) => setRules({ ...rules, migrations })}
              onSubmit={save}
              placeholder="e.g. orders has 80M rows: any lock on it needs a lock_timeout."
              className={css.input}
            />
          </div>
        </>
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
