# Store behaviors beyond GC

## Record sources, and the 4-way matrix

`RelayModernStore` accepts any `MutableRecordSource`. The two implementations
behave differently enough that `RelayModernStore-test.js` and
`RelayModernStore-Subscriptions-test.js` run their whole suite four times:

```js
[
  [data => new RelayRecordSource(data), 'Map', true],
  [data => new RelayRecordSource(data), 'Map', false],
  [data => RelayOptimisticRecordSource.create(new RelayRecordSource(data)), 'Optimistic', true],
  [data => RelayOptimisticRecordSource.create(new RelayRecordSource(data)), 'Optimistic', false],
].forEach(([getRecordSourceImplementation, ImplementationName, optimizeNotify]) => {
  beforeEach(() => { RelayFeatureFlags.OPTIMIZE_NOTIFY = optimizeNotify; });
  afterEach(() => { RelayFeatureFlags.OPTIMIZE_NOTIFY = defaultOptimizeNotify; });
  describe(`Relay Store with ${ImplementationName} Record Source...`, () => { /* ... */ });
});
```

When you add a store test to those files, build sources through
`getRecordSourceImplementation(...)`, never `new RelayRecordSource(...)`
directly, or you silently drop three quarters of the coverage.

`RelayRecordSource` API: `get`, `set`, `has`, `remove`, `delete`, `clear`,
`getRecordIDs`, `getStatus`, `size`, `toJSON`.

## publish / notify / subscribe

- `publish(source, idsMarkedForInvalidation?)` merges records into the target
  source (the optimistic source when one exists) and accumulates
  `_updatedRecordIDs` / `_invalidatedRecordIDs`. **Subscribers are not called.**
- `notify(sourceOperation?, invalidateStore?)` bumps the write epoch, invalidates
  resolver caches, runs subscriber callbacks, fires invalidation subscriptions,
  records the source operation (see the GC reference §1), then clears the
  accumulated id sets and returns the affected `RequestDescriptor`s.

So the canonical write is always `publish()` then `notify()`, and a test that
asserts "subscriber not called yet" belongs between the two.

`experimental_batchUpdates(cb)` (`:262`) defers notification: `notify()` inside
the callback pushes onto a batch and returns `[]`, and one real notify runs at
the end. Anything asserting on `updatedOwners` must account for that `[]`.

## Optimistic layers

```js
store.snapshot();     // creates _optimisticSource; snapshots subscriptions
store.publish(src);   // writes land on the optimistic layer
store.notify();
store.restore();      // drops the layer, unsubscribes live resolvers, restores subscriptions
```

`snapshot()` throws (`invariant`) if a snapshot already exists — no nesting.
While a snapshot exists, `store.publish` logs `{optimistic: true}` and `__gc()`
is a no-op.

Watch which source you assert on: `getSource()` returns
`_optimisticSource ?? _recordSource`, while `_collect()` always marks and sweeps
`_recordSource`. With an optimistic layer active, `store.getSource().toJSON()`
shows the *merged* view; keep a reference to the base source you constructed if
you need to see what GC actually did.

For updater-level optimistic behavior (`applyUpdate`/`revertUpdate`, rebasing,
`commitPayload`, `commitSource`, `commitUpdate`) work at the
`RelayPublishQueue` layer instead — `RelayPublishQueue-test.js` covers reverting
in the same `run()` vs. a later one, rebasing multiple updates on one value, and
rollback after a committed payload.

## Invalidation

Three separate mechanisms, easy to conflate:

| Mechanism | Trigger | Observed by |
|---|---|---|
| Record invalidation | `publish(src, new Set(['4']))` | `RelayModernRecord.getValue(record, INVALIDATED_AT_KEY)` |
| Global store invalidation | `notify(operation, true)` | `_globalInvalidationEpoch`; `check()` → `stale` |
| Invalidation subscriptions | either of the above | `lookupInvalidationState` / `checkInvalidationState` / `subscribeToInvalidationState` |

`lookupInvalidationState(dataIDs)` returns an opaque snapshot including a
`'global'` entry; pass it back to `checkInvalidationState` to ask "has anything
invalidated since?". Tests: `describe('invalidation state')` in
`RelayModernStore-test.js`.

## check()

`check(operation, options?)` runs `DataChecker.check` and then
`getAvailabilityStatus` (`RelayModernStore.js:1116`), returning one of:

- `{status: 'available', fetchTime}` — reachable and fresh
- `{status: 'missing'}` — some field is absent
- `{status: 'stale'}` — globally invalidated after the last write of this
  operation, or a reachable record was invalidated after that write, or the
  operation's `fetchTime` is older than `queryCacheExpirationTime`

Because `fetchTime`/`epoch` only exist on a **root entry**, `check()` on an
operation that was never retained *and* never written reports at best
`{status: 'available', fetchTime: null}` — it cannot be `stale`. Retain before
asserting staleness.

Related suites: `RelayModernEnvironment-Check-test.js`,
`-CheckWithGlobalInvalidation-test.js`, `-CheckWithLocalInvalidation-test.js`,
and `DataChecker-test.js` for the traversal itself.

## Asserting on log events

Pass `log` into the store, push cloned events into an array, and assert on the
sequence. Clone with a helper — `updatedRecordIDs` / `references` are **live
`Set`s that the store clears after `notify()`**, so a stored reference reads
back empty:

```js
function cloneEventWithSets(event) {
  const next = {};
  for (const key in event) {
    if (event.hasOwnProperty(key)) {
      const val = event[key];
      next[key] = val instanceof Set ? new Set(val) : val;
    }
  }
  return next;
}
```

Events the store emits: `store.publish`, `store.snapshot`, `store.restore`,
`store.lookup.start` / `.end`, `store.notify.start` / `.complete` /
`.subscription`, `store.batch.start` / `.complete`, `store.gc.start` /
`.interrupted` / `.end`, `liveresolver.batch.start` / `.end`. Full definitions
in `packages/relay-runtime/store/RelayStoreTypes.js` (~`:749`).

Use `toMatchObject` when you only care about the order of `name`s, `toEqual`
when the payload matters. Reset with `logEvents.length = 0` between phases, and
push a sentinel from a subscriber callback (`{kind: 'test_only_callback'}`) to
pin where callbacks run relative to `notify.start`/`notify.complete` — this is
how `emits log events for publish and notify` proves callbacks fire between the
two.

## Feature flags that change store behavior

| Flag | Effect on tests |
|---|---|
| `OPTIMIZE_NOTIFY` | epoch only advances when something actually changed; changes GC interruption and `updatedOwners` |
| `ENABLE_FIELD_GRANULAR_NOTIFICATIONS` | how many `RelayReader.read` calls a `notify()` triggers |
| `ENABLE_NOTIFY_SUBSCRIPTION` | emits `store.notify.subscription` per updated subscriber |
| `ENABLE_RELAY_RESOLVERS` | required for resolver/live-resolver paths |
| `PROCESS_OPTIMISTIC_UPDATE_BEFORE_SUBSCRIPTION` | ordering of optimistic updates vs. subscription notification |

Always save and restore. `describeWithFeatureFlags([{FLAG: true}, {FLAG: false}], 'desc', body)`
from `relay-test-utils-internal` does it for you; `it.each([true, false])` with
manual `beforeEach`/`afterEach` (as in
`RelayModernStore-FieldGranularNotifications-test.js`) is the alternative.
