#!/usr/bin/env node
// Regenerates server/data/airlines.json, the offline airline lookup bundled with
// the plugin.
//
//   node scripts/build-airlines.js                 # fetch both sources
//   node scripts/build-airlines.js --offline DIR   # use DIR/vrs-airlines.csv + DIR/airlines.dat
//
// SOURCES, in increasing precedence:
//
//   1. OpenFlights airlines.dat — broad, but frozen around 2017. Kept only for the
//      extra historical name spellings it contributes; every code it supplies can
//      be overridden by a fresher source.
//   2. Virtual Radar Server "standing data" (CC0, actively maintained) — the
//      authority for anything modern. Pinned to a commit so a build is reproducible
//      and an upstream edit cannot silently change bundled codes.
//   3. server/data/airline-overrides.json — hand-verified fixes for brand names,
//      name collisions and carriers missing upstream. Always wins.
//
// Why the layering matters: OpenFlights maps "IndiGo" to I9, a defunct US carrier,
// and "Scoot" to its retired TZ. Querying a wrong code silently returns SOMEONE
// ELSE'S FLIGHT, which is far worse than returning nothing — so the build asserts a
// probe list at the end and exits non-zero on any mismatch.
const fs = require('fs');
const path = require('path');

// Pinned: github.com/vradarserver/standing-data @ ae9e846 (2026-04-29).
const VRS_SHA = 'ae9e846528646d80474feb2d81bdc082260f885f';
const SRC_VRS = 'https://raw.githubusercontent.com/vradarserver/standing-data/' + VRS_SHA + '/airlines/schema-01/airlines.csv';
const SRC_OF = 'https://raw.githubusercontent.com/jpatokal/openflights/master/data/airlines.dat';

const DATA_DIR = path.join(__dirname, '..', 'server', 'data');
const OUT = path.join(DATA_DIR, 'airlines.json');
const OVERRIDES = path.join(DATA_DIR, 'airline-overrides.json');

// Corporate suffixes that are never part of the name a traveller types.
const CORP = new Set(['inc', 'ltd', 'llc', 'plc', 'co', 'corp', 'corporation', 'company',
  'group', 'holdings', 'holding', 'limited', 'sa', 'ag', 'gmbh', 'srl', 'spa', 'as', 'ab',
  'oy', 'nv', 'bv', 'pty', 'pvt', 'private', 'jsc', 'ojsc', 'cjsc', 'llp', 'sas', 'sarl']);

// Generic aviation words stripped to form the "core" key ("Delta Air Lines" ->
// "delta"). Deliberately excludes distinguishing words like "express", "connection",
// "eagle", "shuttle", "cargo", "charter" — those separate real, distinct carriers.
const GENERIC = new Set(['airlines', 'airline', 'airways', 'airway', 'air', 'lines', 'line',
  'aviation', 'aviacion', 'aerolineas', 'aerolinea', 'airliner', 'aero', 'linhas', 'aereas',
  'luchtvaartmaatschappij', 'international', 'intl', 'transport', 'transports', 'travel']);

// Two chars, at least one letter: a real IATA designator is LL, LD or DL. An
// all-digit "code" in the source is junk and would make the flight-number parser
// read the first two digits of a bare number as an airline ("1234" -> "12" + "34").
const VALID_IATA = /^(?=.*[A-Z])[A-Z0-9]{2}$/;
const VALID_ICAO = /^[A-Z]{3}$/;

