Maintainability checklist. These are what code reviewers most often ask authors to fix because they cost the next person who touches the code: a second copy of something that already existed, a comment that says too much or says something false, an abstraction nobody needed yet, a name that no longer matches what the code does, and a test that would still pass with the bug back. Report only what you can tie to a concrete cost, with the evidence, such as the path of the helper that already exists.

One source of truth:
- Before accepting a new helper, constant, type, regex, union, or component, search for one that already does the job. A second copy drifts from the first. Name the existing one's path.
- Values derived from one list (keys, options, labels, validation) are generated from it, not listed again by hand beside it.
- Types for data that crosses a boundary (client and server, producer and consumer) live in one place.

Comments:
- Comments say why, not what. A comment that restates the next line, narrates the change ("now we also…"), addresses the reviewer, or records ticket history belongs in the PR description, not the code.
- Long explanatory blocks, often written by an AI assistant, bury the one sentence that matters. Ask for that sentence.
- A comment that no longer matches the code is worse than none. Check that comments near changed lines still describe them.
- Keep comments that explain a surprising constraint, a workaround, or why the obvious approach doesn't work.

Simplicity:
- Abstractions with one caller, options nobody passes, parameters that always get the same value, and extension points for a future that may not come. Suggest the simpler form.
- Dead code: unused exports, props, and branches, paths behind a flag that no longer exists, and files nothing imports.
- Re-exports and barrel files that widen what a module exposes beyond what is used.

Names:
- A name that no longer matches what the code does after this change: a function that now does more, a boolean whose sense flipped, a variable that now holds something else.
- Booleans read as positive questions (`isVisible`, not `isNotHidden`).
- Units in names where they're ambiguous (`timeoutMs`, `sizeBytes`).
- Names that repeat their context (`user.userName`), or that shadow another name in scope.
- The domain's vocabulary, used consistently: check what the rest of the codebase calls the same thing.

Structure and boundaries:
- Code lives where the repository puts that kind of code. Check its instructions and the neighbouring files.
- Imports that cross a boundary the repository draws (shared code importing a feature, client code importing server code), and import cycles.
- A function doing several unrelated jobs, or a file mixing unrelated concerns, when this change made it so.
- Logic inside a framework callback (a resolver, a component, a handler) that would be easier to test as a plain function.

Types:
- Casts (`as`, `any`, non-null assertions) that hide a real mismatch rather than state something the compiler can't know. Data parsed from outside (JSON, storage, the network) is validated, not cast.
- Several optional positional arguments of the same type are easy to swap. Use an options object.

Tests:
- Would the test fail if the fix it accompanies were reverted? If not, it doesn't pin the fix.
- Fixtures that are null, empty, or identical to the default, so the assertion passes trivially.
- Mocks that replace the code under test, or wrap a callback that never runs.
- A suite that collects zero tests, or skips itself, because of an import-time error or a missing environment variable.
- Tests that depend on real time or the environment without fake timers or stubs.
- Tests the repository's CI never runs. Say so, and ask how the author checked instead.

Scope:
- Unrelated changes (refactors, formatting, renames elsewhere) mixed into a behaviour change make both harder to review and to revert. Suggest splitting them when they are substantial.

Severity: report only what you'd rate "warning": duplication that will drift (name the copy that already exists), names or comments that mislead, tests that can't fail, and boundaries this change breaks. Leave out simplifications, cleanups, and small naming or comment fixes unless this repository's rules for you ask for them: a review reports only a few suggestions, and yours would crowd out the ones that matter. Leave out what a formatter or linter catches, and taste you can't tie to a cost.
