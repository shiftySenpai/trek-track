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

// Known-code sets, built once from the bundled dataset + curated overrides. They
// let splitFlight() tell a real airline prefix from a coincidental letter run.
let CODES = null;
function codes() {
  if (CODES) return CODES;
  const iata = Object.create(null), icao = Object.create(null), icaoToIata = Object.create(null);
  // A real IATA airline designator is two chars with at least one LETTER (LL, LD
  // or DL). Admitting an all-digit "code" would make splitFlight read the first
  // two digits of a bare flight number as an airline ("1234" -> "12" + "34").
  const addIata = (c) => { if (/^[A-Z0-9]{2}$/.test(c || '') && /[A-Z]/.test(c)) iata[c] = 1; };
  Object.keys(DATA.iataIcao || {}).forEach(addIata);
  Object.keys(DATA.nameToIata || {}).forEach((k) => addIata(DATA.nameToIata[k]));
  Object.keys(DATA.coreToIata || {}).forEach((k) => addIata(DATA.coreToIata[k]));
  Object.keys(CURATED_IATA).forEach((k) => addIata(CURATED_IATA[k]));
  const pair = (i, c) => { if (/^[A-Z]{3}$/.test(c || '')) { icao[c] = 1; if (!icaoToIata[c]) icaoToIata[c] = i; } };
  Object.keys(DATA.iataIcao || {}).forEach((i) => pair(i, DATA.iataIcao[i]));
  Object.keys(CURATED_ICAO).forEach((i) => pair(i, CURATED_ICAO[i]));
  CODES = { iata, icao, icaoToIata };
  return CODES;
}

// Name normalisation mirrors scripts/build-airlines.js so the lookup keys match.
const CORP_WORDS = { inc: 1, ltd: 1, llc: 1, plc: 1, co: 1, corp: 1, corporation: 1, company: 1,
  group: 1, holdings: 1, holding: 1, limited: 1, sa: 1, ag: 1, gmbh: 1, srl: 1, spa: 1, as: 1, ab: 1,
  oy: 1, nv: 1, bv: 1, pty: 1, pvt: 1, private: 1, jsc: 1, ojsc: 1, cjsc: 1, llp: 1, sas: 1, sarl: 1 };
const GENERIC_WORDS = { airlines: 1, airline: 1, airways: 1, airway: 1, air: 1, lines: 1, line: 1,
  aviation: 1, aviacion: 1, aerolineas: 1, aerolinea: 1, airliner: 1, aero: 1, linhas: 1, aereas: 1,
  luchtvaartmaatschappij: 1, international: 1, intl: 1, transport: 1, transports: 1, travel: 1 };

function normName(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ')
    .trim().replace(/\s+/g, ' ');
}

function coreName(s) {
  return normName(s).split(' ').filter((w) => w && !GENERIC_WORDS[w] && !CORP_WORDS[w]).join(' ');
}

// Split a flight designator into airline prefix + number. IATA airline codes are
// two ALPHANUMERIC characters (F9 Frontier, U2 easyJet, 6E IndiGo) — 452 of the
// ~1100 codes we know contain a digit — so a letters-only prefix regex mis-parses
// them ("F91234" -> "F" + "91234", five digits, no match at all). Candidate splits
// are therefore scored, with a prefix that is a KNOWN airline code winning.
function splitFlight(raw) {
  const s = normNumber(raw);
  if (!s) return null;
  const K = codes();
  let best = null;
  for (let n = 0; n <= 3 && n < s.length; n++) {
    const prefix = s.slice(0, n);
    const m = s.slice(n).match(/^(\d{1,4})([A-Z]?)$/);
    if (!m) continue;
    let score;
    if (n === 0) score = 5;                                  // bare number; airline comes from the booking
    else if (n === 2 && K.iata[prefix]) score = 100;         // known IATA — the common, unambiguous case
    else if (n === 3 && K.icao[prefix]) score = 90;          // known ICAO (e.g. DLH400)
    else if (n === 2 && /^(?:[A-Z][A-Z0-9]|[0-9][A-Z])$/.test(prefix)) score = 50; // IATA-shaped, unknown
    else if (n === 3 && /^[A-Z]{3}$/.test(prefix)) score = 40;
    else if (n === 1 && /^[A-Z]$/.test(prefix)) score = 10;
    else continue;
    if (!best || score > best.score || (score === best.score && n > best.prefix.length)) {
      best = { prefix, digits: m[1], suffix: m[2] || '', score };
    }
  }
  return best;
}

function airlineToIata(name, code) {
  if (code) { const c = String(code).toUpperCase().replace(/[^A-Z0-9]/g, ''); if (/^[A-Z0-9]{2}$/.test(c)) return c; }
  if (!name) return '';
  // Exact, then spelling variants, then the aggressively stripped "core" name —
  // so "Delta Airlines", "Delta Air Lines" and "Delta Air Lines, Inc." all hit DL.
  const n = normName(name);
  if (!n) return '';
  const tries = [n, n.replace(/\bair lines\b/g, 'airlines'), n.replace(/\bairlines\b/g, 'air lines')];
  for (const t of tries) {
    if (CURATED_IATA[t]) return CURATED_IATA[t];
    if (DATA.nameToIata[t]) return DATA.nameToIata[t];
  }
  const c = coreName(n);
  if (c) {
    if (CURATED_IATA[c]) return CURATED_IATA[c];
    if (DATA.coreToIata && DATA.coreToIata[c]) return DATA.coreToIata[c];
    if (DATA.nameToIata[c]) return DATA.nameToIata[c];
  }
  return '';
}

