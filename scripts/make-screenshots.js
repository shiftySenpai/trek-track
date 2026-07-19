#!/usr/bin/env node
// Renders the widget in headless Chrome and writes documentation screenshots to
// docs/img/. Standalone: it builds its own fixtures and inlines TREK's real kit
// stylesheet, so the images show the widget exactly as the host styles it.
//
//   npm run screenshots            # needs Chrome/Edge + `npm i`
//
// Each shot is taken twice, in the dark and light theme, and the viewport height
// is measured first so the image is cropped to the card instead of trailing a
// screenful of empty background.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const OUT = path.join(REPO, 'docs', 'img');
const TMP = path.join(os.tmpdir(), 'ft-shots');
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(TMP, { recursive: true });

function findChrome() {
  const cands = [process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter(Boolean);
  return cands.find((c) => { try { return fs.existsSync(c); } catch (e) { return false; } }) || null;
}
const CHROME = findChrome();
if (!CHROME) { console.log('SKIP: no Chrome/Edge found (set CHROME_PATH).'); process.exit(0); }

let kit;
try { kit = require('trek-plugin-sdk'); if (!kit.TREK_UI_CSS) throw new Error('no TREK_UI_CSS'); }
catch (e) { console.log('SKIP: trek-plugin-sdk unavailable (run `npm i`) — ' + e.message); process.exit(0); }

const widget = fs.readFileSync(path.join(REPO, 'client', 'index.html'), 'utf8');
const MARKER = kit.TREK_UI_MARKER || '<!-- trek:ui -->';

// --- fixtures ---------------------------------------------------------------
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString().replace('Z', '');

function leg(over) {
  return Object.assign({
    number: 'LH452', callsign: 'DLH452', airline: 'Lufthansa', from: 'MUC', to: 'LAX', seat: '14A',
    status: {
      number: 'LH452', status: 'EnRoute', airline: 'Lufthansa',
      aircraftModel: 'Airbus A380-800', aircraftReg: 'D-AIML', delayMin: 64, depDelayMin: 55,
      departure: { iata: 'MUC', name: 'Munich', terminal: '2', gate: 'H45',
        scheduled: iso(now - 3600e3), revised: iso(now - 300e3), scheduledUtc: iso(now - 3600e3), revisedUtc: iso(now - 300e3), lat: 48.35, lon: 11.78 },
      arrival: { iata: 'LAX', name: 'Los Angeles', terminal: 'B', gate: null, baggageBelt: '7',
        scheduled: iso(now + 39600e3), revised: iso(now + 43000e3), scheduledUtc: iso(now + 39600e3), revisedUtc: iso(now + 43000e3), lat: 33.94, lon: -118.4 },
    },
    live: { hex: '3c65a2', callSign: 'DLH452', reg: 'D-AIML', type: 'A388', desc: 'AIRBUS A-380-800',
      lat: 50.799, lon: 5.732, altBaro: 34000, groundSpeed: 464, track: 287, verticalRate: 0, onGround: false, seenPos: 3 },
    weather: { temp: 22, main: 'Clouds', description: 'Overcast', tempMax: 26, tempMin: 18, precipProb: 40 },
    inbound: null, errors: [],
  }, over || {});
}

const booking = { type: 'flight', depMs: now - 3600e3, arrMs: now + 39600e3, phase: 'active', origin: 'MUC', dest: 'LAX', legCount: 1 };
const base = { applicable: true, source: 'detected', legs: [leg()], booking, updatedAt: now };

const preflight = (() => {
  const l = leg({ live: null, inbound: { reg: 'D-AIMK', lat: 47.1, lon: 9.2, groundSpeed: 420, onGround: false } });
  l.status = Object.assign({}, l.status, { status: 'Expected', delayMin: null, depDelayMin: null });
  l.status.departure = Object.assign({}, l.status.departure,
    { scheduled: iso(now + 3 * 3600e3), revised: null, scheduledUtc: iso(now + 3 * 3600e3), revisedUtc: null });
  return l;
})();

function pair(connMin) {
  const arr1 = now + 60 * 60e3, dep2 = arr1 + connMin * 60e3;
  const mk = (number, from, to, depMs, arrMs) => leg({
    number, from, to, live: null, weather: null,
    status: {
      number, status: 'Expected', airline: 'Lufthansa', delayMin: null, depDelayMin: null,
      aircraftModel: 'Airbus A320', aircraftReg: 'D-AIZA',
      departure: { iata: from, name: from, terminal: '1', gate: 'A1', scheduled: iso(depMs), scheduledUtc: iso(depMs), revisedUtc: null, lat: 48.1, lon: 16.5 },
      arrival: { iata: to, name: to, terminal: '2', scheduled: iso(arrMs), scheduledUtc: iso(arrMs), revisedUtc: null, lat: 50.0, lon: 8.5 },
    },
  });
  return [mk('LH1234', 'VIE', 'FRA', now - 30 * 60e3, arr1), mk('LH400', 'FRA', 'JFK', dep2, dep2 + 8 * 3600e3)];
}

const SHOTS = [
  { id: 'widget-enroute', w: 440, payload: Object.assign({}, base, { hasKey: true, canSetKey: false }) },
  { id: 'widget-preflight', w: 440, payload: Object.assign({}, base, { hasKey: true, canSetKey: false, legs: [preflight] }) },
  { id: 'widget-multileg', w: 440,
    payload: Object.assign({}, base, { hasKey: true, canSetKey: false, legs: pair(35),
      booking: Object.assign({}, booking, { legCount: 2, origin: 'VIE', dest: 'JFK' }) }) },
  { id: 'widget-keyless', w: 440,
    payload: Object.assign({}, base, { hasKey: false, canSetKey: false, legs: [leg({ status: null, weather: null })] }) },
  { id: 'widget-key-entry', w: 440,
    payload: Object.assign({}, base, { hasKey: false, canSetKey: true, legs: [preflight] }) },
  { id: 'widget-narrow', w: 320, payload: Object.assign({}, base, { hasKey: true, canSetKey: false }) },
];

function page(sc, theme, clampHeight) {
  const bridge = `
<style>${kit.TREK_UI_CSS}</style>
<style>
  html,body{width:${sc.w}px;max-width:${sc.w}px;margin:0;overflow-x:hidden;
    background:${theme === 'dark' ? '#0b0d10' : '#f4f5f7'};padding:10px;box-sizing:border-box}
  ${clampHeight ? `html,body{height:${clampHeight}px;overflow:hidden}` : ''}
</style>
<script>
(function(){
  var P = ${JSON.stringify(sc.payload)};
  window.trek = {
    onContext: function (cb) { setTimeout(function(){ cb({ tripId:1, reservationId:42, userId:7,
      theme:'${theme}', locale:'en-US', formats:{locale:'en-US',timezone:'Europe/Berlin',hour12:false}, tokens:{} }); },0); },
    invoke: function(){ return Promise.resolve(JSON.parse(JSON.stringify(P))); },
    notify: function(){}, navigate: function(){}, openExternal: function(){},
    confirm: function(){ return Promise.resolve(true); }, onEvent: function(){}, resize: function(){},
  };
})();
<\/script>`;
  let html = widget.replace(MARKER, bridge);
  html = html.replace('</body>', `<div id="h" style="display:none"></div>
<script>setTimeout(function(){document.getElementById('h').textContent='H:'+
  (document.getElementById('app').getBoundingClientRect().height+24);},1200);<\/script></body>`);
  return html;
}

function chrome(args) {
  execFileSync(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--virtual-time-budget=4000'].concat(args), { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
}

let n = 0;
for (const sc of SHOTS) {
  for (const theme of ['dark', 'light']) {
    // pass 1: measure the card so the image is cropped to it
    const probe = path.join(TMP, sc.id + '-probe.html');
    fs.writeFileSync(probe, page(sc, theme, null));
    let h = 900;
    try {
      const dom = execFileSync(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox',
        '--virtual-time-budget=4000', '--window-size=' + sc.w + ',1400', '--dump-dom',
        'file:///' + probe.replace(/\\/g, '/')], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
      const m = dom.match(/H:([\d.]+)/);
      if (m) h = Math.ceil(Number(m[1])) + 10;
    } catch (e) { /* fall back to 900 */ }

    // pass 2: the actual screenshot, at 2x for a crisp image on the wiki
    const file = path.join(TMP, sc.id + '.html');
    fs.writeFileSync(file, page(sc, theme, h));
    const outFile = path.join(OUT, sc.id + (theme === 'light' ? '-light' : '') + '.png');
    chrome(['--force-device-scale-factor=2', '--window-size=' + sc.w + ',' + h,
      '--screenshot=' + outFile, 'file:///' + file.replace(/\\/g, '/')]);
    const kb = Math.round(fs.statSync(outFile).size / 1024);
    console.log('  ' + path.relative(REPO, outFile).padEnd(34) + sc.w + 'x' + h + '  ' + kb + ' KB');
    n++;
  }
}
console.log('\n' + n + ' screenshots written to ' + path.relative(REPO, OUT));
