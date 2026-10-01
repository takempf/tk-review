# tk-review

A local diff viewer for reviewing branches the way a pull request reads. Point it at a git repository on your machine, pick two refs, and read the changes file by file. Nothing leaves your machine and there's no remote to authenticate against.

Diffs are rendered with [`@pierre/diffs`](https://diffs.com/), through its `CodeView` surface: every changed file lives in one virtualized scroll region, the way a pull request reads. Git work happens in Rust by shelling out to the system `git` binary, so rename detection, merge-base resolution, and blob reads all behave exactly as git does.

## Running it

Requires Node with pnpm, and a Rust toolchain for the Tauri shell.

```bash
pnpm install
pnpm app        # tauri dev: builds the Rust binary and opens the window
```

Other commands:

```bash
pnpm dev        # vite dev server on its own, no native window
pnpm harness    # the UI in a plain browser, git backend stubbed (see dev-harness/)
pnpm build      # typecheck, then build the frontend bundle
pnpm typecheck  # tsc --noEmit
pnpm check      # biome lint + format, with fixes applied
```

`pnpm harness` runs the real `App` against fixture data through Tauri's `mockIPC`, which makes UI work possible without rebuilding the Rust binary and is scriptable in a headless browser.

For the Rust side, from `src-tauri/`:

```bash
cargo test      # 13 tests, including ones that build real repos in a temp dir
cargo clippy --all-targets
cargo fmt
```

If `cargo` isn't found and you installed rustup through Homebrew, the formula is keg-only and its shims aren't on your PATH by default. Add them: `fish_add_path -U /opt/homebrew/opt/rustup/bin`.

## How the comparison works

Comparisons are anchored on the merge base of the two refs, which is what a PR shows: work that landed on the compare branch since it diverged, without the commits base picked up in the meantime. The merge base is resolved explicitly rather than using `base...compare`, so the diff and the file contents fetched afterward are pinned to the same commit.

Because everything runs off revisions rather than the working tree, you can compare against `origin/*` branches without checking anything out, and any ref git can resolve (a tag, a SHA) works in either selector.

The **Fetch** button next to the selectors runs `git fetch --all --prune`, so branches pushed (or deleted) on any remote since you last fetched show up without leaving the app; **Refresh** re-reads local state only — the branch list, the checked-out branch, and the diff — and never touches the network. Fetch ends by doing everything Refresh does, so one click brings the whole view current.

The one deliberate exception is the **Uncommitted** checkbox next to the ref selectors: when the compare ref is the checked-out branch, ticking it swaps the compare side for the working tree, folding staged, unstaged, and untracked changes into the review. Untracked files are listed via `git ls-files --others --exclude-standard` and patched in with `git diff --no-index` against `/dev/null`, so they read like any other added file. The checkbox is disabled while compare is any other ref — the working tree extends the checked-out branch and no other revision.

## Layout

```
src/
  ipc/git.ts            typed wrappers over the Rust commands
  store/appStore.ts     the repo the list shows, review settings, open tabs
  store/tabStore.ts     one per tab: refs, diff summary, selection, reviews, agent runs
  components/           one folder per component, each with a CSS module
src-tauri/src/
  git.rs                the git layer and its tests
  review.rs             the agent CLI layer (claude, codex): prompt, spawn, parsing
  commands.rs           the Tauri commands
  error.rs              GitError, serialized with a stable `kind` for the frontend
```

The git layer returns plain serializable structs and knows nothing about the UI. That's deliberate: an LLM analysis layer needs the same `DiffSummary` and per-file contents, and `@pierre/diffs` can anchor arbitrary React content to diff lines through its annotation API, so that feature should slot in beside `ipc/` rather than through it.

## Agent review

The third column holds an on-demand review: press **Review** and the whole
comparison — including uncommitted changes when that box is ticked — goes to an
agent, which reports a summary and per-file findings with severities. Clicking
a finding's path jumps the diff surface to that file.

Two engines are supported, picked from the selector above the results:
**Claude Code** (`claude -p`) and **Codex** (`codex exec`, sandboxed
read-only, with the review shape enforced through `--output-schema`). Both are
shelled out to in headless mode, the same way the git layer shells out to
`git`, so each runs on its own subscription through the CLI's existing login —
no API keys. The model field is free text with suggestions (claude aliases like
`opus` and `sonnet`; codex model names from the installed CLI), and the effort
selector maps to `claude --effort` and codex's `model_reasoning_effort` —
their scales differ, which is why the options change with the engine. Leaving
either blank uses whatever the CLI itself is configured to default to, and
each engine remembers its own choices.

The process runs with the repository as its working directory, which lets the
agent's read-only tools check the code around the diff (callers, tests,
definitions) rather than judging the patch in isolation. Nothing runs until
you press the button.