function parseCsvLine(line) {
  const out = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

function norm(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ')
    .trim().replace(/\s+/g, ' ');
}

function words(s) { return s ? s.split(' ') : []; }

function variants(name) {
  const base = norm(name);
  if (!base) return [];
  const set = new Set([base]);
  set.add(base.replace(/\bair lines\b/g, 'airlines'));
  set.add(base.replace(/\bairlines\b/g, 'air lines'));
  for (const v of Array.from(set)) {
    let w = words(v);
    while (w.length > 1 && CORP.has(w[w.length - 1])) w = w.slice(0, -1);
    if (w.length) set.add(w.join(' '));
  }
  return Array.from(set).filter(Boolean);
}

function core(name) {
  return words(norm(name)).filter((x) => !GENERIC.has(x) && !CORP.has(x)).join(' ');
}

async function grab(url, offlineDir, offlineName) {
  if (offlineDir) return fs.readFileSync(path.join(offlineDir, offlineName), 'utf8');
  const res = await fetch(url);
  if (!res.ok) throw new Error('fetch failed ' + res.status + ': ' + url);
  return res.text();
}

// --- source parsers ---------------------------------------------------------
// Each yields {name, iata, icao, tier} where a higher tier wins a conflict.

function parseOpenFlights(raw) {
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const f = parseCsvLine(line);
    if (f.length < 8) continue;
    const [, name, alias, iataRaw, icaoRaw, , , activeRaw] = f;
    const iata = String(iataRaw || '').toUpperCase().trim();
    if (!VALID_IATA.test(iata)) continue;
    const icao = String(icaoRaw || '').toUpperCase().trim();
    const active = String(activeRaw || '').toUpperCase() === 'Y';
    // Defunct OpenFlights rows are the main source of stale wrong codes; keep them
    // only a hair above nothing so any fresher row displaces them.
    const tier = active ? 2 : 1;
    for (const n of [name, (alias && alias !== '\\N') ? alias : '']) {
      if (n && n.trim()) out.push({ name: n.trim(), iata, icao: VALID_ICAO.test(icao) ? icao : '', tier });
    }
  }
  return out;
}

function parseVrs(raw) {
  const out = [];
  const lines = raw.replace(/^﻿/, '').split(/\r?\n/);
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const f = parseCsvLine(line);
    if (f.length < 4) continue;
    const [, name, icaoRaw, iataRaw] = f;
    const iata = String(iataRaw || '').toUpperCase().trim();
    if (!VALID_IATA.test(iata)) continue;
    const icao = String(icaoRaw || '').toUpperCase().trim();
    if (!name || !name.trim()) continue;
    out.push({ name: name.trim(), iata, icao: VALID_ICAO.test(icao) ? icao : '', tier: 3 });
  }
  return out;
}

// --- probe gate -------------------------------------------------------------
// Names a traveller plausibly types -> the code that MUST come out. Guards against
// upstream drift, vandalism and regressions in the merge logic.
const PROBES = {
  'delta airlines': 'DL', 'delta air lines': 'DL', 'delta': 'DL',
  'frontier airlines': 'F9', 'frontier': 'F9',
  'united airlines': 'UA', 'southwest airlines': 'WN', 'american airlines': 'AA',
  'lufthansa': 'LH', 'british airways': 'BA', 'air france': 'AF', 'klm': 'KL',
  'easyjet': 'U2', 'ryanair': 'FR', 'wizz air': 'W6', 'vueling': 'VY',
  'emirates': 'EK', 'qatar airways': 'QR', 'turkish airlines': 'TK',
  'indigo': '6E', 'scoot': 'TR', 'ita airways': 'AZ', 'condor': 'DE',
  'flydubai': 'FZ', 'saudia': 'SV', 'latam': 'LA', 'gol': 'G3',
  'play': 'OG', 'breeze airways': 'MX', 'akasa air': 'QP', 'riyadh air': 'RX',
  'starlux': 'JX', 'zipair': 'ZG', 'norse atlantic': 'N0', 'discover airlines': '4Y',
  'ajet': 'VF', 'level': 'LL', 'jetsmart': 'JA', 'viva aerobus': 'VB',
  'smartwings': 'QS', 'corendon airlines': 'XC', 'flynas': 'XY', 'salamair': 'OV',
  'avelo': 'XP', 'flair': 'F8', 'world2fly': '2W', 'french bee': 'BF',
  'la compagnie': 'B0', 'wizz air abu dhabi': '5W', 'animawings': 'A2', 'hisky': 'H7',
  'jetblue airways': 'B6', 'alaska airlines': 'AS', 'spirit airlines': 'NK',
  'porter airlines': 'PD', 'westjet': 'WS', 'copa airlines': 'CM', 'aeromexico': 'AM',
};

