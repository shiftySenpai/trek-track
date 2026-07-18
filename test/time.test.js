// Time base, lookup pinning and alerting.
//
// These are the bugs that made the widget lie during exactly the disruption it
// exists to cover: a wrapped layover, a host-timezone-dependent countdown, a
// red-eye showing yesterday's operation, and a delay that was invisible unless it
// happened to move the ARRIVAL estimate.
const test = require('node:test');
const assert = require('node:assert');
const { loadPlugin, mockCtx } = require('./helpers.js');

const T = loadPlugin().__test;
const H = 3600 * 1000;

test('reservation times parse identically regardless of the host timezone', () => {
  // Previously Date.parse() applied the SERVER's offset to a naive local string, so
  // the same reservation produced a different instant on a different host.
  const a = T.parseDateTime('2026-08-01T09:00');
  assert.strictEqual(a.ms, Date.UTC(2026, 7, 1, 9, 0, 0));
  assert.strictEqual(a.date, '2026-08-01');
  assert.strictEqual(a.estimated, true, 'must be flagged as an estimate, not a true instant');
  // date-only input falls back to midday
  assert.strictEqual(T.parseDateTime('2026-08-01').ms, Date.UTC(2026, 7, 1, 12, 0, 0));
  assert.strictEqual(T.parseDateTime(''), null);
});

test('cache TTL follows time-to-departure instead of pinning 60s for two days', () => {
  const now = Date.now();
  const p = (over) => Object.assign({ booking: { phase: 'active', depMs: now + 30 * H }, legs: [] }, over);

  // Far out, nothing moves — the old code refreshed every 60s for 48h straight.
  assert.strictEqual(T.ttlFor(p({ booking: { phase: 'active', depMs: now + 60 * H } })), 2 * H);
  assert.strictEqual(T.ttlFor(p({ booking: { phase: 'active', depMs: now + 30 * H } })), 30 * 60 * 1000);
  assert.strictEqual(T.ttlFor(p({ booking: { phase: 'active', depMs: now + 6 * H } })), 5 * 60 * 1000);
  // The hours that actually decide your day.
  assert.strictEqual(T.ttlFor(p({ booking: { phase: 'active', depMs: now + 1 * H } })), 60 * 1000);
  assert.strictEqual(T.ttlFor(p({ booking: { phase: 'past', depMs: now - 40 * H } })), 6 * H);
  // Airborne always refreshes fast, however far the clock estimate is off.
  assert.strictEqual(
    T.ttlFor({ booking: { phase: 'active', depMs: now + 60 * H }, legs: [{ status: { status: 'EnRoute' } }] }),
    60 * 1000, 'an en-route flight must refresh every minute');
});

test('departure delay is computed, not just arrival delay', () => {
  const f = {
    number: 'LH400',
    departure: {
      scheduledTime: { utc: '2026-08-01 10:00Z', local: '2026-08-01 12:00+02:00' },
      revisedTime: { utc: '2026-08-01 12:00Z', local: '2026-08-01 14:00+02:00' },
      airport: { iata: 'FRA' },
    },
    arrival: {  // arrival estimate has NOT moved — the old code saw no delay at all
      scheduledTime: { utc: '2026-08-01 18:00Z' },
      airport: { iata: 'JFK' },
    },
  };
  const n = T.normaliseAero(f);
  assert.strictEqual(n.depDelayMin, 120, 'a 2h departure slip must be visible');
  assert.strictEqual(n.delayMin, null, 'arrival delay legitimately unknown here');
});

// --- red-eye date pinning ---------------------------------------------------
function stubFetchOnce(payload) {
  const prev = global.fetch;
  global.fetch = async () => ({
    ok: true, status: 200,
    text: async () => JSON.stringify(payload),
  });
  return () => { global.fetch = prev; };
}

