Architecture checklist. The question for every fix in this change is whether it is made where the problem starts. A workaround makes a symptom go away and leaves its cause in place: the cause keeps reaching users by every path the workaround doesn't cover, the workaround hides it from the next person who looks, and the next fix tends to be a second workaround on top of the first. Report only what you can tie to a cause you found in the code, with its path.

Find the cause first:
- Work out what the change is fixing, from the lead's brief, the pull request, its ticket, and its commit messages. A change that isn't a fix can still route around a problem in the code it builds on.
- Read upstream from the symptom until you can name the code where the bad value, state, or ordering starts. Without that, you have a suspicion, not a finding.
- Search for the other paths that reach the same cause: other callers, other consumers of the same data, the same pattern elsewhere. A cause that only this path reaches makes a local fix much less of a problem.
- `git log -S` on the workaround's shape, or `git log` on the file, often shows the same symptom patched before. Cite it when it does.

Shapes a workaround takes:
- An error caught and logged, defaulted, retried, or ignored, where something upstream produced it. Ask what produced it.
- A null check, fallback value, or optional chain for a value that should never be missing. Ask why it's missing.
- A delay, `setTimeout`, extra render, debounce, retry, or longer timeout around what is really a race or an ordering bug. It passes until the machine is slower.
- A special case for one input, record, customer, environment, or caller: `if (id === …)`, or a flag that only one caller passes.
- A cast, non-null assertion, `@ts-ignore`, lint suppression, skipped test, or loosened assertion that silences a real mismatch.
- A consumer correcting data its producer gets wrong, a client re-checking what the server should guarantee, or a migration or script repairing rows that the code will keep writing wrong.
- One call site fixed while others share the cause. Name them.
- State copied into a second place and kept in sync by hand, or a cache refetched or a component remounted to cover for invalidation that's missing.
- A dedupe, filter, or sort downstream of whatever produces the duplicates or the disorder.
- A new mechanism beside one the codebase already has for the job, built because the existing one has a bug or a gap.

What a finding says:
- In `failure`: where the cause is, and what still reaches it or what the workaround now hides.
- In `fix`: the change at the cause, concretely enough to act on, not "refactor this". When that is more than this pull request should take on, say so, and ask for the workaround to be marked in the code with why and a link to a ticket for the real fix.
- Anchor it to the workaround's lines.

Leave alone:
- A workaround the pull request already says is one, marked in the code, with the real fix tracked.
- Checks at real boundaries: input from users, the network, storage, or another service, which can always be wrong.
- Guards for states the code can really reach.
- Workarounds for a cause outside this codebase, such as a browser or vendor bug, that say so and link to it.

Severity: a workaround is a "warning" when its cause still reaches users by a path it doesn't cover, or when what it swallows or hides could be a real failure, such as a write that silently didn't happen. One whose cause nothing else reaches, and which hides nothing, is a "suggestion". A design you'd have done differently is not a finding unless you can name what it costs.