Once a review exists, the button becomes **Re-review**, which follows up on
it in one agent run: every finding from the stored review gets a verdict —
addressed, unaddressed, partial, or obsolete — grounded in the current code,
and the diff is read again for new issues (fixes introduce their own bugs).
The prior findings live on under "Previous findings" with their verdicts and
comment threads, kept apart from the new findings and their fresh threads.

Reviews persist in localStorage, keyed per repo, ref pair, and engine — so
revisiting a comparison shows its old reviews (with a timestamp), and a Codex
review and a Claude review of the same diff sit side by side behind the engine
selector. Each finding carries a comment thread, and there is one for the
review as a whole: replies come from the engine that wrote the review, in
character as the reviewer. Threads are stateless on the CLI side — every reply
request re-sends the finding, its file's diff, and the conversation so far —
so they keep working across app restarts without depending on CLI session
files.

Claude runs are capped at 30 agentic turns. A run that hits the cap has usually
done most of its reading, so instead of failing, the session is resumed once
with its tools taken away (`--resume <id> --tools ""`) and the model asked to
answer from what it has. A review rescued this way is marked as cut short.
When something does fail, the panel leads with a sentence on what went wrong
and keeps the CLI's raw output (the JSON envelope, or the codex or `gh` log)
behind **Show details**, with a copy button for bug reports. The dev harness
acts out each failure with `?fail=review`, `turns`, `explain`, `post`, `list`
or `refresh`.



There is deliberately no file-size limit. [Pierre's write-up on rendering
diffs](https://pierre.computer/writing/on-rendering-diffs) sets the bar at "you
should be able to just render any diff," and the library carries the machinery for
it: virtualization, shadow-DOM pooling, and options held as one shared source of
truth rather than copied per file. Size is the wrong thing to guard.

What is guarded is the axis they call out as still unsolved — long lines are not
virtualized, so minified content is where it hurts. Two limits handle that, both
degrading to plain text rather than refusing to render:

- `tokenizeMaxLineLength` (2,000 characters) for individual long lines
- `tokenizeMaxLength` (100,000 lines) for enormous files

Highlighting deliberately runs on the **main thread**. Moving it into the
library's worker pool is tempting and was tried, but in a worker the renderer uses
Shiki's JavaScript regex engine, which cannot compile every TextMate grammar — SQL
is one it gives up on, rendering the file as plain text while JS/TS look correct,
so the breakage is easy to miss. Requesting the Oniguruma engine there instead
(`preferredHighlighter: "shiki-wasm"`) is worse: its WASM binary doesn't resolve
inside the worker and nothing renders at all. Virtualization is the far larger
performance win and is unaffected either way.

The whole range is fetched as one patch up front; full file contents are read only
when someone expands the context around a hunk.

## Notes

- Binary files appear in the sidebar but not in the diff surface; there is no text
  to render for them.
- Files marked `linguist-generated` in `.gitattributes` get a **GEN** badge and
  start collapsed. So do files ticked as viewed. Selecting a file opens it again.
- The viewed checkbox appears both in the sidebar and in each file's header, and
  persists per repo and ref pair.
- Under the files, the commit list shows the commits the comparison is made of,
  newest first, each marked with the reviews that read it in the verdict's
  colour and glyph, as on the tab. A re-review keeps a stamp of the review it
  replaced, so earlier reviews stay on the list. Reviews from before the head
  commit was recorded, and ones whose commit a rebase rewrote, are placed by
  time instead.
- `j` and `k` move through the file list, which scrolls the surface to that file.
  The viewed checkboxes persist per repo and ref pair.
- Paths are parsed NUL-delimited throughout, so filenames containing spaces or
  newlines survive.
