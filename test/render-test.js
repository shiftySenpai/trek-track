// Renders client/index.html in headless Chrome with TREK's REAL kit stylesheet
// inlined at the trek:ui marker, a stubbed window.trek bridge, and mock payloads.
// Asserts the resulting DOM and fails on any console error or page error.
//
//   npm run test:render
//
// Not part of `npm test`: it needs a Chrome/Edge binary and the trek-plugin-sdk
// devDependency installed. It skips (exit 0) rather than failing when either is
// absent, so it never blocks a machine that simply has no browser.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const OUT = path.join(os.tmpdir(), 'ft-render');
fs.mkdirSync(OUT, { recursive: true });

function findChrome() {
  const env = process.env.CHROME_PATH;
  const candidates = [env,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  return candidates.find((c) => { try { return fs.existsSync(c); } catch (e) { return false; } }) || null;
}

const CHROME = findChrome();
if (!CHROME) {
  console.log('SKIP: no Chrome/Edge binary found (set CHROME_PATH to run these).');
  process.exit(0);
}

// The kit is re-exported from the package root (deep subpaths are blocked by the
// package's "exports" map), so the harness styles the widget with the SAME
// stylesheet the real host injects — not an approximation of it.
let kit;
try {
  kit = require('trek-plugin-sdk');
  if (!kit.TREK_UI_CSS) throw new Error('TREK_UI_CSS missing from trek-plugin-sdk');
} catch (e) {
  console.log('SKIP: trek-plugin-sdk unavailable (run `npm i`) — ' + e.message);
  process.exit(0);
}
const KIT_CSS = kit.TREK_UI_CSS;
const MARKER = kit.TREK_UI_MARKER || '<!-- trek:ui -->';

// FT_CLIENT points the harness at an older widget build, to confirm a scenario
// actually fails against the code it was written to catch.
const WIDGET = process.env.FT_CLIENT ? path.resolve(process.env.FT_CLIENT) : path.join(REPO, 'client', 'index.html');
const widget = fs.readFileSync(WIDGET, 'utf8');
if (widget.indexOf(MARKER) === -1) throw new Error('trek:ui marker not found in client/index.html');

// ---------------------------------------------------------------- fixtures
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString().replace('Z', '');

function leg(over) {
  return Object.assign({
    number: 'LH452', callsign: 'DLH452', airline: 'Lufthansa',
    from: 'MUC', to: 'LAX', seat: '14A',
    status: {
      number: 'LH452', status: 'EnRoute', airline: 'Lufthansa',
      aircraftModel: 'Airbus A380-800', aircraftReg: 'D-AIML', delayMin: 64,
      departure: { iata: 'MUC', name: 'Munich', terminal: '2', gate: 'H45', scheduled: iso(now - 3600e3), revised: iso(now - 3000e3), scheduledUtc: iso(now - 3600e3), revisedUtc: iso(now - 3000e3), lat: 48.35, lon: 11.78 },
      arrival: { iata: 'LAX', name: 'Los Angeles', terminal: 'B', gate: null, baggageBelt: '7', scheduled: iso(now + 39600e3), revised: iso(now + 43000e3), scheduledUtc: iso(now + 39600e3), revisedUtc: iso(now + 43000e3), lat: 33.94, lon: -118.4 },
    },
    live: { hex: '3c65a2', callSign: 'DLH452', reg: 'D-AIML', type: 'A388', desc: 'AIRBUS A-380-800', lat: 50.799, lon: 5.732, altBaro: 34000, groundSpeed: 464, track: 287, verticalRate: 0, onGround: false, seenPos: 3 },
    weather: { temp: 22, main: 'Clouds', description: 'Overcast', tempMax: 26, tempMin: 18, precipProb: 40 },
    inbound: null, errors: [],
  }, over || {});
}

const preflightLeg = leg({
  status: Object.assign({}, leg().status, { status: 'Expected', delayMin: null }),
  live: null,
  inbound: { reg: 'D-AIMK', lat: 47.1, lon: 9.2, groundSpeed: 420, onGround: false },
});
// departure ~3h out so the boarding estimate fires
preflightLeg.status.departure = Object.assign({}, preflightLeg.status.departure, {
  scheduled: iso(now + 3 * 3600e3), revised: null, scheduledUtc: iso(now + 3 * 3600e3), revisedUtc: null,
});

// Two legs connecting through FRA. `connMin` is the gap between leg 1's ARRIVAL and
// leg 2's DEPARTURE; a negative value means the inbound is delayed past the onward
// flight, i.e. the connection is already gone.
function legPair(connMin) {
  const arr1 = now + 60 * 60e3;
  const dep2 = arr1 + connMin * 60e3;
  const iso = (ms) => new Date(ms).toISOString().replace('Z', '');
  const mk = (number, from, to, depMs, arrMs, status) => leg({
    number, from, to,
    status: {
      number, status: status || 'Expected', airline: 'Lufthansa', delayMin: null, depDelayMin: null,
      aircraftModel: 'Airbus A320', aircraftReg: 'D-AIZA',
      departure: { iata: from, name: from, terminal: '1', gate: 'A1', scheduled: iso(depMs), revised: null, scheduledUtc: iso(depMs), revisedUtc: null, lat: 48.1, lon: 16.5 },
      arrival: { iata: to, name: to, terminal: '2', gate: null, baggageBelt: null, scheduled: iso(arrMs), revised: null, scheduledUtc: iso(arrMs), revisedUtc: null, lat: 50.0, lon: 8.5 },
    },
    live: null, weather: null, inbound: null, errors: [],
  });
  return [
    mk('LH1234', 'VIE', 'FRA', now - 30 * 60e3, arr1),
    mk('LH400', 'FRA', 'JFK', dep2, dep2 + 8 * 3600e3),
  ];
}

// Three legs where the first has already arrived — that one collapses.
function threeLegs() {
  const pair = legPair(90);
  const first = JSON.parse(JSON.stringify(pair[0]));
  first.status.status = 'Arrived';
  const third = JSON.parse(JSON.stringify(pair[1]));
  third.number = 'LH500'; third.from = 'JFK'; third.to = 'LAX';
  third.status.number = 'LH500'; third.status.departure.iata = 'JFK'; third.status.arrival.iata = 'LAX';
  return [first, pair[1], third];
}

const base = { applicable: true, source: 'detected', legs: [leg()], updatedAt: now,
  booking: { type: 'flight', depMs: now - 3600e3, arrMs: now + 39600e3, phase: 'active', pnr: 'ABC123', origin: 'MUC', dest: 'LAX', legCount: 1 } };

const SCENARIOS = [
  { id: 'enroute-admin-haskey', w: 420, payload: Object.assign({}, base, { hasKey: true, canSetKey: true }),
    // key is active -> the whole key row must be absent (no repetition per widget)
    expect: { has: ['ft-band', 'trek-chip', 'In the air', 'Progress', 'Ground', 'LAX'],
      not: ['Add AeroDataBox key', 'key active', 'AeroDataBox', 'ft-keyrow', 'ft-pill'] } },
  { id: 'preflight-admin-nokey', w: 420,
    payload: Object.assign({}, base, { hasKey: false, canSetKey: true, legs: [preflightLeg],
      booking: Object.assign({}, base.booking, { depMs: now + 3 * 3600e3, phase: 'active' }) }),
    expect: { has: ['Add AeroDataBox key', 'Seat', 'Terminal MUC', 'Gate MUC', 'Boarding', 'Aircraft inbound'], not: ['key active', 'Replace'] } },
  { id: 'nonadmin-nokey', w: 420, payload: Object.assign({}, base, { hasKey: false, canSetKey: false }),
    expect: { has: ['No AeroDataBox key configured'], not: ['Add AeroDataBox key', 'key active'] } },
  { id: 'cancelled', w: 420,
    payload: Object.assign({}, base, { hasKey: true, canSetKey: true,
      legs: [leg({ status: Object.assign({}, leg().status, { status: 'Canceled' }), live: null })] }),
    expect: { has: ['trek-chip--danger'], not: ['Progress', 'Ground'] } },
  { id: 'nonflight-collapse', w: 420, payload: { applicable: false, legs: [], hasKey: true, canSetKey: true, updatedAt: now, booking: {} },
    expect: { collapsed: true } },
  { id: 'narrow-320', w: 320, payload: Object.assign({}, base, { hasKey: true, canSetKey: true }),
    expect: { has: ['ft-band', 'In the air'], noOverflow: true } },
  // adsb.fi position 20 minutes old: shown, but must not pulse as if live
  { id: 'stale-fix', w: 420,
    payload: Object.assign({}, base, { hasKey: true, canSetKey: true,
      legs: [leg({ live: Object.assign({}, leg().live, { seenPos: 1200 }) })] }),
    expect: { has: ['Last seen', 'ft-dot--idle'], not: ['ft-dot pulse'] } },
  // 45 minutes old: past the point of pretending we know where it is
  { id: 'fix-gone', w: 420,
    payload: Object.assign({}, base, { hasKey: true, canSetKey: true,
      legs: [leg({ live: Object.assign({}, leg().live, { seenPos: 2700 }) })] }),
    expect: { has: ['out of ADS-B coverage'], not: ['ft-dot pulse', 'Progress'] } },
  // --- multi-leg ------------------------------------------------------------
  // Two legs with a comfortable 2h connection: journey header + layover connector.
  { id: 'multileg-normal', w: 420,
    payload: Object.assign({}, base, { hasKey: true, canSetKey: true,
      legs: [legPair(120)[0], legPair(120)[1]],
      booking: Object.assign({}, base.booking, { legCount: 2, origin: 'VIE', dest: 'JFK' }) }),
    expect: { has: ['ft-journey', 'ft-layover', 'Layover'], not: ['ft-layover broken', 'ft-layover tight'] } },
  // 35-minute connection -> the tight warning must fire.
  { id: 'multileg-tight', w: 420,
    payload: Object.assign({}, base, { hasKey: true, canSetKey: true,
      legs: legPair(35),
      booking: Object.assign({}, base.booking, { legCount: 2, origin: 'VIE', dest: 'JFK' }) }),
    expect: { has: ['ft-layover tight'], not: ['ft-layover broken'] } },
  // Inbound delayed PAST the onward departure. The old minute-of-day arithmetic
  // wrapped this into a comfortable "22 h layover"; it must now read as broken.
  { id: 'multileg-broken', w: 420,
    payload: Object.assign({}, base, { hasKey: true, canSetKey: true,
      legs: legPair(-120),
      booking: Object.assign({}, base.booking, { legCount: 2, origin: 'VIE', dest: 'JFK' }) }),
    expect: { has: ['ft-layover broken'], not: ['22 h', 'ft-layover tight'] } },
  // 3+ legs with an arrived first leg -> it collapses, and must be a real button.
  { id: 'multileg-collapsed', w: 420,
    payload: Object.assign({}, base, { hasKey: true, canSetKey: true,
      legs: threeLegs(),
      booking: Object.assign({}, base.booking, { legCount: 3, origin: 'VIE', dest: 'JFK' }) }),
    expect: { has: ['ft-collapsed'], collapsedButtons: 1 } },
  // errors must be visible: a capped key looked identical to "no data for this flight"
  { id: 'quota-error', w: 420,
    payload: Object.assign({}, base, { hasKey: true, canSetKey: true, errors: ['status: 429 quota exceeded'] }),
    expect: { has: ['quota exceeded'] } },
];

// ---------------------------------------------------------------- harness
function buildPage(sc) {
  const bridge = `
<style>${KIT_CSS}</style>
<script>
(function () {
  var PAYLOAD = ${JSON.stringify(sc.payload)};
  var errors = [];
  window.addEventListener('error', function (e) { errors.push('error: ' + (e.message || e)); });
  window.addEventListener('unhandledrejection', function (e) { errors.push('reject: ' + (e.reason && e.reason.message || e.reason)); });
  var ce = console.error; console.error = function () { errors.push('console: ' + Array.prototype.join.call(arguments, ' ')); ce.apply(console, arguments); };
  window.__errors = errors;
  var ctxCb = null;
  window.trek = {
    onContext: function (cb) { ctxCb = cb; setTimeout(function () {
      cb({ tripId: 1, reservationId: 42, userId: 7, theme: 'dark', locale: 'en-US',
           formats: { locale: 'en-US', timezone: 'Europe/Berlin', hour12: true }, tokens: {} });
    }, 0); },
    invoke: function (p, o) { return Promise.resolve(JSON.parse(JSON.stringify(PAYLOAD))); },
    notify: function () {}, navigate: function () {}, openExternal: function () {},
    confirm: function () { return Promise.resolve(true); }, onEvent: function () {},
    resize: function (h) { window.__resized = h; },
  };
})();
<\/script>`;

  // --window-size does not reliably constrain the layout viewport under
  // --dump-dom, so pin the width in CSS — that is what actually exercises the
  // narrow-sidebar media query.
  const clamp = `<style>html,body{width:${sc.w}px;max-width:${sc.w}px;overflow-x:hidden;margin:0}</style>`;
  let html = widget.replace(MARKER, bridge + clamp);
  // report hook: dump assertions into the DOM so --dump-dom can read them
  html = html.replace('</body>', `
<div id="testout" style="display:none"></div>
<script>
setTimeout(function () {
  var app = document.getElementById('app');
  var doc = document.documentElement;
  var out = {
    errors: window.__errors || [],
    resized: window.__resized,
    collapsed: doc.hasAttribute('data-ft-empty'),
    html: app ? app.innerHTML : '',
    text: app ? (app.innerText || app.textContent || '') : '',
    scrollW: app ? app.scrollWidth : 0, clientW: app ? app.clientWidth : 0,
    overflowers: (function () {
      var bad = [], all = document.querySelectorAll('#app *');
      for (var i = 0; i < all.length; i++) {
        var el = all[i];
        // .ft-v truncates deliberately (ellipsis on long values) — not a layout bug
        if (String(el.className).indexOf('ft-v') !== -1) continue;
        if (el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0) bad.push((el.className || el.tagName) + ' ' + el.scrollWidth + '>' + el.clientWidth);
      }
      return bad.slice(0, 6);
    })(),
    chipCount: document.querySelectorAll('.trek-chip').length,
    bandCount: document.querySelectorAll('.ft-band').length,
    lang: doc.lang,
    liveRegion: !!document.querySelector('#ft-live[role="status"][aria-live="polite"]'),
    liveRegionOutsideApp: !!(document.querySelector('#ft-live') && !app.contains(document.querySelector('#ft-live'))),
    collapsedAreButtons: Array.prototype.every.call(
      document.querySelectorAll('.ft-collapsed'), function (e) { return e.tagName === 'BUTTON'; }),
    collapsedCount: document.querySelectorAll('.ft-collapsed').length,
    legCount: document.querySelectorAll('.ft-leg').length,
    layoverText: Array.prototype.map.call(document.querySelectorAll('.ft-layover'), function (e) { return e.textContent.trim(); }),
    legacy: document.querySelectorAll('.ft-pill, .ft-chip, .ft-meta, .ft-weather, .ft-inbound, .ft-live-head, .ft-progline, .ft-maplink').length
  };
  document.getElementById('testout').textContent = 'TESTOUT:' + JSON.stringify(out);
}, 1200);
<\/script>
</body>`);
  const f = path.join(OUT, sc.id + '.html');
  fs.writeFileSync(f, html);
  return f;
}

let failed = 0;
for (const sc of SCENARIOS) {
  const file = buildPage(sc);
  let dom = '';
  try {
    dom = execFileSync(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--virtual-time-budget=4000',
      '--window-size=' + sc.w + ',900', '--dump-dom', 'file:///' + file.replace(/\\/g, '/')],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) { console.log('FAIL ' + sc.id + ': chrome failed ' + e.message); failed++; continue; }

  const m = dom.match(/TESTOUT:(\{.*?\})<\/div>/s);
  if (!m) { console.log('FAIL ' + sc.id + ': no test output'); failed++; continue; }
  let r;
  try { r = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')); }
  catch (e) { console.log('FAIL ' + sc.id + ': unparseable output'); failed++; continue; }

  const probs = [];
  if (r.errors.length) probs.push('JS errors: ' + r.errors.join(' | '));
  if (r.legacy) probs.push('legacy classes still rendered: ' + r.legacy);
  const ex = sc.expect || {};
  if (ex.collapsed) {
    if (!r.collapsed) probs.push('expected data-ft-empty collapse');
    if (r.resized !== 1) probs.push('expected resize(1), got ' + r.resized);
    if ((r.html || '').trim()) probs.push('expected empty #app');
  } else {
    for (const nd of ex.has || []) if (r.html.indexOf(nd) === -1 && r.text.indexOf(nd) === -1) probs.push('missing: ' + nd);
    for (const nd of ex.not || []) if (r.html.indexOf(nd) !== -1 || r.text.indexOf(nd) !== -1) probs.push('should NOT contain: ' + nd);
    if (!r.bandCount) probs.push('no .ft-band rendered');
  }
  if (r.clientW && r.clientW > sc.w) probs.push('viewport not constrained: clientW ' + r.clientW + ' > ' + sc.w);
  // a11y invariants that must hold in EVERY scenario
  if (!r.liveRegion) probs.push('screen-reader live region missing');
  if (!r.liveRegionOutsideApp) probs.push('live region is inside #app — render() would rebuild it and cancel announcements');
  if (!r.collapsedAreButtons) probs.push('collapsed legs are not real buttons (keyboard-unreachable)');
  if (!r.lang) probs.push('document lang not set — German announced with English phonemes');
  if (ex.collapsedButtons != null && r.collapsedCount !== ex.collapsedButtons) {
    probs.push('expected ' + ex.collapsedButtons + ' collapsed leg(s), got ' + r.collapsedCount);
  }
  if (ex.noOverflow) {
    if (r.scrollW > r.clientW + 1) probs.push('horizontal overflow: scrollW ' + r.scrollW + ' > clientW ' + r.clientW);
    if (r.overflowers && r.overflowers.length) probs.push('overflowing elements: ' + r.overflowers.join(' | '));
  }

  // visual capture for review
  try {
    execFileSync(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--virtual-time-budget=4000',
      '--window-size=' + sc.w + ',1100', '--hide-scrollbars',
      '--screenshot=' + path.join(OUT, sc.id + '.png'), 'file:///' + file.replace(/\\/g, '/')],
      { stdio: 'ignore' });
  } catch (e) { /* screenshots are advisory */ }

  if (probs.length) { failed++; console.log('FAIL ' + sc.id); probs.forEach((p) => console.log('     ' + p)); }
  else console.log('PASS ' + sc.id + '  (bands=' + r.bandCount + ' chips=' + r.chipCount + (ex.noOverflow ? ' w=' + r.scrollW + '/' + r.clientW : '') + ')');
}

console.log(failed ? '\n' + failed + ' scenario(s) FAILED' : '\nall render scenarios passed');
process.exit(failed ? 1 : 0);
