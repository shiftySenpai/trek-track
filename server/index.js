// Flight Tracker — TREK reservation-detail widget.
// Combines AeroDataBox (schedule/status, needs a RapidAPI key) with
// adsb.fi opendata (live airborne position, free/no key). Runs in an isolated
// child process; all host access is via `ctx`.
const { definePlugin } = require('trek-plugin-sdk');

const ADSB_HOST = 'https://opendata.adsb.fi/api';
const AERO_HOST = 'https://aerodatabox.p.rapidapi.com';

// Cache TTL for a reservation's combined payload. Protects the adsb.fi
// 1-req/s limit and the AeroDataBox quota when several clients poll.
const CACHE_TTL_MS = 45 * 1000;
const FETCH_TIMEOUT_MS = 9000;

// --- small helpers ----------------------------------------------------------

async function attempt(fn, fallback) {
  try { return await fn(); } catch (_e) { return fallback; }
}

// Fetch JSON with a timeout; returns { ok, status, data, error }.
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

// Normalise a user/detected flight number: strip spaces/dashes, upper-case.
function normNumber(raw) {
  if (!raw) return '';
  return String(raw).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
}

// Pull a plausible flight number out of a reservation's textual fields.
const FLIGHT_RE = /\b([A-Z]{2,3})\s?-?\s?(\d{1,4}[A-Z]?)\b/;
function detectFlightNumber(reservation) {
  if (!reservation) return '';
  const fields = ['flight_number', 'flightNumber', 'number', 'code', 'reference',
    'reference_code', 'title', 'name', 'provider', 'carrier', 'description', 'notes'];
  for (const f of fields) {
    const v = reservation[f];
    if (typeof v === 'string') {
      const m = v.toUpperCase().match(FLIGHT_RE);
      if (m) return normNumber(m[1] + m[2]);
    }
  }
  return '';
}

// --- external data sources ---------------------------------------------------

// AeroDataBox: schedule + status by flight number. Returns { data, error }.
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
  // Choose the leg whose scheduled departure is closest to now.
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

// adsb.fi: live airborne position. Tries registration, then call sign, then the
// raw flight number as a call sign. Returns { data, error }.
async function fetchLive(opts) {
  const tries = [];
  if (opts.reg) tries.push('/v2/registration/' + encodeURIComponent(opts.reg));
  if (opts.callSign) tries.push('/v2/callsign/' + encodeURIComponent(normNumber(opts.callSign)));
  if (opts.number) tries.push('/v2/callsign/' + encodeURIComponent(opts.number));
  for (const path of tries) {
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

// --- core: build the combined payload for a reservation ----------------------

function summariseReservation(r) {
  return { id: r.id, type: r.type || r.category || null, title: r.title || r.name || null };
}

async function buildPayload(ctx, tripId, reservationId, forcedNumber) {
  const key = (ctx.config && ctx.config.aerodatabox_key) ? String(ctx.config.aerodatabox_key) : '';
  const hasKey = !!key;

  // Resolve the flight number: explicit override > stored > detected.
  let number = normNumber(forcedNumber);
  let source = number ? 'manual' : 'none';

  if (!number) {
    const rows = await attempt(() => ctx.db.query('SELECT flight_number FROM flights WHERE reservation_id = ?', reservationId), []);
    if (rows && rows[0] && rows[0].flight_number) { number = normNumber(rows[0].flight_number); source = 'stored'; }
  }

  let reservationSummary = null;
  if (!number) {
    const detected = await attempt(async () => {
      const list = await ctx.trips.getReservations(Number(tripId));
      const r = (list || []).find((x) => String(x.id) === String(reservationId));
      if (r) reservationSummary = summariseReservation(r);
      return detectFlightNumber(r);
    }, '');
    if (detected) { number = detected; source = 'detected'; }
  }

  if (!number) {
    return { flightNumber: null, source: 'none', hasKey, status: null, live: null,
      reservation: reservationSummary, errors: [], updatedAt: Date.now() };
  }

  const errors = [];
  const aero = await fetchAero(number, key);
  if (aero.error) errors.push('status: ' + aero.error);
  const status = aero.data;

  const live = await fetchLive({
    reg: status && status.aircraftReg,
    callSign: status && status.callSign,
    number: number,
  });
  if (live.error) errors.push('live: ' + live.error);

  return {
    flightNumber: number, source, hasKey, status, live: live.data,
    reservation: reservationSummary, errors, updatedAt: Date.now(),
  };
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
  };
}

module.exports = definePlugin({
  async onLoad(ctx) {
    await ctx.db.migrate('001_flights',
      'CREATE TABLE IF NOT EXISTS flights (reservation_id TEXT PRIMARY KEY, trip_id TEXT, flight_number TEXT, updated_at INTEGER)');
    await ctx.db.migrate('002_cache',
      'CREATE TABLE IF NOT EXISTS cache (reservation_id TEXT PRIMARY KEY, payload TEXT, fetched_at INTEGER)');
    ctx.log.info('flight-tracker loaded');
  },

  routes: [
    // Current combined status for a reservation (uses the short-lived cache).
    { method: 'GET', path: '/status', auth: true,
      async handler(req, ctx) {
        const p = readParams(req);
        if (!p.reservationId) return json(400, { error: 'reservationId required' });
        const payload = await cachedPayload(ctx, p.tripId, String(p.reservationId), false);
        return json(200, payload);
      } },

    // Force a fresh fetch, bypassing the cache.
    { method: 'POST', path: '/refresh', auth: true,
      async handler(req, ctx) {
        const p = readParams(req);
        if (!p.reservationId) return json(400, { error: 'reservationId required' });
        const payload = await cachedPayload(ctx, p.tripId, String(p.reservationId), true);
        return json(200, payload);
      } },

    // Set (or clear, with an empty value) the flight number for a reservation.
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
        const payload = await cachedPayload(ctx, p.tripId, rid, true, number);
        return json(200, payload);
      } },
  ],
});
