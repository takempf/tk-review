Migration checklist. These are the ways migrations have actually failed in production: the statement was instant on a developer's database and blocked a busy table for minutes in production, or it worked on its own and broke the code still running beside it. Tests rarely catch any of them, so check each one by reading.

First learn how this repository runs migrations. Find the runner and its configuration, and the repository's migration rules, and answer:
- Does each file run in its own transaction?
- Are `lock_timeout` and `statement_timeout` set for migrations, and where?
- Do migrations finish before every process on the new code starts, including workers and scheduled jobs?
- Is there a schema dump (such as `schema.sql`) that shows each table's triggers, policies, and grants?
Use the answers throughout, and when the repository's rules are stricter than this checklist, hold the migration to them.

Locks on existing tables. This is where most of the damage comes from:
- Name the lock each statement on an existing table takes. Most `ALTER TABLE` forms, `DROP`/`CREATE TRIGGER`, dropping columns or tables, and adding a constraint without `NOT VALID` take an exclusive lock.
- A statement waiting for that lock blocks every query that arrives after it. An `ALTER` that takes milliseconds can stall all traffic on the table for as long as the slowest query or idle transaction already holding it. Any strong lock on a table that serves traffic needs a `SET LOCAL lock_timeout` of a few seconds, so the migration fails fast instead, unless the runner already sets one.
- Adding a `CHECK`, `FOREIGN KEY`, or `UNIQUE` constraint to an existing table scans it under that lock. Add it `NOT VALID`, and `VALIDATE CONSTRAINT` in a separate migration. When the runner wraps each file in one transaction, validating in the same file holds the lock through the scan anyway.
- A constraint written inline in `ADD COLUMN` (`ADD COLUMN x int CHECK (...)` or `REFERENCES ...`) forces the same scan, and linters tend to miss it.
- Dropping and re-adding a `CHECK` to change its allowed values rescans the table every time.
- `SET NOT NULL` on an existing column scans the table under the lock. Validate a `NOT VALID` `CHECK (col IS NOT NULL)` first, in its own migration.
- Changing a column's type, or adding one with a volatile default, rewrites the whole table.
- To change only what a trigger does, `CREATE OR REPLACE FUNCTION` on its function rather than dropping and re-creating the trigger.
- Each migration should touch as few busy tables as possible. A transaction that locks several of them can deadlock against application transactions that lock them in a different order.

Data changes inside the migration:
- For every `UPDATE`, `DELETE`, or `INSERT ... SELECT`, ask how many rows it touches in production. It holds its row locks until the migration's transaction ends, so a large one belongs in a batched backfill outside the deploy.
- Adding a column, backfilling it, and setting it `NOT NULL` in one file holds the strongest of those locks for the whole backfill.
- Row triggers fire for a migration's writes exactly as for a user's: `updated_at` columns, timestamps that propagate to parent rows, notifications, audit rows, storage reference tracking. List the triggers on every table the migration writes to, and say for each whether it should fire. An `UPDATE` with no `WHERE` that skips rows already in their target state rewrites, and re-triggers, every row.
- Functions that read the current user from the session get nothing inside a migration. A trigger that stamps "last edited by" will write a null, or fail.

Indexes:
- An index on an existing table that serves traffic needs `CREATE INDEX CONCURRENTLY`, which cannot run inside a transaction. Follow the repository's convention for that, typically a file holding only that statement.
- A concurrent build that fails leaves an invalid index behind, which every write still maintains and no query uses. `IF NOT EXISTS` then skips it on a retry, so it stays broken. A migration that retries a build should `DROP INDEX CONCURRENTLY IF EXISTS` first.
- A concurrent build waits for every transaction older than it to finish, so long transactions, or other migration runners left waiting on a lock, can stall it for as long as they last.
- A B-tree index on unbounded user text (names, prompts, paths, URLs) fails once any row's value is larger than about 2.7 kB. Index an expression such as `left(col, 256)` or a hash, or bound the column first.
- Every new foreign key column needs an index that leads with it. Otherwise each `ON DELETE CASCADE` or `SET NULL` scans the child table once per deleted parent row, and deleting one large parent can run for many minutes.
- On a table with tens of millions of rows, say how long the build is likely to take, and whether it needs a maintenance window.

