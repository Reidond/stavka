# Effect v4 engineering practices

## Services and Layers

- Define ports as `Context.Service<Self, Shape>()("stable/id")` classes.
- Operations return `Effect<Success, ExpectedError, Requirements>`.
- Use `Effect.gen({ self: this }, function* () { ... })` when a class method
  needs its instance.
- Provide implementations through `Layer.succeed`, `Layer.effect`, or scoped
  Layers, then compose Layers once at the application root.
- Keep SQL, migration text, persistence encodings, filesystem calls, provider
  SDKs, and raw network calls in infrastructure adapters behind injected ports.

## Errors and validation

- Use tagged typed errors for expected failures. Preserve interruption and
  defects rather than converting every cause into a generic exception.
- Decode unknown values with `Schema.decodeUnknownEffect` before business logic.
- Keep encoded wire types distinct from decoded domain types when transforms
  exist, and use `Schema.toStandardSchemaV1` for TanStack boundaries.
- Treat configuration and persisted data as untrusted input.

## Resources and concurrency

- Wrap acquisition/release with scoped Effects or scoped Layers.
- Prefer `Queue`, `Semaphore`, `Ref`, `Deferred`, `Schedule`, `Clock`, and
  supervised fibers over mutable Promise queues, timers, and detached work.
- Retries must be finite, failure-specific, observable, cancellable, and
  bounded by an integration timeout.
- Propagate request interruption into provider SDKs with `AbortSignal` when
  supported.

## Framework boundaries

- Wrap Promise APIs with `Effect.tryPromise` and callbacks with
  `Effect.callback`.
- `Effect.runPromise` belongs only in Worker/DO/Container/Node entrypoints,
  React/TanStack callbacks, and unavoidable third-party framework hooks.
- Test services with controlled Clock/randomness and small test Layers. Cover
  malformed input, duplicate delivery, interruption, timeout, retry exhaustion,
  persistence restore, and resource cleanup.

## v4 reminders for the pinned beta

Common v3 names changed: `Context.Service` replaces older service helpers,
`Effect.callback` replaces `Effect.async`, `catch` replaces `catchAll`,
`andThen` replaces `zipRight`, and `result` replaces `either`. Schema unions,
tuples, records, and literals receive arrays or direct key/value arguments in
v4. Verify declarations before applying these reminders mechanically.
