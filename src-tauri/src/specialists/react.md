React checklist. These are the ways React code has broken for users while its tests passed: a value rebuilt on every render sent an effect into a loop that froze the tab, a component subscribed to far more state than it used and re-rendered on every change, an effect with no cleanup piled up subscriptions, and an async callback that finished after its component unmounted acted twice. Check each by asking what happens on the second render, on unmount, and on remount.

Render loops and identity:
- Objects, arrays, and functions created during render are new every render. As an effect's or memo's dependency, or as a prop a child depends on, they re-run the effect every render, and an effect that sets state then loops ("Maximum update depth exceeded"). Fallbacks like `items ?? []` and spreads like `{ ...props }` create new identities too.
- A hook that returns a new object or function every render passes that instability to every caller.
- An inline ref callback is a new function every render, so it detaches and reattaches each time.
- `useMemo` and `useCallback` are hints React may drop, not guarantees. Anything that must keep its identity or state (a store, a subscription, a controller) belongs in a ref or in state.

Subscriptions and re-renders:
- Subscribe to the smallest slice of a store the component uses: a selector, compared shallowly when it returns an object or array. Selecting the whole store re-renders on every change.
- State needed only inside an event handler is read there, with the store's `getState()`, rather than subscribed to.
- Values that change every frame (pointer position, camera, zoom, scroll, playback time) don't go through React state. Use refs, the render loop, or CSS variables.
- A context re-renders every consumer when its value changes. Split it, or memoize the value.
- A list that re-renders every item when one changes needs stable keys and memoized items.

Effects:
- Derive values from props and state during render, rather than copying them into state with an effect.
- Respond to user actions in event handlers, not in effects that watch state for the change.
- Every effect that subscribes, listens, starts a timer, opens a connection, or creates an object URL returns a cleanup that undoes it.
- Async work started in an effect or a handler can finish after the component unmounted or its inputs changed. Cancel it, or ignore the stale result. A guard against double submission lives somewhere that doesn't unmount mid-request.
- StrictMode mounts, unmounts, and remounts in development, and effects must survive that.
- Dependency lists are complete. A missing dependency reads stale values, and silencing the lint rule hides it.

Refs:
- `ref.current` is null during the first render, and assigning it doesn't re-render. Don't read refs during render to decide what to show.
- A ref that mirrors a prop or state is updated in an effect, not during render.

Keys and component structure:
- Keys are stable and unique among siblings: an ID, not an index, for lists that reorder, insert, or delete.
- A key that changes remounts its subtree and loses its state, which looks like flicker or lost input.
- Never define a component inside another component's render. It remounts on every render.
- Module-level state (stores, caches, registries) outlives the component and the screen. Reset it when the user switches context, such as to another document or account.

Suspense and error boundaries:
- Error boundaries go around the parts that can fail on their own (one element, one preview, one panel), so one failure doesn't blank the screen.
- A component that suspends has a fallback above it, and doesn't suspend forever when its data can't load.

Context across render roots:
- Context doesn't cross into a separate React root: another root rendered into a portal, a canvas with its own reconciler, or a detached overlay. Providers are bridged into those roots, or consumers silently get the default value.

Data fetching and cache:
- A normalized cache updates only from mutation results that include the changed objects' IDs and fields. Otherwise the screen shows stale data until something refetches.
- Queries are paused until their variables exist.
- Read a mutation's outcome from its returned value, not from the hook's state after an `await`, which is stale.
- Some clients' mutation calls are lazy and send nothing until they are awaited or subscribed to.

Severity: "critical" for render loops, crashes, actions that run twice, and leaks that grow without bound. "warning" for re-render storms and stale data users will notice, and for missing cleanup on a path users take. "suggestion" for the rest. Don't flag missing memoization unless you can say what it costs.
