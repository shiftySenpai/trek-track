// The userless hook providers (trip warnings, map markers, PDF, calendar).
//
// These run with no acting user, so they cannot membership-check anything and read
// only the plugin's own cache. That makes what gets WRITTEN into the cache a trust
// decision (covered in auth.test.js) and what they render a pure function of it.
const test = require('node:test');
const assert = require('node:assert');
const { loadPlugin, mockCtx, ALICE_TRIP } = require('./helpers.js');

const plugin = loadPlugin();
const T = plugin.__test;

function cachePayload(ctx, tripId, rid, payload, ageMs) {
  ctx._tables.cache.push({
    reservation_id: String(rid), trip_id: String(tripId),
    payload: JSON.stringify(payload), fetched_at: Date.now() - (ageMs || 0),
  });
}

const legFor = (number, from, to, over) => Object.assign({
  number, from, to, seat: '12C',
  status: {
    number, status: 'Expected', delayMin: null, depDelayMin: null,
    departure: { iata: from, name: from + ' Airport', lat: 10, lon: 10, terminal: '2', gate: 'A1', scheduled: '2026-08-01 08:00' },
    arrival: { iata: to, name: to + ' Airport', lat: 20, lon: 20, terminal: '1', gate: null, baggageBelt: '4', scheduled: '2026-08-01 10:00' },
  },
  live: null,
}, over || {});

// A round trip: the outbound origin is the return destination, and both legs of
// the outbound share a hub — four airport references over two distinct places.
function roundTrip(ctx) {
  cachePayload(ctx, ALICE_TRIP, 1, {
    applicable: true, legs: [legFor('LH100', 'VIE', 'FRA')], booking: { phase: 'active' },
  });
  cachePayload(ctx, ALICE_TRIP, 2, {
    applicable: true, legs: [legFor('LH101', 'FRA', 'VIE')], booking: { phase: 'active' },
  });
}

test('airports are not duplicated across legs or reservations', async () => {
  const ctx = mockCtx();
  roundTrip(ctx);
  const markers = await plugin.hooks.mapMarkerProvider.getMarkers(ALICE_TRIP, ctx);
  const airports = markers.filter((m) => !m.icon);
  const labels = airports.map((m) => m.label).sort();
  assert.deepStrictEqual(labels, ['FRA', 'VIE'],
    'a round trip stacked two pins per airport: ' + JSON.stringify(labels));
  const ids = markers.map((m) => m.id);
  assert.strictEqual(new Set(ids).size, ids.length, 'duplicate marker ids');
  // the merged pin still names every flight touching it
  const fra = airports.find((m) => m.label === 'FRA');
  assert.match(fra.popupText, /LH 100/);
  assert.match(fra.popupText, /LH 101/);
});

test('a live aircraft is still its own marker', async () => {
  const ctx = mockCtx();
  cachePayload(ctx, ALICE_TRIP, 1, {
    applicable: true, booking: { phase: 'active' },
    legs: [legFor('LH100', 'VIE', 'FRA', { live: { lat: 15, lon: 15, onGround: false, type: 'A320', altBaro: 30000 } })],
  });
  const markers = await plugin.hooks.mapMarkerProvider.getMarkers(ALICE_TRIP, ctx);
  assert.strictEqual(markers.filter((m) => m.icon === 'plane').length, 1);
});

test('the PDF carries what you need with no app and no network', async () => {
  const ctx = mockCtx();
  cachePayload(ctx, ALICE_TRIP, 1, {
    applicable: true, booking: { phase: 'active' },
    legs: [legFor('LH100', 'VIE', 'FRA')],
  });
  const sections = await plugin.hooks.pdfSectionProvider.getSections(ALICE_TRIP, ctx);
  assert.strictEqual(sections.length, 1);
  const { headers, rows } = sections[0].table;
  assert.ok(headers.includes('Seat'), 'seat missing from the PDF');
  assert.ok(headers.includes('Date'), 'date missing — two legs on different days were indistinguishable');
  const row = rows[0].join(' | ');
  assert.match(row, /12C/, 'seat value missing');
  assert.match(row, /T2 Gate A1/, 'departure terminal/gate missing');
  assert.match(row, /Belt 4/, 'baggage belt missing');
});

test('trip warnings are English, not German, and cover departure delay', async () => {
  const ctx = mockCtx();
  cachePayload(ctx, ALICE_TRIP, 1, {
    applicable: true, booking: { phase: 'active' },
    legs: [legFor('LH100', 'VIE', 'FRA', {
      status: Object.assign(legFor('LH100', 'VIE', 'FRA').status, { depDelayMin: 45 }) })],
  });
  const warnings = await plugin.hooks.warningProvider.getWarnings(ALICE_TRIP, ctx);
  assert.strictEqual(warnings.length, 1, JSON.stringify(warnings));
  assert.match(warnings[0].message, /late/, 'expected English: ' + warnings[0].message);
  assert.doesNotMatch(warnings[0].message, /verspaetet|verspätet/);
});

test('stale cache rows are ignored by the warning provider', async () => {
  const ctx = mockCtx();
  cachePayload(ctx, ALICE_TRIP, 1, {
    applicable: true, booking: { phase: 'active' },
    legs: [legFor('LH100', 'VIE', 'FRA', {
      status: Object.assign(legFor('LH100', 'VIE', 'FRA').status, { status: 'Canceled' }) })],
  }, 45 * 60 * 1000);
  const warnings = await plugin.hooks.warningProvider.getWarnings(ALICE_TRIP, ctx);
  assert.deepStrictEqual(warnings, [], 'a 45-minute-old row must not drive a live warning');
});

test('hooks never throw, whatever is in the cache', async () => {
  const ctx = mockCtx();
  ctx._tables.cache.push({ reservation_id: '1', trip_id: String(ALICE_TRIP), payload: '{not json', fetched_at: Date.now() });
  ctx._tables.cache.push({ reservation_id: '2', trip_id: String(ALICE_TRIP), payload: JSON.stringify({ legs: null }), fetched_at: Date.now() });
  assert.deepStrictEqual(await plugin.hooks.warningProvider.getWarnings(ALICE_TRIP, ctx), []);
  assert.deepStrictEqual(await plugin.hooks.mapMarkerProvider.getMarkers(ALICE_TRIP, ctx), []);
  assert.deepStrictEqual(await plugin.hooks.pdfSectionProvider.getSections(ALICE_TRIP, ctx), []);
});
