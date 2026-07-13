# Flight Tracker

Turn every flight reservation in TREK into a live flight tracker. The widget
sits under each reservation card in the trip planner and shows the real-time
status of that flight — combining scheduled data from **AeroDataBox** with the
actual aircraft position from the free **adsb.fi** open-data network.

![screenshot](./docs/screenshot.png)

## What it does

- **Reads the flight straight from the booking.** It scans the reservation for a
  flight number (e.g. `LH400`); if none is found you can type or correct it, and
  it is remembered for that reservation.
- **Schedule & status** (via AeroDataBox): departure/arrival airports, scheduled
  vs. estimated times, delay in minutes, live status (boarding, en route,
  arrived, cancelled), plus terminal, gate and baggage belt.
- **Live position in the air** (via adsb.fi): when the aircraft is transmitting
  ADS-B, it shows altitude, ground speed, climb/descent trend, registration and
  aircraft type, and a one-tap link to open the plane on a live map.
- **Works with or without an API key.** Without an AeroDataBox key you still get
  the free live position from adsb.fi by entering the ATC call sign (e.g.
  `DLH400`). Results are cached briefly so the public rate limits are respected.
- Native TREK look in both light and dark themes, German and English.

## Screenshots

See the image above (`docs/screenshot.png`), showing the widget with a delayed
Frankfurt → New York flight in both the light and dark theme: route, revised
times with the delay highlighted, gate/terminal/belt, and the live in-air block
with altitude and speed.

## Permissions

| Permission | Why |
|---|---|
| `db:own` | Stores the flight number linked to each reservation and a short-lived response cache in the plugin's own SQLite database. |
| `db:read:trips` | Reads the reservation to auto-detect its flight number. |
| `db:meta` | Best-effort mirror of the chosen flight number onto the reservation so other TREK surfaces can read it. |
| `http:outbound` | Marks the plugin as making outbound HTTP calls. |
| `http:outbound:aerodatabox.p.rapidapi.com` | Fetches flight schedule, status, gate and delay data from AeroDataBox. |
| `http:outbound:opendata.adsb.fi` | Fetches the live aircraft position from the adsb.fi open-data API. |

## Setup

1. Install and activate the plugin, then approve its permissions.
2. **Optional but recommended:** get a free AeroDataBox key at
   `rapidapi.com/aedbx-aedbx/api/aerodatabox` and paste it into the plugin's
   **AeroDataBox RapidAPI key** setting (Admin → Plugins). This unlocks the
   schedule, gate and delay data. Without a key, only the live adsb.fi position
   is shown.
3. Open a trip, expand a flight reservation, and the tracker appears beneath it.
   If the flight number isn't detected automatically, type it once and it is
   saved.

Data sources: [AeroDataBox](https://aerodatabox.com/) and
[adsb.fi](https://adsb.fi/) — adsb.fi open data is for personal, non-commercial
use.

## License

MIT — see `LICENSE`.
