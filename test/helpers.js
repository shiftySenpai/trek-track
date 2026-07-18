// Test harness: loads server/index.js against a stubbed trek-plugin-sdk and an
// in-memory ctx, so routes and pure helpers can be exercised with no TREK host and
// no network. The plugin's internals are exposed via an appended __test export
// rather than by adding test hooks to the shipped source.
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
// FT_SERVER lets the suite be pointed at an older build of the server, to confirm
// a regression test actually fails against the code it was written to catch.
const ENTRY = process.env.FT_SERVER ? path.resolve(process.env.FT_SERVER) : path.join(ROOT, 'server', 'index.js');

// Fixtures. Reservation ids are deliberately adjacent integers — that is exactly
// how a real attacker would enumerate them.
const ALICE_TRIP = 1;
const BOB_TRIP = 2;
const ALICE_RESV = 100;
const BOB_RESV = 101;

const RESERVATIONS = {
  [ALICE_TRIP]: [{
    id: ALICE_RESV, type: 'flight', day_id: 10, end_day_id: 10,
    reservation_time: '2026-08-01T09:00', reservation_end_time: '2026-08-01T11:30',
    confirmation_number: 'ABC123',
    endpoints: [{ sequence: 0, code: 'VIE', local_time: '09:00', local_date: '2026-08-01' },
      { sequence: 1, code: 'FRA', local_time: '11:30', local_date: '2026-08-01' }],
    metadata: { airline: 'Lufthansa', flight_number: 'LH1234', seat: '3A' },
  }],
  [BOB_TRIP]: [{
    id: BOB_RESV, type: 'flight', day_id: 20, end_day_id: 20,
    reservation_time: '2026-08-02T14:00', reservation_end_time: '2026-08-02T22:00',
    confirmation_number: 'ZZZ999',
    endpoints: [{ sequence: 0, code: 'MUC', local_time: '14:00', local_date: '2026-08-02' },
      { sequence: 1, code: 'LAX', local_time: '22:00', local_date: '2026-08-02' }],
    metadata: { airline: 'Lufthansa', flight_number: 'LH452', seat: '14A' },
  }],
};

// Which trips each user may read. The real host enforces this; the mock mirrors it
// by throwing the same prefixed error the RPC boundary produces.
const MEMBERSHIP = { 1: [ALICE_TRIP], 2: [BOB_TRIP], 9: [ALICE_TRIP, BOB_TRIP] };

function loadPlugin() {
  const stubDir = path.join(os.tmpdir(), 'ft-test-sdk', 'node_modules', 'trek-plugin-sdk');
  fs.mkdirSync(stubDir, { recursive: true });
  fs.writeFileSync(path.join(stubDir, 'package.json'),
    JSON.stringify({ name: 'trek-plugin-sdk', version: '1.5.0', main: 'index.js' }));
  fs.writeFileSync(path.join(stubDir, 'index.js'), 'exports.definePlugin = (p) => p;\n');

  // typeof-guarded so the same harness can load an OLDER server build (via
  // FT_SERVER) that does not yet define all of these.
  const INTERNALS = ['splitFlight', 'airlineToIata', 'iataToIcao', 'icaoToIata', 'resolveLeg',
    'normName', 'coreName', 'canSetKey', 'getKey', 'requireOwnedReservation', 'parseDateTime',
    'buildPayload', 'layoverMinutes', 'srvStr'];
  const expose = INTERNALS.map((n) => `  ${n}: typeof ${n} !== 'undefined' ? ${n} : undefined,`).join('\n');
  const src = fs.readFileSync(ENTRY, 'utf8') + `\nmodule.exports.__test = {\n${expose}\n};\n`;
  const m = new Module(ENTRY, null);
  m.filename = ENTRY;
  m.paths = [path.join(os.tmpdir(), 'ft-test-sdk', 'node_modules')].concat(Module._nodeModulePaths(path.dirname(ENTRY)));
  m._compile(src, ENTRY);
  return m.exports;
}

// No network: every outbound call fails closed, so tests exercise the plugin's own
// logic and never depend on AeroDataBox or adsb.fi.
function stubFetch() {
  if (!global.fetch || !global.fetch.__stubbed) {
    const f = async () => { throw new Error('network disabled in tests'); };
    f.__stubbed = true;
    global.fetch = f;
  }
}

