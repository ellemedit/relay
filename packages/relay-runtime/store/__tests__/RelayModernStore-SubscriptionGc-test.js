/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 * @format
 * @oncall relay
 */

'use strict';

const RelayNetwork = require('../../network/RelayNetwork');
const RelayModernEnvironment = require('../RelayModernEnvironment');
const {
  createOperationDescriptor,
} = require('../RelayModernOperationDescriptor');
const RelayModernStore = require('../RelayModernStore');
const RelayRecordSource = require('../RelayRecordSource');

// Hand-authored compiled operations (ConcreteRequest shape) so this test needs no
// generated artifacts. Two operations reference the same `Room:1` record; only QB
// selects its `profile` child (a separate record), QA selects only {id, name}.
//   query QB($id: ID!) { room(id: $id) { id name profile { id name } } }
//   query QA($id: ID!) { room(id: $id) { id name } }
const idField = {
  alias: null,
  args: null,
  kind: 'ScalarField',
  name: 'id',
  storageKey: null,
};
const nameField = {
  alias: null,
  args: null,
  kind: 'ScalarField',
  name: 'name',
  storageKey: null,
};
const roomArgs = [{kind: 'Variable', name: 'id', variableName: 'id'}];
const argumentDefinitions = [
  {defaultValue: null, kind: 'LocalArgument', name: 'id'},
];
const profileField = {
  alias: null,
  args: null,
  concreteType: 'Profile',
  kind: 'LinkedField',
  name: 'profile',
  plural: false,
  storageKey: null,
  selections: [idField, nameField],
};
const roomWithProfile = {
  alias: null,
  args: roomArgs,
  concreteType: 'Room',
  kind: 'LinkedField',
  name: 'room',
  plural: false,
  storageKey: null,
  selections: [idField, nameField, profileField],
};
const roomWithoutProfile = {
  alias: null,
  args: roomArgs,
  concreteType: 'Room',
  kind: 'LinkedField',
  name: 'room',
  plural: false,
  storageKey: null,
  selections: [idField, nameField],
};
const DetailQuery: $FlowFixMe = {
  fragment: {
    argumentDefinitions,
    kind: 'Fragment',
    metadata: null,
    name: 'SubscriptionGcDetailQuery',
    selections: [roomWithProfile],
    type: 'Query',
    abstractKey: null,
  },
  kind: 'Request',
  operation: {
    argumentDefinitions,
    kind: 'Operation',
    name: 'SubscriptionGcDetailQuery',
    selections: [roomWithProfile],
  },
  params: {
    cacheID: 'SubscriptionGcDetailQuery',
    id: null,
    metadata: {},
    name: 'SubscriptionGcDetailQuery',
    operationKind: 'query',
    text: 'query SubscriptionGcDetailQuery($id:ID!){room(id:$id){id name profile{id name}}}',
  },
};
const ListQuery: $FlowFixMe = {
  fragment: {
    argumentDefinitions,
    kind: 'Fragment',
    metadata: null,
    name: 'SubscriptionGcListQuery',
    selections: [roomWithoutProfile],
    type: 'Query',
    abstractKey: null,
  },
  kind: 'Request',
  operation: {
    argumentDefinitions,
    kind: 'Operation',
    name: 'SubscriptionGcListQuery',
    selections: [roomWithoutProfile],
  },
  params: {
    cacheID: 'SubscriptionGcListQuery',
    id: null,
    metadata: {},
    name: 'SubscriptionGcListQuery',
    operationKind: 'query',
    text: 'query SubscriptionGcListQuery($id:ID!){room(id:$id){id name}}',
  },
};

function createStoreAndEnvironment() {
  const store = new RelayModernStore(new RelayRecordSource(), {
    gcReleaseBufferSize: 0, // evict a released operation immediately
    gcScheduler: run => run(), // run GC synchronously for a deterministic test
  });
  const environment = new RelayModernEnvironment({
    network: RelayNetwork.create(() =>
      Promise.reject(new Error('no network in test')),
    ),
    store,
  });
  return {store, environment};
}

describe('RelayModernStore garbage collection with active subscriptions', () => {
  it('keeps a linked child that a live subscription still reads after its owner operation is released', () => {
    const {environment} = createStoreAndEnvironment();
    const detail = createOperationDescriptor(DetailQuery, {id: '1'});
    const list = createOperationDescriptor(ListQuery, {id: '1'});

    environment.commitPayload(detail, {
      room: {id: '1', name: 'Room One', profile: {id: 'p1', name: 'Alice'}},
    });
    environment.commitPayload(list, {room: {id: '1', name: 'Room One'}});

    // Both screens are mounted: the detail page and a list page that the router
    // keeps alive (e.g. under React <Activity>).
    const listRetain = environment.retain(list);
    const detailRetain = environment.retain(detail);

    // A live fragment subscription reads room.profile (the mounted useFragment).
    const snapshot = environment.lookup(detail.fragment);
    expect(snapshot.isMissingData).toBe(false);
    expect(snapshot.seenRecords.has('p1')).toBe(true);
    const subscription = environment.subscribe(snapshot, () => {});

    // Navigate away from the detail page: its query retention is released. The
    // list op stays retained (its <Activity> subtree is kept mounted). GC runs.
    detailRetain.dispose();

    // DESIRED (post-fix): the child survives because a live subscription still
    // reads it. CURRENT (bug): Profile:p1 is collected (only the released detail op
    // selected it), and the next read of the detail fragment is a partial read.
    expect(environment.getStore().getSource().get('p1')).not.toBe(undefined);
    const after = environment.lookup(detail.fragment);
    expect(after.isMissingData).toBe(false);
    expect((after.data as $FlowFixMe).room.profile).toEqual({
      id: 'p1',
      name: 'Alice',
    });

    subscription.dispose();
    listRetain.dispose();
  });

  it('collects the child once the subscription is disposed (no over-retention)', () => {
    const {environment} = createStoreAndEnvironment();
    const detail = createOperationDescriptor(DetailQuery, {id: '1'});
    const list = createOperationDescriptor(ListQuery, {id: '1'});

    environment.commitPayload(detail, {
      room: {id: '1', name: 'Room One', profile: {id: 'p1', name: 'Alice'}},
    });
    environment.commitPayload(list, {room: {id: '1', name: 'Room One'}});

    const listRetain = environment.retain(list);
    const detailRetain = environment.retain(detail);
    const subscription = environment.subscribe(
      environment.lookup(detail.fragment),
      () => {},
    );

    // With no active subscription and no retained op selecting it, the child must
    // be collected — the fix must not leak records past a subscription's lifetime.
    subscription.dispose();
    detailRetain.dispose();

    expect(environment.getStore().getSource().get('p1')).toBe(undefined);

    listRetain.dispose();
  });
});
