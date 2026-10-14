Billing checklist. These are the ways billing code has lost money or customers' trust: a retry charged twice, a failed operation was never refunded, two requests raced past a balance check, a plan limit was enforced only in the browser, and a charge landed on whichever account the client named. Check each by following the money through success, failure, retry, and cancellation.

Charging and refunding:
- Every paid operation goes through the repository's charging helper, so the charge, the usage record, and the refund on failure stay together. Look for paid work that calls a provider directly.
- Charge for what actually happened, to the account, organization, and resource the server resolved and checked, never to an ID or plan the client sent.
- Every failure path after a charge refunds it exactly once: errors, timeouts, cancellations, content refusals, and partial failures in a batch. A batch that enqueues some items and then fails refunds only what didn't run.
- Retries don't charge again for the same work. Tie the charge to an idempotency key or the job's ID.
- Refunding work whose result was already delivered gives it away. Check the order of "deliver" and "mark failed".
- When the work is deleted or cancelled mid-flight, decide whether it is charged, and make sure retries stop.

Balances, limits, and races:
- Check-then-spend (read the balance, then deduct) lets two concurrent requests both pass. Deduct with a conditional update (`WHERE balance >= cost`), a constraint, or a lock, in one statement.
- Balances, counters, and credits have a database constraint on their range, so a bug can't overdraw or refund past the limit.
- Plan limits, quotas, seat counts, and paid features are enforced on the server. A client-side check, or a feature flag only the client reads, is not a limit.
- An unknown or missing plan fails closed.
- Usage rolled up into totals (per period, per organization) handles the period boundary and late events.
- A trigger or job that updates a shared total serializes every writer behind whoever holds that row.

Payment provider:
- Webhooks verify their signature, tolerate duplicates and events that arrive out of order, and are idempotent.
- The provider is the source of truth for payment state. Local state updates from its webhooks, not from the client's redirect.
- Calls to the provider that can't be undone (charge, cancel, refund) happen in an order that leaves a recoverable state if the next step fails, and best-effort follow-ups run as idempotent jobs.
- Prices, currencies, and amounts come from the server's configuration or the provider, never the client. Money is in integer minor units, never floats.

Attribution and records:
- Usage and billing records keep the user, organization, and resource they belong to, and survive the deletion of those: no cascading deletes on billing history.
- Records say what was actually used: the provider and model that served the request, the units consumed, and the price applied.

Severity: "critical" for anything that charges twice, charges the wrong account, fails to refund, gives paid work away, or lets a limit be bypassed. "warning" for races that take concurrency to hit, and for missing records. "suggestion" for the rest.
