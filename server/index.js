// Flight Tracker — TREK reservation-detail widget.
// Combines AeroDataBox (schedule/status, needs a RapidAPI key) with
// adsb.fi opendata (live airborne position, free/no key). Handles multi-leg
// flights (each leg has its own airline + flight number). Runs in an isolated
// child process; all host access is via `ctx`.
const { definePlugin } = require('trek-plugin-sdk');

// Full airline dataset (OpenFlights-derived), bundled under server/data.
let DATA = { nameToIata: {}, iataIcao: {} };
try { DATA = require('./data/airlines.json'); } catch (_e) { /* optional */ }

const ADSB_HOST = 'https://opendata.adsb.fi/api';
const AERO_HOST = 'https://aerodatabox.p.rapidapi.com';

const CACHE_TTL_MS = 45 * 1000;
const FETCH_TIMEOUT_MS = 8000;
const MAX_LEGS = 6;

// Curated overrides — win over the dataset (fixes cargo/subsidiary IATA clashes
// like LH -> DLH, not GEC). Names lowercased.
const CURATED_IATA = {
  'austrian': 'OS', 'austrian airlines': 'OS', 'lufthansa': 'LH', 'swiss': 'LX',
  'eurowings': 'EW', 'brussels airlines': 'SN', 'air france': 'AF', 'klm': 'KL',
  'british airways': 'BA', 'iberia': 'IB', 'vueling': 'VY', 'ryanair': 'FR',
  'easyjet': 'U2', 'wizz air': 'W6', 'turkish airlines': 'TK', 'emirates': 'EK',
  'qatar airways': 'QR', 'etihad': 'EY', 'etihad airways': 'EY', 'united': 'UA',
  'united airlines': 'UA', 'american airlines': 'AA', 'delta': 'DL', 'delta air lines': 'DL',
  'ita airways': 'AZ', 'alitalia': 'AZ', 'condor': 'DE', 'sas': 'SK', 'finnair': 'AY',
  'norwegian': 'DY', 'tap air portugal': 'TP', 'aer lingus': 'EI', 'aegean': 'A3',
  'lot polish airlines': 'LO', 'transavia': 'HV', 'edelweiss': 'WK', 'sunexpress': 'XQ',
};
const CURATED_ICAO = {
  OS: 'AUA', LH: 'DLH', LX: 'SWR', EW: 'EWG', SN: 'BEL', AF: 'AFR', KL: 'KLM', BA: 'BAW',
  IB: 'IBE', VY: 'VLG', FR: 'RYR', U2: 'EZY', W6: 'WZZ', TK: 'THY', EK: 'UAE', QR: 'QTR',
  EY: 'ETD', UA: 'UAL', AA: 'AAL', DL: 'DAL', AZ: 'ITY', DE: 'CFG', SK: 'SAS', AY: 'FIN',
  DY: 'NAX', TP: 'TAP', EI: 'EIN', A3: 'AEE', LO: 'LOT', HV: 'TRA', WK: 'EDW', XQ: 'SXS',
};

// --- small helpers ----------------------------------------------------------

async function attempt(fn, fallback) {
  try { return await fn(); } catch (_e) { return fallback; }
}

