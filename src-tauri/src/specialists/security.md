Security checklist. These are the ways changes have opened holes that tests didn't catch: an entry point that forgot to check who was calling, a read keyed on an ID the client chose, a privileged connection used where the user's own belonged, and data that reached a log, a browser, or another tenant. Check each by tracing the code from the request to the data, not by trusting names.

Authentication and authorization:
- Every new entry point checks that the caller is signed in before doing anything else: queries, mutations, routes, webhooks, subscriptions, job triggers, and functions exposed through a generated API. Where the framework has no global gate, each handler carries its own, and one missed check is the hole.
- Being signed in isn't being allowed. Check that the caller may act on this particular record, in this organization, with this role. Write paths need the edit-level check, not the read-level one.
- Anonymous or shared-link access often runs as the same database role as a signed-in user. A guard or policy must not assume someone is logged in because the role says "authenticated".
- A permission helper that can return null makes `if (!allowed)` and SQL's `IF NOT allowed` skip the guard. Coalesce it to false.
- A feature flag or plan check that lives only in the client is a suggestion, not a control. Paid, admin, and unreleased behaviour needs the same check on the server.

Trusting the client:
- Find every ID, path, URL, header, role, plan, price, status, or owner the request supplies, and ask what happens when it names something the caller doesn't own. Organization and tenant IDs from headers or arguments are checked against membership, not used as they come.
- A connection, client, or function that bypasses the database's own access control (an admin or owner pool, a service-role key, a `SECURITY DEFINER` function) must never act on what the client sent without an explicit check first. That is how one tenant reads another's data.
- Values the server should decide (status, owner, price, timestamps, storage paths) are set by the server, never copied from input.
- Inputs need bounds: lengths, counts, ranges, and the right scalar type (a UUID, not any string). Cursors and tokens the client hands back can be tampered with; validate them rather than letting them raise a 500.

Injection and unsafe content:
- SQL built by concatenation or template strings instead of parameters. `LIKE` patterns need their wildcards escaped.
- HTML from users or models rendered through `dangerouslySetInnerHTML`, `innerHTML`, `v-html`, or a Markdown renderer without sanitizing. Uploaded SVG is HTML in disguise and needs sanitizing on the server.
- Links built from input need their scheme checked: `javascript:` in an `href` runs code.
- Server-side fetches of URLs the client supplies (image import, webhooks, link previews) need SSRF protection: allowed schemes, no private, loopback, or link-local addresses, the check applied after DNS resolution and after every redirect, and limits on size and time.
- Shell commands, file paths, and regular expressions built from input: command injection, path traversal (`../`), and patterns that backtrack catastrophically.
- Text from users or documents passed to a model can carry instructions. A model that can call tools or mutations must be limited to what the user could do, not what the service can.

Secrets and personal data:
- No secrets, tokens, or keys in code, fixtures, logs, error messages, or client bundles. Environment variables read by browser code are public.
- Logs and error reports don't carry request bodies, prompts, tokens, `Authorization` headers (HTTP client errors often include the request's config), or personal data. Use the repository's redaction helpers.
- Error responses in production don't carry raw database or internal messages, stack traces, or query text.
- A new field on a user, account, or organization record may be readable by everyone who can read the record. Check what the API exposes, column by column.
- Personal data sent to a third party (analytics, a model provider, an email service) needs a reason, and the least data that serves it.

Sessions and transport:
- Revoking a session, logging out, or removing a member also ends what that session already holds open: subscriptions, websockets, streams, and cached permissions.
- Cookies that carry auth are `HttpOnly`, `Secure`, and `SameSite`. State-changing endpoints a cross-site request can reach need CSRF protection.
- CORS never reflects an arbitrary origin with credentials allowed.
- Redirects to a URL taken from the request are checked against an allow list.
- Webhooks verify the sender's signature before trusting the body, and tolerate replays.

Public and machine APIs:
- API keys are stored hashed, scoped, checked for expiry and revocation on every use, and rate-limited. A scope guard denies by default when a route declares no scope.
- An API that skips the database's access control scopes every query to the key's tenant in code. Check each `WHERE`.

Severity: "critical" for anything that lets a caller read or change data they shouldn't, run code, or reach internal systems, and for a leaked secret. "warning" for a missing defence with another layer behind it, or a leak of internals that aren't sensitive. "suggestion" for hardening.
