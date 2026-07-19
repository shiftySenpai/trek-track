# Development

```bash
git clone https://github.com/fbnlrz/trek-track.git
cd trek-track
npm install
```

`trek-plugin-sdk` is a **devDependency only** — the host makes
`require('trek-plugin-sdk')` resolve inside the plugin process at runtime. Never
vendor it, and never add a runtime dependency: TREK does not run `npm install` on a
plugin, so anything else would have to be bundled.

## Layout

| Path | |
|---|---|
| `trek-plugin.json` | manifest — permissions, egress, settings, TREK range |
| `server/index.js` | backend: routes, hooks, all `ctx` access |
| `client/index.html` | the whole widget, single file; TREK's kit is injected at the `<!-- trek:ui -->` marker |
| `server/data/airlines.json` | generated — do not edit by hand |
| `server/data/airline-overrides.json` | hand-verified airline codes, applied last |
| `scripts/` | dataset build, documentation screenshots |

## Commands

```bash
npm run build:airlines   # regenerate server/data/airlines.json from upstream
npm run screenshots      # regenerate docs/img/* (needs Chrome + npm i)
npx trek-plugin-sdk validate .
npx trek-plugin-sdk pack . --out plugin.zip
```

## The airline dataset

`npm run build:airlines` merges, in increasing precedence:

1. **OpenFlights** — broad but frozen around 2017, kept only for extra historical name
   spellings.
2. **Virtual Radar Server standing-data** (CC0) — the authority for anything modern,
   pinned to a commit so builds are reproducible and an upstream edit cannot silently
   change bundled codes.
3. **`server/data/airline-overrides.json`** — hand-verified fixes for brand names,
   collisions and carriers missing upstream. Always wins.

The build then asserts a probe list of 58 known airline codes and **exits non-zero
without writing** if any mismatch. Treat a probe failure as a real signal: OpenFlights
alone maps `IndiGo` to `I9` (a defunct US carrier) and `Scoot` to its retired `TZ`, and
a wrong code silently queries someone else's flight.

Adding an override requires a code you actually verified from a fetched source —
record which one in the `src` field. If no source can confirm it, leave it out.

## Tests

The test suite is not committed. If you have it locally:

```bash
npm test              # unit + authorization tests, no network, no TREK host
npm run test:render   # renders the widget in headless Chrome with TREK's real kit
```

Two conventions worth keeping if you add tests:

- **`FT_SERVER` / `FT_CLIENT`** point the suites at an older build, so a regression
  test can be proven non-vacuous. A security test that passes against the vulnerable
  code is worthless — the authorization tests fail 14-of-18 against the pre-fix
  server, and the layover scenario fails against the pre-fix client.
- **The render harness inlines the SDK's real `TREK_UI_CSS`** rather than an
  approximation, so what it asserts is what the host actually renders. It skips
  cleanly when Chrome or the devDependencies are absent.

## Things that will bite you

- **`ctx.trips` works only inside route handlers.** In `onLoad` and jobs there is no
  acting user, so it throws `RESOURCE_FORBIDDEN`. Never wrap that call in a
  swallow-everything helper — doing so once turned a failed permission check into a
  successful request.
- **Egress is driven by `http:outbound:<host>` permissions**, not by `egress[]`. A
  host in `egress[]` but not granted is silently blocked at runtime. Keep both lists
  identical, and remember any new host needs a README entry (a hard CI gate) and admin
  re-approval on update.
- **The UI frame renders no bundled or external images.** Opaque origin, strict CSP —
  only inline SVG and `data:`/`blob:` work. `trek-plugin dev` applies no CSP, so
  something that works there can still fail in the real host.
- **`docs/` is not shipped** in `plugin.zip` by design; the store fetches images from
  GitHub at the pinned commit.
- **Git tag must equal the manifest version**, and the registry pins the release
  asset's sha256 — never re-upload a released `plugin.zip`, cut a new version.

## Releasing

```bash
# bump "version" in trek-plugin.json first, then:
npx trek-plugin-sdk publish --repo fbnlrz/trek-track --tag v1.8.0 --sign
```

Signing is a one-way door: once shipped signed, an unsigned or differently-keyed
update is refused until an admin re-trusts the plugin. Back up
`~/.trek-plugin/signing.key`.

The registry entry (`registry/plugins/flight-tracker.json` in
[liketrek/TREK-Plugins](https://github.com/liketrek/TREK-Plugins)) must keep the
maintainer-set top-level `reviewedAt` and `boundOwner` fields, and keep prior versions
in `versions`, newest first. `entry --sign` regenerates only the current version block,
so re-add those by hand.

## Updating this wiki

The pages live in `wiki/` in the main repo and are pushed to the wiki repo:

```bash
node scripts/publish-wiki.js
```