function iataToIcao(iata, code) {
  if (code) { const c = String(code).toUpperCase().replace(/[^A-Z]/g, ''); if (/^[A-Z]{3}$/.test(c)) return c; }
  if (iata) { if (CURATED_ICAO[iata]) return CURATED_ICAO[iata]; if (DATA.iataIcao[iata]) return DATA.iataIcao[iata]; }
  return '';
}

// A 3-letter ICAO prefix typed into the flight-number box ("DLH400") must become
// the IATA form before querying AeroDataBox, which keys on IATA numbers.
function icaoToIata(icao) {
  const K = codes();
  return (icao && K.icaoToIata[icao]) || '';
}

function parseMeta(r) {
  if (!r) return {};
  let m = r.metadata != null ? r.metadata : r.meta;
  if (typeof m === 'string') { try { m = JSON.parse(m || '{}'); } catch (_e) { m = {}; } }
  return (m && typeof m === 'object') ? m : {};
}

// Parse a reservation datetime ('YYYY-MM-DDTHH:MM' or with a space) into an
// epoch-ms estimate and the local date string used for the AeroDataBox query.
// A reservation time is a NAIVE local time at the departure airport — TREK stores
// no offset. Parsing it without one made Date.parse use the SERVER's timezone, so
// every derived window silently shifted by the host's offset (and moved when the
// host moved). We parse as UTC instead: still not the airport's true instant, but
// deterministic and host-independent, with a known bound on the error (±14h, the
// range of real UTC offsets). Callers must therefore treat this as an ESTIMATE and
// apply TZ_SLACK; the authoritative instants are the *Utc fields AeroDataBox
// returns, which replace these as soon as a status lookup succeeds.
function parseDateTime(s) {
  if (!s || typeof s !== 'string') return null;
  const m = s.match(/(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/);
  if (!m) return null;
  const iso = m[4] ? (m[1] + '-' + m[2] + '-' + m[3] + 'T' + m[4] + ':' + m[5] + ':00Z')
    : (m[1] + '-' + m[2] + '-' + m[3] + 'T12:00:00Z');
  const ms = Date.parse(iso);
  return { ms: isNaN(ms) ? null : ms, date: m[1] + '-' + m[2] + '-' + m[3], estimated: true };
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
    const fromBooking = airlineToIata(leg.airline, leg.airlineCode);
    // Precedence: an ICAO prefix maps back to IATA; a *known* IATA prefix in the
    // typed number is authoritative; otherwise the booking's airline field wins,
    // with the typed prefix as the last resort. This makes "F9 1234", bare "1234"
    // + "Frontier Airlines", and "DLH400" all resolve to the same flight.
    let iata;
    if (sf.prefix.length === 3) iata = icaoToIata(sf.prefix) || fromBooking || '';
    else if (sf.prefix && sf.score >= 100) iata = sf.prefix;
    else iata = fromBooking || sf.prefix;
    if (iata) number = iata + sf.digits + sf.suffix;
    const icao = (sf.prefix.length === 3 && codes().icao[sf.prefix])
      ? sf.prefix : iataToIcao(iata, leg.airlineCode);
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
  // dateLocalRole=Both also returns the PREVIOUS day's operation when it arrives on
  // the pinned date, so a red-eye (dep 23:40, arr 07:10+1) gets two candidates. The
  // closest-to-now tie-break below reliably picks the earlier — i.e. wrong — one for
  // an upcoming flight, showing yesterday's gate, status and delay. Keep only
  // candidates that actually DEPART on the pinned date; fall back to the unfiltered
  // list if that leaves nothing, so a schedule quirk can't blank the widget.
  let pool = list;
  if (/^\d{4}-\d{2}-\d{2}$/.test(date || '')) {
    const sameDay = list.filter((f) => {
      const t = f && f.departure && f.departure.scheduledTime;
      const local = t && (t.local || t.utc);
      return typeof local === 'string' && local.slice(0, 10) === date;
    });
    if (sameDay.length) pool = sameDay;
  }
  const now = Date.now();
  pool.sort((a, b) => Math.abs(depTime(a) - now) - Math.abs(depTime(b) - now));
  return { data: normaliseAero(pool[0]), error: null };
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
  const diffMin = (t) => {
    if (!t || !t.revisedUtc || !t.scheduledUtc) return null;
    const d = Math.round((Date.parse(t.revisedUtc) - Date.parse(t.scheduledUtc)) / 60000);
    return isNaN(d) ? null : d;
  };
  const delayMin = diffMin(at);
  // AeroDataBox routinely publishes a revised DEPARTURE long before (or instead of)
  // a revised arrival. Deriving delay from arrival alone therefore missed exactly
  // the delay that strands a traveller at the gate: no chip, no alert, no warning.
  const depDelayMin = diffMin(dt);
  return {
    number: (f.number || '').toString(),
    callSign: f.callSign || null,
    status: f.status || 'Unknown',
    airline: (f.airline && f.airline.name) || null,
    aircraftModel: (f.aircraft && f.aircraft.model) || null,
    aircraftReg: (f.aircraft && f.aircraft.reg) || null,
    delayMin: delayMin,
    depDelayMin: depDelayMin,
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
    scheduledUtc: times ? times.scheduledUtc : null,
    revisedUtc: times ? times.revisedUtc : null,
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

// Parse an AeroDataBox UTC timestamp to epoch ms. These carry a real offset (or a
// trailing Z), unlike the reservation strings, so they are authoritative.
function toMs(s) {
  if (!s) return null;
  let t = String(s).replace(' ', 'T');
  if (!/[zZ]$|[+-]\d\d:?\d\d$/.test(t)) t += 'Z';
  const n = Date.parse(t);
  return isNaN(n) ? null : n;
}

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
async function trackLeg(ctx, leg, key, win) {
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
  // Destination weather at the arrival airport for the arrival day (host-cached,
  // free/tenant-free broker). Skipped once the flight is in the past.
  let weather = null;
  const arr = status && status.arrival;
  if (arr && arr.lat != null && arr.lon != null && win.status) {
    const wdate = (typeof arr.scheduled === 'string' ? arr.scheduled.slice(0, 10) : '') || win.date || null;
    const w = await attempt(() => ctx.weather.get(arr.lat, arr.lon, /^\d{4}-\d{2}-\d{2}$/.test(wdate || '') ? wdate : undefined), null);
    if (w && typeof w === 'object' && !w.error && typeof w.temp === 'number') {
      weather = {
        temp: Math.round(w.temp), main: w.main || null, description: w.description || null,
        tempMax: typeof w.temp_max === 'number' ? Math.round(w.temp_max) : null,
        tempMin: typeof w.temp_min === 'number' ? Math.round(w.temp_min) : null,
        precipProb: typeof w.precipitation_probability_max === 'number' ? Math.round(w.precipitation_probability_max) : null,
      };
    }
  }
  // Inbound aircraft: before departure, look up the ASSIGNED tail by registration.
  // If it's airborne elsewhere (finishing a previous rotation) we surface where it
  // is + how far from the departure airport — "your plane is on its way".
  let inbound = null;
  const notUp = status && !AIRBORNE[status.status] && status.status !== 'Arrived';
  if (status && status.aircraftReg && notUp && win.live && !live.data) {
    const ri = await fetchJson(ADSB_HOST + '/v2/registration/' + encodeURIComponent(status.aircraftReg), { headers: { accept: 'application/json' } });
    if (ri.ok && ri.data && Array.isArray(ri.data.ac) && ri.data.ac.length) {
      const a = normaliseLive(ri.data.ac[0]);
      if (a.lat != null && !a.onGround) inbound = a;
    }
  }
  return Object.assign({}, leg, { status, live: live.data, weather, inbound, errors });
}

// --- key resolution: instance-wide, admin-managed -----------------------------
// The AeroDataBox key is instance-wide (one key serves every user). It can arrive
// two ways:
//   1. ctx.config.aerodatabox_key — set through TREK's admin-guarded plugin config
//      API (PUT /api/admin/plugins/flight-tracker/config) and injected decrypted.
//   2. the plugin's own kv row — written by the in-widget key field below.
// ctx.config always WINS: it is the explicitly admin-managed channel, and it is
// frozen at activation, so letting a kv row shadow it would silently override an
// admin's deliberate setting.
//
// TREK 3.4.0 fixed plugin admin-detection (TREK#1569): the proxy now builds the
// route user as `isAdmin: user.role === 'admin'`, so req.user.isAdmin is finally
// trustworthy — which is what makes the in-widget entry safe to re-enable. On
// 3.3 it was hardcoded from a non-existent `is_admin` column and always false;
// the manifest therefore requires >=3.4.0.
function isAdminUser(u) { return !!(u && (u.isAdmin || u.is_admin)); }
function canSetKey(ctx, user) { return isAdminUser(user); }

async function getKey(ctx) {
  if (ctx.config && ctx.config.aerodatabox_key) return String(ctx.config.aerodatabox_key);
  const rows = await attempt(() => ctx.db.query("SELECT v FROM kv WHERE k = 'aerodatabox_key'"), []);
  return (rows && rows[0] && rows[0].v) ? String(rows[0].v) : '';
}

// --- core: build the combined payload for a reservation ----------------------

// AUTHORIZATION GATE. ctx.trips is the only host surface that membership-checks a
// read, so every route must pass through it BEFORE touching the plugin's own
// storage. That storage (ctx.db) is a single shared database with no per-user
// scoping, and reservation ids are sequential integers — so without this gate any
// authenticated user could enumerate ids and read another user's itinerary out of
// the cache, or write flight-number overrides into their reservations.
//
// Deliberately NOT wrapped in attempt(): swallowing RESOURCE_FORBIDDEN to null is
// precisely what turned a failed permission check into a successful request.
// Returns { resv } on success or { error } holding the response to send.
async function requireOwnedReservation(ctx, tripId, reservationId) {
  if (tripId == null || tripId === '') return { error: json(400, { error: 'tripId required' }) };
  let list;
  try {
    list = await ctx.trips.getReservations(Number(tripId));
  } catch (e) {
    const msg = String((e && e.message) || e);
    // The host prefixes rejections with the error code.
    if (/^(RESOURCE_FORBIDDEN|PERMISSION_DENIED)/.test(msg)) return { error: json(403, { error: 'forbidden' }) };
    return { error: json(502, { error: 'trip lookup failed' }) };
  }
  const resv = (list || []).find((x) => String(x.id) === String(reservationId));
  // Not a member of the trip, or the reservation is not in it — same answer either
  // way, so membership cannot be probed by comparing responses.
  if (!resv) return { error: json(404, { error: 'not found' }) };
  return { resv };
}

// `resv` is supplied by the caller and has ALREADY passed the membership gate —
// buildPayload never re-reads it, so there is no path here that bypasses the check.
async function buildPayload(ctx, tripId, reservationId, forcedNumber, resv) {
  const key = await getKey(ctx);
  const hasKey = !!key;

  // A manual/stored override replaces detection with a single leg.
  let overrideNumber = normNumber(forcedNumber);
  let source = overrideNumber ? 'manual' : 'none';
  if (!overrideNumber) {
    const rows = await attempt(() => ctx.db.query('SELECT flight_number FROM flights WHERE reservation_id = ?', reservationId), []);
    if (rows && rows[0] && rows[0].flight_number) { overrideNumber = normNumber(rows[0].flight_number); source = 'stored'; }
  }

  const bookingType = resv ? (resv.type || parseMeta(resv).type || null) : null;

  // Departure/arrival datetimes drive the countdown and the fetch windows.
  const H = 3600 * 1000;
  const dep = parseDateTime(resv && resv.reservation_time);
  const arr = parseDateTime(resv && resv.reservation_end_time);
  const now = Date.now();
  const depMs = dep && dep.ms;
  // No end time means we must guess the duration. The old guess of +6h declared a
  // 13h flight "past" while it was still in the air, which stopped polling, muted
  // every alert and dropped it from the trip warnings. Assume a long-haul instead:
  // being late to call a flight finished only costs a little polling, while being
  // early goes dark during the part of the trip that matters most.
  const arrMs = (arr && arr.ms) || (depMs ? depMs + 20 * H : null);
  const baseDate = dep && dep.date;
  // Both endpoints came from naive local strings, so they carry up to ±14h of
  // timezone error. Widen the fetch windows by that bound rather than letting a
  // long-haul departure out of Asia or the Americas fall outside them entirely.
  const SLACK = (dep && dep.estimated) ? 14 * H : 0;

  // phase: upcoming (>48h out) | active (within window) | past
  let phase = 'active';
  if (depMs && now < depMs - 48 * H - SLACK) phase = 'upcoming';
  else if (arrMs && now > arrMs + 6 * H + SLACK) phase = 'past';

  // AeroDataBox status: from 48h before departure until 6h after arrival
  // (or best-effort if we don't know the date). Saves quota on far-future flights.
  const statusWin = !depMs ? true : (now >= depMs - 48 * H - SLACK && now <= arrMs + 6 * H + SLACK);
  // adsb.fi live position: only while the aircraft is plausibly airborne — 1h
  // before departure to 2h after arrival. Kept TIGHT despite the timezone slack,
  // because a wrong-day match here is worse than a miss; trackLeg independently
  // fetches the live position whenever the (date-pinned) status says the aircraft
  // is airborne, which is the reliable signal when the clock estimate is off.
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
    // No PNR: a booking reference is bearer-ish for airline "manage my booking"
    // portals, and copying it into a second datastore bought only a subtitle the
    // user can already see on the reservation itself.
    type: bookingType, depMs: depMs || null, arrMs: arrMs || null, phase,
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
    const tracked = await attempt(() => trackLeg(ctx, l, key, win), Object.assign({}, l, { status: null, live: null, errors: ['failed'] }));
    legs.push(tracked);
  }

  // AeroDataBox returns true UTC instants. Once we have them they REPLACE the
  // naive estimates above, so the countdown, the phase and the client's polling
  // cadence stop depending on the reservation string's missing timezone.
  const firstUtc = toMs(legs[0] && legs[0].status && legs[0].status.departure &&
    (legs[0].status.departure.revisedUtc || legs[0].status.departure.scheduledUtc));
  const lastLeg = legs[legs.length - 1];
  const lastUtc = toMs(lastLeg && lastLeg.status && lastLeg.status.arrival &&
    (lastLeg.status.arrival.revisedUtc || lastLeg.status.arrival.scheduledUtc));
  if (firstUtc != null) { booking.depMs = firstUtc; booking.estimatedTimes = false; }
  if (lastUtc != null) booking.arrMs = lastUtc;
  if (firstUtc != null || lastUtc != null) {
    const d = booking.depMs, a = booking.arrMs;
    booking.phase = (d && now < d - 48 * H) ? 'upcoming' : ((a && now > a + 6 * H) ? 'past' : 'active');
  } else {
    booking.estimatedTimes = true;
  }

  // Every leg's errors, surfaced so an exhausted quota or a rejected key is
  // visible instead of looking identical to "this flight has no data".
  const errors = [];
  legs.forEach((l) => (l.errors || []).forEach((e) => { if (e && errors.indexOf(e) === -1) errors.push(e); }));

  return { applicable: true, source, hasKey, legs, booking, errors: errors.slice(0, 4), updatedAt: Date.now() };
}

// Cache lifetime as a curve on time-to-departure, not a three-way phase switch.
// "active" began 48h before departure and pinned the TTL at 60s for two full days
// — ~2900 lookups per reservation against a ~600/month quota, when nothing about a
// schedule moves that far out. Refresh fast only when the data actually changes:
// in the air, or close to departure.
function ttlFor(payload) {
  const M = 60 * 1000, H = 3600 * 1000;
  const b = (payload && payload.booking) || {};
  if (b.phase === 'past') return 6 * H;
  const legs = (payload && payload.legs) || [];
  const moving = legs.some((l) => {
    const st = l && l.status && l.status.status;
    return st === 'EnRoute' || st === 'Departed' || st === 'Approaching' ||
      st === 'Boarding' || st === 'Diverted';
  });
  if (moving) return M;
  const dep = b.depMs;
  if (!dep) return 5 * M;                       // unknown departure: middle ground
  const untilDep = dep - Date.now();
  if (untilDep < 3 * H) return M;               // the hours that decide your day
  if (untilDep < 12 * H) return 5 * M;
  if (untilDep < 48 * H) return 30 * M;
  return 2 * H;                                 // far future: schedules barely move
}

// `tripId` here is always the VERIFIED trip from requireOwnedReservation — never
// the raw request value. The cache read is scoped by it as defence in depth, and
// the write persists it so the userless hooks (which cannot membership-check
// anything) can only ever be fed rows a member actually caused.
async function cachedPayload(ctx, tripId, reservationId, force, forcedNumber, resv) {
  const tid = tripId != null ? String(tripId) : null;
  if (!force && !forcedNumber) {
    const rows = await attempt(() => ctx.db.query('SELECT payload, fetched_at FROM cache WHERE reservation_id = ? AND trip_id IS ?', reservationId, tid), []);
    if (rows && rows[0]) {
      try {
        const cached = JSON.parse(rows[0].payload);
        const fresh = (Date.now() - Number(rows[0].fetched_at)) < ttlFor(cached);
        // A cached payload built before/after the admin key was set/removed is
        // stale even within TTL: its hasKey (and thus its schedule data) no
        // longer matches reality. Rebuild when the key's presence has flipped.
        const keyNow = !!(await getKey(ctx));
        if (fresh && !!cached.hasKey === keyNow) return Object.assign(cached, { cached: true });
      } catch (_e) { /* refetch */ }
    }
  }
  const payload = await buildPayload(ctx, tripId, reservationId, forcedNumber, resv);
  await attempt(() => ctx.db.exec(
    'INSERT OR REPLACE INTO cache (reservation_id, trip_id, payload, fetched_at) VALUES (?, ?, ?, ?)',
    reservationId, tid, JSON.stringify(payload), Date.now()));
  return payload;
}

// --- server-rendered strings -------------------------------------------------
// Everything the HOST renders rather than the widget: push/bell notifications and
// the native trip warnings. These were hardcoded German regardless of locale, so
// an English user on an English TREK got German alerts — for the highest-stakes
// text the plugin produces, the one saying the flight is cancelled.
//
// ctx carries no locale: req.user is { id, username, isAdmin } and the userless
// hooks get no user at all. So the widget passes its own locale on /status and
// /refresh (it already receives one via trek:context), and anything without that
// context falls back to English rather than to German.
const SRV_STR = {
  en: {
    cancelled: 'Flight cancelled', diverted: 'Flight diverted',
    delayed: (m) => 'Delayed +' + m + ' min', depDelayed: (m) => 'Departure delayed +' + m + ' min',
    gate: (g) => 'Gate ' + g, departed: 'Departed', arrived: 'Landed',
    updates: 'Flight updates',
    wCancelled: 'cancelled', wDiverted: 'diverted', wDelayed: (m) => '+' + m + ' min late',
  },
  de: {
    cancelled: 'Flug annulliert', diverted: 'Flug umgeleitet',
    delayed: (m) => 'Verspätung +' + m + ' Min', depDelayed: (m) => 'Abflug +' + m + ' Min später',
    gate: (g) => 'Gate ' + g, departed: 'Gestartet', arrived: 'Gelandet',
    updates: 'Flug-Updates',
    wCancelled: 'annulliert', wDiverted: 'umgeleitet', wDelayed: (m) => '+' + m + ' Min verspätet',
  },
};
function srvStr(locale) {
  return String(locale || '').toLowerCase().indexOf('de') === 0 ? SRV_STR.de : SRV_STR.en;
}

// --- notifications (only possible with a bound user, i.e. from a route) -------
// TREK forbids a userless job from notifying, so we fire while the app is open:
// each poll diffs the flight state and, on a meaningful change, sends one
// deduplicated bell/email notification to the acting user.
async function maybeNotify(ctx, user, rid, payload, locale) {
  if (!user || !user.id || !payload || !payload.legs || !payload.legs.length) return;
  if (payload.booking && payload.booking.phase === 'past') return;
  const S = srvStr(locale);
  const uid = String(user.id);
  const cur = payload.legs.map((l) => {
    const s = l.status;
    return { n: l.number,
      st: s ? s.status : null,
      d: s && s.delayMin != null ? Math.round(s.delayMin / 5) * 5 : null,
      // Departure delay is part of the signature, so a 10:00 -> 12:00 slip is a
      // change worth alerting on even when the arrival estimate has not moved.
      dd: s && s.depDelayMin != null ? Math.round(s.depDelayMin / 5) * 5 : null,
      g: s && s.arrival ? (s.arrival.gate || null) : null,
      dg: s && s.departure ? (s.departure.gate || null) : null };
  });
  const prevRows = await attempt(() => ctx.db.query('SELECT sig FROM notif_state WHERE rid = ? AND uid = ?', rid, uid), []);
  const prev = prevRows && prevRows[0] ? prevRows[0].sig : null;
  let prevArr = []; try { prevArr = JSON.parse(prev); } catch (_e) { prevArr = []; }
  const old = {}; (prevArr || []).forEach((o) => { if (o && o.n) old[o.n] = o; });

  // A leg with no status right now (API timeout, 429, key just removed, or simply
  // outside the fetch window) must NOT overwrite what we knew: storing all-nulls as
  // the baseline made the next successful poll look like a fresh gate assignment
  // and a fresh departure, firing alerts for events that never happened. Carry the
  // previous entry forward instead, so the diff is only ever against real data.
  const merged = cur.map((c) => (c.st == null && old[c.n]) ? old[c.n] : c);
  const sig = JSON.stringify(merged);
  await attempt(() => ctx.db.exec('INSERT OR REPLACE INTO notif_state (rid, uid, sig) VALUES (?, ?, ?)', rid, uid, sig));
  if (!prev || prev === sig) return; // baseline or nothing changed
  // Collect EVERY notify-worthy change across all legs (don't mask a second one),
  // then send a single combined notification. The baseline was already advanced
  // above, so nothing gets re-notified.
  const msgs = [];
  for (const c of merged) {
    const o = old[c.n] || {};
    if (c.st == null) continue;               // nothing known this round
    let msg = null;
    if ((c.st === 'Canceled' || c.st === 'Cancelled') && o.st !== c.st) msg = S.cancelled;
    else if (c.st === 'Diverted' && o.st !== c.st) msg = S.diverted;
    else if (c.d != null && c.d >= 15 && c.d !== o.d) msg = S.delayed(c.d);
    else if (c.dd != null && c.dd >= 15 && c.dd !== o.dd) msg = S.depDelayed(c.dd);
    else if ((c.dg || c.g) && (c.dg || c.g) !== (o.dg || o.g)) msg = S.gate(c.dg || c.g);
    else if (c.st === 'Departed' && o.st !== c.st) msg = S.departed;
    else if (c.st === 'Arrived' && o.st !== c.st) msg = S.arrived;
    if (msg) msgs.push({ n: c.n, msg: msg });
  }
  if (msgs.length === 1) {
    await attempt(() => ctx.notify.send({ title: withSpaceNum(msgs[0].n), body: msgs[0].msg, scope: 'user', targetId: user.id }));
  } else if (msgs.length > 1) {
    const body = msgs.map((m) => withSpaceNum(m.n) + ': ' + m.msg).join(' · ').slice(0, 990);
    await attempt(() => ctx.notify.send({ title: S.updates, body: body, scope: 'user', targetId: user.id }));
  }
}

function toIsoUtc(s) {
  if (!s) return null;
  let t = String(s).replace(' ', 'T');
  if (!/[zZ]$|[+-]\d\d:?\d\d$/.test(t)) t += 'Z';
  return t;
}
function hhmm(s) { const m = String(s || '').match(/(\d{1,2}):(\d{2})/); return m ? (m[1].length < 2 ? '0' : '') + m[1] + ':' + m[2] : ''; }

// Record the acting user's flights (UTC times) so the userless calendarSource
// hook can surface them per-user. Keyed by (user, reservation).
async function recordUserFlight(ctx, user, tripId, rid, payload) {
  if (!user || !user.id || !payload) return;
  const uid = String(user.id);
  const events = [];
  if (payload.applicable !== false && Array.isArray(payload.legs)) {
    payload.legs.forEach((l, i) => {
      const s = l.status; if (!s) return;
      const start = toIsoUtc((s.departure && (s.departure.scheduledUtc || s.departure.revisedUtc)) || null);
      const end = toIsoUtc((s.arrival && (s.arrival.revisedUtc || s.arrival.scheduledUtc)) || null);
      if (!start || !end) return;
      const from = l.from || (s.departure && s.departure.iata) || '';
      const to = l.to || (s.arrival && s.arrival.iata) || '';
      events.push({ id: 'ft-' + rid + '-' + i, title: withSpaceNum(l.number) + (from && to ? ' ' + from + '→' + to : ''), start: start, end: end });
    });
  }
  if (events.length) await attempt(() => ctx.db.exec('INSERT OR REPLACE INTO cal_events (uid, rid, trip_id, data, updated_at) VALUES (?, ?, ?, ?, ?)', uid, String(rid), tripId != null ? String(tripId) : null, JSON.stringify(events), Date.now()));
  else await attempt(() => ctx.db.exec('DELETE FROM cal_events WHERE uid = ? AND rid = ?', uid, String(rid)));
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
      // Userless hook: no locale is available here, so English is the documented
      // default rather than the previous German-only text.
      const S = srvStr(null);
      if (s.status === 'Canceled' || s.status === 'Cancelled') out.push({ level: 'error', message: num + route + ' ' + S.wCancelled });
      else if (s.status === 'Diverted') out.push({ level: 'error', message: num + route + ' ' + S.wDiverted });
      else if (s.delayMin != null && s.delayMin >= 20) out.push({ level: 'warning', message: num + route + ' ' + S.wDelayed(s.delayMin) });
      else if (s.depDelayMin != null && s.depDelayMin >= 20) out.push({ level: 'warning', message: num + route + ' ' + S.wDelayed(s.depDelayMin) });
    }
    if (out.length >= 12) break;
  }
  return out.slice(0, 12);
}