test('a red-eye picks the operation departing on the pinned date', async () => {
  // dateLocalRole=Both also returns the PREVIOUS day's flight when it ARRIVES on
  // the pinned date. The closest-to-now tie-break reliably chose that wrong one,
  // showing yesterday's gate, status and delay.
  const yesterday = {
    number: 'LH400', status: 'Arrived',
    departure: { scheduledTime: { local: '2026-07-31 23:40+02:00', utc: '2026-07-31 21:40Z' }, airport: { iata: 'FRA' }, gate: 'OLD' },
    arrival: { scheduledTime: { local: '2026-08-01 07:10+02:00', utc: '2026-08-01 05:10Z' }, airport: { iata: 'JFK' } },
  };
  const today = {
    number: 'LH400', status: 'Expected',
    departure: { scheduledTime: { local: '2026-08-01 23:40+02:00', utc: '2026-08-01 21:40Z' }, airport: { iata: 'FRA' }, gate: 'NEW' },
    arrival: { scheduledTime: { local: '2026-08-02 07:10+02:00', utc: '2026-08-02 05:10Z' }, airport: { iata: 'JFK' } },
  };
  const restore = stubFetchOnce([yesterday, today]);
  try {
    const r = await T.fetchAero('LH400', 'KEY', '2026-08-01');
    assert.ok(r.data, 'expected a result');
    assert.strictEqual(r.data.departure.gate, 'NEW', 'returned the previous day\'s operation');
    assert.strictEqual(r.data.status, 'Expected');
  } finally { restore(); }
});

test('the date filter falls back rather than blanking the widget', async () => {
  const other = {
    number: 'LH400', status: 'Expected',
    departure: { scheduledTime: { local: '2026-07-30 08:00+02:00', utc: '2026-07-30 06:00Z' }, airport: { iata: 'FRA' }, gate: 'X' },
    arrival: { scheduledTime: { local: '2026-07-30 10:00+02:00' }, airport: { iata: 'JFK' } },
  };
  const restore = stubFetchOnce([other]);
  try {
    const r = await T.fetchAero('LH400', 'KEY', '2026-08-01');
    assert.ok(r.data, 'no same-day candidate must fall back, not return nothing');
    assert.strictEqual(r.data.departure.gate, 'X');
  } finally { restore(); }
});

// --- notification baseline --------------------------------------------------
const legWith = (over) => ({
  number: 'LH400',
  status: Object.assign({
    status: 'Expected', delayMin: null, depDelayMin: null,
    departure: { gate: 'A12' }, arrival: { gate: null },
  }, over),
});
const payloadOf = (legs) => ({ booking: { phase: 'active' }, legs });
const user = { id: 1 };

test('a transient status blip does not fire phantom alerts', async () => {
  const ctx = mockCtx();
  // 1. baseline established from real data
  await T.maybeNotify(ctx, user, '100', payloadOf([legWith({})]), 'en');
  assert.strictEqual(ctx._notifications.length, 0, 'baseline must not notify');

  // 2. an API timeout / 429 / removed key -> status is null for this poll
  await T.maybeNotify(ctx, user, '100', payloadOf([{ number: 'LH400', status: null }]), 'en');
  assert.strictEqual(ctx._notifications.length, 0, 'a blank poll must not notify');

  // 3. the next successful poll returns exactly the same data as the baseline.
  //    Previously step 2 stored all-nulls, so this looked like a brand new gate
  //    assignment and fired "Gate A12" for an event that never happened.
  await T.maybeNotify(ctx, user, '100', payloadOf([legWith({})]), 'en');
  assert.deepStrictEqual(ctx._notifications, [], 'phantom alert after a transient blip');
});

test('a real change still notifies, in the caller\'s language', async () => {
  const ctx = mockCtx();
  await T.maybeNotify(ctx, user, '100', payloadOf([legWith({})]), 'en');
  await T.maybeNotify(ctx, user, '100', payloadOf([legWith({ status: 'Canceled' })]), 'en');
  assert.strictEqual(ctx._notifications.length, 1);
  assert.match(ctx._notifications[0].body, /cancelled/i);

  const de = mockCtx();
  await T.maybeNotify(de, user, '100', payloadOf([legWith({})]), 'de-DE');
  await T.maybeNotify(de, user, '100', payloadOf([legWith({ status: 'Canceled' })]), 'de-DE');
  assert.match(de._notifications[0].body, /annulliert/);
});

test('an unknown locale falls back to English, not German', async () => {
  // The server strings used to be German-only regardless of locale.
  const S = T.srvStr('fr-FR');
  assert.strictEqual(S.cancelled, 'Flight cancelled');
  assert.strictEqual(T.srvStr(null).arrived, 'Landed');
  assert.strictEqual(T.srvStr('de').arrived, 'Gelandet');
});

test('a departure-only delay raises an alert', async () => {
  const ctx = mockCtx();
  await T.maybeNotify(ctx, user, '100', payloadOf([legWith({})]), 'en');
  // arrival estimate unmoved; only the departure slipped
  await T.maybeNotify(ctx, user, '100', payloadOf([legWith({ depDelayMin: 45 })]), 'en');
  assert.strictEqual(ctx._notifications.length, 1, 'a departure-only delay must alert');
  assert.match(ctx._notifications[0].body, /45/);
});