async function fetchJson(url, options) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, Object.assign({ signal: ctrl.signal }, options));
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_e) { data = null; }
    return { ok: res.ok, status: res.status, data, error: res.ok ? null : (data && (data.message || data.error)) || ('HTTP ' + res.status) };
  } catch (e) {
    return { ok: false, status: 0, data: null, error: e.name === 'AbortError' ? 'timeout' : String(e && e.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

function normNumber(raw) {
  if (!raw) return '';
  return String(raw).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
}

function splitFlight(raw) {
  const s = normNumber(raw);
  const m = s.match(/^([A-Z]{1,3})?(\d{1,4})([A-Z]?)$/);
  if (!m) return null;
  return { prefix: m[1] || '', digits: m[2], suffix: m[3] || '' };
}

function airlineToIata(name, code) {
  if (code) { const c = String(code).toUpperCase().replace(/[^A-Z0-9]/g, ''); if (/^[A-Z0-9]{2}$/.test(c)) return c; }
  if (name) {
    const k = String(name).toLowerCase().trim();
    if (CURATED_IATA[k]) return CURATED_IATA[k];
    if (DATA.nameToIata[k]) return DATA.nameToIata[k];
  }
  return '';
}

function iataToIcao(iata, code) {
  if (code) { const c = String(code).toUpperCase().replace(/[^A-Z]/g, ''); if (/^[A-Z]{3}$/.test(c)) return c; }
  if (iata) { if (CURATED_ICAO[iata]) return CURATED_ICAO[iata]; if (DATA.iataIcao[iata]) return DATA.iataIcao[iata]; }
  return '';
}

function parseMeta(r) {
  if (!r) return {};
  let m = r.metadata != null ? r.metadata : r.meta;
  if (typeof m === 'string') { try { m = JSON.parse(m || '{}'); } catch (_e) { m = {}; } }
  return (m && typeof m === 'object') ? m : {};
}

// Ordered endpoints (from -> stops -> to), by `sequence`.
function orderedEndpoints(r) {
  if (!Array.isArray(r.endpoints)) return [];
  return r.endpoints.slice().sort((a, b) => (a.sequence || 0) - (b.sequence || 0));
}

// Mirror of TREK's getFlightLegs: metadata.legs is the source of truth for
// multi-leg; otherwise a single leg from the ordered endpoints + flat metadata.
function getFlightLegs(r) {
  const meta = parseMeta(r);
  if (Array.isArray(meta.legs) && meta.legs.length) {
    return meta.legs.slice(0, MAX_LEGS).map((l) => ({
      from: l.from || null, to: l.to || null,
      airline: l.airline || null, airlineCode: l.airline_code || null,
      flight: l.flight_number || l.flightNumber || null,
      depTime: l.dep_time || null, arrTime: l.arr_time || null,
    }));
  }
  const eps = orderedEndpoints(r);
  const first = eps[0], last = eps[eps.length - 1];
  const from = (first && first.code) || meta.departure_airport || null;
  const to = (last && last.code) || meta.arrival_airport || null;
  if (!from && !to && !meta.flight_number) return [];
  return [{
    from, to,
    airline: meta.airline || null, airlineCode: meta.airline_code || null,
    flight: meta.flight_number || meta.flightNumber || null,
    depTime: (first && first.local_time) || null,
    arrTime: (last && last.local_time) || null,
  }];
}

// Resolve a raw leg into queryable identifiers.
function resolveLeg(leg) {
  let number = '', callsign = '';
  const sf = leg.flight ? splitFlight(leg.flight) : null;
  if (sf) {
    const prefix = sf.prefix || airlineToIata(leg.airline, leg.airlineCode);
    if (prefix) number = prefix + sf.digits + sf.suffix;
    const icao = iataToIcao(sf.prefix || prefix, leg.airlineCode);
    if (icao) callsign = icao + sf.digits + sf.suffix;
  }
  return {
    number, callsign, airline: leg.airline, from: leg.from, to: leg.to,
    depTime: leg.depTime, arrTime: leg.arrTime, rawFlight: leg.flight,
  };
}

// --- external data sources ---------------------------------------------------

async function fetchAero(number, key) {
  if (!key || !number) return { data: null, error: null };
  const url = AERO_HOST + '/flights/number/' + encodeURIComponent(number) +
    '?withAircraftImage=false&withLocation=false&dateLocalRole=Both';
  const r = await fetchJson(url, {
    headers: { 'x-rapidapi-key': key, 'x-rapidapi-host': 'aerodatabox.p.rapidapi.com' },
  });
  if (!r.ok) return { data: null, error: r.error || 'aerodatabox error' };
  const list = Array.isArray(r.data) ? r.data
    : (r.data && Array.isArray(r.data.flights) ? r.data.flights
      : (r.data && r.data.departure ? [r.data] : []));
  if (!list.length) return { data: null, error: null };
  const now = Date.now();
  list.sort((a, b) => Math.abs(depTime(a) - now) - Math.abs(depTime(b) - now));
  return { data: normaliseAero(list[0]), error: null };
}

function depTime(f) {
  const t = f && f.departure && (f.departure.scheduledTime || f.departure.revisedTime);
  const s = t && (t.utc || t.local);
  const n = s ? Date.parse(s) : NaN;
  return isNaN(n) ? 0 : n;
}

function pickTime(block) {
  if (!block) return null;
  const revised = block.revisedTime || block.predictedTime || block.runwayTime;
  const scheduled = block.scheduledTime;
  return {
    scheduled: (scheduled && (scheduled.local || scheduled.utc)) || null,
    revised: (revised && (revised.local || revised.utc)) || null,
    scheduledUtc: (scheduled && scheduled.utc) || null,
    revisedUtc: (revised && revised.utc) || null,
  };
}

function normaliseAero(f) {
  const dep = f.departure || {};
  const arr = f.arrival || {};
  const dt = pickTime(dep);
  const at = pickTime(arr);
  let delayMin = null;
  if (at && at.revisedUtc && at.scheduledUtc) {
    const d = Math.round((Date.parse(at.revisedUtc) - Date.parse(at.scheduledUtc)) / 60000);
    delayMin = isNaN(d) ? null : d;
  }
  return {
    number: (f.number || '').toString(),
    callSign: f.callSign || null,
    status: f.status || 'Unknown',
    airline: (f.airline && f.airline.name) || null,
    aircraftModel: (f.aircraft && f.aircraft.model) || null,
    aircraftReg: (f.aircraft && f.aircraft.reg) || null,
    delayMin: delayMin,
    departure: airportBlock(dep, dt),
    arrival: airportBlock(arr, at),
  };
}

function airportBlock(block, times) {
  const ap = block.airport || {};
  return {
    iata: ap.iata || ap.icao || null,
    name: ap.shortName || ap.name || ap.municipalityName || null,
    terminal: block.terminal || null,
    gate: block.gate || null,
    baggageBelt: block.baggageBelt || null,
    scheduled: times ? times.scheduled : null,
    revised: times ? times.revised : null,
  };
}

async function fetchLive(opts) {
  const tries = [];
  if (opts.reg) tries.push('/v2/registration/' + encodeURIComponent(opts.reg));
  if (opts.callSign) tries.push('/v2/callsign/' + encodeURIComponent(normNumber(opts.callSign)));
  if (opts.callsignHint) tries.push('/v2/callsign/' + encodeURIComponent(normNumber(opts.callsignHint)));
  if (opts.number) tries.push('/v2/callsign/' + encodeURIComponent(opts.number));
  const seen = {};
  for (const path of tries) {
    if (seen[path]) continue; seen[path] = 1;
    const r = await fetchJson(ADSB_HOST + path, { headers: { accept: 'application/json' } });
    if (r.ok && r.data && Array.isArray(r.data.ac) && r.data.ac.length) {
      return { data: normaliseLive(r.data.ac[0]), error: null };
    }
  }
  return { data: null, error: null };
}

function num(v) { return (typeof v === 'number' && isFinite(v)) ? v : null; }

function normaliseLive(ac) {
  const alt = ac.alt_baro === 'ground' ? 'ground' : num(ac.alt_baro);
  return {
    hex: ac.hex || null,
    callSign: (ac.flight || '').trim() || null,
    reg: ac.r || null,
    type: ac.t || null,
    desc: ac.desc || null,
    lat: num(ac.lat),
    lon: num(ac.lon),
    altBaro: alt,
    groundSpeed: num(ac.gs),
    track: num(ac.track),
    verticalRate: num(ac.baro_rate) != null ? num(ac.baro_rate) : num(ac.geom_rate),
    squawk: ac.squawk || null,
    onGround: alt === 'ground',
    seenPos: num(ac.seen_pos),
  };
}

// Fetch status + live for one resolved leg.
async function trackLeg(leg, key) {
  const errors = [];
  const aero = await fetchAero(leg.number, key);
  if (aero.error) errors.push('status: ' + aero.error);
  const status = aero.data;
  const live = await fetchLive({
    reg: status && status.aircraftReg,
    callSign: status && status.callSign,
    callsignHint: leg.callsign,
    number: leg.number,
  });
  if (live.error) errors.push('live: ' + live.error);
  return Object.assign({}, leg, { status, live: live.data, errors });
}

// --- key resolution: user setting > instance config > in-widget stored key ---

async function getKey(ctx) {
  const u = await attempt(() => ctx.settings.get('aerodatabox_key'), null);
  if (u) return String(u);
  if (ctx.config && ctx.config.aerodatabox_key) return String(ctx.config.aerodatabox_key);
  const rows = await attempt(() => ctx.db.query("SELECT v FROM kv WHERE k = 'aerodatabox_key'"), []);
  if (rows && rows[0] && rows[0].v) return String(rows[0].v);
  return '';
}

// --- core: build the combined payload for a reservation ----------------------

async function readReservation(ctx, tripId, reservationId) {
  return attempt(async () => {
    const list = await ctx.trips.getReservations(Number(tripId));
    return (list || []).find((x) => String(x.id) === String(reservationId)) || null;
  }, null);
}

async function buildPayload(ctx, tripId, reservationId, forcedNumber) {
  const key = await getKey(ctx);
  const hasKey = !!key;

  // A manual/stored override replaces detection with a single leg.
  let overrideNumber = normNumber(forcedNumber);
  let source = overrideNumber ? 'manual' : 'none';
  if (!overrideNumber) {
    const rows = await attempt(() => ctx.db.query('SELECT flight_number FROM flights WHERE reservation_id = ?', reservationId), []);
    if (rows && rows[0] && rows[0].flight_number) { overrideNumber = normNumber(rows[0].flight_number); source = 'stored'; }
  }

  const resv = tripId ? await readReservation(ctx, tripId, reservationId) : null;
  const bookingType = resv ? (resv.type || parseMeta(resv).type || null) : null;
  const booking = { type: bookingType };

  let rawLegs;
  if (overrideNumber) {
    const sf = splitFlight(overrideNumber);
    rawLegs = [resolveLeg({ flight: overrideNumber, airline: null, from: null, to: null })];
    // keep number as typed even if it had no prefix
    if (rawLegs[0] && !rawLegs[0].number) rawLegs[0].number = overrideNumber;
  } else {
    rawLegs = resv ? getFlightLegs(resv).map(resolveLeg) : [];
    if (rawLegs.length) source = 'detected';
  }

  // Only legs we can actually query.
  const queryable = rawLegs.filter((l) => l.number);

  if (!queryable.length) {
    const applicable = !bookingType || bookingType === 'flight';
    return { applicable, source: 'none', hasKey, legs: [], booking,
      // surface any detected-but-unqueryable legs so the UI can hint
      hint: rawLegs.length ? rawLegs.map((l) => ({ airline: l.airline, from: l.from, to: l.to, rawFlight: l.rawFlight })) : null,
      updatedAt: Date.now() };
  }

  // Track each leg (parallel; cache dedups repeat load).
  const legs = await Promise.all(queryable.map((l) => attempt(() => trackLeg(l, key), Object.assign({}, l, { status: null, live: null, errors: ['failed'] }))));

  return { applicable: true, source, hasKey, legs, booking, updatedAt: Date.now() };
}

async function cachedPayload(ctx, tripId, reservationId, force, forcedNumber) {
  if (!force && !forcedNumber) {
    const rows = await attempt(() => ctx.db.query('SELECT payload, fetched_at FROM cache WHERE reservation_id = ?', reservationId), []);
    if (rows && rows[0] && (Date.now() - Number(rows[0].fetched_at)) < CACHE_TTL_MS) {
      try { return Object.assign(JSON.parse(rows[0].payload), { cached: true }); } catch (_e) { /* refetch */ }
    }
  }
  const payload = await buildPayload(ctx, tripId, reservationId, forcedNumber);
  await attempt(() => ctx.db.exec(
    'INSERT OR REPLACE INTO cache (reservation_id, payload, fetched_at) VALUES (?, ?, ?)',
    reservationId, JSON.stringify(payload), Date.now()));
  return payload;
}

function json(status, body) {
  return { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: JSON.stringify(body) };
}

function readParams(req) {
  const q = req.query || {};
  const b = (req.body && typeof req.body === 'object') ? req.body : {};
  return {
    tripId: b.tripId != null ? b.tripId : q.tripId,
    reservationId: b.reservationId != null ? b.reservationId : q.reservationId,
    flightNumber: b.flightNumber != null ? b.flightNumber : q.flightNumber,
    apiKey: b.apiKey != null ? b.apiKey : q.apiKey,
  };
}

module.exports = definePlugin({
  async onLoad(ctx) {
    await ctx.db.migrate('001_flights',
      'CREATE TABLE IF NOT EXISTS flights (reservation_id TEXT PRIMARY KEY, trip_id TEXT, flight_number TEXT, updated_at INTEGER)');
    await ctx.db.migrate('002_cache',
      'CREATE TABLE IF NOT EXISTS cache (reservation_id TEXT PRIMARY KEY, payload TEXT, fetched_at INTEGER)');
    await ctx.db.migrate('003_kv',
      'CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)');
    ctx.log.info('flight-tracker loaded');
  },

  routes: [
    { method: 'GET', path: '/status', auth: true,
      async handler(req, ctx) {
        const p = readParams(req);
        if (!p.reservationId) return json(400, { error: 'reservationId required' });
        return json(200, await cachedPayload(ctx, p.tripId, String(p.reservationId), false));
      } },

    { method: 'POST', path: '/refresh', auth: true,
      async handler(req, ctx) {
        const p = readParams(req);
        if (!p.reservationId) return json(400, { error: 'reservationId required' });
        return json(200, await cachedPayload(ctx, p.tripId, String(p.reservationId), true));
      } },

    // Manual single-flight override for a reservation (empty clears it).
    { method: 'POST', path: '/set', auth: true,
      async handler(req, ctx) {
        const p = readParams(req);
        if (!p.reservationId) return json(400, { error: 'reservationId required' });
        const rid = String(p.reservationId);
        const number = normNumber(p.flightNumber);
        if (number) {
          await ctx.db.exec('INSERT OR REPLACE INTO flights (reservation_id, trip_id, flight_number, updated_at) VALUES (?, ?, ?, ?)',
            rid, p.tripId != null ? String(p.tripId) : null, number, Date.now());
          await attempt(() => ctx.meta.set('reservation', Number(rid), 'flight_number', number));
        } else {
          await ctx.db.exec('DELETE FROM flights WHERE reservation_id = ?', rid);
          await attempt(() => ctx.meta.delete('reservation', Number(rid), 'flight_number'));
        }
        await attempt(() => ctx.db.exec('DELETE FROM cache WHERE reservation_id = ?', rid));
        return json(200, await cachedPayload(ctx, p.tripId, rid, true, number));
      } },

    // In-widget fallback for the AeroDataBox key (stored in the plugin's own DB).
    { method: 'POST', path: '/key', auth: true,
      async handler(req, ctx) {
        const p = readParams(req);
        const val = (p.apiKey == null ? '' : String(p.apiKey)).trim();
        if (val) await ctx.db.exec("INSERT OR REPLACE INTO kv (k, v) VALUES ('aerodatabox_key', ?)", val);
        else await ctx.db.exec("DELETE FROM kv WHERE k = 'aerodatabox_key'");
        await attempt(() => ctx.db.exec('DELETE FROM cache'));
        return json(200, { ok: true, hasKey: !!val });
      } },
  ],
});
