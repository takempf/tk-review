Rollout checklist. These are the ways changes have broken while they deployed, or when they were rolled back: old pods ran against a new schema, new code ran before its migration finished, clients that never reloaded sent requests the server no longer accepted, queued jobs carried payloads in the old shape, and a rollback brought back code that couldn't read what the new code had written. Tests never see any of this, because they run one version at a time.

First learn how this repository deploys: when migrations run relative to the new code, which services start on the new code before migrations finish (workers and scheduled jobs often don't wait), how long old and new versions run side by side, how clients pick up a new release, and what a rollback reverts. Then answer each question below for the versions that will actually run together.

Old code against new data and schema:
- During a rollout the previous release keeps serving. Anything it reads or writes that this change removes, renames, or tightens breaks it: a dropped column or field, a new `NOT NULL` or required argument, a narrower enum, a changed type.
- A rollback runs an earlier release against everything the new one wrote. New enum values, nulls in fields the old code declares non-null, new status values, and new shapes in JSON columns can all make the old code fail.
- Removals ship in steps: stop writing, stop reading, then remove, each in its own release. Say which step this change is.

New code against old data and schema:
- Code that needs a new table, column, function, queue, or config value fails wherever it starts before that exists. Workers, cron jobs, and other services that don't wait for migrations start early. Ship the schema a release earlier, or make the new code tolerate its absence.
- Rows, cache entries, and stored documents written before this change still have the old shape. The new code reads them, or a backfill runs first.

Clients that don't reload:
- Browser tabs stay open for days on an old bundle, and desktop apps, plugins, and integrations update more slowly still. Every request they send keeps working, or fails in a way they recover from. Removed endpoints, fields, and arguments, and changed persisted-query hashes, all break them.
- When client and server change together, check which deploys first. With persisted queries, the server must know the new operations before any client sends them.
- An old tab that asks for a lazily loaded chunk the deploy deleted fails to load it. Check the client recovers.

Messages in flight:
- Jobs already queued, webhooks being retried, and events in a stream carry payloads in the old shape. The new consumer accepts them, and the old consumer accepts the new shape until every producer is upgraded. Remove a payload field only after the release that stopped sending it has drained.
- Scheduled and long-running jobs can start on one version and finish on another.

Stored client state:
- What the client stored (local storage, IndexedDB, cached query results, saved preferences, bookmarked URLs) outlives the release. New code reads the old format or migrates it, and doesn't crash on a key it doesn't expect.

Feature flags and config:
- A flag that guards the new path defaults to the old behaviour when it can't be read. Removing a flag removes the kill switch, so check the new path has proven itself first.
- New environment variables and secrets exist in every environment before the code that requires them ships.

Events:
- An existing event field keeps its meaning. Add or rename instead, and keep consumers working with both.

Deploy order and recovery:
- When the change needs a particular order (schema, then API, then client), say so, and check that every state in between works.
- If the deploy fails halfway, can it simply be retried, and can it be rolled back without a manual step?

Severity: "critical" for anything that breaks running pods, deployed clients, queued work, or a rollback. "warning" for what breaks only in an unusual order or after a delay. "suggestion" for missing notes on deploy order.
