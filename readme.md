# tk-review

A macOS app for reading code changes the way a pull request reads. Open a local git repository, pick one of its GitHub pull requests (or any two refs), and read every changed file in one scrolling view. Claude Code or Codex can review or explain the change, and you can send their findings back to the PR.

There are no API keys. Git work shells out to the system `git`, GitHub goes through `gh`, and the agents through `claude` and `codex`, so each uses the login you already have. Comparing branches works offline.

## Running it

You'll need:

- Node 20.19+ or 22.12+, with [pnpm](https://pnpm.io/installation)
- Rust from [rustup](https://rustup.rs/), plus Tauri's [prerequisites](https://tauri.app/start/prerequisites/) (on macOS, the Xcode Command Line Tools)
- CMake and Ninja (`brew install cmake ninja`), to build CEF's C++ wrapper
- `git` on your PATH
- Optionally, [`gh`](https://cli.github.com/) for pull requests, and [Claude Code](https://docs.anthropic.com/en/docs/claude-code) or [Codex](https://github.com/openai/codex) for agent reviews, each logged in

The UI is built on [tk-design-system](https://github.com/takempf/tk-design-system), read from source in a checkout beside this one:

```bash
git clone https://github.com/takempf/tk-review.git
git clone https://github.com/takempf/tk-design-system.git   # must sit next to tk-review
(cd tk-design-system && npm install)

cd tk-review
pnpm install
pnpm app        # builds the Rust side and opens the window
```

The first `pnpm app` downloads CEF (about 1 GB, into `~/Library/Caches/tauri-cef`) and compiles the whole Rust side, so give it a few minutes. The app runs on [Tauri 3's Chromium runtime](https://v3.tauri.app/develop/cef/), not the system's WebKit. Design system edits show up live.

## Development

```bash
pnpm harness    # the real UI in a browser, against fixture data (dev-harness/)
pnpm test:ui    # Playwright tests against the harness, in Chromium and WebKit
pnpm typecheck
pnpm check      # biome lint and format, with fixes
```

From `src-tauri/`: `cargo test` (some tests build real repos in a temp dir), `cargo clippy --all-targets`, and `cargo fmt`. If `cargo` is missing after a Homebrew rustup install, its shims aren't on your PATH: `fish_add_path -U /opt/homebrew/opt/rustup/bin`.

The harness stubs the Rust side with Tauri's `mockIPC`, so UI work doesn't need a native rebuild. Query parameters act out edge cases: `?prs=200` for a long PR list, and `?fail=review` (or `turns`, `explain`, `post`, `list`, `refresh`) for each failure.

## Comparisons

A comparison shows what the compare ref added since it left the base, as a PR does. The merge base is resolved explicitly rather than with `base...compare`, so the diff and any file contents read later come from the same commit. Any ref git can resolve works (`origin/*`, a tag, a SHA) without checking anything out.

- **Fetch** runs `git fetch --all --prune`, then does what Refresh does.
- **Refresh** re-reads the branch list, the checked-out branch, and the diff, without touching the network.
- **Uncommitted** swaps the compare side for the working tree (staged, unstaged, and untracked files) when compare is the checked-out branch.

## Pull requests

The home screen lists the repository's open PRs through `gh`, 100 at a time as you scroll, and the filter takes a pasted PR link. Opening one fetches its head and base and compares them like any two refs. If GitHub's `pull/N/head` lags behind a force-push, the head GitHub reports is fetched by name instead.

Each PR or comparison opens in its own tab, and tabs stay open until you close them, so an agent can work in one while you read another. The **PR** tab shows the description and discussion. Findings can be posted as comments (inline where GitHub allows it), and a review's conclusion as an approval, a request for changes, or a comment. On your own PR, GitHub only allows a comment.

## Agent review

**AI review** sends the whole comparison to an agent, which returns a summary and findings with severities. Pick the engine, model, and effort above the results. Each engine remembers its own, and a blank field uses the CLI's default.

| Engine | Runs as | Sandbox |
| --- | --- | --- |
| Claude Code | `claude -p --restricted`, answer pinned by `--json-schema` | reads files, plus `git log`/`show`/`blame`, read-only `gh`, and Linear and Slack reads if connected; anything that writes is denied |
| Codex | `codex exec`, answer pinned by `--output-schema` | its read-only sandbox, with no network |

Both run in the repository, so the agent can read callers and tests rather than judge the patch alone. A restricted Claude run skips the repository's `CLAUDE.md` and your `~/.claude/settings.json`, so the app puts `CLAUDE.md` (or `AGENTS.md`) in the prompt and fills a blank model or effort from your settings.

### Specialists

Parts of a diff also go to specialists, each owning one way changes fail in production. A specialist picks files by where they live and what their changed lines mention, and carries a checklist in [`specialists/`](src-tauri/src/specialists):

| Specialist | Picks |
| --- | --- |
| Migrations | files under `migrations`, `migration`, or `migrate`, and schema dumps |
| Security | source code outside tests and migrations |
| Backend runtime | server code using transactions, pools, queues, retries, timeouts, storage, or outside services |
| GraphQL | schemas, documents, resolvers, and GraphQL client code |
| Rollout | contracts between things that deploy apart: migrations, API schemas, job payloads, stored client state, routes |
| Frontend platform | markup, styles, components, bundler or browser config, browser APIs |
| React | `.tsx`/`.jsx`, hooks, React state libraries |
| Graphics | shaders, three.js, react-three-fiber, WebGL, textures, canvases |
| Billing | billing, payments, credits, refunds, quotas, usage |
| Analytics | analytics and tracking events |
| Maintainability | source code and tests |

Files marked `linguist-generated` are left out, except a generated GraphQL schema. A Claude review gets each specialist that picked something as a read-only subagent, carrying its checklist, the repository's rules for it, and its files' diffs (up to 192 KB, then paths to read). The lead reviewer launches them all at once, reviews the whole diff itself, checks what they report, and merges what holds. Each finding names who raised it ("Lead · Migrations"), and a run that skips a specialist is resumed once to launch it. Codex gets the checklists in its prompt instead.

### Rules

**Rules** holds one set of rules per reviewer for the repository: the lead's go into every review, and each specialist's only to that specialist. They're for what's specific to one codebase (which tables are large, which triggers fire), so they're kept on this computer in `~/Library/Application Support/com.tkempf.tk-review/repo-rules.json`, keyed by GitHub repository so every clone shares them.

### Re-review, threads, and storage

**Re-review** gives every earlier finding a verdict (addressed, unaddressed, partial, or obsolete) against the current code, and reads the diff again for new problems. Each finding has a comment thread, and so does the review. Replies come from the engine that wrote the review, and each reply re-sends the finding, its file's diff, and the thread, so threads survive restarts without CLI session files.

Reviews are kept in localStorage per repository, ref pair, engine, and `gh` account. Revisiting a comparison shows its earlier reviews, and Claude and Codex reviews of the same diff show side by side.

### Limits

- Claude runs get 60 turns plus one per two files, up to 150. A run that runs out is resumed once without tools (`--resume <id> --tools ""`) to answer from what it read, and the review is marked as cut short.
- A run that writes nothing for 15 minutes, or is still going after an hour, is stopped. **Cancel** stops one sooner.
- A failure leads with one sentence on what went wrong, and keeps the CLI's raw output behind **Show details**.

## Agent explanation

**AI explain** writes a walkthrough of the change for someone who hasn't seen it, using the same engine settings. It runs apart from the review, so both can go at once. It returns the walkthrough, in the tab, and a short note at the top of each file that needs one, which the **Notes** toggle hides. The voice lives in `src-tauri/src/voice.md`, so the tone can change without touching the prompt. One explanation is kept per comparison.

## Rendering

Diffs render through [`@pierre/diffs`](https://diffs.com/)' `CodeView`, with every file in one virtualized scroll region. There is no file-size limit, following [Pierre's take](https://pierre.computer/writing/on-rendering-diffs) that you should be able to render any diff. Long lines are the part virtualization doesn't cover, so highlighting falls back to plain text past 2,000 characters on a line or 100,000 lines in a file.

Highlighting stays on the main thread. In the library's worker pool, Shiki's JavaScript regex engine can't compile every grammar (SQL renders as plain text), and the WASM engine doesn't load in the worker at all.

The whole comparison is fetched as one patch, and full file contents are read only when you expand context around a hunk.

## Layout

```
src/
  ipc/git.ts            typed wrappers over the Rust commands
  store/appStore.ts     the repo the list shows, review settings, open tabs
  store/tabStore.ts     one per tab: refs, diff summary, selection, reviews, agent runs
  components/           one folder per component, each with a CSS module
src-tauri/src/
  git.rs                the git layer and its tests
  github.rs             pull requests through gh: list, open, refresh, post
  review.rs             the agent CLIs: prompts, runs, parsing
  specialists.rs        the specialist reviewers: what each picks and is told
  specialists/          each specialist's checklist
  rules.rs              the rules kept per repository
  voice.md              how explanations should sound
  runs.rs               runs in flight, so they can be cancelled and timed out
  models.rs             model suggestions, read from each CLI's cache
  commands.rs           the Tauri commands
  error.rs              GitError, with a stable `kind` for the frontend
```

## Notes

- Binary files are listed in the sidebar but not drawn in the diff.
- Generated files get a **GEN** badge and start collapsed, as do files marked viewed. Viewed state is kept per repository and ref pair.
- The commit list under the files marks each commit with the reviews that read it, in the verdict's colour.
- `j` and `k` move through the file list.
- Paths are read NUL-delimited, so filenames with spaces or newlines survive.
