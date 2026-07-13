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

const CACHE_TTL_MS = 60 * 1000;
const FETCH_TIMEOUT_MS = 7000;
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

function withSpaceNum(n) {
  const m = String(n || '').match(/^([A-Z]{2,3})(\d.*)$/);
  return m ? m[1] + ' ' + m[2] : String(n || '');
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

// Parse a reservation datetime ('YYYY-MM-DDTHH:MM' or with a space) into an
// epoch-ms estimate and the local date string used for the AeroDataBox query.
function parseDateTime(s) {
  if (!s || typeof s !== 'string') return null;
  const m = s.match(/(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/);
  if (!m) return null;
  const iso = m[4] ? (m[1] + '-' + m[2] + '-' + m[3] + 'T' + m[4] + ':' + m[5] + ':00')
    : (m[1] + '-' + m[2] + '-' + m[3] + 'T12:00:00');
  const ms = Date.parse(iso);
  return { ms: isNaN(ms) ? null : ms, date: m[1] + '-' + m[2] + '-' + m[3] };
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
      depDayId: l.dep_day_id != null ? l.dep_day_id : null,
      arrDayId: l.arr_day_id != null ? l.arr_day_id : null,
      seat: l.seat || null,
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
    depDayId: r.day_id != null ? r.day_id : null,
    arrDayId: r.end_day_id != null ? r.end_day_id : (r.day_id != null ? r.day_id : null),
    seat: meta.seat || null,
    localDepDate: (first && first.local_date) || null,
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
    depDayId: leg.depDayId != null ? leg.depDayId : null,
    arrDayId: leg.arrDayId != null ? leg.arrDayId : null,
    seat: leg.seat || null, localDepDate: leg.localDepDate || null,
  };
}

// --- external data sources ---------------------------------------------------

async function fetchAero(number, key, date) {
  if (!key || !number) return { data: null, error: null };
  // With a booking date we query the exact day (accurate for future flights and
  // avoids matching a different day's operation of the same number).
  const datePath = /^\d{4}-\d{2}-\d{2}$/.test(date || '') ? '/' + date : '';
  const url = AERO_HOST + '/flights/number/' + encodeURIComponent(number) + datePath +
    '?withAircraftImage=false&withLocation=true&dateLocalRole=Both';
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
  const loc = ap.location || {};
  return {
    iata: ap.iata || ap.icao || null,
    name: ap.shortName || ap.name || ap.municipalityName || null,
    terminal: block.terminal || null,
    gate: block.gate || null,
    baggageBelt: block.baggageBelt || null,
    scheduled: times ? times.scheduled : null,
    revised: times ? times.revised : null,
    lat: num(loc.lat != null ? loc.lat : loc.latitude),
    lon: num(loc.lon != null ? loc.lon : loc.longitude),
  };
}

async function fetchLive(opts) {
  const tries = [];
  if (opts.reg) {
    // Registration is the unique tail — authoritative, so don't also spend
    // requests on the shared call sign.
    tries.push('/v2/registration/' + encodeURIComponent(opts.reg));
  } else {
    if (opts.callSign) tries.push('/v2/callsign/' + encodeURIComponent(normNumber(opts.callSign)));
    if (opts.callsignHint) tries.push('/v2/callsign/' + encodeURIComponent(normNumber(opts.callsignHint)));
    if (opts.number) tries.push('/v2/callsign/' + encodeURIComponent(opts.number));
  }
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

// Fetch status + live for one resolved leg. `win` gates the two calls:
//   win.status → query AeroDataBox (near enough departure to have data)
//   win.live   → query adsb.fi (flight plausibly airborne right now)
async function trackLeg(leg, key, win) {
  const errors = [];
  let status = null;
  if (win.status) {
    const aero = await fetchAero(leg.number, key, win.date);
    if (aero.error) errors.push('status: ' + aero.error);
    status = aero.data;
  }
  let live = { data: null };
  // Fetch the live position when the flight is plausibly up: inside the booking's
  // time window, OR whenever the date-pinned status itself says the flight is
  // airborne (then the aircraft is unambiguously this flight, so we can show it
  // even if the booking's clock times were rough). The correct-DAY guarantee
  // comes from the date-pinned status, not from requiring the plane to be up.
  const AIRBORNE = { EnRoute: 1, Departed: 1, Approaching: 1 };
  const wantLive = win.live || (status && AIRBORNE[status.status]);
  if (wantLive) {
    live = await fetchLive({
      reg: status && status.aircraftReg,
      callSign: status && status.callSign,
      callsignHint: leg.callsign,
      number: leg.number,
    });
    if (live.error) errors.push('live: ' + live.error);
  }
  return Object.assign({}, leg, { status, live: live.data, errors });
}

// --- key resolution: instance-wide setting (admin) > in-widget stored key ---
// Both are instance-wide (shared by all users): ctx.config is the admin's
// Admin -> Plugins setting; the kv row is what the in-widget field writes.

async function getKey(ctx) {
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

  // Departure/arrival datetimes drive the countdown and the fetch windows.
  const H = 3600 * 1000;
  const dep = parseDateTime(resv && resv.reservation_time);
  const arr = parseDateTime(resv && resv.reservation_end_time);
  const now = Date.now();
  const depMs = dep && dep.ms;
  const arrMs = (arr && arr.ms) || (depMs ? depMs + 6 * H : null);
  const baseDate = dep && dep.date;

  // phase: upcoming (>48h out) | active (within window) | past
  let phase = 'active';
  if (depMs && now < depMs - 48 * H) phase = 'upcoming';
  else if (arrMs && now > arrMs + 6 * H) phase = 'past';

  // AeroDataBox status: from 48h before departure until 6h after arrival
  // (or best-effort if we don't know the date). Saves quota on far-future flights.
  const statusWin = !depMs ? true : (now >= depMs - 48 * H && now <= arrMs + 6 * H);
  // adsb.fi live position: only while the aircraft is plausibly airborne — 1h
  // before departure to 2h after arrival. Prevents matching another day's flight.
  const liveWin = !depMs ? true : (now >= depMs - 1 * H && now <= arrMs + 2 * H);
  // Map trip day ids -> dates, so a per-leg (possibly next-day) query hits the
  // right calendar day instead of the reservation-level date.
  const days = tripId ? await attempt(() => ctx.trips.getDays(Number(tripId)), []) : [];
  const dayDate = {};
  (days || []).forEach((d) => { if (d && d.id != null && d.date) dayDate[String(d.id)] = String(d.date).slice(0, 10); });
  const legDate = (l) => (l.depDayId != null && dayDate[String(l.depDayId)]) || l.localDepDate || baseDate || null;

  let rawLegs;
  if (overrideNumber) {
    rawLegs = [resolveLeg({ flight: overrideNumber, airline: null, from: null, to: null })];
    if (rawLegs[0] && !rawLegs[0].number) rawLegs[0].number = overrideNumber;
  } else {
    rawLegs = resv ? getFlightLegs(resv).map(resolveLeg) : [];
    if (rawLegs.length) source = 'detected';
  }

  const queryable = rawLegs.filter((l) => l.number);

  const booking = {
    type: bookingType, depMs: depMs || null, arrMs: arrMs || null, phase,
    pnr: (resv && (resv.confirmation_number || null)) || null,
    origin: (queryable[0] && queryable[0].from) || null,
    dest: (queryable.length && queryable[queryable.length - 1].to) || null,
    legCount: queryable.length,
  };

  if (!queryable.length) {
    const applicable = !bookingType || bookingType === 'flight';
    return { applicable, source: 'none', hasKey, legs: [], booking,
      hint: rawLegs.length ? rawLegs.map((l) => ({ airline: l.airline, from: l.from, to: l.to, rawFlight: l.rawFlight })) : null,
      updatedAt: Date.now() };
  }

  // Track legs SEQUENTIALLY to respect both APIs' 1 req/s free-tier ceiling
  // (bursting Promise.all over legs would trip rate limits). Each leg pins its own
  // date. A past/arrived leg is not re-queried live.
  const legs = [];
  for (const l of queryable) {
    const win = { status: statusWin, live: liveWin, date: legDate(l) };
    const tracked = await attempt(() => trackLeg(l, key, win), Object.assign({}, l, { status: null, live: null, errors: ['failed'] }));
    legs.push(tracked);
  }

  return { applicable: true, source, hasKey, legs, booking, updatedAt: Date.now() };
}

// Cache lifetime by phase: an active flight refreshes ~once a minute, but a
// far-future or completed flight barely changes — so we don't burn the ~600/mo
// AeroDataBox quota re-fetching schedules that won't move.
function ttlFor(payload) {
  const ph = payload && payload.booking && payload.booking.phase;
  if (ph === 'past') return 6 * 3600 * 1000;
  if (ph === 'upcoming') return 30 * 60 * 1000;
  return CACHE_TTL_MS;
}

async function cachedPayload(ctx, tripId, reservationId, force, forcedNumber) {
  if (!force && !forcedNumber) {
    const rows = await attempt(() => ctx.db.query('SELECT payload, fetched_at FROM cache WHERE reservation_id = ?', reservationId), []);
    if (rows && rows[0]) {
      try {
        const cached = JSON.parse(rows[0].payload);
        if ((Date.now() - Number(rows[0].fetched_at)) < ttlFor(cached)) return Object.assign(cached, { cached: true });
      } catch (_e) { /* refetch */ }
    }
  }
  const payload = await buildPayload(ctx, tripId, reservationId, forcedNumber);
  await attempt(() => ctx.db.exec(
    'INSERT OR REPLACE INTO cache (reservation_id, trip_id, payload, fetched_at) VALUES (?, ?, ?, ?)',
    reservationId, tripId != null ? String(tripId) : null, JSON.stringify(payload), Date.now()));
  return payload;
}

// --- notifications (only possible with a bound user, i.e. from a route) -------
// TREK forbids a userless job from notifying, so we fire while the app is open:
// each poll diffs the flight state and, on a meaningful change, sends one
// deduplicated bell/email notification to the acting user.
async function maybeNotify(ctx, user, rid, payload) {
  if (!user || !user.id || !payload || !payload.legs || !payload.legs.length) return;
  if (payload.booking && payload.booking.phase === 'past') return;
  const uid = String(user.id);
  const cur = payload.legs.map((l) => {
    const s = l.status;
    return { n: l.number,
      st: s ? s.status : null,
      d: s && s.delayMin != null ? Math.round(s.delayMin / 5) * 5 : null,
      g: s && s.arrival ? (s.arrival.gate || null) : null,
      dg: s && s.departure ? (s.departure.gate || null) : null };
  });
  const sig = JSON.stringify(cur);
  const prevRows = await attempt(() => ctx.db.query('SELECT sig FROM notif_state WHERE rid = ? AND uid = ?', rid, uid), []);
  const prev = prevRows && prevRows[0] ? prevRows[0].sig : null;
  await attempt(() => ctx.db.exec('INSERT OR REPLACE INTO notif_state (rid, uid, sig) VALUES (?, ?, ?)', rid, uid, sig));
  if (!prev || prev === sig) return; // baseline or nothing changed
  let prevArr = []; try { prevArr = JSON.parse(prev); } catch (_e) { prevArr = []; }
  const old = {}; prevArr.forEach((o) => { old[o.n] = o; });
  for (const c of cur) {
    const o = old[c.n] || {};
    let msg = null;
    if ((c.st === 'Canceled' || c.st === 'Cancelled') && o.st !== c.st) msg = 'Flug annulliert';
    else if (c.st === 'Diverted' && o.st !== c.st) msg = 'Flug umgeleitet';
    else if (c.d != null && c.d >= 15 && c.d !== o.d) msg = 'Verspaetung: +' + c.d + ' min';
    else if ((c.dg || c.g) && (c.dg || c.g) !== (o.dg || o.g)) msg = 'Gate: ' + (c.dg || c.g);
    else if (c.st === 'Departed' && o.st !== c.st) msg = 'Gestartet';
    else if (c.st === 'Arrived' && o.st !== c.st) msg = 'Gelandet';
    if (msg) {
      await attempt(() => ctx.notify.send({ title: withSpaceNum(c.n), body: msg, scope: 'user', targetId: user.id }));
      break;
    }
  }
}

// --- warning provider (userless): surfaces delays/cancellations in the planner
// from the freshest cached payloads (no extra API calls — quota-safe) ----------
async function getTripWarnings(tripId, ctx) {
  const out = [];
  const rows = await attempt(() => ctx.db.query('SELECT payload, fetched_at FROM cache WHERE trip_id = ?', String(tripId)), []);
  const now = Date.now();
  for (const r of rows || []) {
    if (now - Number(r.fetched_at) > 30 * 60 * 1000) continue; // ignore stale
    let p; try { p = JSON.parse(r.payload); } catch (_e) { continue; }
    if (!p || p.applicable === false || !Array.isArray(p.legs)) continue;
    if (p.booking && p.booking.phase === 'past') continue;
    for (const lg of p.legs) {
      const s = lg.status; if (!s) continue;
      const from = lg.from || (s.departure && s.departure.iata) || '';
      const to = lg.to || (s.arrival && s.arrival.iata) || '';
      const route = from && to ? ' ' + from + '→' + to : '';
      const num = withSpaceNum(lg.number);
      if (s.status === 'Canceled' || s.status === 'Cancelled') out.push({ level: 'error', message: num + route + ' annulliert' });
      else if (s.status === 'Diverted') out.push({ level: 'error', message: num + route + ' umgeleitet' });
      else if (s.delayMin != null && s.delayMin >= 20) out.push({ level: 'warning', message: num + route + ' +' + s.delayMin + ' min verspaetet' });
    }
    if (out.length >= 12) break;
  }
  return out.slice(0, 12);
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
    await ctx.db.migrate('004_cache_trip', 'ALTER TABLE cache ADD COLUMN trip_id TEXT');
    await ctx.db.migrate('005_notif',
      'CREATE TABLE IF NOT EXISTS notif_state (rid TEXT, uid TEXT, sig TEXT, PRIMARY KEY (rid, uid))');
    ctx.log.info('flight-tracker loaded');
  },

  hooks: {
    // Native TREK trip warnings for delays/cancellations, shown when a member
    // opens the trip. Userless + fail-safe; reads only the freshest cache.
    warningProvider: {
      async getWarnings(tripId, ctx) {
        return attempt(() => getTripWarnings(tripId, ctx), []);
      },
    },
  },

  routes: [
    { method: 'GET', path: '/status', auth: true,
      async handler(req, ctx) {
        const p = readParams(req);
        if (!p.reservationId) return json(400, { error: 'reservationId required' });
        const payload = await cachedPayload(ctx, p.tripId, String(p.reservationId), false);
        if (!payload.cached) await attempt(() => maybeNotify(ctx, req.user, String(p.reservationId), payload));
        return json(200, payload);
      } },

    { method: 'POST', path: '/refresh', auth: true,
      async handler(req, ctx) {
        const p = readParams(req);
        if (!p.reservationId) return json(400, { error: 'reservationId required' });
        const payload = await cachedPayload(ctx, p.tripId, String(p.reservationId), true);
        await attempt(() => maybeNotify(ctx, req.user, String(p.reservationId), payload));
        return json(200, payload);
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

    // In-widget fallback for the AeroDataBox key (stored in the plugin's own DB,
    // instance-wide). Admin-only: the key is shared by every user, so only an
    // admin may set or clear it (mirrors TREK's admin-owned instance settings).
    { method: 'POST', path: '/key', auth: true,
      async handler(req, ctx) {
        if (!req.user || !req.user.isAdmin) return json(403, { error: 'admin only' });
        const p = readParams(req);
        const val = (p.apiKey == null ? '' : String(p.apiKey)).trim();
        if (val) await ctx.db.exec("INSERT OR REPLACE INTO kv (k, v) VALUES ('aerodatabox_key', ?)", val);
        else await ctx.db.exec("DELETE FROM kv WHERE k = 'aerodatabox_key'");
        await attempt(() => ctx.db.exec('DELETE FROM cache'));
        return json(200, { ok: true, hasKey: !!val });
      } },
  ],
});
