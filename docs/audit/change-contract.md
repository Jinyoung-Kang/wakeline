# SkyWx change contract (binding for all implementation lanes)

All lanes implement against THIS document so api (Java), web (TS) and collector (Python) stay compatible.
Data-honesty rule (project owner's standing rule): never show values guessed from heuristics as data. Unknown = null (JSON) / "—" (UI).
Estimates (dead reckoning, predictions) must be labelled "추정". Assumptions used for judgement must be labelled as assumptions.

## 1. WebSocket protocol v1 (revised)
- Per-session sequence: every `snapshot` and `diff` sent to a session carries `seq` (integer). `seq` restarts at 1 with each snapshot
  (initial, periodic resync, resume, backpressure resync) and increments by exactly 1 for every diff SENT to that session.
  The server sends a diff only when it is non-empty, so there are never gaps. `v` (global snapshot version) stays as informational.
  Client: on snapshot → lastSeq = seq; on diff → if seq !== lastSeq + 1 send {type:"resync"} and ignore the diff; else apply.
- Aircraft encoding (keys with null values are OMITTED by the server's Jackson non_null setting; the client treats a missing key as unknown/null, never as 0/false):
  - zoom > 5 ("lite"): hex, callsign, lat, lon, alt_ft, gs_kt, track_deg, vrate_fpm, on_ground, squawk, seen_at (ISO-8601 UTC), provider, quality.
  - zoom <= 5 ("world"): hex, callsign, lat, lon (rounded to 3 decimals), alt_ft, gs_kt, track_deg, on_ground, squawk, seen_at, provider.
  - "full" (selected aircraft / REST detail): lite + registration, type_code, category, fetched_at.
- Snapshot message: {type:"snapshot", seq, v, ts, sources:{region:{provider, fetched_at, lag_s, stale}, global:{provider, fetched_at, lag_s, stale}|null}, sigmets_version, aircraft:[...]}.
  lag_s = now - fetched_at. stale: region lag > 60 s, global lag > 300 s. `global` is null when there is no global feed.
- Periodic full snapshot (resync): every 30 s for sessions with zoom > 5; every 120 s for zoom <= 5.
- Removal: the server puts a hex in `remove` only when the aircraft disappears from the merged snapshot (its provider stopped reporting it) or leaves the session bbox.
  During a total provider outage the snapshot is not replaced, so nothing is removed. The CLIENT MUST NOT remove aircraft by age.
  Client staleness: age = now - seen_at; stale when age > 60 s (provider != "opensky") or > 300 s (provider == "opensky").
  Client extrapolation (dead reckoning) is capped at 60 s (non-opensky) / 180 s (opensky); beyond the cap the icon stays at the capped position and is shown stale.
  If seen_at is missing, the client does not extrapolate and shows age "—".
- Global aircraft whose own seen_at is older than 600 s are dropped by the api from the merged snapshot (they are no longer "current").
- Alerts:
  - initial: {type:"alerts", version, alerts:[Alert...]} ; incremental: {type:"alerts_batch", version, items:[{event, alert}]}.
  - event ∈ ENTERED | LEFT | LOST | PREDICTED | PREDICTION_UPDATED | PREDICTION_CLEARED.
    LOST = the aircraft stopped being reported while inside (not a confirmed exit). LEFT = confirmed outside for 3 distinct observations.
  - Alert JSON fields: id, kind ("OBSERVED"|"PREDICTED"), hex, callsign, sigmet_id, fir_id, hazard, qualifier, entered_at, left_at, close_reason ("left"|"signal_lost"|"restart"|"prediction_cleared"|null),
    eta_s, eta_at (ISO; judged_at + eta_s, PREDICTED only), alt_ft, evidence (object), estimated (true for PREDICTED).
  - Hysteresis counts DISTINCT OBSERVATIONS (an aircraft's seen_at must change for a step to count): enter after 2 inside observations, leave after 3 outside observations.
  - Alert ids are unique across api restarts (time-based: epochMillis*1000 + counter, monotonic).
- SIGMETs: {type:"sigmets", v, fetched_at, provider, collection}. Sent on subscribe/resume only if the session has not yet received that v. Pushed to all sessions whenever the set changes,
  INCLUDING when the periodic expiry rebuild removes expired SIGMETs. Feature properties add:
  base_source: "json" | "assumed_surface" (AWC base was null; judgement assumes SFC — UI shows "하한 미발표(SFC 가정)"),
  top_source: "json" | "raw_text" | "unknown" (unknown → top_ft null; judgement treats it as unbounded — UI shows "상한 미발표(무제한 가정)", never "∞" as if published).
- select: client {type:"select", hex|null}. Server replies immediately and then on every snapshot update where that aircraft changed:
  {type:"selected", hex, state:{full encoding}|null, prediction:{available:boolean, reason:null|"turning"|"slow"|"on_ground"|"no_track"|"stale"}}.
  state null = aircraft no longer in the snapshot.
- pause/resume: on resume, and on any backpressure-triggered resync, the server sends the full initial set again (snapshot + alerts + sigmets if v changed + radar + status).
- Client→server rate limit: max 20 messages per 10 s per session; exceeding closes with 1008 "rate limit". At most one initial send in flight per session (latest bbox wins).
- hello must arrive within 5 s (per-session timer); ping every 30 s; close after 2 consecutive missed pongs.
- WebSocket allowed origins come from config `skywx.allowed-origins` (env SKYWX_ALLOWED_ORIGINS, comma-separated; default "http://localhost:8700,http://127.0.0.1:8700").
- status message: {type:"status", status: <same object as GET /api/v1/status>}.

## 2. REST changes
- GET /api/v1/status: `region.center` and `region.radius_nm` come from the runtime settings (app_setting / Redis skywx:settings), the same values the collector uses. `global` has provider, aircraft, lag_s, stale (300 s), fetched_at.
- GET /api/v1/aircraft?bbox= and /aircraft/search?q= use the merged (region + global) snapshot. Search also matches callsign prefix. ≤ 20 results.
- GET /api/v1/aircraft/{hex}: must still return the live state (200) when the database is unavailable; `static` becomes null and meta has `db_unavailable: true`.
- DB unavailable (DataAccessException / pool timeout) on DB-backed endpoints → 503 problem+json with Retry-After: 10.
- Alerts (REST and WS) include close_reason and eta_at as above. /alerts/history includes close_reason.
- GET /api/v1/sigmets feature properties include base_source, top_source; withdrawn (cancelled before valid_to) SIGMETs are not active.
- GET /api/v1/airports: feature properties add obs_age_s (now - obs_time, null if no METAR), stale (obs_age_s > 7200), ceiling_state ("measured"|"none"|"unknown"), flight_cat_source ("awc"|"computed"|null).
  flight_cat is null when it cannot be determined (no AWC value and ceiling or visibility unknown).
- GET /api/v1/airports/{icao}/wx: latest adds ceiling_state, obs_age_s, stale.
- GET /api/v1/replay: `source` = the table that actually supplied the rows ("track_point" | "track_point_1m" | "none"); adds `radar`: {host, path, time} | null — the stored RainViewer frame within ±10 min of `at` if `at` is within the last 2 h (RainViewer keeps only 2 h), else null.
- Stats: traffic_by_hour counts distinct aircraft inside the configured region bbox only. alert dwell is omitted (no row) when there is no closed OBSERVED alert that day. SIGMET counts per issue day (valid_from::date in UTC) — each SIGMET counted once.
- All cacheable GET endpoints send `Cache-Control: public, max-age=N` and ETag where a version exists (aircraft, sigmets, radar/frames, radar/kr, status is max-age=5 no ETag).

## 3. Database (Flyway V3, owned by the api lane)
- alert_event.close_reason text NULL CHECK (close_reason IN ('left','signal_lost','restart','prediction_cleared')).
- sigmet.withdrawn_at timestamptz NULL; sigmet.base_source text NOT NULL DEFAULT 'json'; sigmet.top_source text NOT NULL DEFAULT 'json'.
- metar_obs.ceiling_state text NULL CHECK (ceiling_state IN ('measured','none','unknown')); flight_cat stays nullable.
- Retention grants: GRANT DELETE ON metar_obs, radar_frame, ingest_run, quality_event, quality_rule_count TO skywx_api.
- On api startup: close alert_event rows with left_at IS NULL: left_at = now(), close_reason = 'restart'.

## 4. Stream payload schema changes (owned by the collector lane; schemas/*.json AND the copy in apps/api/src/main/resources/schemas/ must stay byte-identical)
- sigmet.v1.json: add optional properties base_source (enum json|assumed_surface) and top_source (enum json|raw_text|unknown). top_ft null + top_source "unknown" = not published.
  top_ft is filled from the raw text ONLY when the JSON top is null and the raw text deterministically states it (regex on "TOP FL\d{3}", "TOP ABV FL\d{3}" → top_source "raw_text"; "ABV" means the stated level is a lower bound of the top, so store it and set top_source "raw_text"). Otherwise top_source "unknown".
  base null → base_ft 0 and base_source "assumed_surface".
- SIGMET rings with more than 2,000 points are rejected (geometry null, excluded_reason "too_many_points"), never truncated.

## 5. Collector ↔ DB
- metar_obs.ceiling_state written by the collector: "measured" (BKN/OVC/OVX/VV layer with base), "none" (cloud data present but no ceiling layer, or CLR/SKC), "unknown" (no cloud data).
  flight_cat: AWC fltCat if present (flight_cat_source 'awc'); else computed only when visibility is known AND ceiling_state != 'unknown' (source 'computed'); else NULL (source NULL).
- DB writes in the collector are best-effort: a DB failure is logged and counted but must not stop publishing to Redis (the live path).

## 6. Redis ACL (owned by infra lane; clients must support usernames)
- Users: default (admin; password REDIS_PASSWORD; used only by healthcheck/ops), skywx_api (password REDIS_API_PASSWORD, keys ~skywx:* ~rl:*), skywx_collector (password REDIS_COLLECTOR_PASSWORD, keys ~skywx:* ~budget:*).
- Env: api gets REDIS_USERNAME=skywx_api, REDIS_PASSWORD=<api pw>; collector gets REDIS_USERNAME=skywx_collector, REDIS_PASSWORD=<collector pw>.
  api: spring.data.redis.username=${REDIS_USERNAME:} and the stream connection factory sets the username too. collector: Settings.redis_username → Redis(username=...).

## 7. Ops CLI
- `java -jar app.jar --create-ops-user --password-stdin` reads the password from stdin (one line). The env var path (SKYWX_OPS_PASSWORD) stays for backwards compatibility. Makefile pipes the password via stdin (never on a command line).

## 8. Collector health
- `python -m skywx_collector.health` exits 0 if Redis hash skywx:collector has region_at within the last 90 s (or fixture=1 and region_at within 90 s), else 1. Used by the compose healthcheck.