async function main() {
  const offlineIdx = process.argv.indexOf('--offline');
  const offlineDir = offlineIdx > -1 ? process.argv[offlineIdx + 1] : null;

  const [ofRaw, vrsRaw] = await Promise.all([
    grab(SRC_OF, offlineDir, 'airlines.dat'),
    grab(SRC_VRS, offlineDir, 'vrs-airlines.csv'),
  ]);

  const rows = parseOpenFlights(ofRaw).concat(parseVrs(vrsRaw));
  const overrides = JSON.parse(fs.readFileSync(OVERRIDES, 'utf8'));
  const ovAll = Object.assign({}, overrides.collisions, overrides.missing, overrides.brand);

  const nameToIata = {}, nameTier = {};
  const coreOwners = {}, coreBest = {}, coreTier = {};
  const iataIcao = {}, iataTier = {};

  for (const r of rows) {
    if (r.icao && (!(r.iata in iataIcao) || r.tier > iataTier[r.iata])) {
      iataIcao[r.iata] = r.icao; iataTier[r.iata] = r.tier;
    }
    for (const v of variants(r.name)) {
      if (v.length < 2) continue;
      if (!(v in nameToIata) || r.tier > nameTier[v]) { nameToIata[v] = r.iata; nameTier[v] = r.tier; }
    }
    const c = core(r.name);
    if (c.length < 3) continue;
    (coreOwners[c] || (coreOwners[c] = new Set())).add(r.iata);
    if (!(c in coreBest) || r.tier > coreTier[c]) { coreBest[c] = r.iata; coreTier[c] = r.tier; }
  }

  // A core key is trustworthy when one airline claims it, or when a single row
  // outranks every rival. Ambiguous cores are DROPPED, never guessed.
  const coreToIata = {};
  let droppedCores = 0;
  for (const [c, owners] of Object.entries(coreOwners)) {
    if (owners.size === 1) { coreToIata[c] = coreBest[c]; continue; }
    const top = coreTier[c];
    const rivals = new Set(rows.filter((r) => core(r.name) === c && r.tier === top).map((r) => r.iata));
    if (rivals.size === 1) coreToIata[c] = coreBest[c];
    else droppedCores++;
  }

  // Overrides last — they beat every source, for exact names and core keys alike.
  let ovApplied = 0;
  for (const [key, spec] of Object.entries(ovAll)) {
    if (!spec || !VALID_IATA.test(spec.iata || '')) throw new Error('bad override iata for ' + key);
    for (const v of variants(key)) { nameToIata[v] = spec.iata; nameTier[v] = 99; }
    const c = core(key);
    if (c.length >= 3) coreToIata[c] = spec.iata;
    if (spec.icao && VALID_ICAO.test(spec.icao)) { iataIcao[spec.iata] = spec.icao; iataTier[spec.iata] = 99; }
    ovApplied++;
  }

  const out = { nameToIata, coreToIata, iataIcao };
  fs.writeFileSync(OUT, JSON.stringify(out) + '\n');

  // --- assert the probes ----------------------------------------------------
  const failures = [];
  for (const [name, want] of Object.entries(PROBES)) {
    const n = norm(name);
    const got = nameToIata[n] || coreToIata[core(n)] || '(none)';
    if (got !== want) failures.push('  ' + name.padEnd(24) + ' got ' + got.padEnd(8) + ' want ' + want);
  }

  const size = fs.statSync(OUT).size;
  console.log('sources        : openflights (tier 1-2) + vrs@' + VRS_SHA.slice(0, 7) + ' (tier 3) + ' + ovApplied + ' overrides');
  console.log('source rows    : ' + rows.length);
  console.log('nameToIata     : ' + Object.keys(nameToIata).length);
  console.log('coreToIata     : ' + Object.keys(coreToIata).length + ' (' + droppedCores + ' ambiguous dropped)');
  console.log('iataIcao       : ' + Object.keys(iataIcao).length);
  console.log('written        : ' + path.relative(process.cwd(), OUT) + ' (' + Math.round(size / 1024) + ' KB)');

  if (failures.length) {
    console.error('\nPROBE FAILURES (' + failures.length + '/' + Object.keys(PROBES).length + '):');
    failures.forEach((f) => console.error(f));
    process.exit(1);
  }
  console.log('probes         : all ' + Object.keys(PROBES).length + ' passed');
}

main().catch((e) => { console.error(e); process.exit(1); });
