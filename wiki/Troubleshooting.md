# Troubleshooting

Since v1.8.0 the widget **shows API errors instead of hiding them** — a red line
under the card. Previously an exhausted quota, a rejected key and "this flight has no
data" all looked identical. If you see a message there, start with it.

---

## "You are not subscribed to this API."

**This does not mean your subscription is broken.** RapidAPI returns that exact text
for *any* key it does not recognise — a typo, a truncated paste and a genuinely
unsubscribed key are indistinguishable:

| Key sent | Response |
|---|---|
| `INVALID_KEY_TEST` | `You are not subscribed to this API.` |
| well-formed but fake | `You are not subscribed to this API.` |

**Step 1 — is the key itself good?** Test it outside TREK entirely:

```bash
curl -sS -H "x-rapidapi-key: YOUR_KEY" \
     -H "x-rapidapi-host: aerodatabox.p.rapidapi.com" \
     "https://aerodatabox.p.rapidapi.com/flights/number/EK24?withAircraftImage=false&withLocation=true" | head -c 300
```

- **JSON flight data comes back** → the key is fine, so the plugin is sending a
  *different* one. Go to step 2.
- **Same error** → an account problem on rapidapi.com. Check you are subscribed to
  the listing at host `aerodatabox.p.rapidapi.com`; AeroDataBox has several.

**Step 2 — the key precedence trap.** `ctx.config` always wins over the key entered
in the widget. If an old or empty value sits there, your new key is never used, and
`{ok: true, hasKey: true}` from the widget only confirms it was *stored*, not that it
is being *used*. Clear the config key and re-activate:

```js
await fetch('/api/admin/plugins/flight-tracker/config', {
  method:'PUT', credentials:'include', headers:{'Content-Type':'application/json'},
  body: JSON.stringify({ aerodatabox_key: '' })
}).then(r=>r.json()).then(console.log);
```

Then **deactivate → activate** the plugin — this step is mandatory, `ctx.config` is
only read at activation — and hard-refresh the trip tab.

---

## No schedule, gate or delay — only the live position

Expected without an AeroDataBox key. adsb.fi provides position, altitude, speed,
registration and type for free; everything scheduled comes from AeroDataBox. See
[Setup](Setup#2-add-the-aerodatabox-key).

If a key *is* set, check for:

- **Too far out.** Schedule data is only fetched from about 48 h before departure, to
  protect the monthly quota. A flight next month legitimately shows only a countdown.
- **A red error line** under the card — read it, then see the section above.
- **Quota exhausted** (`429`). The free tier is ~600 requests/month; see
  [How it works](How-it-works#quota).

---

## The widget shows nothing at all

- **Not a flight.** On hotels, trains and other reservation types the widget collapses
  to a 1 px sliver by design.
- **TREK older than 3.4.0.** The plugin declares `>=3.4.0 <4.0.0` and will not install.
- **Not activated**, or its permissions were never approved (Admin → Plugins).

## "Add AeroDataBox key" is not visible

Three possible reasons, in order of likelihood:

1. **A key is already active.** The field is hidden once a key is set — that is
   intended. To replace or remove it, see
   [Changing or removing the key](Setup#changing-or-removing-the-key).
2. **You are not an admin.** Non-admins only ever see the hint line.
3. **TREK below 3.4.** `req.user.isAdmin` is always `false` there, so nobody qualifies.

---

## The flight is not found, or the wrong flight appears

**Type it any way you like.** `Frontier Airlines` + `1234`, `F9 1234`, `F91234` and
the ICAO form `FFT1234` all resolve to the same flight, and airline names match
loosely — `Delta Airlines`, `Delta Air Lines` and `Delta` all reach `DL`.

If a lookup still fails:

- **Check the airline name.** Codes come from a bundled dataset of ~2,800 name
  spellings. An unusual spelling may miss — enter the flight number *with* its airline
  prefix instead (`LH400`), which bypasses the name lookup entirely.
- **Deliberately missing carriers.** Where no source could verify a code, none is
  shipped — a wrong code silently queries someone *else's* flight, which is worse than
  no result. Iberojet is currently in this category.
- **Re-detect.** The ✧ icon re-reads the reservation and clears any manual override.

> Fixed in v1.8.0: airline codes containing a digit (`F9` Frontier, `U2` easyJet,
> `6E` IndiGo, `W6` Wizz Air) were unqueryable — about 40 % of all codes. Also
> `IndiGo` used to resolve to `I9`, a defunct US carrier, and `Scoot` to its retired
> `TZ`.

## A red-eye shows yesterday's gate or status

Fixed in v1.8.0. Lookups are pinned to the booking's date, but the API also returns
the *previous* day's operation when it arrives on that date, and the old tie-break
picked it. Candidates are now filtered to those departing on the pinned date.

## The aircraft is shown but the flight hasn't departed

Fixed in v1.8.0. The live window was derived from the *booking's* clock, which carries
no timezone and need not match the real schedule — so a flight departing tomorrow
could display the aircraft currently flying today's rotation. A position is now
discarded when the authoritative schedule says the flight is not up.

## The map is an empty grey box

Fixed in v1.8.0, and it affected **every user without an API key**. With no airport
coordinates the map had a single point to frame, and zoomed so far in that the bundled
coarse world outline had no geometry to draw. It now frames a continent.

## The aircraft looks frozen

If the ADS-B position is more than 5 minutes old the dot stops pulsing and the age is
shown ("Last seen 14 min ago"); beyond 30 minutes it is treated as a coverage gap and
the position is dropped. Mid-ocean and over Siberia this is normal — receivers are
ground-based.

---

## Imported bookings are missing departure/arrival

TREK's importer uses [KItinerary](https://invent.kde.org/pim/kitinerary). Its most
reliable path is **schema.org JSON-LD** embedded in the message. From reading its
source, the silent failure modes are:

- The nested airport must be `"@type": "Airport"` **exactly**. A `Place`,
  `CivicStructure` or misspelling fails a type check and the property is left empty,
  while the flight and airline still populate — which looks exactly like this symptom.
- `reservationFor` must carry `"@type": "Flight"`; it has no fallback.
- Airports must be **objects**, not bare strings (`"departureAirport": "FRA"`) and not
  arrays — both yield an empty object.
- `departureTime` / `arrivalTime` belong **inside** `reservationFor`, not on the
  reservation.
- A **date-only** value (10 characters) is silently moved to `departureDay` and the
  time is lost.
- If you supply a UTC offset that disagrees with the airport's real one, timezone
  normalisation is skipped and the time stays wrong. **Omitting the offset is safer** —
  KItinerary then attaches the airport's real zone from its IATA code.

`@context` is *not* required and is never read — a missing one is not your problem.

## Notifications arrive in the wrong language

Fixed in v1.8.0: the notification and trip-warning strings were hardcoded German
regardless of locale. They now follow the widget's locale and fall back to English.
Trip warnings rendered by the planner have no user context available, so those are
always English.

---

## Nothing here matches

Open an [issue](https://github.com/fbnlrz/trek-track/issues) with the TREK version,
the plugin version, the red error line if there is one, and what the browser console
shows. If the widget renders but the data looks wrong, the exact flight number and
date help a lot — most remaining edge cases are date- or timezone-shaped.
