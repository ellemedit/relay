# GC & Retention — behaviors and how to pin them

All line references are to `packages/relay-runtime/store/RelayModernStore.js`
unless stated otherwise.

## 1. Root bookkeeping

```
_roots: Map<request.identifier, {operation, refCount, epoch, fetchTime}>
_releaseBuffer: Array<request.identifier>   // FIFO; every entry has refCount === 0
```

`request.identifier` is derived from the operation name **and its variables** —
`createOperationDescriptor(UserQuery, {id: '4'})` and `{id: '5'}` are two
different roots, while two descriptors built from the same query and the same
variables share one root entry and one refCount.

### retain / dispose (`:375`)

| Situation | Effect |
|---|---|
| First `retain` of an id | new entry `{refCount: 1, epoch: null, fetchTime: null}` |
| `retain` of an id at `refCount === 0` | id filtered out of `_releaseBuffer`, `refCount` → 1 |
| `retain` of a live id | `refCount++` |
| `dispose()` twice on one disposable | second call is a no-op (`disposed` flag) |
| `dispose()` of the last retain | see the two branches below |

On `refCount === 0`:

- **Stale** — `fetchTime != null && queryCacheExpirationTime != null &&
  fetchTime <= Date.now() - queryCacheExpirationTime` → entry deleted from
  `_roots` and `scheduleGC()`. Note `fetchTime` is only non-null once the
  operation has been written (`notify(operation)`), so a retained-but-never-
  written operation is never "stale".
- **Fresh** — pushed onto `_releaseBuffer`. Only when the buffer exceeds
  `gcReleaseBufferSize` is the oldest id shifted off, deleted, and GC scheduled.

Under `shouldRetainWithinTTL_EXPERIMENTAL: true` the `_roots.delete(...)` in
both branches is skipped; expiry is decided in the mark phase instead
(see §4).

Tests: `RelayModernStore-test.js` → `describe('GC with a release buffer')` —
`keeps the data retained in the release buffer after released by caller`,
`immediately releases disposed items that are stale`,
`releases the operation and collects data after release buffer reaches capacity`,
`when same operation retained multiple times, data is only collected until fully released from buffer`,
`does not free data if previously disposed query is retained again`.

### The invisible root: `_recordSourceOperation` (`:599`)

Called at the **end** of `notify(sourceOperation)`:

- id already in `_roots` → stamp `epoch = _currentWriteEpoch` and
  `fetchTime = Date.now()`.
- otherwise, if `operationKind === 'query'` **and** `gcReleaseBufferSize > 0`
  **and** the buffer is not full → insert `{refCount: 0, epoch, fetchTime}` and
  push onto the release buffer.

Consequence: `store.publish(src); store.notify(operation);` on a query you never
retained still protects its records from GC. If your test wants a clean slate,
either construct the store with `gcReleaseBufferSize: 0` or call `notify()` with
no argument.

## 2. Mark & sweep (`_collect`, `:838`)

```
top:
  log store.gc.start
  startEpoch = _currentWriteEpoch;  references = new Set()
  for each [dataID, {operation, refCount, fetchTime}] of _roots:
      (experimental TTL filter — see §4)
      RelayReferenceMarker.mark(_recordSource, operation.root, references, ...)
      yield                              # <- one scheduler job boundary
      if startEpoch !== _currentWriteEpoch:
          log store.gc.interrupted; continue top
  # sweep, in the same resumption as the final root's post-yield check
  for each dataID in _recordSource.getRecordIDs():
      if not references.has(dataID):
          invoke record[RELAY_RESOLVER_LIVE_STATE_SUBSCRIPTION_KEY]?.()
          _recordSource.remove(dataID)
  log store.gc.end { references }
  return
```

**Job accounting** (`_gcStep`, `:828` — one `next()` per scheduled job):

| Roots | Scheduler jobs |
|---|---|
| 0 | 1 (sweep only) |
| 1 | 2 (mark, sweep) |
| N | N + 1 |
| N, with a write landing after job *k* | k + N + 1 |

An interruption restarts from `top:`, so `store.gc.start` is emitted again.
Because the epoch check lives *after* the yield inside the loop, a store with
zero roots can never be interrupted.

**What bumps the epoch.** `notify()` increments `_currentWriteEpoch`.
With `RelayFeatureFlags.OPTIMIZE_NOTIFY = false` (default) that happens
unconditionally; with it `true` the epoch only moves when something actually
changed (updated records, updated owners, invalidations). A test that expects a
GC interruption must therefore publish real changes when `OPTIMIZE_NOTIFY` is on.
`publish()` alone never bumps the epoch.

Test: `RelayModernStore-test.js` → `describe('GC Scheduler')` —
`runs GC with full cleanup mode when no retains left`,
`runs GC with partial cleanup when some retain is left`,
`restarts GC when data is written halfway through`.

