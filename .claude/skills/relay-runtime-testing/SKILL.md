---
name: relay-runtime-testing
description: >-
  Write, run and debug Jest tests for the Relay JavaScript runtime in this
  repo — above all `RelayModernStore`, garbage collection and retention. Use
  when adding or changing tests under `packages/relay-runtime/**/__tests__/`
  or `packages/react-relay/**/__tests__/`, when a `graphql` tag in a test needs
  recompiling, or when reasoning about `retain`/`dispose`, `gcReleaseBufferSize`,
  `gcScheduler`, `holdGC()`, `__gc()`, `queryCacheExpirationTime`, the release
  buffer, `RelayReferenceMarker`, optimistic `snapshot()`/`restore()`, record
  sources, or `publish`/`notify`/`subscribe`. NOT for the Rust compiler in
  `compiler/` — see `.claude/PROJECT.md` for fixture tests there.
---

# Testing the Relay Runtime (Store & GC)

Scope: the JavaScript runtime in `packages/`. Everything below is verified
against the source in `packages/relay-runtime/store/`.

## The loop

Run from the **repo root**:

```bash
yarn jest RelayModernStore              # run tests matching a pattern
yarn jest packages/relay-runtime/store/__tests__/RelayModernStore-test.js -t 'release buffer'
./scripts/compile-tests.sh              # regenerate __generated__ artifacts (needs cargo)
yarn typecheck                          # flow
yarn lint && yarn prettier
```

The jest transform (`scripts/jest/preprocessor.js`) loads
`./dist/babel-plugin-relay`, so `dist/` must exist before any test can run.
`yarn install` normally builds it via `postinstall`; if you installed with
`--ignore-scripts`, run `yarn build` once or every suite fails to transform.

Run `./scripts/compile-tests.sh` **whenever you add, rename, or edit a
`graphql` tag inside a test**. It runs the Rust compiler over
`scripts/config.tests.json`, which uses
`packages/relay-test-utils-internal/testschema.graphql` (+ `schema-extensions/`)
and writes `__generated__/*.graphql.js` next to each test. Without it the test
fails at require-time on a missing artifact. Commit the generated files — CI's
`build-test-projects` job regenerates them and then runs
`scripts/check-git-status.sh`, which fails on any diff.

> `.claude/PROJECT.md` names `./scripts/compile-test.js`. That file does not
> exist; the real script is `./scripts/compile-tests.sh`.

## Naming rule for `graphql` tags — get this right first

The compiler rejects operations/fragments whose name does not start with the
**module name**, derived from the filename: take the stem up to the first `.`,
then upper-case the letter after every non-alphanumeric run
(`compiler/crates/relay-transforms/src/validations/validate_module_names/extract_module_name.rs`).

| Test file | Module name | Legal operation name |
|---|---|---|
| `RelayModernStore-test.js` | `RelayModernStoreTest` | `RelayModernStoreTest7Query` |
| `RelayModernEnvironment-Retain-test.js` | `RelayModernEnvironmentRetainTest` | `RelayModernEnvironmentRetainTestQuery` |
| `resolvers/ResolverGC-test.js` | `ResolverGCTest` | `ResolverGCTestLiveWithRootFragmentQuery` |

Operations must additionally end in `Query`, `Mutation` or `Subscription`.
Fragments only need the prefix. When adding a tag to an existing file, keep
counting from the highest existing number rather than renumbering — renaming an
existing tag churns every `__generated__` file that references it.

One more compiler rule bites constantly in store tests: spreading a fragment on
a type that is not a subtype of the selection — the ubiquitous
`node(id: $id) { ...SomeUserFragment }`, where `node` returns `Node` — fails
with *"Expected `@alias` directive. `X` is defined on `User` which might not
match this selection type of `Node`."* Append `@dangerously_unaliased_fixme` to
the spread (what existing tests do, and what keeps `snapshot.data` flat) or
`@alias` (which nests the data under a key).

## The GC model

Read this before writing a GC test; nearly every surprising assertion follows
from it. Source: `packages/relay-runtime/store/RelayModernStore.js`.

**State.** `_roots: Map<requestIdentifier, {operation, refCount, epoch, fetchTime}>`
plus `_releaseBuffer: Array<requestIdentifier>` — a FIFO of roots at
`refCount === 0` that are kept alive anyway; overflow evicts the
least-recently-added entry. Default size is **10**
(`DEFAULT_RELEASE_BUFFER_SIZE`, `RelayModernStore.js:81`).

