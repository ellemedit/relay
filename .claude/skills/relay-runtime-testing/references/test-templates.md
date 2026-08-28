# Test templates

Copy, rename, and adjust. Every `graphql` tag name below must be re-derived from
your own filename (see the naming rule in SKILL.md), and
`./scripts/compile-tests.sh` must be run after editing any tag.

Every file starts with the repo header:

```js
/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict-local
 * @format
 * @oncall relay
 */

'use strict';
```

## 1. Store-level GC test, timer-driven

For "after N retains and disposes, which records survive?".

```js
const {graphql} = require('../../query/GraphQLTag');
const {createOperationDescriptor} = require('../RelayModernOperationDescriptor');
const RelayModernStore = require('../RelayModernStore');
const RelayRecordSource = require('../RelayRecordSource');
const {REF_KEY} = require('../RelayStoreUtils');
const {
  injectPromisePolyfill__DEPRECATED,
  simpleClone,
} = require('relay-test-utils-internal');

// Required: the default gcScheduler is a promise microtask, which legacy fake
// timers cannot flush. This swaps in a timer-based Promise.
injectPromisePolyfill__DEPRECATED();

describe('MyModuleTest GC', () => {
  let UserQuery;
  let data;
  let initialData;
  let source;
  let store;

  beforeEach(() => {
    data = {
      '4': {
        __id: '4',
        __typename: 'User',
        id: '4',
        name: 'Zuck',
        'profilePicture(size:32)': {[REF_KEY]: 'client:1'},
      },
      'client:1': {__id: 'client:1', uri: 'https://photo1.jpg'},
      'client:root': {
        __id: 'client:root',
        __typename: '__Root',
        'node(id:"4")': {__ref: '4'},
      },
    };
    // Snapshot BEFORE the store freezes `data` in __DEV__.
    initialData = simpleClone(data);
    source = new RelayRecordSource(data);
    store = new RelayModernStore(source, {
      gcReleaseBufferSize: 0,     // <- almost always what you want
      queryCacheExpirationTime: 0,
    });

    UserQuery = graphql`
      query MyModuleTestUserQuery($id: ID!, $size: [Int]) {
        node(id: $id) {
          # a User fragment on a Node selection needs @alias or this escape
          # hatch, otherwise the compiler errors with ExpectedAliasOnNonSubtypeSpread
          ...MyModuleTestUserFragment @dangerously_unaliased_fixme
        }
      }
    `;
    graphql`
      fragment MyModuleTestUserFragment on User {
        name
        profilePicture(size: $size) {
          uri
        }
      }
    `;
  });

  it('collects records once the last retain is disposed', () => {
    const {dispose} = store.retain(
      createOperationDescriptor(UserQuery, {id: '4', size: 32}),
    );
    jest.runAllTimers();
    expect(source.toJSON()).toEqual(initialData);

    dispose();
    jest.runAllTimers();
    expect(source.toJSON()).toEqual({});
  });
});
```

## 2. Manual GC scheduler — step-by-step assertions

For "how far did GC get before X happened?". This is the right shape for
interruption, `holdGC`, and optimistic-pause tests.

```js
const {ROOT_ID, ROOT_TYPE} = require('../RelayStoreUtils');

describe('MyModuleTest GC scheduler', () => {
  let source;
  let store;
  let schedulerQueue;

  const NodeQuery = graphql`
    query MyModuleTestNodeQuery($id: ID!) {
      node(id: $id) {
        __typename
      }
    }
  `;

  function runNextScheduledJob() {
    const job = schedulerQueue.shift();
    expect(job).toBeDefined();
    job();
  }

  function getStoreRecordIDs() {
    const ids = Object.keys(source.toJSON());
    ids.sort();          // insertion order is not a contract
    return ids;
  }

  function writeAndRetainNode(nodeID) {
    store.publish(
      new RelayRecordSource({
        [nodeID]: {__id: nodeID, __typename: 'User'},
        [ROOT_ID]: {
          __id: ROOT_ID,
          __typename: ROOT_TYPE,
          [`node(id:"${nodeID}")`]: {__ref: nodeID},
        },
      }),
    );
    store.notify();      // no sourceOperation -> no temporary root entry
    return store.retain(createOperationDescriptor(NodeQuery, {id: nodeID}));
  }

  beforeEach(() => {
    schedulerQueue = [];
    source = new RelayRecordSource({});
    store = new RelayModernStore(source, {
      gcReleaseBufferSize: 0,
      gcScheduler: job => schedulerQueue.push(job),
      queryCacheExpirationTime: 0,
    });
  });

  // Turns an unexpected extra GC schedule into a failure.
  afterEach(() => {
    expect(schedulerQueue).toEqual([]);
  });

  it('marks each root in its own job, then sweeps', () => {
    const {dispose: disposeA} = writeAndRetainNode('a');
    writeAndRetainNode('b');
    disposeA();
    expect(getStoreRecordIDs()).toEqual(['a', 'b', 'client:root']);

    runNextScheduledJob();      // mark root 'b'
    expect(getStoreRecordIDs()).toEqual(['a', 'b', 'client:root']);

    runNextScheduledJob();      // sweep
    expect(getStoreRecordIDs()).toEqual(['b', 'client:root']);
  });
});
```

