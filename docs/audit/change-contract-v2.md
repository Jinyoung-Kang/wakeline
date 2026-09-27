# Wakeline change contract v2 (binding for all implementation lanes) — 2026-09-28

Supersedes nothing in `change-contract.md` (v1 stays in force); this document ADDS the demand-driven tracking (ADR-013), AIS ships (ADR-014) and the remaining review fixes.
Data-honesty rule (owner's standing rule): unknown = null/"—"; estimates/assumptions labelled; never display heuristic guesses as data.
Evidence for external APIs is in ADR-013/014 (measured 2026-09-28). Fixture for AIS: `fixtures/ais_east_asia_90s.jsonl` (484 real messages, JSON lines, each with `_recv_offset_s`).

## A. Demand-driven tracking (ADR-013)

### A1. Demand computation (api)
- Every 10 s (and immediately on subscribe/select changes, debounced 1 s) the api computes demand from live, non-paused WS sessions:
  - session.selectedHex != null → focus demand {hex}. That session contributes NO hot-region demand.
  - else if session.zoom >= 7 and the viewport centre is NOT inside the fixed region circle (runtime settings region_center/region_radius_nm) → hot demand:
    cell = (round(lat*2)/2, round(lon*2)/2) i.e. 0.5° grid; radius_nm = min(250, ceil(half-diagonal of the session bbox in NM / 50) * 50), minimum 50.
    cell key = `{lat:.1f}:{lon:.1f}:{radius}` (e.g. `35.5:139.5:150`). Sessions with the same key share one lease.
  - A session's focus older than 30 min continuously (same hex) stops producing demand; the server sends the session {type:"demand", ..., focus:{state:"expired_session_cap"}} and the UI says so.
- Leases in Redis (api is the only writer; collector read-only):
  - ZSET `wakeline:demand:hot` member=cellKey score=expiresAtEpochMs (now + 60 000). HASH `wakeline:demand:hot:meta` field=cellKey value=JSON {lat, lon, radius_nm, sessions, first_at}.
  - ZSET `wakeline:demand:focus` member=hex score=expiresAtEpochMs (now + 60 000). HASH `wakeline:demand:focus:meta` field=hex value=JSON {sessions, first_at}.
  - The api removes expired members (ZREMRANGEBYSCORE -inf now) and their meta fields on every refresh. Caps enforced by the api when writing: at most 6 hot cells (rank by sessions desc, then first_at asc) and at most 50 focus hexes.
- Hex format: 6 lowercase hex chars (validated). Cell coordinates validated to lat ±85, lon ±180.

### A2. Collector scheduling
- DemandPoller reads both ZSETs every 1 s (ZRANGEBYSCORE now +inf) + meta HASHes.
- focus: every 5 s, ONE adsb.fi request `https://opendata.adsb.fi/api/v2/icao/{hex,hex,...}` (≤ 50 hexes per request; more → multiple requests through the limiter). Publish to `wakeline:aircraft` with scope "focus" (see §C) including `requested` = list of hexes asked and `missing` = hexes not returned.
- hot: each active cell every 30 s via `https://opendata.adsb.fi/api/v3/lat/{lat}/lon/{lon}/dist/{radius}`. Publish scope "hot" with `cell` = cellKey and region {lat, lon, radius_nm}.
- Host limiter (in-process, collector is a single instance): adsb.fi 0.8 req/s token bucket (burst 1) shared by ALL adsb.fi calls (region fallback, focus, hot). Collector-wide cap 2.0 req/s across all external HTTP hosts. Daily budget adsb_fi = 40 000.
- Priority when the limiter cannot serve everything within the target interval: fixed region > focus > hot. Hot intervals back off 30 → 60 → 120 s; cells beyond capacity are skipped (state "throttled").
- Status HASH `wakeline:demand:status` (collector writes): field `focus:{hex}` / `hot:{cellKey}` → JSON {state: "active"|"throttled"|"not_found"|"error", interval_s, last_success_at, last_error, provider}. TTL-free; the collector deletes fields whose lease is gone.
- Fixture mode: focus/hot served from the fixture snapshot (moved by dead reckoning like the region fixture) with provider "fixture"; no external calls.

### A3. api merge + WS
- SnapshotStore keeps scopes: region, global, hot (per cellKey, dropped 90 s after its last message), focus (per hex, entry dropped 60 s after its last observation or when the hex is no longer in the focus lease set).
- Merged view: for each hex pick the observation with the most recent seen_at among all scopes; ties → region > focus > hot > global. (Fixes DH-2.) Global entries older than 600 s are still dropped.
- Engine/alerts and TrackWriter consume the merged states and the focus/hot states like region states (focus points are persisted → dense 5 s track).
- WS server → client `{type:"demand", hot:{cell, radius_nm, state, interval_s}|null, focus:{hex, state, interval_s, since}|null}` sent on change and every 30 s. States: hot: "active"|"pending"|"throttled"|"covered_by_region"; focus: "active"|"pending"|"throttled"|"not_found"|"error"|"expired_session_cap".
- `selected` messages are sent on every focus update of that hex (≈ 5 s) in addition to existing triggers.
- /api/v1/status adds `demand: {hot_active, focus_active, adsb_fi_rps_1m}` (counts only, no hexes).

## B. AIS ships (ADR-014)

### B1. Ingest container `ais` (python -m wakeline_collector.ais)
- Env: AISSTREAM_API_KEY (compose maps it from `${aisstream_key}` in .env), REDIS_USERNAME=wakeline_ais, REDIS_PASSWORD=${REDIS_AIS_PASSWORD}, WAKELINE_FIXTURE_MODE, AIS_BBOXES default "18,105,46,150" (lat1,lon1,lat2,lon2; ';' separates boxes).
  Runtime override: HASH wakeline:settings field `ais_bboxes` (same format), re-read every 30 s; subscription update sent at most once per 5 s.
- websockets client with compression="deflate", subscription within 1 s of connect, max_size 1 MiB, ping keepalive 20 s.
- Reader → bounded asyncio.Queue(20 000) of raw text; on full: drop and count `dropped`. Worker parses (orjson), validates, maintains per-MMSI state; flush every 10 s.
- Validation → null: lat 91 / lon 181 (drop the position), SOG >= 102.3 → null, COG >= 360 → null, TrueHeading 511 → null, ETA month 0/day 0/hour 24/minute 60 → null, empty/"@"-padded strings → trimmed, "" → null. MMSI must be 9 digits. Position quality gate: |lat|>90, |lon|>180 → drop; jump > 50 NM within 60 s of the previous accepted fix → quarantine (count, do not publish).
- Position timestamp: `time_utc` from MetaData (receiver time). `Timestamp` field 61 → position_source "manual", 62 → "estimated" (ship's own dead reckoning), 63 → "inoperative", else "gnss".
- Every 10 s: XADD `wakeline:ships` (MAXLEN ~200) envelope kind "ships" (schemas/stream_envelope.v1.json extended) with payload {ships:[ShipState...changed since last flush], static:[ShipStatic...changed], stats:{msgs, msgs_per_s, dropped, quarantined, connected, bbox}}.
- Gaps: on disconnect record started_at; on the next successful subscription record ended_at and XADD `wakeline:ships` kind "ais_gap" payload {started_at, ended_at, reason}. Status HASH `wakeline:ais:status` {connected, connected_since, last_msg_at, msgs_per_s, dropped_total, quarantined_total, gap_open_since|""}.
- Backoff 1 → 2 → 4 … 60 s with ±20 % jitter; reset only after 60 s of healthy connection.
- Fixture mode: replay fixtures/ais_east_asia_90s.jsonl in a loop honoring `_recv_offset_s`, shifting time_utc to now; provider "fixture".
- Health: `python -m wakeline_collector.ais.health` exit 0 if wakeline:ais:status last_msg_at within 120 s OR a gap is open and the process is reconnecting (healthy = process alive and trying; the UI shows the gap).

### B2. Schemas (schemas/*.json + byte-identical copies in apps/api/src/main/resources/schemas/)
- `ship_state.v1.json`: {mmsi (string ^[0-9]{9}$), lat, lon, sog_kn|null, cog_deg|null, heading_deg|null, nav_status (0-15)|null, rot|null, position_source ("gnss"|"manual"|"estimated"|"inoperative"), seen_at (ISO), provider ("aisstream"|"fixture"), msg_type (string), class ("A"|"B")}.
- `ship_static.v1.json`: {mmsi, name|null, call_sign|null, imo|null, ship_type (0-99)|null, dim_a|null, dim_b|null, dim_c|null, dim_d|null, draught_m|null, destination|null, eta_month|null, eta_day|null, eta_hour|null, eta_minute|null, updated_at, provider}.
- stream_envelope.v1.json: kind enum adds "ships", "ais_gap"; scope enum adds "hot", "focus", "ships"; $defs adds ships_payload, ais_gap_payload; aircraft_payload adds optional `cell` (string), `requested` (array of hex), `missing` (array of hex).

### B3. api
- Consumer group `api` on stream `wakeline:ships`. ShipStore: MMSI → latest ShipState + ShipStatic; ships with seen_at older than 30 min are removed from the live set UNLESS an AIS gap is open (then frozen and shown stale).
- Flyway V4: `ship` (mmsi char(9) PK, name, call_sign, imo int, ship_type smallint, dim_a..dim_d smallint, draught_m real, destination, eta_month..eta_minute smallint, first_seen, last_seen, updated_at, provider), `ship_position` partitioned daily like track_point (mmsi char(9), ts timestamptz, geom Point 4326, sog_kn real, cog_deg real, heading_deg smallint, nav_status smallint, position_source text, provider text, PK (mmsi, ts)) with SECURITY DEFINER partition functions mirroring V2 (ensure/drop with bounds), `ingest_gap` (id bigserial, source text, started_at, ended_at, reason text, UNIQUE(source, started_at)). Grants: wakeline_api DML on these; retention 72 h ship_position, gaps permanent.
- Persist ship positions downsampled: at most one row per MMSI per 60 s (keep the first fix of each 60 s window), batched off the consumer thread (reuse OrderedWriter/TrackWriter patterns).
- WS: client {type:"layers", aircraft:boolean, ships:boolean} (default aircraft true, ships false). Ships are sent only to sessions with ships=true:
  - zoom >= 7: {type:"ships_snapshot", sseq, ts, ships:[ShipLite]} then {type:"ships_diff", sseq, ts, upsert, remove} every 10 s (own per-session contiguous sseq, same rules as aircraft seq). ShipLite = {mmsi, lat, lon, sog_kn, cog_deg, heading_deg, ship_type, name, seen_at, position_source, nav_status} (nulls omitted). Cap 5 000 ships per message; if exceeded send grid instead and say so (`capped:true`).
  - zoom < 7: {type:"ships_grid", ts, cell_deg, cells:[[lat, lon, count, dominant_category]...]} every 10 s; cell_deg = 5 (z<3), 2 (z<5), 0.5 (z<7); cell centre coordinates.
  - {type:"select_ship", mmsi|null} → {type:"ship_selected", mmsi, state|null, static|null} immediately and on each change.
  - status message adds sources.ais {connected, lag_s, msgs_per_s, gap_open_since|null, last_gap:{started_at, ended_at}|null}.
- REST: GET /api/v1/ships?bbox= (≤ 2 500 sq°, ShipLite FeatureCollection + meta), GET /api/v1/ships/{mmsi} (state + static + meta), GET /api/v1/ships/{mmsi}/track?from&to (≤ 24 h; GeoJSON MultiLineString split at AIS gaps and at time jumps > 15 min; response lists `gaps` overlapping the window), GET /api/v1/ais/gaps?from&to.
- Ship category (for colour) derived from ship_type using the USCG AIS Guide table: 30 fishing; 31,32,52 tug/towing; 36,37 sailing/pleasure; 40–49 high-speed craft; 50,51,53,54,55,58 special/service (pilot, SAR, port tender, anti-pollution, law enforcement, medical); 35 military; 60–69 passenger; 70–79 cargo; 80–89 tanker; 0/null unknown; everything else other. The mapping lives in ONE place per side (api ShipCategory + web lib/ships.ts) and both are unit-tested against the same table.

### B4. web
- Layer toggles 항공기 / 선박 (persist in localStorage, wrapped in try/catch). Ship icon: SDF hull shape rotated by heading_deg, else cog_deg (then outline dashed = "침로 기준"), else not rotated and drawn as a circle ("방향 모름"). Colour by category with a legend section. Stale (age > 15 min) translucent. position_source estimated/manual → 추정/수동 badge.
- Grid view: circles sized by count with labels.
- Ship card: 선박명, MMSI, 호출부호, IMO, 선종(코드+분류), 크기(A+B × C+D m, "보고값"), 흘수, 목적지, ETA("MM-DD HH:MM UTC · 선원 입력값, 연도 없음" or "—"), 속력/침로/선수방위, 항해 상태, 위치 출처, 관측 시각(age). Track line from REST + live appends; AIS gap segments drawn dashed/grey with a label.
- Status bar: AIS badge (connected · msgs/s · lag) and a gap badge when a gap is open or ended within 30 min ("AIS 공백 hh:mm–hh:mm UTC").
- Demand UX: when an aircraft is selected show "집중 추적 5초 · N분째" / "대기" / "호출 상한으로 지연" / "공급자에서 찾지 못함"; when zoomed in outside the region show "핫 리전 30초 갱신(반경 N NM)" or its state. Never claim a cadence the server did not report.

## C. Redis ACL additions (infra lane)
- wakeline_api: add `~wakeline:demand:*` (write) — already covered by ~wakeline:* — and the ships stream.
- wakeline_collector: add `%R~wakeline:demand:hot %R~wakeline:demand:focus %R~wakeline:demand:hot:meta %R~wakeline:demand:focus:meta ~wakeline:demand:status` (read leases, write status).
- NEW user wakeline_ais (password REDIS_AIS_PASSWORD): `~wakeline:ships ~wakeline:ais:* %R~wakeline:settings`, same COMMON rules and the collector's consumer-group deny list.
- init_env generates REDIS_AIS_PASSWORD. compose: new service `ais` hardened like collector (read_only, cap_drop ALL, no-new-privileges, non-root, mem limit 256m), depends_on redis healthy, healthcheck per B1.

## D. Remaining review fixes (owners in the workflow)
See docs/audit/review-2026-09-28.json (confirmed + unverified) and the residual list; lanes must re-verify each unverified item against the code before fixing (skip with a reason if not real).