// Markers on TREK's own trip map (userless, per-trip): departure/arrival airports
// and the live aircraft, from the freshest cache.
async function getTripMarkers(tripId, ctx) {
  const out = [];
  const rows = await attempt(() => ctx.db.query('SELECT reservation_id, payload, fetched_at FROM cache WHERE trip_id = ?', String(tripId)), []);
  const now = Date.now();
  for (const r of rows || []) {
    if (now - Number(r.fetched_at) > 6 * 3600 * 1000) continue;
    let p; try { p = JSON.parse(r.payload); } catch (_e) { continue; }
    if (!p || p.applicable === false || !Array.isArray(p.legs)) continue;
    const rid = r.reservation_id;
    p.legs.forEach((l, i) => {
      const s = l.status, num = withSpaceNum(l.number);
      if (s && s.departure && s.departure.lat != null && s.departure.lon != null) out.push({ id: 'ft-' + rid + '-' + i + '-d', lat: s.departure.lat, lng: s.departure.lon, label: s.departure.iata || '', popupText: num + ' — ' + (s.departure.name || s.departure.iata || '') });
      if (s && s.arrival && s.arrival.lat != null && s.arrival.lon != null) out.push({ id: 'ft-' + rid + '-' + i + '-a', lat: s.arrival.lat, lng: s.arrival.lon, label: s.arrival.iata || '', popupText: num + ' — ' + (s.arrival.name || s.arrival.iata || '') });
      if (l.live && l.live.lat != null && !l.live.onGround) out.push({ id: 'ft-' + rid + '-' + i + '-p', lat: l.live.lat, lng: l.live.lon, label: num, popupText: (l.live.desc || l.live.type || 'Aircraft') + (l.live.altBaro != null && l.live.altBaro !== 'ground' ? ' · ' + Math.round(l.live.altBaro) + ' ft' : ''), icon: 'plane', tone: 'accent' });
    });
    if (out.length >= 180) break;
  }
  return out.slice(0, 180);
}