Remaining roots ⇒ jobs: `N` roots need `N + 1` calls to `runNextScheduledJob()`.

## 3. TTL / release-buffer test

```js
const QUERY_CACHE_EXPIRATION_TIME = 1000;

let fetchTime;
beforeEach(() => {
  fetchTime = Date.now();
  jest.spyOn(global.Date, 'now').mockImplementation(() => fetchTime);
  source = new RelayRecordSource(data);
  store = new RelayModernStore(source, {
    gcReleaseBufferSize: 1,
    queryCacheExpirationTime: QUERY_CACHE_EXPIRATION_TIME,
    shouldRetainWithinTTL_EXPERIMENTAL: true,
  });
});
afterEach(() => {
  jest.clearAllMocks();
});

it('drops a released root immediately once it is stale', () => {
  const operation = createOperationDescriptor(UserQuery, {id: '4', size: 32});
  const disposable = store.retain(operation);
  jest.runAllTimers();

  // fetchTime is only stamped on the root by notify(operation).
  store.publish(source);
  store.notify(operation);

  fetchTime += QUERY_CACHE_EXPIRATION_TIME;   // now stale
  disposable.dispose();
  jest.runAllTimers();

  expect(source.toJSON()).toEqual({});
});
```

Use `QUERY_CACHE_EXPIRATION_TIME - 1` for the "not yet stale, stays in the
release buffer" counterpart.

## 4. Synchronous GC through a real environment

When GC *timing* is not under test, `store.__gc()` drains the generator in one
call. Retain an empty query so `client:root` survives independently.

```js
const store = new RelayModernStore(RelayRecordSource.create(), {
  gcReleaseBufferSize: 0,
  log: mockLogger,
});
const environment = new RelayModernEnvironment({
  network: RelayNetwork.create((request, variables) =>
    Promise.resolve(payloads.shift()),
  ),
  store,
});

const rootRetain = environment.retain(
  createOperationDescriptor(
    graphql`
      query MyModuleTestGCEmptyQuery {
        __id
      }
    `,
    {},
  ),
);

await environment.execute({operation}).toPromise();
const retain = environment.retain(operation);
store.__gc();
expect(store.getSource().getRecordIDs().sort()).toEqual([/* still there */]);

retain.dispose();
store.__gc();
expect(store.getSource().getRecordIDs()).toEqual(['client:root']);
```

`store.__gc()` is a no-op while an optimistic snapshot is active — call
`store.restore()` first.

## 5. Reference-marker (reachability) test

No store, no scheduling — just "what does this query reach?".

```js
import {mark} from '../RelayReferenceMarker';
import {createNormalizationSelector} from '../RelayModernSelector';
import {ROOT_ID} from '../RelayStoreUtils';

it('marks referenced records', () => {
  const FooQuery = graphql`
    query MyModuleTestFooQuery($id: ID, $size: [Int]) {
      node(id: $id) {
        id
        ... on User {
          profilePicture(size: $size) {
            uri
          }
        }
      }
    }
  `;
  const references = new Set();
  mark(
    source,
    createNormalizationSelector(FooQuery.operation, ROOT_ID, {id: '1', size: 32}),
    references,
    null,          // operationLoader — required for @match/@module
  );
  expect(Array.from(references).sort()).toEqual(['1', 'client:4', 'client:root']);
});
```

## 6. Environment-level test skeleton

Most `RelayModernEnvironment-*-test.js` files run against both environment
implementations. Follow the convention when adding one:

```js
const {MultiActorEnvironment, getActorIdentifier} = require('../../multi-actor-environment');
const RelayNetwork = require('../../network/RelayNetwork');
const {disallowWarnings} = require('relay-test-utils-internal');

disallowWarnings();

const ActorQuery = graphql`
  query MyModuleTestActorQuery {
    me {
      name
    }
  }
`;

describe.each(['RelayModernEnvironment', 'MultiActorEnvironment'])(
  'MyFeature',
  environmentType => {
    let environment;
    let operation;
    let source;
    let store;

    describe(environmentType, () => {
      beforeEach(() => {
        operation = createOperationDescriptor(ActorQuery, {});
        source = RelayRecordSource.create();
        store = new RelayModernStore(source);
        const fetch = jest.fn();
        const multiActorEnvironment = new MultiActorEnvironment({
          createNetworkForActor: () => RelayNetwork.create(fetch),
          createStoreForActor: () => store,
        });
        environment =
          environmentType === 'MultiActorEnvironment'
            ? multiActorEnvironment.forActor(getActorIdentifier('actor:1234'))
            : new RelayModernEnvironment({network: RelayNetwork.create(fetch), store});
      });

      it('does the thing', () => {
        /* ... */
      });
    });
  },
);
```

Spy on the store without losing behavior:
`store.notify = jest.fn(store.notify.bind(store));`

## 7. Console hygiene

```js
const {
  disallowWarnings,
  disallowConsoleErrors,
  expectWarningWillFire,
  expectConsoleErrorWillFire,
} = require('relay-test-utils-internal');

disallowWarnings();          // module scope
disallowConsoleErrors();

it('warns on X', () => {
  expectWarningWillFire('RelayModernStore: ...');   // declare before triggering
  // ...
});
```

An undeclared warning fails the test; a declared warning that never fires fails
it too.
