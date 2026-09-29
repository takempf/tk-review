import {
  getSharedHighlighter,
  type HighlighterTypes,
  type SupportedLanguages,
} from "@pierre/diffs";
import { DIFF_THEME } from "../components/DiffSurface/diffsTheme";
import { screenSettling } from "./screenTransition";

/**
 * The regex engine behind syntax highlighting. There is one highlighter, and
 * whichever caller creates it picks the engine, so every caller passes this.
 *
 * Oniguruma, compiled to WASM, rather than Shiki's JavaScript engine: WebKit is
 * slow to compile the JavaScript engine's translations of grammar patterns —
 * 1.1s for TSX's, where Oniguruma takes 0.1s — and Oniguruma is the engine the
 * grammars are written for, so every one of them works (SQL included).
 */
export const HIGHLIGHTER: HighlighterTypes = "shiki-wasm";

/**
 * A little of each language's everyday syntax. Tokenizing it compiles the
 * grammar patterns that real code will hit first; anything rarer compiles on
 * demand, as it always did.
 */
const SAMPLES: [SupportedLanguages, string][] = [
  [
    "tsx",
    `import { useState, type ReactNode } from "react";
import css from "./Panel.module.css";

interface Props { title: string; children?: ReactNode }

/** Doc comment. */
export function Panel({ title, children }: Props) {
  const [open, setOpen] = useState<boolean>(false);
  const label = \`\${title} (\${open ? "open" : "closed"})\`;
  return (
    <section className={css.panel} data-open={open || undefined}>
      <button type="button" onClick={() => setOpen(!open)}>{label}</button>
      {open ? <div>{children}</div> : null}
    </section>
  );
}
`,
  ],
  [
    "typescript",
    `import { invoke } from "@tauri-apps/api/core";

export type Status = "idle" | "loading" | { error: string };

export class Store<T extends object> {
  #items = new Map<string, T>();
  constructor(private readonly key: string) {}

  async load(id: string): Promise<T | undefined> {
    // Line comment.
    const cached = this.#items.get(id);
    if (cached) return cached;
    const value = await invoke<T>("load", { key: this.key, id });
    this.#items.set(id, value);
    return value ?? undefined;
  }
}

export const enum Mode { Split = 1, Unified = 2 }
const pattern = /^(?:[a-z]+)\\/(\\d+)$/i;
`,
  ],
  [
    "css",
    `@import "tokens.css";

:root { --gap: 0.5rem; }

.panel > .title:hover,
[data-open] {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  color: color-mix(in oklab, var(--accent) 16%, #1a1a1a);
  transition: opacity 120ms cubic-bezier(0.16, 1, 0.3, 1);
}

@media (prefers-reduced-motion: reduce) {
  .panel { animation: none !important; }
}
`,
  ],
  [
    "json",
    `{ "name": "app", "version": "1.0.0", "private": true, "scripts": { "dev": "vite" }, "list": [1, 2.5, null, false] }
`,
  ],
  [
    "rust",
    `use std::collections::HashMap;

#[derive(Debug, Clone, serde::Serialize)]
pub struct Branch<'a> { name: &'a str, head: bool }

impl<'a> Branch<'a> {
    /// Doc comment.
    pub fn parse(line: &'a str) -> Result<Self, String> {
        let head = line.starts_with('*');
        match line.split_whitespace().nth(1) {
            Some(name) => Ok(Self { name, head }),
            None => Err(format!("bad line: {line}")),
        }
    }
}

fn count(items: &[u32]) -> HashMap<u32, usize> {
    let mut map = HashMap::new();
    for item in items { *map.entry(*item).or_insert(0) += 1; }
    map
}
`,
  ],
  [
    "markdown",
    `# Title

Some **bold**, _italic_, \`code\` and a [link](https://example.com).

- item
  1. nested

\`\`\`ts
const x = 1;
\`\`\`
`,
  ],
  [
    "python",
    `from dataclasses import dataclass

@dataclass
class Review:
    """Docstring."""
    title: str
    findings: list[str]

    def summary(self, limit: int = 3) -> str:
        # Comment.
        return f"{self.title}: {', '.join(self.findings[:limit])}"
`,
  ],
  [
    "sql",
    `CREATE TABLE reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_id uuid NOT NULL REFERENCES repos (id),
  created_at timestamptz NOT NULL DEFAULT now()
);
SELECT r.id, count(*) AS n FROM reviews r WHERE r.created_at > now() - interval '1 day' GROUP BY r.id;
`,
  ],
  [
    "yaml",
    `name: ci
on: { push: { branches: [main] } }
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: pnpm test # comment
`,
  ],
  [
    "shellscript",
    `#!/usr/bin/env bash
set -euo pipefail
for file in "$@"; do
  if [[ -f "$file" ]]; then echo "ok: \${file##*/}"; fi
done
`,
  ],
];

/** Runs `task` when the main thread has nothing better to do. */
function whenIdle(task: () => void) {
  if ("requestIdleCallback" in window) requestIdleCallback(task, { timeout: 2000 });
  else setTimeout(task, 100);
}

let started = false;

/**
 * The highlighter compiles a language's patterns the first time it tokenizes
 * it, and keeps them for the session: a few hundred ms of main thread for a
 * typical TS/CSS PR, paid the moment its diff first renders — just as the
 * review screen lands.
 *
 * This pays it early instead, while the pull-request list is up: one language
 * per idle moment (none takes much over 100ms), never during a screen change.
 * Best effort throughout.
 */
export function warmHighlighter() {
  if (started) return;
  started = true;

  const queue = [...SAMPLES];
  const next = () =>
    whenIdle(async () => {
      const settling = screenSettling();
      if (settling) {
        await settling;
        next();
        return;
      }
      const item = queue.shift();
      if (!item) return;
      const [lang, code] = item;
      try {
        const highlighter = await getSharedHighlighter({
          themes: [DIFF_THEME.light, DIFF_THEME.dark],
          langs: [lang],
          preferredHighlighter: HIGHLIGHTER,
        });
        highlighter.codeToTokens(code, { lang, theme: DIFF_THEME.dark });
      } catch {
        // A language that fails here fails the same way in the diff, later.
      }
      next();
    });
  next();
}