Code running against the new schema. During a deploy, the code from the previous release keeps running against the new schema, and any process that starts early runs the new code against the old one:
- Dropping or renaming a column, table, function, or enum value that the previous release uses breaks it mid-rollout. Remove every use first, and drop it in a later release. A rename is an add, a backfill, a switch, and then a drop.
- Tightening breaks old code that still writes the old way too: a new `NOT NULL` or `CHECK`, a column made `GENERATED ALWAYS`, a revoked grant.
- Code in this same change that needs the new schema fails wherever it starts before the migration has finished, or after it has failed. Check whether workers and scheduled jobs wait for migrations.
- Rolling back a release reverts the code but not the migration. Check that the previous release still works against this schema.
- A migration only runs where it hasn't run yet. An edit to one that already ran on any database is silently skipped there.

Deletes and data that must survive:
- For every `REFERENCES`, ask what should happen to the row when its parent is deleted. `ON DELETE CASCADE` or `SET NULL` on audit logs, billing or usage records, ledgers, and analytics erases the history those tables exist to keep. Prefer a plain indexed column, or `NO ACTION` with a soft delete.

Security, when the database enforces it:
- Every new table enables row-level security when the repository uses it, with a policy for each command it allows. Each policy's `FOR` clause should match its name.
- Write policies need `WITH CHECK` and the edit-level permission check, not the read-level one.
- A policy that adds a condition every row must meet must be `AS RESTRICTIVE`. Permissive policies are combined with `OR`, so a permissive "condition" grants access instead of limiting it.
- No `USING (true)` on tables that hold personal data.
- Grants are table-wide. On a table with a broad `SELECT` grant, every new column is readable by everyone that grant covers.
- A `SECURITY DEFINER` function needs all of these:
  - a caller check derived from the session's user, never from a user-id argument
  - `SET search_path`
  - `REVOKE EXECUTE ... FROM PUBLIC` when only the system should call it
  - boolean permission helpers wrapped in `COALESCE(..., false)`, because a null makes an `IF NOT ...` guard skip
- A policy that calls a function for each row costs that function times the rows. Estimate it for the largest tenant.
- Counters, balances, and ledgers need a `CHECK` on their range, so a bad write can't refund or overdraw.
- Casts and parameter types must match the real column types. For example, a `text` id column may hold values that aren't UUIDs.

An API generated from the schema (PostGraphile, PostgREST, Hasura):
- Every new table, column, function, and foreign key becomes API. Functions meant only for the system need the tool's hide marker, such as PostGraphile's `@omit` smart comment, or must live in a schema it doesn't expose.
- Adding or dropping a foreign key adds or removes relation fields.
- When the generated schema is committed, its diff should show only the API you meant to add.
- Postgres can't drop an enum value, so add only values that are used.

History:
- Never edit, rename, or delete a migration that may already have run anywhere: production, staging, or a preview environment. An edit is skipped where it already ran, a rename runs it twice, and a deletion leaves databases with schema the repository no longer knows about. Undo with a new migration, and that goes for revert PRs too.
- Check that a new migration sorts after everything it depends on under the runner's ordering, and doesn't repeat DDL that another migration already has, which a bad rebase can leave behind.
- A committed schema dump should change only by what the migration does. Anything else is drift from someone's local database.

Recovery:
- If it fails halfway in production, can it simply be run again?
- Does it include the undo SQL, or rollback note, the repository asks for?
- If it needs a maintenance window, say so in a finding of its own, so whoever ships the release knows before it reaches main.

Severity: "critical" for anything that can hold a strong lock on a busy table without a timeout, lose or corrupt data, break code that is running, or open a security hole. "warning" for what will probably bite under production load or a later change. "suggestion" for the rest.