// A section for the exported trip PDF (userless, per-trip).
async function getTripPdf(tripId, ctx) {
  const rows = await attempt(() => ctx.db.query('SELECT payload, fetched_at FROM cache WHERE trip_id = ?', String(tripId)), []);
  const now = Date.now();
  const body = [];
  for (const r of rows || []) {
    if (now - Number(r.fetched_at) > 24 * 3600 * 1000) continue;
    let p; try { p = JSON.parse(r.payload); } catch (_e) { continue; }
    if (!p || p.applicable === false || !Array.isArray(p.legs)) continue;
    p.legs.forEach((l) => {
      const s = l.status;
      const from = l.from || (s && s.departure && s.departure.iata) || '';
      const to = l.to || (s && s.arrival && s.arrival.iata) || '';
      const dep = hhmm((s && s.departure && (s.departure.revised || s.departure.scheduled)) || l.depTime || '');
      const arrT = hhmm((s && s.arrival && (s.arrival.revised || s.arrival.scheduled)) || l.arrTime || '');
      body.push([withSpaceNum(l.number), (from && to ? from + ' → ' + to : (from || to || '')), dep, arrT, (s && s.status) || '']);
    });
    if (body.length >= 50) break;
  }
  if (!body.length) return [];
  return [{ title: 'Flights', table: { headers: ['Flight', 'Route', 'Departure', 'Arrival', 'Status'], rows: body } }];
}