function mockCtx(opts) {
  stubFetch();
  const o = opts || {};
  const kv = new Map();
  const tables = { cache: [], flights: [], notif_state: [], cal_events: [] };
  const metaWrites = [];
  const asUser = o.userId != null ? o.userId : null;

  const ctx = {
    config: o.config || {},
    _kv: kv,
    _metaWrites: metaWrites,
    _cacheRows: () => tables.cache,
    _flightRows: () => tables.flights,
    _tables: tables,
    log: { info() {}, warn() {}, error() {} },
    trips: {
      async getReservations(tripId) {
        const uid = ctx._actingUser;
        const allowed = MEMBERSHIP[uid] || [];
        if (!allowed.map(String).includes(String(tripId))) {
          throw new Error('RESOURCE_FORBIDDEN: not a member of trip ' + tripId);
        }
        return RESERVATIONS[tripId] || [];
      },
      async getDays(tripId) {
        const uid = ctx._actingUser;
        const allowed = MEMBERSHIP[uid] || [];
        if (!allowed.map(String).includes(String(tripId))) throw new Error('RESOURCE_FORBIDDEN');
        return [{ id: 10, date: '2026-08-01' }, { id: 20, date: '2026-08-02' }];
      },
    },
    weather: { async get() { return null; } },
    notify: { async send() {} },
    meta: {
      async set(kind, id, k, v) { metaWrites.push({ kind, id, k, v }); },
      async delete(kind, id, k) { metaWrites.push({ kind, id, k, deleted: true }); },
    },
    db: {
      async migrate() {},
      async query(sql, ...args) {
        if (/FROM kv WHERE k = 'aerodatabox_key'/.test(sql)) {
          const v = kv.get('aerodatabox_key');
          return v ? [{ v }] : [];
        }
        if (/FROM cache WHERE reservation_id = \? AND trip_id IS \?/.test(sql)) {
          return tables.cache.filter((r) => String(r.reservation_id) === String(args[0]) &&
            String(r.trip_id) === String(args[1]));
        }
        if (/FROM cache WHERE trip_id/.test(sql)) return tables.cache.filter((r) => String(r.trip_id) === String(args[0]));
        if (/FROM flights WHERE reservation_id/.test(sql)) return tables.flights.filter((r) => String(r.reservation_id) === String(args[0]));
        if (/FROM notif_state/.test(sql)) return tables.notif_state.filter((r) => String(r.rid) === String(args[0]) && String(r.uid) === String(args[1]));
        if (/FROM cal_events WHERE uid/.test(sql)) return tables.cal_events.filter((r) => String(r.uid) === String(args[0]));
        return [];
      },
      async exec(sql, ...args) {
        if (/INSERT OR REPLACE INTO kv/.test(sql)) kv.set('aerodatabox_key', args[0]);
        else if (/DELETE FROM kv/.test(sql)) kv.delete('aerodatabox_key');
        else if (/INSERT OR REPLACE INTO cache/.test(sql)) {
          const [reservation_id, trip_id, payload, fetched_at] = args;
          const i = tables.cache.findIndex((r) => String(r.reservation_id) === String(reservation_id));
          const row = { reservation_id, trip_id, payload, fetched_at };
          if (i >= 0) tables.cache[i] = row; else tables.cache.push(row);
        } else if (/DELETE FROM cache WHERE reservation_id/.test(sql)) {
          tables.cache = tables.cache.filter((r) => String(r.reservation_id) !== String(args[0]));
          ctx._tables.cache = tables.cache;
        } else if (/^\s*DELETE FROM cache\s*$/.test(sql)) { tables.cache.length = 0; }
        else if (/INSERT OR REPLACE INTO flights/.test(sql)) {
          const [reservation_id, trip_id, flight_number, updated_at] = args;
          tables.flights.push({ reservation_id, trip_id, flight_number, updated_at });
        } else if (/DELETE FROM flights/.test(sql)) {
          tables.flights = tables.flights.filter((r) => String(r.reservation_id) !== String(args[0]));
        } else if (/INSERT OR REPLACE INTO notif_state/.test(sql)) {
          const [rid, uid, sig] = args;
          const i = tables.notif_state.findIndex((r) => String(r.rid) === String(rid) && String(r.uid) === String(uid));
          if (i >= 0) tables.notif_state[i].sig = sig; else tables.notif_state.push({ rid, uid, sig });
        } else if (/INSERT OR REPLACE INTO cal_events/.test(sql)) {
          const [uid, rid, trip_id, data, updated_at] = args;
          tables.cal_events.push({ uid, rid, trip_id, data, updated_at });
        } else if (/DELETE FROM cal_events/.test(sql)) {
          tables.cal_events = tables.cal_events.filter((r) => !(String(r.uid) === String(args[0]) && String(r.rid) === String(args[1])));
        }
      },
    },
  };
  ctx._actingUser = asUser;
  return ctx;
}

// Routes read req.user; the mock ctx needs the same identity for its membership
// check, so wrap the handler call to keep the two in sync.
function callRoute(plugin, pathName, req, ctx) {
  ctx._actingUser = req.user && req.user.id;
  return plugin.routes.find((r) => r.path === pathName).handler(req, ctx);
}

module.exports = { loadPlugin, mockCtx, callRoute, RESERVATIONS, MEMBERSHIP,
  ALICE_TRIP, BOB_TRIP, ALICE_RESV, BOB_RESV };
