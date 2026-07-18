// Flight-number and airline-name resolution.
//
// Regression cover for the v1.8.0 parser fix: IATA airline designators are two
// ALPHANUMERIC characters, and ~40% of them contain a digit. A letters-only prefix
// regex silently made those flights unqueryable ("F91234" -> "F" + "91234", five
// digits, no match), which is why Frontier only worked WITHOUT its prefix while
// Delta only worked WITH it.
const test = require('node:test');
const assert = require('node:assert');
const { loadPlugin } = require('./helpers.js');

const T = loadPlugin().__test;

const split = (s) => { const r = T.splitFlight(s); return r ? r.prefix + '|' + r.digits + (r.suffix || '') : null; };
const resolve = (flight, airline) => {
  const r = T.resolveLeg({ flight, airline });
  return r.number + (r.callsign ? '/' + r.callsign : '');
};

test('splits alphanumeric IATA prefixes', () => {
  assert.strictEqual(split('F91234'), 'F9|1234');   // the originally reported break
  assert.strictEqual(split('F9123'), 'F9|123');
  assert.strictEqual(split('F9 1234'), 'F9|1234');
  assert.strictEqual(split('U21234'), 'U2|1234');
  assert.strictEqual(split('6E123'), '6E|123');     // digit first
  assert.strictEqual(split('W62411'), 'W6|2411');
});

test('still splits ordinary letter prefixes and ICAO forms', () => {
  assert.strictEqual(split('LH400'), 'LH|400');
  assert.strictEqual(split('DL1234'), 'DL|1234');
  assert.strictEqual(split('DLH400'), 'DLH|400');
  assert.strictEqual(split('LH400A'), 'LH|400A');
});

test('a bare number is not mistaken for an airline code', () => {
  // Regression: an all-digit "code" in the dataset made "1234" parse as "12"+"34".
  assert.strictEqual(split('1234'), '|1234');
  assert.strictEqual(split('123'), '|123');
});

test('rejects nonsense', () => {
  assert.strictEqual(split('!!!'), null);
  assert.strictEqual(split(''), null);
});

test('matches airline names loosely', () => {
  assert.strictEqual(T.airlineToIata('Delta Airlines'), 'DL');      // the reported break
  assert.strictEqual(T.airlineToIata('Delta Air Lines'), 'DL');
  assert.strictEqual(T.airlineToIata('Delta Air Lines, Inc.'), 'DL');
  assert.strictEqual(T.airlineToIata('delta'), 'DL');
  assert.strictEqual(T.airlineToIata('Frontier Airlines'), 'F9');
  assert.strictEqual(T.airlineToIata('Lufthansa'), 'LH');
  assert.strictEqual(T.airlineToIata('Whatever', 'BA'), 'BA');      // explicit code wins
  assert.strictEqual(T.airlineToIata('Not An Airline At All'), '');
});

test('brand-name collisions resolve to the airline people mean', () => {
  // OpenFlights alone maps these to a defunct carrier; the override layer fixes them.
  assert.strictEqual(T.airlineToIata('IndiGo'), '6E');   // not I9 (defunct US Indigo)
  assert.strictEqual(T.airlineToIata('Scoot'), 'TR');    // not the retired TZ
  assert.strictEqual(T.airlineToIata('Condor'), 'DE');
  assert.strictEqual(T.airlineToIata('Level'), 'LL');
});

test('a flight resolves identically however the user types it', () => {
  // This is the property the bug broke: detection and manual entry must agree.
  const expected = 'F91234/FFT1234';
  assert.strictEqual(resolve('1234', 'Frontier Airlines'), expected);
  assert.strictEqual(resolve('F91234', 'Frontier Airlines'), expected);
  assert.strictEqual(resolve('F9 1234', null), expected);

  assert.strictEqual(resolve('1234', 'Delta Airlines'), 'DL1234/DAL1234');
  assert.strictEqual(resolve('DL1234', 'Delta Airlines'), 'DL1234/DAL1234');

  assert.strictEqual(resolve('900', 'United Airlines'), 'UA900/UAL900');
  assert.strictEqual(resolve('UA900', 'United Airlines'), 'UA900/UAL900');

  assert.strictEqual(resolve('DLH400', 'Lufthansa'), 'LH400/DLH400');   // ICAO -> IATA
});

test('an unresolvable airline yields no query rather than a wrong one', () => {
  // A wrong code silently returns someone else's flight — worse than no result.
  assert.strictEqual(resolve('1234', 'Nonexistent Air'), '');
});

test('canSetKey is strictly admin-only', () => {
  assert.strictEqual(T.canSetKey({}, { id: 1, isAdmin: true }), true);
  assert.strictEqual(T.canSetKey({}, { id: 1, is_admin: true }), true);
  assert.strictEqual(T.canSetKey({}, { id: 2, isAdmin: false }), false);
  assert.strictEqual(T.canSetKey({}, { id: 1, role: 'admin' }), false);  // TREK 3.3 shape
  assert.strictEqual(T.canSetKey({}, null), false);
});

test('an admin-configured key takes precedence over a widget-stored one', async () => {
  const { mockCtx } = require('./helpers.js');
  const ctx = mockCtx({ config: { aerodatabox_key: 'FROM_CONFIG' } });
  ctx._kv.set('aerodatabox_key', 'FROM_WIDGET');
  assert.strictEqual(await T.getKey(ctx), 'FROM_CONFIG');

  const ctx2 = mockCtx();
  ctx2._kv.set('aerodatabox_key', 'FROM_WIDGET');
  assert.strictEqual(await T.getKey(ctx2), 'FROM_WIDGET');
  assert.strictEqual(await T.getKey(mockCtx()), '');
});