**Retain / dispose** (`:375`). `retain()` increments `refCount`, creating the
entry (`epoch: null, fetchTime: null`) if new, and pulls the id back out of the
release buffer. Each returned `dispose` is idempotent — a second call on the
*same* disposable is a no-op, but two separate `retain()` calls need two
disposes. When `refCount` hits 0 the entry either

- is dropped immediately and GC scheduled, if it is **stale** — i.e.
  `fetchTime != null && queryCacheExpirationTime != null && fetchTime <= Date.now() - queryCacheExpirationTime`; or
- is pushed onto the release buffer, and only if that pushes the buffer *over*
  capacity is the oldest entry shifted off, dropped, and GC scheduled.

`shouldRetainWithinTTL_EXPERIMENTAL` changes this: the root entry is *not*
deleted in either branch — expiry is instead evaluated during the mark phase.

**Writes create roots you never retained** (`_recordSourceOperation`, `:599`).
`notify(operation)` for an `operationKind === 'query'` that is not in `_roots`
inserts a *temporary* entry with `refCount: 0` and pushes it onto the release
buffer, as long as there is room. So committing a payload for an unretained
query still keeps its records alive. This is the single most common reason a
"nothing is retained, so it should be collected" test fails — measured, with
one record reachable from an unretained query and `__gc()` run immediately after
`notify(operation)`:

| `gcReleaseBufferSize` | surviving record ids |
|---|---|
| `10` (default) | `['a', 'client:root']` |
| `0` | `[]` |

**Mark & sweep** (`_collect`, `:838`) is a generator:

1. Snapshot `startEpoch = _currentWriteEpoch`, start an empty `references` set,
   emit `store.gc.start`.
2. For **each root**: `RelayReferenceMarker.mark(...)` into `references`, then
   `yield`. After the yield, if `_currentWriteEpoch` moved, emit
   `store.gc.interrupted` and restart the whole loop from step 1.
3. After the last root, **sweep** in the same resumption: for every record id
   not in `references`, invoke its live-resolver unsubscribe callback if
   present, then `remove()` it. Emit `store.gc.end` carrying `references`.

So **N roots costs N + 1 scheduler jobs** (N marks, then the sweep). Zero roots
costs exactly one job. Getting this count right is what makes manual-scheduler
tests readable.

**Pausing.** GC is suppressed by two independent mechanisms:

- `holdGC()` (`:657`) increments `_gcHoldCounter`, discarding any in-flight run
  and setting `_shouldScheduleGC`. The last `dispose()` reschedules.
- An optimistic `snapshot()` (`:755`) discards the in-flight run and sets
  `_shouldScheduleGC`; `restore()` (`:777`) reschedules. Note `restore()` does
  not clear `_shouldScheduleGC` the way the `holdGC` dispose path does.
  `__gc()` (`:819`) is a **no-op** while `_optimisticSource != null`.

## Store construction — the levers

```js
const source = RelayRecordSource.create(data);
const store = new RelayModernStore(source, {
  gcReleaseBufferSize: 0,          // 0 = collect as soon as refCount hits 0
  gcScheduler: job => queue.push(job),  // default: resolveImmediate
  queryCacheExpirationTime: 1000,  // null/undefined = infinite TTL
  shouldRetainWithinTTL_EXPERIMENTAL: false,
  log: event => logEvents.push(event),
});
```

**Set `gcReleaseBufferSize: 0` unless the release buffer is what you are
testing.** With the default of 10, a small test never evicts anything and every
"is it collected?" assertion silently passes for the wrong reason.

## Picking an assertion style

| You want to assert | Use |
|---|---|
| Exactly which records survive | `expect(source.toJSON()).toEqual({...})` |
| Only *which ids* survive | `Object.keys(source.toJSON()).sort()` or `store.getSource().getRecordIDs()` — **sort it**, order is insertion order |
| GC ran / restarted / what it marked | a `log` fn collecting `store.gc.start` / `store.gc.interrupted` / `store.gc.end` |
| Reachability alone, no store | `RelayReferenceMarker.mark(source, selector, references, ...)` directly |
| Retention at the environment layer | `trackRetentionForEnvironment(environment).isOperationRetained(op)` |

Take `initialData = simpleClone(data)` **before** handing `data` to the store:
in `__DEV__` (always on in tests) the store deep-freezes every record, so the
object you passed in is no longer a safe "expected" value to mutate.

## Controlling time and the scheduler

Jest here runs with **legacy fake timers enabled globally**
(`package.json` → `jest.fakeTimers`), `testEnvironment: node`, `__DEV__ = true`.

