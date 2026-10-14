Analytics checklist. These are the ways tracking changes have corrupted data without breaking anything users see: an event fired twice, or not at all on one path, a field changed meaning under an existing dashboard, client and server disagreed about an event's shape, and personal data ended up in an analytics store. Check each against the event's definition and everyone who consumes it.

Definitions and registry:
- A new event is declared where the repository declares events (a schema, a registry, a union type) and documented where it documents them, so it validates and people can find it.
- Client and server agree on the event's name and shape. A schema or type shared between them is updated on both sides.
- Validating an event never throws in a way that breaks the user's action.

Meaning:
- Never change what an existing event or field means, its units, or when it fires. Dashboards and queries built on it will silently mix the two meanings. Add a new field or event instead, and deprecate the old one.
- Rename fields before an event first ships, not after.
- New fields are optional or have defaults, so older clients and stored events still validate.
- Keep what was known when the action started (inputs, options) apart from what was learned after it (results, costs, errors), the way the repository's event model does.

Firing:
- Each user action fires its event exactly once: not on every render or retry, not twice because two code paths both emit it, and not zero times on paths that skip the emitter (errors, cancellations, keyboard shortcuts, bulk actions).
- Server-side events for jobs fire once per job, not once per attempt, unless attempts are what the event measures.
- Attribution fields (user, organization, session, the object acted on) are filled in on every path, including background work that runs outside a request.

Privacy:
- No personal data, prompts, file contents, or secrets in event properties beyond what the repository allows. Send lengths, counts, and IDs instead.
- Consent and opt-out settings are respected where the repository has them.

Volume:
- High-frequency events (per frame, per keystroke, per pointer move) are sampled, batched, or debounced.

Severity: "critical" for personal data sent to analytics, and for changes that corrupt an existing event's meaning. "warning" for events that fire twice or never on a real path, and for client and server out of step. "suggestion" for missing documentation and smaller gaps.