// The acting user's flight events for TREK's calendar (userless; reads what the
// user's own views recorded in cal_events).
async function getUserCalendar(userId, start, end, ctx) {
  const rows = await attempt(() => ctx.db.query('SELECT data FROM cal_events WHERE uid = ?', String(userId)), []);
  const s = Date.parse(start), e = Date.parse(end), out = [];
  for (const r of rows || []) {
    let evs; try { evs = JSON.parse(r.data); } catch (_e) { continue; }
    (evs || []).forEach((ev) => {
      const es = Date.parse(ev.start), ee = Date.parse(ev.end);
      if (isNaN(es) || isNaN(ee)) return;
      if (isNaN(s) || isNaN(e) || (ee >= s && es <= e)) out.push({ id: ev.id, title: ev.title, start: ev.start, end: ev.end, allDay: false });
    });
    if (out.length >= 200) break;
  }
  return out.slice(0, 200);
}

function json(status, body) {
  return { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: JSON.stringify(body) };
}

function readParams(req) {
  const q = req.query || {};
  const b = (req.body && typeof req.body === 'object') ? req.body : {};
  // NOTE: apiKey is deliberately absent — it must never be read from the query
  // string, where proxies, host logs and browser history would persist it in
  // plaintext. /key reads it from the body only.
  return {
    tripId: b.tripId != null ? b.tripId : q.tripId,
    reservationId: b.reservationId != null ? b.reservationId : q.reservationId,
    flightNumber: b.flightNumber != null ? b.flightNumber : q.flightNumber,
    // Display locale, forwarded by the widget so host-rendered notifications match
    // the language the user is reading TREK in.
    locale: b.locale != null ? b.locale : q.locale,
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
    await ctx.db.migrate('006_cal',
      'CREATE TABLE IF NOT EXISTS cal_events (uid TEXT, rid TEXT, trip_id TEXT, data TEXT, updated_at INTEGER, PRIMARY KEY (uid, rid))');
    ctx.log.info('flight-tracker loaded');
  },

  hooks: {
    // All userless + fail-safe; they read only the plugin's own freshest cache /
    // per-user event store (populated when a member views the widget).
    warningProvider: {
      async getWarnings(tripId, ctx) { return attempt(() => getTripWarnings(tripId, ctx), []); },
    },
    mapMarkerProvider: {
      async getMarkers(tripId, ctx) { return attempt(() => getTripMarkers(tripId, ctx), []); },
    },
    pdfSectionProvider: {
      async getSections(tripId, ctx) { return attempt(() => getTripPdf(tripId, ctx), []); },
    },
    calendarSource: {
      async getEvents(userId, start, end, ctx) { return attempt(() => getUserCalendar(userId, start, end, ctx), []); },
    },
  },

  routes: [
    { method: 'GET', path: '/status', auth: true,
      async handler(req, ctx) {
        const p = readParams(req);
        if (!p.reservationId) return json(400, { error: 'reservationId required' });
        const own = await requireOwnedReservation(ctx, p.tripId, p.reservationId);
        if (own.error) return own.error;
        const payload = await cachedPayload(ctx, p.tripId, String(p.reservationId), false, null, own.resv);
        if (!payload.cached) {
          await attempt(() => maybeNotify(ctx, req.user, String(p.reservationId), payload, p.locale));
          await attempt(() => recordUserFlight(ctx, req.user, p.tripId, String(p.reservationId), payload));
        }
        payload.canSetKey = canSetKey(ctx, req.user); // per-request — never cached
        return json(200, payload);
      } },

    { method: 'POST', path: '/refresh', auth: true,
      async handler(req, ctx) {
        const p = readParams(req);
        if (!p.reservationId) return json(400, { error: 'reservationId required' });
        const own = await requireOwnedReservation(ctx, p.tripId, p.reservationId);
        if (own.error) return own.error;
        const payload = await cachedPayload(ctx, p.tripId, String(p.reservationId), true, null, own.resv);
        await attempt(() => maybeNotify(ctx, req.user, String(p.reservationId), payload, p.locale));
        await attempt(() => recordUserFlight(ctx, req.user, p.tripId, String(p.reservationId), payload));
        payload.canSetKey = canSetKey(ctx, req.user); // per-request — never cached
        return json(200, payload);
      } },

    // Manual single-flight override for a reservation (empty clears it).
    { method: 'POST', path: '/set', auth: true,
      async handler(req, ctx) {
        const p = readParams(req);
        if (!p.reservationId) return json(400, { error: 'reservationId required' });
        // Gate FIRST: this route writes the override table and, via ctx.meta, into
        // TREK's own reservation data.
        const own = await requireOwnedReservation(ctx, p.tripId, p.reservationId);
        if (own.error) return own.error;
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
        const payload = await cachedPayload(ctx, p.tripId, rid, true, number, own.resv);
        payload.canSetKey = canSetKey(ctx, req.user); // per-request — never cached
        return json(200, payload);
      } },

    // Instance-wide AeroDataBox key, settable in-widget by an admin (TREK >=3.4.0,
    // where req.user.isAdmin is reliable). An empty value clears it. Every cached
    // payload is dropped afterwards: entries built without a key hold no schedule
    // data, so they would otherwise mask the newly-working lookups until TTL.
    { method: 'POST', path: '/key', auth: true,
      async handler(req, ctx) {
        if (!canSetKey(ctx, req.user)) return json(403, { error: 'admin only' });
        // Body only. Fail loudly rather than silently ignoring a query-string key:
        // a caller who thinks the key was set would never rotate the leaked one.
        if (req.query && req.query.apiKey != null) return json(400, { error: 'apiKey must be sent in the JSON body, not the query string' });
        const b = (req.body && typeof req.body === 'object') ? req.body : {};
        const val = (b.apiKey == null ? '' : String(b.apiKey)).trim();
        if (val) await ctx.db.exec("INSERT OR REPLACE INTO kv (k, v) VALUES ('aerodatabox_key', ?)", val);
        else await ctx.db.exec("DELETE FROM kv WHERE k = 'aerodatabox_key'");
        await attempt(() => ctx.db.exec('DELETE FROM cache'));
        return json(200, { ok: true, hasKey: !!val });
      } },
  ],
});