- **Default scheduler.** `resolveImmediate` is a promise continuation, and a
  *native* one is invisible to legacy fake timers. Measured, with
  `gcReleaseBufferSize: 0` and one orphan record:

  | Setup | `jest.runAllTimers()` | `await Promise.resolve()` |
  |---|---|---|
  | no polyfill | record **survives** — GC never ran | record collected |
  | `injectPromisePolyfill__DEPRECATED()` | record collected | record collected |

  So a test that drives GC with `jest.runAllTimers()` **must** call
  `injectPromisePolyfill__DEPRECATED()` at module scope — it swaps in
  `promise-polyfill`, which schedules on timers. Otherwise `await Promise.resolve()`
  works on its own. Skipping both is the failure mode where GC silently never
  runs and the assertion passes for the wrong reason.
- **Deterministic scheduler.** For step-by-step GC, inject your own and drive it:

  ```js
  let schedulerQueue = [];
  const store = new RelayModernStore(source, {
    gcReleaseBufferSize: 0,
    gcScheduler: job => schedulerQueue.push(job),
    queryCacheExpirationTime: 0,
  });
  function runNextScheduledJob() {
    const job = schedulerQueue.shift();
    expect(job).toBeDefined();
    job();
  }
  afterEach(() => expect(schedulerQueue).toEqual([])); // catches stray GCs
  ```

  That `afterEach` is worth copying — it turns an unintended extra GC schedule
  into a failure instead of silence.
- **Synchronous GC.** `store.__gc()` drains the generator in one call. Ideal
  when GC timing is not the thing under test — but remember it no-ops under an
  optimistic snapshot.
- **TTL.** Freeze and advance the clock by hand; do not use timer advancement,
  because staleness is computed from `Date.now()`:

  ```js
  let fetchTime = Date.now();
  jest.spyOn(global.Date, 'now').mockImplementation(() => fetchTime);
  // ...
  fetchTime += QUERY_CACHE_EXPIRATION_TIME; // now stale
  ```

## Pitfalls

1. **Forgot `./scripts/compile-tests.sh`** → `Cannot find module './__generated__/...'`.
2. **Left `gcReleaseBufferSize` at its default** → nothing is ever collected.
3. **`jest.runAllTimers()` without `injectPromisePolyfill__DEPRECATED()`** → GC
   never runs, and a "still retained" assertion passes for the wrong reason.
4. **`notify(operation)` re-rooted your query.** See `_recordSourceOperation`
   above. Either pass no operation to `notify()`, or expect the extra root.
5. **Miscounted scheduler jobs.** N roots ⇒ N + 1 jobs. A `publish()` +
   `notify()` between jobs restarts the run and costs a full extra pass.
6. **A stray `retain()` on `client:root`.** Any retained root query keeps
   `client:root` alive; `ResolverGC-test.js` deliberately retains an empty
   `{ __id }` query for exactly this.
7. **Mutating the seed `data` object** after the store froze it.
8. **Feature flags leaking across tests.** Save in `beforeEach`, restore in
   `afterEach`, or use `describeWithFeatureFlags`.
9. **Unexpected console output.** Most store tests call `disallowWarnings()` /
   `disallowConsoleErrors()` at module scope; an expected one must be declared
   with `expectWarningWillFire` / `expectConsoleErrorWillFire`.

## References

Load these as needed — do not read them all up front.

| File | Contents |
|---|---|
| `references/gc-and-retention.md` | Every GC lever with the test that pins it; release-buffer, TTL, holdGC, optimistic, interruption, live-resolver cleanup |
| `references/store-behaviors.md` | `publish`/`notify`/`subscribe`, optimistic layers, invalidation, `check()` availability, log-event assertions |
| `references/test-templates.md` | Copy-paste skeletons: store-level, environment-level, manual-scheduler, TTL, reference-marker |

Best existing tests to imitate:

- `packages/relay-runtime/store/__tests__/RelayModernStore-test.js` — GC with a
  release buffer, GC Scheduler, `holdGC()`
- `packages/relay-runtime/store/__tests__/resolvers/ResolverGC-test.js` — the
  `testResolverGC` harness (retain → `__gc` → dispose → `__gc`)
- `packages/relay-runtime/store/__tests__/RelayModernEnvironment-QueryCacheExpirationTime-test.js` — TTL × release buffer
- `packages/relay-runtime/store/__tests__/RelayReferenceMarker-test.js` — mark phase in isolation
