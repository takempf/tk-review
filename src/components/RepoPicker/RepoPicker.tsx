import { open } from "@tauri-apps/plugin-dialog";
import { useReviewStore } from "../../store/reviewStore";
import css from "./RepoPicker.module.css";

async function chooseFolder(): Promise<string | null> {
  const selected = await open({
    directory: true,
    multiple: false,
    title: "Choose a git repository",
  });
  return typeof selected === "string" ? selected : null;
}

/** Header control: shows the open repository and allows switching. */
export function RepoPicker() {
  const repo = useReviewStore((state) => state.repo);
  const loading = useReviewStore((state) => state.loadingRepo);
  const openRepo = useReviewStore((state) => state.openRepo);

  async function pick() {
    const path = await chooseFolder();
    if (path) await openRepo(path);
  }

  return (
    <div className={css.compact}>
      <span className={css.repoName} title={repo?.root}>
        {repo?.name ?? "No repository"}
      </span>
      <button type="button" className={css.button} onClick={pick} disabled={loading}>
        {loading ? "Opening…" : "Change…"}
      </button>
    </div>
  );
}

/** Startup state, before a repository has been chosen. */
export function RepoPickerHero() {
  const loading = useReviewStore((state) => state.loadingRepo);
  const error = useReviewStore((state) => state.error);
  const openRepo = useReviewStore((state) => state.openRepo);

  async function pick() {
    const path = await chooseFolder();
    if (path) await openRepo(path);
  }

  return (
    <div className={css.hero}>
      <h1 className={css.heroTitle}>tk-review</h1>
      <p className={css.heroHint}>
        Open a git repository to compare two branches and read the diff like a pull request.
      </p>
      <button type="button" className={css.heroButton} onClick={pick} disabled={loading}>
        {loading ? "Opening…" : "Open repository…"}
      </button>
      {error ? <p className={css.heroError}>{error}</p> : null}
    </div>
  );
}
