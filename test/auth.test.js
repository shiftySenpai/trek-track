// Authorization regression tests.
//
// The plugin's SQLite database is shared and unscoped, and TREK reservation ids are
// sequential integers — so ctx.trips (the only membership-checked host surface) is
// the single thing standing between a user and someone else's itinerary. These
// tests exist because that check was once swallowed by attempt(), which turned a
// failed permission check into a successful request.
//
//   node --test test/            (or: node test/auth.test.js)
const test = require('node:test');
const assert = require('node:assert');
const { loadPlugin, mockCtx, callRoute, ALICE_TRIP, BOB_TRIP, ALICE_RESV, BOB_RESV } = require('./helpers.js');

const plugin = loadPlugin();
const call = (p, req, ctx) => callRoute(plugin, p, req, ctx);
const alice = { id: 1, username: 'alice', isAdmin: false };
const body = (res) => JSON.parse(res.body);

for (const path of ['/status', '/refresh', '/set']) {
  test(path + ' refuses a reservation in a trip the user is not a member of', async () => {
    const ctx = mockCtx();
    const res = await call(path, { user: alice, query: {}, body: { tripId: BOB_TRIP, reservationId: BOB_RESV } }, ctx);
    // getReservations throws RESOURCE_FORBIDDEN for a non-member -> 403
    assert.strictEqual(res.status, 403, 'expected 403, got ' + res.status + ' ' + res.body);
  });

  test(path + ' refuses a reservation id that is not in the given trip', async () => {
    const ctx = mockCtx();
    const res = await call(path, { user: alice, query: {}, body: { tripId: ALICE_TRIP, reservationId: BOB_RESV } }, ctx);
    assert.strictEqual(res.status, 404, 'expected 404, got ' + res.status + ' ' + res.body);
  });

  test(path + ' refuses when tripId is missing (membership is unverifiable)', async () => {
    const ctx = mockCtx();
    const res = await call(path, { user: alice, query: {}, body: { reservationId: ALICE_RESV } }, ctx);
    assert.strictEqual(res.status, 400, 'expected 400, got ' + res.status);
  });

  test(path + ' allows the owner', async () => {
    const ctx = mockCtx();
    const res = await call(path, { user: alice, query: {}, body: { tripId: ALICE_TRIP, reservationId: ALICE_RESV } }, ctx);
    assert.strictEqual(res.status, 200, 'owner should be allowed, got ' + res.status + ' ' + res.body);
  });
}

test('a cache hit does not bypass the membership check', async () => {
  const ctx = mockCtx();
  // Bob views his own reservation, populating the shared cache.
  const bob = { id: 2, username: 'bob', isAdmin: false };
  const ok = await call('/status', { user: bob, query: {}, body: { tripId: BOB_TRIP, reservationId: BOB_RESV } }, ctx);
  assert.strictEqual(ok.status, 200);
  assert.ok(ctx._cacheRows().length > 0, 'precondition: cache should be populated');

  // Alice now asks for the same reservation id. Previously the cache SELECT was
  // keyed on reservation_id alone and answered before ctx.trips was consulted.
  const res = await call('/status', { user: alice, query: {}, body: { tripId: BOB_TRIP, reservationId: BOB_RESV } }, ctx);
  assert.strictEqual(res.status, 403, 'cached payload leaked across users: ' + res.status);
  assert.ok(!/LH|MUC|LAX/.test(res.body), 'response body leaked flight data: ' + res.body);
});

test('a foreign /set writes nothing to the override table or to TREK metadata', async () => {
  const ctx = mockCtx();
  const res = await call('/set', { user: alice, query: {}, body: { tripId: BOB_TRIP, reservationId: BOB_RESV, flightNumber: 'LH999' } }, ctx);
  assert.strictEqual(res.status, 403);
  assert.strictEqual(ctx._flightRows().length, 0, 'override row written for a foreign reservation');
  assert.deepStrictEqual(ctx._metaWrites, [], 'wrote into TREK reservation metadata without membership');
});

test('the trip a payload is cached under is the verified one, not the caller-supplied one', async () => {
  const ctx = mockCtx();
  // Alice may only reach her own trip; a mismatched tripId must never be persisted.
  await call('/set', { user: alice, query: {}, body: { tripId: BOB_TRIP, reservationId: ALICE_RESV, flightNumber: 'LH400' } }, ctx);
  const poisoned = ctx._cacheRows().filter((r) => String(r.trip_id) === String(BOB_TRIP));
  assert.strictEqual(poisoned.length, 0, 'a row was planted under another trip — it would surface in that trip\'s warnings/markers/PDF');
});

test('the payload no longer carries the booking reference', async () => {
  const ctx = mockCtx();
  const res = await call('/status', { user: alice, query: {}, body: { tripId: ALICE_TRIP, reservationId: ALICE_RESV } }, ctx);
  const p = body(res);
  assert.ok(!('pnr' in (p.booking || {})), 'booking.pnr is still exposed');
  assert.ok(!/ABC123/.test(res.body), 'PNR leaked into the payload');
});

test('/key rejects an API key supplied in the query string', async () => {
  const ctx = mockCtx();
  const admin = { id: 9, username: 'root', isAdmin: true };
  const res = await call('/key', { user: admin, query: { apiKey: 'LEAKED' }, body: {} }, ctx);
  assert.strictEqual(res.status, 400, 'query-string key should be refused, not silently ignored');
  assert.strictEqual(ctx._kv.get('aerodatabox_key'), undefined, 'query-string key was stored');
});

test('/key stays admin-only', async () => {
  const ctx = mockCtx();
  const res = await call('/key', { user: alice, query: {}, body: { apiKey: 'SEKRIT' } }, ctx);
  assert.strictEqual(res.status, 403);
  assert.strictEqual(ctx._kv.get('aerodatabox_key'), undefined);
});
