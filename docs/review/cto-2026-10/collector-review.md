# Wakeline collector — backend review (read-only, 2026-10-01)

Scope: `apps/collector`, package `wakeline_collector` (78 modules, 17,039 lines; tests 26,776 lines). Repo HEAD `e0e1eba`; last collector code change `80a6206` (2026-10-01 08:23 KST).

Method
- I read every module, then computed the import graph with a read-only AST script (Appendix A).
- I checked behaviour with in-memory experiments that use the repo's own `tests/fakes.py` FakeRedis (Appendix B). They ran with `PYTHONDONTWRITEBYTECODE=1`, so nothing was written to the repo.
- I ran `uv run --frozen --no-sync pytest/mypy/ruff` with caches disabled.
- No network, no containers, `.env` not read.

Prior work: I checked the fixed items in `docs/VERIFICATION.md` (#1–#96), `docs/review/REVIEW-v1.md` (R-01…R-98) and `docs/audit/change-contract-v5.md`, and I do not report them again. Items that were deferred and are still open are marked "known (R-xx, deferred)".

---

## 0. Top findings

| # | Sev | Where | Finding |
|---|---|---|---|
| F1 | **Medium** | `jobs/kma_radar.py:637-675, 908, 926, 1097-1102, 1563-1616, 1014` | The KMA job treats Redis as infallible. A Redis error or `noeviction` OOM makes `run_once` raise to the scheduler. The run record and quality events for that cycle are lost, and frames and meta can be left inconsistent. `except OSError` does not catch redis-py errors. Reproduced. |
| F2 | **Medium (process)** | `tests/test_db_pg_integration.py:28-29` | The 7 Postgres integration tests (port_call V15 transaction, marine_grid4 V14) never run. They are not wired into CI, the Makefile or `infra/tests`. Nothing automatically checks the collector's SQL against the api's Flyway schema. |
| F3 | Low | `budget.py:135-140` | `release()` recomputes the UTC-day key at release time. A give-back that crosses 00:00Z goes to the wrong day: the new day gets `used=-1`, the hash is created with no TTL, and maintenance snapshots -1. Reproduced. |
| F4 | Low | `budget.py:87-91` | `_eval` re-runs EVALSHA after any exception, not only NOSCRIPT. A reply lost to a timeout after the script ran reserves twice; for OpenSky that is 4 credits each time. |
| F5 | Low | `main.py:271-284` vs `ais/main.py:190-195` | If a job task ends unexpectedly, the collector does not log which task or why, and exits 0. The only trace is asyncio's GC-time message, which fires after the log sink is detached. Reproduced. |
| F6 | Low | `raw_store.py:48-49, 63-64` | Raw-archive failures are silent: no log and no counter. Purge swallows errors too, so a full or read-only volume goes unnoticed. |
| F7 | Low (known R-65, deferred, still present) | `jobs/aircraft.py:229-230`, `jobs/demand.py:406-407`, `jobs/weather.py:103-111` | The "not sent" classification still differs per job. PoolTimeout counts as a provider failure (it feeds the 3-strike rest) and keeps the budget unit. Weather records rate-limiter Throttled as a provider failure. |
| F8 | Low (latent) | `providers/kma_radar.py:29-30` (+ `portcalls.py:49,152`, `traffic_grid.py:32`) | `kst_now()` returns the KST wall-clock time labelled `tzinfo=UTC`, and there are three separate KST definitions. Every current caller is correct; this is a trap for the next change. |
| F9 | Low | `kma_grid.py:220` (perf/memory) | `echo_cells` makes two full-grid float32 copies: 14.0 ms and +57 MiB peak. An int16 threshold gives the identical result in 2.4 ms and +6.4 MiB. Measured. |
| F10 | Low (needs confirmation) | `db.py:180` | The pool is sized "writer 1 + probe 1" but now also serves the port-call transaction and marine_grid4/coverage reads. The liveness probe can be starved and wrongly mark the DB unreachable. |
| F11 | Low (needs confirmation) | `http.py:186-189` | 3xx responses are returned as success (`follow_redirects=False`). The parsers then report a JSON or shape error instead of "HTTP 302". |
| F12 | Arch | `errors.py:23`, `retry.py:29-32`, `fallback.py:55-57,244`, `portcalls.py:21`, `ais/sink.py:46-54,107,203` | There are no import cycles, but some dependencies point the wrong way: a formatter imports the HTTP adapter, a policy imports the Redis budget, the decision class owns Redis adapters, `portcalls` imports `route.clean_text` across features, and `ais/sink` uses publisher's private `_size` and builds a `Publisher` just to call a pure function. |

Also noted (Low): `runtime_settings.py:22-26` logs a WARN on every region cycle during a Redis outage (not rate-limited); the Dockerfile runs `uv sync` without `--locked` (`Dockerfile:8-11`); the collector has no event-loop-lag metric (only ais has one), so loop-blocking claims cannot be checked in production.

---

## 1. Architecture map

### 1.1 Modules by layer (size = lines incl. docstrings)
I/O legend: **R** Redis · **H** HTTP · **D** Postgres · **F** filesystem · **W** WebSocket · **E** reads `config.settings` (env, built at import) · **T** threads/CPU-heavy.

**Entry / composition**
| module | lines | responsibility | I/O |
|---|---:|---|---|
| `main.py` | 284 | builds 9–10 job tasks, signals, shutdown order (grace 18 s → DB drain 4 s → log sink 0.5 s) | R H D E |
| `__main__.py`, `health.py`, `tools/snapshot.py` | 6 / 88 / 39 | entrypoint; healthcheck on `region_at`; fixture refresh tool | R E / H |
| `ais/main.py`, `ais/health.py`, `ais/config.py` | 220 / 126 / 48 | separate AIS process: 4 tasks + watcher; exits 1 if a task crashes | R W E |

**Application (jobs): where orchestration, rules and I/O are mixed**
| module | lines | responsibility | I/O |
|---|---:|---|---|
| `jobs/traffic_grid.py` | 1,627 | KOMSA polling schedule, geometry fill (one-id + bbox tiles), two breakers, negative cache, Redis snapshot, heartbeat (28 async defs) | H R D T |
| `jobs/kma_radar.py` | 1,626 | KMA listing, candidate selection, missing-file streak state machine, partial-composite refetch, Redis frame store, run status. About 27 % is prose: 268 docstring + 174 comment lines. | H R T E |
| `jobs/portcalls_index.py` | 755 | PORT-MIS (port authority, KST day) planner, fetch, DB transaction calls | H R D |
| `jobs/demand.py` | 548 | focus/hot scheduling, capacity plan, normalize, publish | H R |
| `jobs/weather.py` | 437 | SIGMET, RainViewer, METAR | H R D T |
| `jobs/aircraft.py` | 292 | region/global cycle | H R D T |
| `jobs/route.py` / `maintenance.py` / `context.py` | 218 / 47 / 21 | adsbdb lookups; purge and budget snapshot; DI bag | H R / F R D |
| `fallback.py` | 580 | `ProviderChain` (fail/429/hold state machine) **plus** Redis status writes and the 429 store | R |
| `scheduler.py` | 43 | `run_periodic` (jitter, backoff 2^n capped at 300 s) | – |

**Adapters**
| module | lines | responsibility | I/O |
|---|---:|---|---|
| `http.py` | 200 | allow-listed client, total timeout, 429 penalize, size cap | H E |
| `ratelimit.py` | 275 | token buckets and priority waiters (pure state, asyncio timers) | – |
| `providers/*.py` | 19–174 each | adsb.fi/lol, OpenSky, AWC, RainViewer, KMA, adsbdb, data.go.kr (KOMSA, WFS), PORT-MIS, fixture | H (E, F) |
| `budget.py` | 160 | Lua day budget and UTC-hour windows | R |
| `status.py`, `chain_store.py` | 188 / 104 | provider status hashes, heartbeat, 429 history | R |
| `publisher.py` | 284 | stream XADD with local queue, time and byte trim (pure `StreamTrim`, `encode_payload`) | R |
| `runtime_settings.py`, `demand.py` | 75 / 307 | runtime overrides; lease parsing (pure) + poller/status (I/O) | R E |
| `logsink.py` | 643 | WARN/ERROR → `wakeline:logs` (pure fingerprint/fit section + handler) | R T |
| `db.py` | 672 | writer queue **and** all collector SQL, including the port-call transaction | D E |
| `raw_store.py`, `redis_retry.py`, `gz.py` | 65 / 24 / 26 | raw archive; retry policy; bounded gunzip | F E / R / – |

**Pure rules / parsers (no I/O)**
`normalize` 279 · `quality` 99 · `models` 89 · `geo` 45 · `flight_category` 106 · `sigmet_parse` 275 (shapely) · `kma_grid` 223 (numpy/pyproj/PIL) · `marine_grid` 477 (GML + EPSG:5179) · `grid_tiles` 246 · `traffic_grid` 227 · `portcalls` 371 (XML) · `route` 218 · `masking` 127 · `errors` 95 (but imports `http`) · `retry` 119 (policy with injected I/O; imports `budget`)

AIS pure: `parse` 370 · `book` 230 · `bbox` 143 · `backoff` 59 · `queue` 111 · `feed` 232 · `shards` 429 · `reconnect` 176 · `diag` 124. AIS I/O: `client` 306 (W) · `pool` 129 · `sink` 397 (R) · `runtime` 70 (R) · `replay` 92 (F) · `worker` 98.

### 1.2 Where business rules sit inside I/O classes (line ranges)
- **`jobs/kma_radar.py`**
  - 1–130: module docstring, mostly incident and review history.
  - **229–603: already-pure block, about 375 lines**: `streak_probes` 229, `slow_probe_every_s` 246, `streak_probe_every_s` 254, `missing_carry_s` 263, `streak_calls_per_day` 268, `_tm_span` 280, `_Exhausted` 289, `MissingStreak` 299–353, `_ListCheck` 356–380, `_ListIdle` 383–407, `_gap_expired` 410 (reads the clock), `old_tm_cut` 420, `select_candidates` 427, `_tm_dt` 440, `_site_count` 450, `annotate_partial` 456–490, `_parse_iso` 493, `select_refetch` 506–525, `refetch_headroom` 528 (reads settings), `_refetch_until` 533, `_latest_station_fields` 539, `_outcome` 574, `_throttle` 585.
  - **606–1626: `KmaRadarJob`, about 1,020 lines**, mixing four kinds of code:
    - Redis frame/meta/streak store, about 240 lines: 637–675, 1097–1102, 1267–1304, 1463–1546, 1563–1626.
    - HTTP + budget + retry orchestration: 718–747, 805–898, 973–1019, 1190–1265.
    - Decision rules: 749–787 (bad/not-ready bookkeeping, `_streak_needs_prev_day`, `_prev_end`, `_behind_prev_day`), 1104–1114 (`_list_idle`), 1155–1173 (slow-probe cadence), 1312–1461 (streak transitions), **1042–1067 (run-status merge)**.
    - Log-text assembly.
- **`jobs/traffic_grid.py`**
  - 1–66: docstring.
  - **179–499: already-pure block**: `_step`, `KomsaSchedule` 190–259, `_Pending`/`Negative`/`GridGeometry` 265–435, `FillPass`/`_Tick` 438–498.
  - 504–1627: `TrafficGridJob`, mixing:
    - Redis: 589–660, 1522–1567, 1569–1627.
    - HTTP/budget: 736–877, 1088–1141, 1186–1350.
    - Decisions: gating 922–968, **two copies of breaker logic 1143–1184**, tile completeness 1333–1346, split vs incomplete 1359–1361, `_idle_reason` 1412–1432, `_fill_state` 1476–1497, `known_tiles`/`_known_inside` 682–722.
- **`fallback.py`**
  - Pure helpers: 77–141.
  - State machine: `mark_down`/`_rest`/`paused`/`_candidates` 193–226, `probing`/`none_*`/`hold_s` 274–296, `_next_release`/`_reason` 364–409, `_quiet`/`record_success`/`_record_429` 422–472, `_apply_saved` 534–563, `record_failure` 565–576.
  - I/O inside the rules: `_evaluate` awaits `status.is_disabled` once per candidate per pick or peek (244) and `_restore` (233).
  - Writes: `pick`/`_use`/`_enter_none` 298–362, 411–420; persistence 475–532.
- **`db.py`**: the generic writer is 200–372. The port-call transaction 586–656 encodes port-call rules (refuse-empty guard, hole semantics, `merge_day`) inside the data-access module.
- **`jobs/demand.py` `_normalize` 414–437** duplicates `jobs/aircraft.py` `_process` 162–191 (`readsb_reference_time` → `normalize_readsb` → `Rejected`→`Quarantine` → `gate.apply`). Aircraft runs it in a thread; demand runs it on the event loop.

### 1.3 Import graph (intra-package)
Computed with the AST script in Appendix A. It includes function-level ("lazy") imports. Tarjan SCC over all edges finds **no cycles**.
```
budget            -> (none)                     chain_store -> status
db                -> config, masking, portcalls  demand      -> masking, route, status
errors            -> http, masking               fallback    -> chain_store, masking, status
grid_tiles        -> marine_grid                 http        -> config, ratelimit
kma_grid          -> gz                          logsink     -> masking
normalize         -> models                      portcalls   -> masking, route
publisher         -> gz                          quality     -> geo, models
raw_store         -> config                      retry       -> budget, errors, http, ratelimit
runtime_settings  -> config                      sigmet_parse-> models
status            -> masking                     traffic_grid-> marine_grid
health            -> [lazy: config]
providers.adsbdb  -> config, http, ratelimit, route
providers.awc|kma_radar|opensky|rainviewer -> http, models
providers.data_go_kr -> http, marine_grid, ratelimit, traffic_grid
providers.fixture -> config, geo, models
providers.portmis -> config, http, portcalls, providers.data_go_kr, ratelimit
providers.readsb  -> http, models, ratelimit
jobs.context      -> budget, db, publisher, raw_store, runtime_settings, status
jobs.aircraft     -> budget, config, errors, fallback, http, jobs.context, models, normalize, publisher, quality, ratelimit, raw_store, status
jobs.demand       -> budget, config, demand, errors, http, jobs.context, jobs.route, models, normalize, publisher, quality, ratelimit, raw_store, route, status
jobs.kma_radar    -> budget, config, errors, http, jobs.context, kma_grid, models, providers.kma_radar, ratelimit, raw_store, retry, status
jobs.traffic_grid -> budget, errors, grid_tiles, http, jobs.context, marine_grid, providers.data_go_kr, raw_store, retry, traffic_grid, (package)
jobs.portcalls_index -> budget, db, errors, http, jobs.context, portcalls, providers.data_go_kr, providers.portmis, ratelimit
jobs.weather      -> budget, errors, flight_category, geo, http, jobs.context, models, publisher, raw_store, retry, sigmet_parse
jobs.route        -> budget, errors, http, providers.adsbdb, ratelimit, route, status, (package)
jobs.maintenance  -> jobs.context, portcalls
main              -> everything above + scheduler, logsink, masking, redis_retry, providers.*
ais.book -> ais.parse, geo        ais.feed -> ais.diag, ais.parse     ais.queue -> ais.diag
ais.client -> ais.backoff, ais.bbox, ais.diag, ais.feed, ais.parse, ais.queue, ais.reconnect, masking
ais.pool -> ais.backoff, ais.bbox, ais.client, ais.queue, ais.shards
ais.sink -> ais.book, ais.client, ais.diag, ais.parse, ais.queue, ais.reconnect, ais.shards, ais.worker, logsink, masking, publisher
ais.shards -> ais.bbox, ais.feed, ais.parse   ais.worker -> ais.book, ais.parse, ais.queue
ais.replay -> ais.feed, ais.parse, ais.queue  ais.runtime -> ais.bbox   ais.config -> ais.bbox
ais.main -> ais.*, logsink, masking, redis_retry   ais.health -> [lazy: ais.config]
```

### 1.4 Wrong-way and cross-feature dependencies
1. **`errors` → `http`** (`errors.py:23`). A pure formatter imports the HTTP adapter module to get exception classes. That module also builds the global `settings` at import (env read).
2. **`retry` → `budget`, `http`** (`retry.py:29-32`). A retry policy imports the Redis budget module for one constant (`UNKNOWN`) and `NOT_SENT_ERRORS`.
3. **`fallback` → `status`, `chain_store`** (`fallback.py:55-57`). The decision state machine owns two Redis adapters, and `_evaluate` awaits Redis per candidate (`:244`).
4. **`portcalls` → `route.clean_text`** (`portcalls.py:21`). The port-call feature depends on the aircraft-route feature for a generic text helper.
5. **`db` → `portcalls`**. The direction is fine (adapter → rules), but port-call business rules live in the generic writer module (`db.py:586-656`).
6. **`ais.sink` → `publisher._size`** (a private name) and `Publisher(redis)` built only to call `envelope()`, which is pure (`ais/sink.py:46-54, 107, 203`; `publisher.py:72-73, 163-188`).
7. **Implicit env reads**: `config.settings` is used by `runtime_settings`, `raw_store`, `http`, `providers.adsbdb|portmis|fixture` and `jobs.aircraft|demand|kma_radar`. Any rule code extracted from jobs must take these values as parameters.
8. **Cycles: none.**

---

## 2. Target layering and a minimal extraction plan

### 2.1 Target (no new infrastructure)
```
entry        main.py · ais/main.py · health.py · tools/
application  jobs/*.py — orchestration only: reserve → call adapter → decide (pure) → write via adapter
rules (pure) normalize · quality · sigmet_parse · kma_grid · marine_grid · grid_tiles · traffic_grid(+plan) · portcalls · route
             · geo · flight_category · errors · kma_rules(new) · chain_state(new) · send_outcome(new) · timeutil(new) · http_errors(new)
adapters     http + providers/* · budget · status · chain_store · publisher · runtime_settings · demand(poller/status) · raw_store · db
             · kma_store(new) · logsink
```
Rules
- Rules import only rules, `models` and the stdlib (and numpy/shapely where needed).
- Adapters may import rules.
- Jobs import both.
- Nothing imports `jobs.*` except `main`, plus `jobs.route` from `jobs.demand`.

Enforce this with a small AST test (`tests/test_layering.py`, the same code as Appendix A) that starts with an allowlist of today's violations and removes entries as each commit lands. No new tooling.

### 2.2 What to extract, and what stays
| new module | move from (current lines) | stays in job |
|---|---|---|
| `http_errors.py` | `http.py:45-88`: `HostNotAllowed`, `ResponseTooLarge`, `SendCancelled`, `RequestTimedOut`, `ProviderHttpError`, `NOT_SENT_ERRORS`. `http.py` re-exports them; 30+ test imports use `wakeline_collector.http`. | client, limiter use |
| `kma_rules.py` | `jobs/kma_radar.py:229-603` except `_decode`/`_decode_if_more` (they stay because tests patch them); plus `_prev_end`/`_behind_prev_day` (772-787), `_streak_needs_prev_day` (763-770, made to take `missing`), `_list_idle` (1104-1114, made to take `now`), and the run-status merge 1042-1067 as `cycle_status(...)`. Clock and settings readers (`_gap_expired`, `refetch_headroom`) take `now`/`poll_s` as arguments. | HTTP/budget/retry orchestration, logging, `_decode*`, seams `_now`/`_sleep`/`kst_now` |
| `kma_store.py` (adapter) | `_frames`/`_save_frames`/`prune` 637-675, `_latest_stored` 1097-1102, Redis part of `_note_refetch` 1267-1304, `_load_missing`/`_publish_missing` reads/writes 1463-1546, `_store` writes 1570-1616. Explicit `RedisError` semantics (fixes F1). | — |
| `traffic_grid_plan.py` (pure) | `jobs/traffic_grid.py:179-499` (`KomsaSchedule`, `GridGeometry`, `Negative`, `_Pending`, `FillPass`, `_Tick`), plus a small `Breaker` dataclass replacing the duplicated logic in `_call_failed` 1143-1184 and the resets at 1029-1032 | fetch/fill/tile orchestration, Redis, heartbeat |
| `chain_state.py` (pure) | `fallback.py` helpers 77-141 and state-machine methods (193-226, 274-296, 364-409, 422-472, 534-576). `_evaluate` 228-268 takes a pre-fetched `disabled: frozenset[str]`. | `ProviderChain` facade: `pick`/`peek`/`succeeded`/`stand_down`/`_enter_none`/`_use`/persist/restore (I/O) |
| `send_outcome.py` (pure, R-65) | the scattered `isinstance(e, ConnectError\|ConnectTimeout)` / `NOT_SENT` / `Throttled` branches become `classify_send(e) -> "not_sent" \| "throttled" \| "sent"` | jobs call it |
| `normalize.readsb_batch(...)` | the shared body of `jobs/aircraft.py:162-191` and `jobs/demand.py:414-437` | jobs call it (demand via `asyncio.to_thread`) |
| `timeutil.py` | `KST_TZ`, `kst_now()` returning an aware KST datetime, `kst_date`, tm↔UTC conversion. Replaces `providers/kma_radar.py:21,29-30`, `portcalls.py:49,152-156`, `traffic_grid.py:32`. | — |
| `textutil.clean_text` | `route.py:61-67` (`route` and `portcalls` both import it) | — |
| `publisher.envelope()` / `entry_size()` | `Publisher.envelope` 163-188 and `_size` 72-73 become module functions; `Publisher.envelope` delegates | AisSink drops its `Publisher` instance |
| `diag.py` (shared) | `ais/diag.py` `WindowMax`/`LoopLag`; `ais.diag` re-exports. The collector then reports `loop_lag_max_s` in its heartbeat. | — |

### 2.3 Commit order (each one keeps `ruff check`, `ruff format --check`, `mypy wakeline_collector` and `pytest -q` green; commits that touch Redis adapters also run `infra/tests/collector_redis_test.sh`)

**Phase A — bug fixes, failing test first (independent, small)**
1. **A1 budget.** Write tests F3/F4 first (FakeRedis, plus a real-Redis TTL assertion in `test_redis_integration.py`). Then add a guarded release Lua and catch only `NoScriptError` in `_eval`.
2. **A2 KMA Redis failures.** Write tests F1 first (Redis down; frame-SET OOM). Then catch `RedisError` at pre-listing reads and in `_store`, and record a run.
3. **A3 main.** Extend `test_main.py::test_run_until_stopped_when_a_job_ends_unexpectedly` with a caplog check and the return code. Then log the task and its exception, and exit 1.
4. **A4 raw store.** Add a `test_raw_store.py` caplog + counter test. Then add a rate-limited WARN and a `raw_unsaved` metric.
5. (opt) **A5**: rate-limit the settings-refresh WARN.

**Phase B — guard rail**
6. **B1** `tests/test_layering.py` with the allowlist of the 6 violations in §1.4.
7. (opt) mypy `[[tool.mypy.overrides]] strict = true` for new pure modules. Today `--strict` reports only 54 errors, 23 of them in `jobs/kma_radar.py`.

**Phase C — behaviour-preserving moves**
8. **C1** `http_errors.py` (re-exported from `http`).
9. **C2** module-level `publisher.envelope/entry_size`; AisSink uses them.
10. **C3** `textutil.clean_text`.
11. **C4** `kma_rules.py`. Keep the names tests import (via re-exports or updated imports): `annotate_partial`, `select_refetch`, `select_candidates`, `streak_probes`, `refetch_headroom`, `REGULAR_CALLS_PER_CYCLE`, `REF_MIN_SUPPORT`, `KEEP_FRAMES`, `MAX_PER_CYCLE`, `MissingStreak`.
12. **C5** `kma_store.py` (after A2, so the error semantics are already pinned).
13. **C6** `traffic_grid_plan.py` + `Breaker`.
14. **C7** `chain_state.py` + thin `ProviderChain`.
15. **C8** `timeutil.py`.

**Phase D — behaviour changes, tests first**
16. **D0** shared `diag.py` + collector `loop_lag_max_s`, so perf changes can be measured (§4).
17. **D1** `send_outcome.classify_send`, adopted by aircraft, demand, weather and OpenSky token (R-65).
18. **D2** `normalize.readsb_batch`; demand runs it in a thread, only if D0 shows loop-lag spikes of 20 ms or more.
19. **D3** `kma_grid` integer thresholds (F9), optionally partial inflate.

### 2.4 Tests that pin each piece, and seams that will move
| piece | existing tests | seams to preserve |
|---|---|---|
| http_errors | test_http (13), test_errors (20), test_error_text (6), test_weather_retry (20), test_kma_throttle (12) | re-export from `http` |
| publisher envelope | test_publisher (15), test_ais_sink (24), test_contract (3), test_ais_contract (9); real Redis: `test_r14_publisher_time_trim…`, `test_restart_seeds_the_byte_budget…` | — |
| kma_rules / kma_store | test_kma_radar (35), test_kma_partial (25), test_kma_missing (30), test_kma_list_idle (29), test_kma_throttle (12), test_weather_jobs (10); real Redis `test_kma_missing_streak_reads_and_writes_under_the_collector_acl` | tests patch `mod._sleep` ×7, `mod._decode` ×6, `mod.kst_now` ×4, `mod._now` ×3, `read_header`, `read_echo`, `_decode_if_more` on `jobs.kma_radar`. These must stay there, and moved rules must take `now` as a parameter. |
| traffic_grid_plan | test_traffic_grid_job (44), _fill (19), _tile_job (34), _tile_plan (13), _tile_sim (2), _db (7), _providers (16), _geo (35); real Redis tile/negative/publish tests | tests patch `tg.MAX_TRACKED` ×5, `tg.WFS_PER_TICK` ×4, `tg.UNCHANGED_BACKOFF_S` ×1 on `jobs.traffic_grid`. Either pass these as constructor arguments from the job module or update those 10 lines in the same commit. |
| chain_state | test_fallback (26), test_chain_store (22), test_aircraft_job (40); real Redis `test_chain_429_history_store_under_collector_acl` | `monkeypatch.setattr(fallback, "time", …)` ×19. Inject a `mono` callable resolved through `fallback.time` at call time. |
| send_outcome | test_aircraft_job, test_demand_job (32), test_weather_retry, test_route_job (21), test_portcalls_index_job (36), test_traffic_grid_job | — |
| readsb_batch | test_normalize (21), test_quality (9), test_aircraft_job, test_demand_job | — |
| timeutil | `test_kma_radar.py:64` (`kst_now` format), test_db_writer (KST day), test_maintenance (3), test_traffic_grid_komsa (17), test_portcall_index_parse (21) | — |
| diag | test_ais_diag (14), test_ais_keepalive (10), test_main (17) | re-export from `ais.diag` |

**Characterization tests to add before moving code**
- F1/F3/F4/F5/F6 tests (Phase A).
- Direct unit tests of the breaker ladder per kind (5 → 10 → 30 → 60 min; resets at `jobs/traffic_grid.py:1029-1032`). Today it is pinned only through 3 job-level tests (`test_traffic_grid_job.py:569`, `test_traffic_grid_tile_job.py:394, 775`).
- Table tests for `_behind_prev_day` / `_streak_needs_prev_day` / `_list_idle` once they are pure. They are pinned today through the job by test_kma_list_idle and test_kma_missing.

### 2.5 Where extraction is not worth it
- **`logsink.py`**: already split into a pure section (79–209) and the handler/sender, with 43 tests and cross-language vectors.
- **`jobs/portcalls_index.py`**: `plan()` and helpers (286–374) are already pure over in-memory state and pinned by 36 tests. If that area is touched, only the day-completeness block (552–580) could become `portcalls.classify_day()`.
- **`jobs/aircraft.py`, `jobs/weather.py`, `jobs/route.py`, `jobs/maintenance.py`**: thin orchestration; only D1/D2 apply.
- **`demand.py`**: the lease parsing (60–175) is already module-level pure functions next to the poller.
- **`db.py` port-call SQL**: borderline. Move it to a port-call data-access module only when port-call work resumes.
- **`ais/*`**: already layered (parse/book/queue/bbox/backoff/feed/shards/reconnect/diag are pure; client/pool/sink/runtime/replay do I/O).
- **Docstrings (not an extraction)**: `jobs/kma_radar.py:1-130` and `jobs/traffic_grid.py:1-66` mix the specification with incident history that is already in VERIFICATION and the ADRs. Trimming them to the rules would make the rule modules easier to review.

---

## 3. Correctness and reliability findings

### F1 — Medium — the KMA job treats Redis as infallible
**Where**
- `jobs/kma_radar.py:637-675`: `_frames`/`_save_frames`/`prune` have no try and no timeout.
- `:908`: `prune()` is the first call in `run_once`.
- `:926, 1097-1102`: `_latest_stored` (`hmget`).
- `:1563-1616`: `_store` does `hmget` → SET image → GET list → SET list → DEL → HSET meta, all unguarded.
- `:1014`: the `except OSError` around `_store` does not catch Redis errors; redis-py's `ConnectionError` MRO is ConnectionError → RedisError → Exception (checked against redis 8.1).
- `:1267-1304`: `_note_refetch` (only caught by the broad except in `_refetch_partial`).

**Evidence (Appendix B, experiments 1 and 2)**
- (a) FakeRedis down → `KmaRadarJob.run_once()` raises `redis.exceptions.ConnectionError`; 0 `ingest_run` queued.
- (b) Only the frame-image SET fails with `ResponseError('OOM command not allowed…')`. That is what Redis returns under the deployed `maxmemory 256mb` / `maxmemory-policy noeviction` (`infra/redis/redis.conf:8-10`). `run_once` raises after 3 budget units were spent, and the cycle's run record is lost, including the "tm=…1050 not available yet" note from the same cycle.
- The scheduler then logs `radar_kr: unhandled error (#n)` with a traceback (`scheduler.py:34-36`).
- Coverage confirms these paths are untested: `kma_radar.py:938-940, 1014-1016, 1470-1472` are uncovered.

**Contrast**
- `TrafficGridJob` wraps every Redis call in `asyncio.timeout(REDIS_TIMEOUT_S)` + except (`jobs/traffic_grid.py:592-618, 639-646, 1523-1540, 1559-1564`).
- `jobs/aircraft.py:3-5` states the invariant that a job fails to the scheduler only on unexpected code errors. The KMA job breaks it.

**Impact**
- A Redis blip or OOM produces ERROR tracebacks instead of a `budget_unavailable`/`error` run.
- Run records and quality events for that cycle are dropped.
- A failure between the list SET and the final meta HSET leaves the frames list ahead of `meta.latest_tm/fetched_at` (the STALE clock). That tm is now in `have`, so it is never re-fetched, and meta stays behind until a newer tm is stored (at least 5 min).

**Failing tests**
1. `FakeRedis.down = True` → `await job.run_once()` returns and queues exactly one `ingest_run(radar_kr)` with status `budget_unavailable` (kma_radar is a strict provider).
2. A FakeRedis subclass whose `set("wakeline:radar_kr:frame:*")` raises `ResponseError` → no exception; the run is recorded as `error` with step `store tm=…`; meta is either unchanged or consistent with the list.

**Minimal root-cause fix**
- Treat `RedisError` exactly like `OSError` at `:1014` → `_fail(started, CallFailed("store tm=…", e, None))`.
- Wrap `prune()` and `_latest_stored()` in `asyncio.timeout(AUX_TIMEOUT_S)`; on `RedisError`, record an `error` run ("redis unavailable") and return.
- In `_store`, write the list and meta in **one** non-transactional pipeline after the image (the ACL has no MULTI — `chain_store.py:63`). A failure then leaves at most an orphan image with a 3 h TTL, never a list/meta mismatch.
- Carry these semantics into `kma_store.py` (C5).

### F2 — Medium (process) — the Postgres integration tests never run
**Where**: `tests/test_db_pg_integration.py:28-29` skips unless `WAKELINE_TEST_PG_URL` is set. A grep of `.github/workflows/ci.yml`, `Makefile`, `infra/`, `tools/` and `apps/api` finds no wiring. The 7 tests cover `record_run` idempotency on a lost commit reply, marine_grid4 upsert/read (V14), and port_call upsert/withdraw/coverage/holes/refused day (V15).

**Impact**
- The collector writes to tables owned by the api's Flyway, and unit tests use fake pools.
- A migration that changes a column or CHECK makes `apply_port_call_day` refuse every day: they become holes, with only WARNs (`jobs/portcalls_index.py:397-405`).
- `upsert_marine_grid4` would fall back to row-by-row rejects (`db.py:491-515`).
- This is the cheap, concrete slice of deferred R-36.

**Fix**: run them in an existing job that already builds `wakeline-db:local` (the CI api job builds it at `ci.yml:61-63`; `make infra-docker-test` also does), with a throwaway DB migrated by the api's `--migrate`. Fail if any test is skipped, the same pattern as `infra/tests/collector_redis_test.sh`.

### F3 — Low — `Budget.release` gives the unit back to the wrong UTC day
**Where**: `budget.py:135-140` does `hincrby(day_key(provider), "used", -cost)` with the key computed at release time, while `reserve` computed it at reservation time (`:98`).

**Evidence (Appendix B, experiment 3)**: reserve at 23:59:59.9Z, release at 00:00:04Z →
- `budget:adsbdb:20261001 used=1` (never given back)
- `budget:adsbdb:20261002 used=-1`, a new hash created by HINCRBY with no TTL until some later reservation runs the Lua `EXPIRE`
- `usage(day2) = (-1, 2000)`

**When**: any "not sent" failure that straddles 00:00Z: limiter waits (readsb region 5 s, `DEFAULT_WAIT_S` 10 s, PORT-MIS 15 s), connect failures, or the 5 s KMA/weather retry sleep.
- On-demand providers (adsbdb, an idle mof_grid4 fill) may not reserve again that day, so the TTL-less key stays forever under `noeviction`.
- `MaintenanceJob` snapshots `used=-1` for that day into `provider_budget_day` (`jobs/maintenance.py:38-45`).

**Tests**
- `tests/test_budget.py`: patch the `budget.day_key` clock as in experiment 3; assert day 1 is back to 0 and the day-2 key does not exist.
- Real Redis (runs in CI via `collector_redis_test.sh`): assert no TTL-less `budget:*` key after release.

**Fix**
- Minimal: release through a small Lua script that only decrements an existing hash with `used >= cost`. It never creates a key and never goes negative.
- Follow-up: have `reserve()` return the key it used (as `reserve_hour` already does), so callers release exactly that key via the existing `release_key()`.

### F4 — Low — `Budget._eval` reruns EVALSHA after any error
**Where**: `budget.py:87-91`, `except Exception: script_load; evalsha` with the comment "NOSCRIPT 등".

**Problem**: if the reply times out after Redis already ran the script (socket timeout 2 s, `redis_retry.py:20`), the reservation is made twice. For strict OpenSky (cost 4) that burns credits and reaches `budget_exhausted` early. It also doubles the time a reserve spends on an unresponsive Redis.

**Test**: a fake `evalsha` that increments and then raises `redis.TimeoutError` once → after `reserve`, assert `used == 1` (today it is 2).

**Fix**: catch `redis.exceptions.NoScriptError` only (it exists in redis-py 8.1: NoScriptError → ResponseError → RedisError).

### F5 — Low — the collector hides an unexpected job exit
**Where**: `main.py:271-284` sets `stop` and drains, but never says which task ended or why. `main` returns normally → exit 0 (`__main__.py:6`).

**Evidence (Appendix B, experiment 4)**: a job raising `RuntimeError` produces only asyncio's GC-time "Task exception was never retrieved". In production that fires after `close_log_sink` (`main.py:266`), so it never reaches `wakeline:logs` or `/logs`. The ais process does this right (`ais/main.py:190-195`, returns 1).

**Context**: `restart: unless-stopped` (`infra/compose.yml:23`) restarts either way, so this only costs diagnosis. All current job loops catch `Exception`, so it needs another bug to trigger; this is defence in depth.

**Test**: extend `test_run_until_stopped_when_a_job_ends_unexpectedly` (`tests/test_main.py:208`) with caplog `"job:… ended unexpectedly"` + the exception, and `main()` returning 1.

**Fix**: copy the ais pattern and use `sys.exit(asyncio.run(main()))`.

### F6 — Low — raw-archive failures are silent
**Where**
- `raw_store.py:48-49` returns `unsaved:<Exc>` with no log and no counter.
- `purge` swallows per-file `OSError` (`:63-64`), and `os.walk` ignores unreadable directories.

**Impact**: a full or read-only `/data/raw` silently stops archiving (and purging). The only trace is `raw_ref='unsaved:…'` in `ingest_run` rows; the R-18 pipeline counters in the heartbeat have `db_*`, `publish_*` and `log_*` but nothing for raw. Separately, empty per-day directories are never removed (minor).

**Test**: save into a read-only tmp dir with caplog → one WARN, and `store.unsaved == 1`.

**Fix**: a rate-limited WARN plus a `raw_unsaved` counter added to `main.metrics()` (same pattern as `Db.failures`).

### F7 — Low (known R-65, deferred, still present) — "not sent" is classified differently per job
**Where and what**
- `jobs/aircraft.py:229-230` and `jobs/demand.py:406-407` give budget back only for `ConnectError`/`ConnectTimeout`.
- `PoolTimeout` (pool max 8, `http.py:131`; pool wait defaults to the 8 s timeout) and `ProxyError` are counted as sent. For the region chain they also count as a provider failure: `record_failure` → 3 strikes → 10 min rest (`fallback.py:565-576`), although the provider was never contacted.
- `jobs/weather.py:103-111` records rate-limiter `Throttled` as `status.failure` plus run `error`.
- An OpenSky token failure keeps the 4-credit reservation.

**Fix**: plan D1. Write tests first in test_aircraft_job (PoolTimeout → budget released, no strike), test_weather_retry (Throttled → run `throttled`, `consecutive_failures` unchanged) and test_demand_job.

### F8 — Low (latent) — time-zone helpers
**Where**: `providers/kma_radar.py:29-30` `kst_now()` returns `datetime.now(UTC) + 9h` with `tzinfo=UTC`, i.e. the KST wall clock labelled UTC.

**Current state**: all 8 call sites in `jobs/kma_radar.py` (413, 819, 941, 1160, 1167, 1182, 1197, 1386) either strip tzinfo or only call `strftime`, so there is no bug today. But `.timestamp()`, `.isoformat()` or subtraction with a real UTC datetime would be off by 9 h with no error.

**Related**
- There are three KST definitions: `portcalls.py:49/152`, `traffic_grid.py:32`, `providers/kma_radar.py:21`.
- `run_once` reads the clock twice (`:819` in `_listing`, `:941` after it), up to about 85 s apart.

**Fix**: one pure `timeutil.py` with an aware-KST `kst_now()`. Tests already patch `mod.kst_now` with naive values (`tests/test_kma_missing.py:72-79`) and production strips tzinfo, so behaviour is unchanged.

### F9 — Low — KMA decode memory (see §4 P3 for numbers)
**Where**: `kma_grid.py:220`, `(grid.astype(np.float32) / 100.0 >= min_dbz)`. **Fix**: `grid >= ceil(min_dbz*100)`; the result is identical (asserted in the experiment). **Test**: the existing render tests in test_kma_radar / test_kma_partial pin `echo_cells`; add an equality test against the float version on a random grid.

### F10 — Low (needs confirmation) — the DB pool is sized for the writer but shared
**Where**: `db.py:180` `max_size=2  # writer 1 + 생존 확인 1`. The same pool now also serves `read_marine_grid4` (556-570), `read_port_call_coverage` (573-584) and the port-call transaction (586-656).

**Problem**: while the port-call transaction holds one connection and the writer holds the other, `_reachable()` (293-298, 5 s) cannot get a connection after a transient op failure. The writer then flips `db_ok=0`, does not count the attempt, and backs off. The window is short, so confirm with `db_ok` flaps in the heartbeat history.

**Fix**: `max_size=3` (or a separate 1-connection pool for direct reads and transactions), and update the comment.

### F11 — Low (needs confirmation) — 3xx is treated as success
**Where**: `http.py:186-189` raises only for 400 and above, with `follow_redirects=False` (`:128`). A redirect (portal maintenance, moved endpoint) reaches the parsers and is reported as `JSONDecodeError` or "unexpected … shape", which misleads the ops "last_error". I have not seen this in any logs available to me.

**Fix**: raise `ProviderHttpError` for 300–399, with only the host of `Location` in the message.

### Other Low items
- `runtime_settings.py:22-26` logs a WARN on every refresh, i.e. every region cycle (10 s) during an outage (`scheduler.py:29-30`). Every other Redis helper rate-limits to 1/min (`budget.py:78-82`, `status.py:51-56`, `demand.py:191-196`).
- `fallback.py:244` awaits one `HGET` per candidate on every pick and peek. Each is bounded by `AUX_TIMEOUT_S=1.5`, so in a Redis stall a region cycle can spend about 6 s on status reads (2 providers × pick+peek). Not a bug; it is the reason to pre-fetch `disabled` in C7.
- `Dockerfile:8-11` runs `uv sync --no-dev` without `--locked`, and copies `uv.lock*` with a glob. A local `make up` image can drift from the lock; CI's `uv sync --locked` (`ci.yml:29`) guards only the CI path.

### Checked and found OK (evidence-backed, no finding)
- **Bounded memory**
  - Collector: RateLimiter waiters ≤64; publisher queue ≤1,000 / 64 MB; DB queue ≤500; log sink ≤500 / 2 MiB and ≤1,000 fingerprints; AircraftGate ≤50k; GridGeometry pending ≤20k; KMA `_bad`/`_not_ready` ≤64; route tasks ≤64.
  - AIS: RawQueue ≤20k / 32 MiB; ShipBook ≤50k with TTL; gap queues ≤1,000.
  - Redis hashes: the negative and tile hashes are bounded by geography and documented.
- **Retry storms**: all paths are capped (KMA/weather retry once with budget; scheduler 2^n ≤300 s; DB 2→30 s; log sink 1→30 s; AIS 1→60 s ±20 %; redis-py retries connection errors only, ×2).
- **Shutdown**: 18 + 4 + 4 + 0.5 s fits inside `stop_grace_period: 30s`. Cancellation before sending gives budget back in route, traffic grid and port calls (`asyncio.shield`). A cancelled KMA call over-counts budget, which is the safe direction.
- **Races**: one event loop; the publisher lock serializes the queue and XADD; gates are per job. The only cross-thread mutable globals are `normalize.clock_fallbacks` / `_clock_fallback_logged`, which are diagnostic and benign.
- **TTLs**: frames/meta, route cache, 429 history, hour windows, streams (MINID/MAXLEN) and `wakeline:events` are all bounded. The only leak found is F3.
- **TZ**: budget days are UTC by design (ADR-005); quality counts and port-call days are KST (V16); `reg_dt`/`hour_key`/`next_utc_*` conversions are correct.

---

## 4. Performance hot spots (measured on this machine: Apple Silicon, CPython 3.13.13, switch interval 5 ms; containers will differ)

| # | Where | Measured now | How to measure before/after |
|---|---|---|---|
| P1 | Global aircraft `_process` in a thread (`jobs/aircraft.py:108,162-191`) | 6,600 readsb records, normalize + gate + encode. **Inline**: 115–120 ms of work = 115–120 ms max loop lag. **`to_thread`** (current): 104–125 ms of work, **max loop lag 15–19 ms**, because the GIL is handed back every 5 ms. R-21's offload works but leaves hiccups. | Run the Appendix B harness (1 ms sleep sampler around `work()`) inline vs thread; in production, D0's `loop_lag_max_s` over 24 h before and after. A further gain needs less Python per record (e.g. build dicts instead of `model_dump`). |
| P2 | Demand focus/hot normalize + gate + gzip on the loop (`jobs/demand.py:414-437, 445-456, 489, 528`) | 127 aircraft: 2.2 ms (max 4.6); 300: 5.1 ms (6.0); 600: 10.5 ms (14.5) per fetch. Up to 6 cells per 30 s plus focus every 5 s: low on average, worst single block about 15 ms. | Same harness with 300/600-aircraft bodies. Ship D2 only if D0 shows p99 at 20 ms or more. |
| P3 | KMA decode memory (`kma_grid.py:220`; also `:202-204`, `read_echo` 121-133) | `echo_cells` on a 2881×2305 grid: **14.0 ms, +57.0 MiB peak → 2.4 ms, +6.4 MiB** with an int16 threshold (equal result). `read_echo` inflates all three data blocks (~40 MB) but uses only the first (nx·ny·2 ≈ 13.3 MB). | `tracemalloc` peak and `perf_counter` per `_decode` on a real `/data/raw/kma_radar/*.bin.gz` (kept 72 h); container RSS over 40 min as in PERF.md §7 (#26b). |
| P4 | `parse_komsa` on the loop (`traffic_grid.py:125-174` via `providers/data_go_kr.py:105`) | 6,422 items / 314 KiB: median 8.9 ms, max 12 ms, every ~5 min. Low. | Harness + D0; if needed, use `to_thread` like the bbox tile parse (`data_go_kr.py:171`). |
| P5 | Traffic-grid publish and queue scans (`jobs/traffic_grid.py:1546,1561`; `GridGeometry.due/has_due/retries`) | `build_payload` + `orjson`: 5.9 ms (max 7.9) per publish (at most every 30 s); queue scans at the 20,000 cap: 3.8 ms per tick. Low. | Harness; D0. |
| P6 | AIS worker parse + book (`ais/worker.py`) | 15 µs/msg; a 512-message batch takes about 8 ms. At the measured 61–140 msg/s (PERF.md §3) that is about 1–2 ms of loop time per second. Fine. | ais already exports `loop_lag_max_s`. |
| P7 | Publisher restart seeding (`publisher.py:124-143, 226-249`) | Not measured. Once per restart it reads back up to the 80 MiB budget of aircraft entries (XREVRANGE pages of 16, full payloads decoded to `str`) only to sum their sizes, while holding the publish lock. | Time `Publisher._seed` against a real Redis loaded with about 900 entries (extend `test_restart_seeds_the_byte_budget…`), plus the first region-publish latency after a restart. |
| P8 | OpenSky `orjson.loads` on the loop (`providers/opensky.py:59`, ~0.85–1.5 MB) | Not measured (expected a few ms). | Harness. |

**Enabler (D0)**: the collector has no loop-lag metric; `LoopLag` exists only in `ais/diag.py`. Move it to `diag.py` and add `loop_lag_max_s` and `loop_stalls_total` to the collector heartbeat. That gives before/after numbers for every claim above with no new infrastructure.

---

## 5. Test and build facts

**How tests run**
- `make test-collector` = `cd apps/collector && uv run pytest -q` (`Makefile:64-65`). No ruff, no mypy, no coverage, so a green local run does not mean a green CI run.
- CI collector job (`.github/workflows/ci.yml:18-49`):
  - `uv sync --locked`
  - `ruff check . && ruff format --check .`
  - `mypy wakeline_collector` (`strict=false`, `ignore_missing_imports=true`)
  - `pytest -q --cov=wakeline_collector --cov-fail-under=80` (statement coverage, no `--cov-branch`)
  - `infra/tests/collector_redis_test.sh`: a throwaway Redis from the compose-pinned image, runs `test_redis_integration.py` + `test_ais_redis_integration.py`, fails if any test is skipped
  - `pip-audit@2.10.1 --require-hashes` on exported runtime deps
  - `tools/contract_check.py`
- Other jobs: the security job builds the collector image and runs trivy (blocking); the e2e job runs the fixture stack.

**Measured today**
- pytest: **1,729 passed, 21 skipped in 135 s wall (45 s CPU)**. Skipped = 12 real-Redis + 2 AIS real-Redis + 7 Postgres. The slowest tests are real-time timeouts (R-43 status 7.5 s and 4.5 s, tile simulation 6.2 s).
- `mypy`: clean (78 files). `mypy --strict` would add 54 errors in 15 files (23 in `jobs/kma_radar.py`; 33 type-arg, 12 no-untyped-def, 8 no-any-return).
- `ruff check` and `ruff format --check`: clean (164 files).
- Coverage, read from the existing `.coverage` (08:28, after the last code change at 08:23): **98 % statements** (10,151 statements, 252 missed). The 80 % floor is far below reality.

**Gaps**
1. The Postgres integration tests never run (F2).
2. No branch coverage, and a floor of 80 % against an actual 98 %. Add `--cov-branch` and raise the floor to around 95 %.
3. The real provider wiring in `main` is untested (`main.py:203-208, 231-232, 236-239, 245` uncovered); only fixture mode is smoke-tested.
4. Budget release and TTL semantics: FakeRedis `evalsha` ignores TTL (`tests/fakes.py:184-196`; R-41 partial). No test for a release crossing midnight (F3) or for double reservation (F4).
5. KMA Redis-failure paths are uncovered (F1).
6. No test enforces import direction; `tests/test_layering.py` (B1) would cover it.
7. No collector loop-lag metric, so performance claims cannot be checked in production (D0).
8. `make test-collector` should mirror CI: `ruff check . && ruff format --check . && mypy wakeline_collector && pytest -q --cov … --cov-fail-under=…`.
9. Wall time is 3× CPU because of real sleeps. Parallelizing (pytest-xdist) would add a dependency, so I am not recommending it under the no-new-infrastructure rule.

---

## Appendix A — import-graph script (read-only)
```python
import ast, os
from collections import defaultdict
root = "wakeline_collector"; mods = {}
for dp, _, fn in os.walk(root):
    for f in fn:
        if f.endswith(".py"):
            p = os.path.join(dp, f); m = p[:-3].replace("/", ".")
            mods[m[:-9] if m.endswith(".__init__") else m] = p
graph, lazy = defaultdict(set), defaultdict(set)
for m, p in mods.items():
    def visit(node, depth):
        for ch in ast.iter_child_nodes(node):
            if isinstance(ch, (ast.Import, ast.ImportFrom)):
                if isinstance(ch, ast.Import): names = [a.name for a in ch.names]
                else:
                    base = ch.module or ""
                    names = [base] + [f"{base}.{a.name}" for a in ch.names]
                for n in names:
                    if n in mods and n != m: (graph if depth == 0 else lazy)[m].add(n)
            elif isinstance(ch, (ast.FunctionDef, ast.AsyncFunctionDef)): visit(ch, depth + 1)
            else: visit(ch, depth)
    visit(ast.parse(open(p).read()), 0)
# print adjacency; Tarjan SCC over graph ∪ lazy found no cycle of size > 1
```

## Appendix B — experiments (run from `apps/collector` with `PYTHONDONTWRITEBYTECODE=1 uv run --frozen --no-sync python -`)

1. **KMA, Redis down.** `r = FakeRedis(); r.down = True; job = KmaRadarJob(P(), make_ctx(r)); await job.run_once()` → raises `redis.exceptions.ConnectionError`; `ctx.db.names == []`.
2. **KMA, frame SET fails with OOM.** Subclass FakeRedis so `set("wakeline:radar_kr:frame:*")` raises `ResponseError("OOM command not allowed…")`. The provider lists `…1050, …1055` (1050 answers "file not exist"). Result: `run_once` raises `ResponseError`; `ingest_run` records 0; `budget:kma_radar:<today>` `used=3`.
3. **Budget, release across midnight.** Patch `budget.day_key` to a controllable clock; reserve at `2026-10-01T23:59:59.9Z`, release at `2026-10-02T00:00:04Z`. Result: `budget:adsbdb:20261001 {'used':'1'}`, `budget:adsbdb:20261002 {'used':'-1'}`, `usage(day2) == (-1, 2000)`.
4. **Collector main, unexpected job end.** `run_until_stopped([crashing_task, looping_task], stop, grace_s=1)` returns `None` with `stop` set; the only output is asyncio's "Task exception was never retrieved".
5. **Loop lag, inline vs thread.** 6,600 synthetic readsb records (from `fixtures/adsb_lol_region.json`, re-hexed) through `normalize_readsb` → `AircraftGate.apply` → `encode_payload`, with a 1 ms `asyncio.sleep` sampler. Inline: max lag 115–120 ms. `to_thread`: 15–19 ms.
6. **`kma_grid` echo_cells.** Random int16 grid of 2881×2305: the float32 path vs `grid >= 500` give the same count; 14.0 ms / 57.0 MiB vs 2.4 ms / 6.4 MiB (tracemalloc peak).
7. **Other timings.** `parse_komsa` at 6,422 items: 8.9 ms. `build_payload` + `orjson` at 6,422: 5.9 ms. `GridGeometry` scans at 20k: 3.8 ms. AIS parse + book: 15 µs/msg (fixture `ais_east_asia_90s.jsonl`).