## 3. Pausing GC

### holdGC (`:657`)

```js
const gcHold = store.holdGC();   // in-flight _gcRun is discarded, _shouldScheduleGC = true
// ... retain/dispose freely: scheduleGC() only sets the flag ...
gcHold.dispose();                // last dispose reschedules and clears the flag
```

`_gcHoldCounter` is a counter, so nested holds all have to be disposed. Note
that a discarded in-flight run restarts from scratch — the marking work done
before the hold is lost, so job counts after a hold start over at N + 1.

Tests: `describe('holdGC()')` and `GC pauses after holdGC` in `describe('GC Scheduler')`.

### Optimistic snapshot (`:755` / `:777`)

`snapshot()` discards the in-flight run and sets `_shouldScheduleGC`;
`restore()` calls `scheduleGC()` if the flag is set. Unlike the `holdGC`
dispose path, `restore()` does **not** clear `_shouldScheduleGC` — a detail
worth a regression test if you touch this code.

`__gc()` (`:819`) returns immediately while `_optimisticSource != null`, so a
synchronous-GC test must `restore()` first.

Test: `GC pauses during optimistic updates.` in `describe('GC Scheduler')`.

## 4. TTL: `queryCacheExpirationTime`

Two distinct roles:

1. **Dispose-time staleness** (§1) — decides whether a released root skips the
   release buffer and is dropped at once.
2. **`check()` availability** (`getAvailabilityStatus`, `:1116`) — an operation
   whose `fetchTime <= Date.now() - queryCacheExpirationTime` reports
   `{status: 'stale'}` rather than `{status: 'available', fetchTime}`.

`null`/`undefined` means an infinite TTL. Combined with
`shouldRetainWithinTTL_EXPERIMENTAL: true` that makes `_collect()` **return
immediately without collecting anything** (`:839-847`) — a store configured that
way never GCs, which is easy to mistake for a broken test.

Under `shouldRetainWithinTTL_EXPERIMENTAL: true` the mark loop skips (does not
mark, and therefore collects) any root that is simultaneously expired,
`refCount === 0`, and absent from `_releaseBuffer`; those roots are also deleted
from `_roots` during the sweep. The flag `invariant`s that
`queryCacheExpirationTime != null`.

Always drive TTL by stubbing the clock, never by advancing timers:

```js
let fetchTime = Date.now();
jest.spyOn(global.Date, 'now').mockImplementation(() => fetchTime);
// ... retain, publish, notify ...
fetchTime += QUERY_CACHE_EXPIRATION_TIME;   // now stale
disposable.dispose();
jest.runAllTimers();
```

Tests: `RelayModernEnvironment-QueryCacheExpirationTime-test.js`, plus
`immediately releases disposed items that are stale` and
`keeps published data retained in the release buffer if the data is not stale`.

## 5. Reachability in isolation

To test *what* is reachable without involving retention or scheduling, call the
marker directly:

```js
const references = new Set();
mark(source, createNormalizationSelector(Query.operation, ROOT_ID, variables), references, null);
expect(Array.from(references).sort()).toEqual([...]);
```

`RelayReferenceMarker-test.js` is the model. It is the right place for coverage
of `@match`/`@module` (needs an `operationLoader`), `@defer`/`@stream`, client
extensions, client edges, plural links, and resolver records — GC bugs are far
more often marking bugs than sweeping bugs.

## 6. Live resolvers and the sweep

Records may carry a subscription cleanup function under
`RELAY_RESOLVER_LIVE_STATE_SUBSCRIPTION_KEY`. The sweep calls it before
`remove()`, which is why `_collect` cannot shortcut to `_recordSource.clear()`
even when `references` is empty — see the comment at `:910`. Regressions here
leak subscriptions rather than memory, so assert on the resolver's call count
or on `GLOBAL_STORE` unsubscription, not only on record ids.

`resolvers/ResolverGC-test.js` provides `testResolverGC`, which runs a query
through a real environment and takes five callbacks: `beforeLookup`,
`afterLookup`, `afterRetainedGC`, `afterFreedGC`, `afterLookupAfterFreedGC`.
It retains a separate empty `graphql\`query ...GCEmptyQuery { __id }\`` so that
`client:root` survives independently of the operation under test. Reuse that
trick whenever you need "collect everything except the root".

## 7. Environment-level retention

`trackRetentionForEnvironment(environment)` (in `relay-test-utils-internal`)
replaces `environment.retain` with a counting mock and returns
`{isOperationRetained, release_DEPRECATED}`. Prefer `isOperationRetained(op)`
over asserting on mock call counts — it is what `useRefetchableFragmentNode-test.js`
uses and it survives refactors that change how many times `retain` is called.
It does **not** exercise the real store, so it answers "did the hook release its
query?", never "was the data collected?".
