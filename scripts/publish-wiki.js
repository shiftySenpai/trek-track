#!/usr/bin/env node
// Publishes wiki/*.md to the GitHub wiki repo.
//
//   node scripts/publish-wiki.js [--dry]
//
// The wiki is a separate git repository (…/trek-track.wiki.git) that GitHub only
// creates once the first page has been made through the web UI. Pages are authored
// in the main repo so they review alongside the code, and mirrored here.
//
// Images are NOT copied: the pages reference raw.githubusercontent.com URLs on the
// main branch, so screenshots stay versioned with the code that produced them.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const SRC = path.join(REPO, 'wiki');
// Derive the wiki URL from origin, so it inherits whatever transport (and
// credentials) already work for the code repo — usually SSH.
function wikiUrl() {
  if (process.env.WIKI_URL) return process.env.WIKI_URL;
  try {
    const origin = execFileSync('git', ['remote', 'get-url', 'origin'],
      { cwd: REPO, encoding: 'utf8' }).trim();
    return origin.replace(/\.git$/, '') + '.wiki.git';
  } catch (e) {
    return 'https://github.com/fbnlrz/trek-track.wiki.git';
  }
}
const WIKI_URL = wikiUrl();
const DRY = process.argv.includes('--dry');

if (!fs.existsSync(SRC)) { console.error('no wiki/ directory'); process.exit(1); }
const pages = fs.readdirSync(SRC).filter((f) => f.endsWith('.md'));
if (!pages.length) { console.error('no pages in wiki/'); process.exit(1); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-wiki-'));
const git = (args, cwd) => execFileSync('git', args, { cwd: cwd || tmp, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

try {
  try {
    git(['clone', '--depth', '1', WIKI_URL, tmp], REPO);
  } catch (e) {
    console.error('Could not clone ' + WIKI_URL + '\n\n' +
      'Enabling the Wiki checkbox in Settings does NOT create the repository —\n' +
      'it only appears once the first page has been saved. Open\n' +
      '  https://github.com/fbnlrz/trek-track/wiki\n' +
      'click "Create the first page", save anything (it gets overwritten), then\n' +
      're-run this script.\n\n' + (e.stderr || e.message));
    process.exit(1);
  }

  let changed = 0;
  for (const p of pages) {
    const to = path.join(tmp, p);
    const next = fs.readFileSync(path.join(SRC, p), 'utf8');
    const prev = fs.existsSync(to) ? fs.readFileSync(to, 'utf8') : null;
    if (prev !== next) { fs.writeFileSync(to, next); changed++; console.log('  updated ' + p); }
    else console.log('  unchanged ' + p);
  }

  if (!changed) { console.log('\nNothing to publish.'); process.exit(0); }
  if (DRY) { console.log('\n--dry: ' + changed + ' page(s) would be published.'); process.exit(0); }

  git(['add', '-A']);
  git(['commit', '-m', 'Update wiki from wiki/ in the main repo']);
  git(['push']);
  console.log('\nPublished ' + changed + ' page(s) to ' + WIKI_URL);
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* best effort */ }
}
