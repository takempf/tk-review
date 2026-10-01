# tk-review

A desktop app for reviewing code changes the way a pull request reads. Point it at a git repository on your machine, then open one of its GitHub pull requests or compare any two branches, and read the changes file by file. An agent (Claude Code or Codex, through their own CLIs) can review the change or explain it, and you can send what it found back to the PR.

Diffs are rendered with [`@pierre/diffs`](https://diffs.com/), through its `CodeView` surface: every changed file lives in one virtualized scroll region, the way a pull request reads. Git work happens in Rust by shelling out to the system `git` binary, so rename detection, merge-base resolution, and blob reads all behave exactly as git does. Comparing branches works entirely offline. GitHub goes through the `gh` CLI, and the agents through `claude` and `codex`, so each uses the login you already have and there are no API keys to set up.

## Running it

It's built with [Tauri](https://tauri.app/) and used on macOS.

You'll need:

- Node 20.19+ or 22.12+ (what Vite 8 asks for), with [pnpm](https://pnpm.io/installation)
- A Rust toolchain from [rustup](https://rustup.rs/), plus Tauri's [system prerequisites](https://tauri.app/start/prerequisites/) (on macOS, the Xcode Command Line Tools)
- `git` on your PATH

And for the parts that talk to other services, any of these you want to use:

- [`gh`](https://cli.github.com/), logged in with `gh auth login`, to list, open and comment on pull requests
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (`claude`) and/or [Codex](https://github.com/openai/codex) (`codex`), each logged in, for agent reviews and explanations

The UI is built on [tk-design-system](https://github.com/takempf/tk-design-system), which is read from source in a checkout beside this one rather than installed from a registry. Clone both into the same folder:

```bash
git clone https://github.com/takempf/tk-review.git
git clone https://github.com/takempf/tk-design-system.git   # must sit next to tk-review
(cd tk-design-system && npm install)

cd tk-review
pnpm install
pnpm app        # tauri dev: builds the Rust binary and opens the window
```

The first `pnpm app` compiles the whole Rust side, so give it a few minutes. Once the window is up, **Open repository…** picks a local clone. Its GitHub pull requests are listed if `gh` can see them, and **Compare branches** compares any two refs instead. Changes in the design system checkout show up live, since nothing is built in between.

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
cargo test      # including tests that build real repos in a temp dir
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
  github.rs             pull requests through the gh CLI: list, open, refresh, post
  review.rs             the agent CLI layer (claude, codex): prompt, spawn, parsing
  voice.md              how the explanations should sound (see Agent explanation)
  runs.rs               agent runs in flight, so they can be cancelled and timed out
  models.rs             model suggestions, read from each CLI's own cache
  commands.rs           the Tauri commands
  error.rs              GitError, serialized with a stable `kind` for the frontend
```

The git layer returns plain serializable structs and knows nothing about the UI. The agent layer reads the same `DiffSummary` and patch the diff surface does, and what it writes back reaches the diff through `@pierre/diffs`' annotation API (the file notes) rather than through the git layer.

## Pull requests

The home screen lists the open pull requests of the repository's GitHub remote, through `gh`, with a filter that also takes a pasted PR link. Lists load 100 at a time and fetch the next page as you scroll to the end (the dev harness takes `?prs=200` to try it on a long one). Opening one fetches its head and base refs into the local clone and compares them the same way as any two branches (below). Each pull request or comparison opens in a tab of its own, so an agent can work through one while you read another.

The review panel's **PR** tab shows the description and the existing discussion. Findings can be sent to the PR as comments (inline on their lines where GitHub allows it), and a review's conclusion can be submitted as an approval, a request for changes, or a comment (only a comment on your own PR, since GitHub refuses the other two there).

## Agent review

The review panel's **AI review** tab holds an on-demand review: press **Review** and the whole
comparison — including uncommitted changes when that box is ticked — goes to an
agent, which reports a summary and per-file findings with severities. Clicking
a finding's path jumps the diff surface to that file.

Two engines are supported, picked in the agent settings above the results:
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

Reviews persist in localStorage, keyed per repo, ref pair, engine, and the
account `gh` is signed in as (so two GitHub accounts on one computer each see
their own; whatever was stored before that, or with nobody signed in, goes to
the first account to open the repo) — so
revisiting a comparison shows its old reviews (with a timestamp), and a Codex
review and a Claude review of the same diff show together, each finding tagged
with the engine and model that wrote it. Each finding carries a comment thread, and there is one for the
review as a whole: replies come from the engine that wrote the review, in
character as the reviewer. Threads are stateless on the CLI side — every reply
request re-sends the finding, its file's diff, and the conversation so far —
so they keep working across app restarts without depending on CLI session
files.

Claude runs get a turn budget that grows with the diff (30, plus one per two
files, up to 100). A run that hits it has usually
done most of its reading, so instead of failing, the session is resumed once
with its tools taken away (`--resume <id> --tools ""`) and the model asked to
answer from what it has. A review rescued this way is marked as cut short.
While a run goes, the panel shows how long it's been going and when the CLI
last wrote anything, next to a **Cancel** button. A run that writes nothing for
15 minutes, or is still going after an hour, is stopped.
When something does fail, the panel leads with a sentence on what went wrong
and keeps the CLI's raw output (the JSON envelope, or the codex or `gh` log)
behind **Show details**, with a copy button for bug reports. The dev harness
acts out each failure with `?fail=review`, `turns`, `explain`, `post`, `list`
or `refresh`.

## Agent explanation

The **AI explain** tab is the review's counterpart for understanding rather
than judging: press **Explain** and the same agent (same engine, model and
effort settings) writes a walkthrough of the change for someone who hasn't seen
it. It's a run of its own, so an explanation and a review can go at the same
time, and either can fail or be cancelled without touching the other.

It comes back in two parts:

- **The walkthrough**, in the tab: the short version first, then the parts of
  the change in reading order, with short paragraphs, lists, and the odd table.
- **File notes**, at the top of each file in the diff (on the new side of a
  split diff): a sentence or three on what that file's changes are for. Files
  that explain themselves (lockfiles, pure renames, formatting) get none. The
  **Notes** toggle in the diff toolbar hides them; the tab keeps an index of
  them either way.

The prompt's voice lives in `src-tauri/src/voice.md`: how the explanations
should sound, plus a handful of real (cleaned-up) messages to borrow the
register from. Edit it to change the tone without touching the prompt.

One explanation is kept per comparison, whichever engine wrote it, alongside
the reviews in localStorage.

## Rendering

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
- Paths are parsed NUL-delimited throughout, so filenames containing spaces or
  newlines survive.
