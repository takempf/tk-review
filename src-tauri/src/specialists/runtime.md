Backend runtime checklist. These are the ways server code has failed in production after passing its tests: a pool ran dry because connections sat waiting on slow work, a side effect happened for a transaction that rolled back, a retry charged twice, a timeout stopped the caller but not the work, and a worker ran out of memory. Check each by reading what the changed code holds, and for how long.

Connections and transactions:
- Don't hold a database connection or an open transaction across slow work: network calls, other services, model inference, storage uploads and downloads, image processing, or waiting on a queue. Check out, run a fast query, release, then do the slow work. A transaction left idle holds its locks too, and has blocked migrations and other writers for hours.
- Request-scoped transactions count. A framework that wraps each request in a transaction holds it for as long as the handler awaits anything.
- Count the connections a code path can hold at once against the pool's size, under concurrency. A handler that takes a second connection while it holds the first deadlocks the pool once every slot holds a first one.
- Long-running reads and writes set their own `statement_timeout` (`SET LOCAL` inside the transaction), and so do jobs that run outside a request's timeout.
- A helper that wraps work in a savepoint or transaction rolls back what it should on error, and the outer transaction doesn't commit a half-done write when a later step fails.

Side effects and transaction boundaries:
- Emails, payments, webhooks, queue jobs, cache writes, and storage deletes inside a transaction still happen when it rolls back, or happen before the data they describe is committed. Enqueue jobs in the same transaction when the queue lives in the database, or after the commit, and make the consumer tolerate a row that isn't there yet.
- An outside action that can't be undone (a charge, a cancellation, a sent email) followed by a database write that can fail leaves the two out of step. Order them so a failure is recoverable, and make the retry idempotent.
- A job marked done before its result is stored, or a row written before its job is enqueued, shows up as stuck or lost when the second step fails.

Retries and idempotency:
- Every retried operation (jobs, webhooks, client retries, at-least-once queues) runs again with the same input. Check it can't charge, send, insert, or refund twice: idempotency keys, unique constraints, or a check-and-set in one statement.
- Don't retry what can't succeed: validation errors, content-policy refusals, 4xx responses, and work whose target was deleted. Mark them non-retryable.
- A deterministic job ID dedupes, but re-adding a failed job under the same ID can return the old failure instead of running again.
- Check-then-act sequences (read a count, then increment; read a status, then update) race between two requests or replicas. Use a conditional update, a constraint, or a lock.
- With several replicas, a stale worker can overwrite newer state. Writes conditioned on a version or timestamp prevent it.
- Notifications that fan out to every instance (`LISTEN`/`NOTIFY`, pub/sub) run their handler once per instance. Work that must happen once needs a lock or a job.

Timeouts and cancellation:
- Every outside call has a timeout, and the timeouts nest: a queue's job timeout covers the provider's, which covers each attempt of a retry loop. Put one deadline around the whole retry loop, not one per attempt.
- Aborting the caller doesn't always stop the work: an `AbortSignal` the library ignores, a promise that keeps running after it lost a race with a timer, an HTTP client whose own default timeout is minutes long, or a provider that keeps billing. A timeout should release a slot, a semaphore, or a connection only once the work has stopped.
- Uploads and streams need deadlines too.

Outside services:
- Check the status before using a body, and validate its shape. Some providers report errors with a 200.
- Unknown values from a provider or a config (an unknown plan, model, or status) fail closed.
- Fallback paths honour the same switches as the main path: kill switches, provider weights, outage flags, and rate limits.
- Record which provider or model actually served the request, not the one asked first.

Memory and resources:
- Don't buffer a whole upload, image, or response before checking its size. Stream it, or check `Content-Length` and cap the read.
- Image and video processing allocates per pixel. Check the largest input the code accepts, and how many can run at once.
- Every file, handle, listener, interval, subscription, and child process that is opened is closed on every path, errors included.
- Check whether the process logs or exits on an unhandled rejection, or an error thrown in an event handler or timer, and that the changed code doesn't rely on the other.
- Storage objects the code creates are registered with whatever cleans storage up, and that cleanup knows every place that references them, or it deletes files still in use.

Severity: "critical" for anything that can exhaust a pool, crash or hang a service, lose or duplicate money or data, or run unbounded. "warning" for what will bite under load, on a retry, or during a provider's outage. "suggestion" for the rest.
