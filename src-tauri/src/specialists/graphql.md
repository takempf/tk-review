GraphQL checklist. These are the ways GraphQL changes have broken production: a removed field broke clients that were still running, a resolver that was fast for one row timed out for a large account, a missed cache update left the screen showing stale data, and an error leaked the database's message. Check each against both sides of the API: the schema and resolvers, and every client operation that uses them.

Clients already deployed:
- Removing or renaming a type, field, argument, input field, or enum value breaks every client still sending the old operation: browser tabs on an older bundle, older desktop or plugin versions, mobile apps, and integrations. Deprecate it, stop using it everywhere, and remove it in a later release.
- Making a field nullable breaks clients that assumed it never is. Making an argument or input field required breaks callers that don't send it. A new enum value breaks clients that switch over the enum exhaustively.
- With persisted or allow-listed operations, the server must know an operation's hash before any client sends it. A changed document or fragment gets a new hash, so the server deploys first. Check that a client meeting an unknown hash recovers rather than failing for good.
- A shared fragment change reaches every operation that spreads it, including mutation inputs and selections. Check them all.
- Changing what an existing field means, its units, or its default breaks clients even when the type stays the same.
- When the schema is generated from the database, a migration changes the API: new columns, foreign keys, indexes, functions, and grants all add or remove fields. Read the committed schema's diff.

Resolver cost:
- A resolver that runs a query per parent row is N+1: a list of 50 parents with three nested lists runs hundreds of queries. Batch them with a data loader, a join, or a lateral query.
- Row-level security policies run for every row a query reads, so a `totalCount` or an aggregate over a large table pays for the policy on every row. Estimate the cost for the largest tenant, not a test account.
- Unbounded lists need a limit, and a default page size the server enforces.
- Expensive fields and deep nesting need a depth or cost limit, or must be impossible to request in bulk.
- Heavy work in a mutation's payload selection runs inside the request's timeout too.
- A browser aborting a request doesn't always cancel the database query behind it.

Pagination:
- Offset pagination skips or repeats rows when rows are inserted or deleted between pages. Use a cursor over a unique, stable ordering, such as a timestamp plus an ID.
- Cursors come back from the client. Validate them, and return a clear error rather than a 500 for one that was tampered with.
- A cursor's ordering needs an index that matches it.

Inputs and errors:
- Use the specific scalar (an ID or UUID type, an enum) rather than a free string. Bound lengths, counts, and ranges.
- Store what you validated: trim and normalize, then check, then save that same value.
- Errors carry a stable code the client can act on. Don't drop `extensions.code` when wrapping an error, and don't return a raw database message in production.
- Tell "not signed in" apart from "not allowed" and from "not found", the way the repository's error types do.
- A mutation that reports success means the change happened. A delete or update that matched no rows shouldn't report `ok`.

Custom resolvers and plugins:
- Every custom query and mutation checks who is calling before doing anything, unless the framework gates them all. Read the repository's convention.
- A resolver that reads through a connection that bypasses access control checks access itself, or passes the client's IDs through the user's own connection first.
- Resolvers and operations use the generated types rather than `any` or broad casts.
- A side effect inside a resolver (an email, a queued job, a call to another service) runs even if the request's transaction rolls back later.

Subscriptions:
- Subscriptions check authorization when they start and stay tied to the session: revoking the session or removing a member ends them.
- Server-side listeners are cleaned up when a socket closes.
- Payloads sent to subscribers pass the same field-level access checks as queries.

Client operations and cache:
- A normalized cache updates itself only when a mutation returns the changed objects with their IDs and the fields the screen shows. Otherwise it needs an explicit cache update or invalidation.
- Creating or deleting an object doesn't add it to or remove it from lists on its own. Check every list that should change.
- Invalidate narrowly, and once per batch rather than once per item. Invalidating a whole root query refetches everything under it.
- Optimistic updates are reconciled with the server's result, errors included.
- Pause a query until its variables exist, rather than sending it with `undefined`.
- Two components subscribing to the same thing open two subscriptions.
- A custom client exchange or link forwards each operation exactly once.
- Every operation has a unique name, which persisted-query tooling and logs rely on.

Generated code:
- Generated schemas, types, and query maps are regenerated, never edited by hand, and their diff shows only what the change meant to add. Anything else is drift from someone's local database.

Severity: "critical" for anything that breaks clients already deployed, exposes data, or can time out the database for large accounts. "warning" for N+1 and cost problems on realistic data, and for cache bugs users will see. "suggestion" for the rest.
