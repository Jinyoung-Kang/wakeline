# Wakeline API review: architecture, correctness, performance, tests

- **Scope.** `apps/api` at `main` HEAD `e0e1eba` (clean tree). That is 149 main classes in 13 packages plus the root, and 968 tests.
- **Paths.** Unless a path says otherwise, it is relative to `apps/api/src/main/java/dev/wakeline/`.
- **Method.** I read all 149 classes, `application.yml`, `build.gradle.kts`, the migrations, the Makefile, the Dockerfile, compose and the edge config. Small Python scripts built the import graph. Runtime evidence came only from a scratch copy (`scratchpad/review/api-copy`, `./gradlew --offline test --tests …`). Nothing in the repository was changed.
- **Already-fixed items.** Problems fixed in `docs/VERIFICATION.md` #1–#96, ADR-017 R-xx and `docs/audit/change-contract-v5.md` are not reported again. Where a finding is a gap in a fixed item, the entry says which one.
- **Evidence labels.**
  - **Confirmed**: a test that fails today was written and run in the scratch copy (the code is in §3).
  - **Static**: from reading the code.
  - **Needs confirmation**: the entry says what would confirm it.
- **Orchestrator context, checked.** The package edges and cycles you measured match mine. "OpsController is the only controller with SQL" is true. However, two more controllers do Redis I/O directly: `ops/OpsPipelineController.java:185` and `rest/WeatherController.java:221-244`.

---

## 0. Top findings

| # | Sev | Where | Finding | Status |
|---|---|---|---|---|
| 1 | MEDIUM | `ingest/IngestHealthIndicator.java:78` | With no region snapshot yet, `health()` throws (`withDetail("region_lag_s", null)`; Boot 4 rejects null). Both `/actuator/health` and `/actuator/health/ingest` return 500. This happens during every startup grace period and in exactly the failure the indicator exists to report (`no_region_snapshot`). | Confirmed |
| 2 | MEDIUM | `ws/WakelineWsHandler.java:151` | `z.asInt()` throws `JsonNodeException` when zoom is outside the int range (e.g. `1e10`). Any anonymous client can trigger an uncaught exception, which Spring logs as ERROR with a stack and answers with close 1011. The edge allows 5 connections/s per IP. | Confirmed |
| 3 | MEDIUM | `persist/ShipWriter.java:183-185` | The static-info memo is updated when a row is queued, not when it is committed. If the row is then dropped (queue overflow at 100k, or a permanent batch failure), the collector's 30-minute same-content re-send is skipped as a duplicate. The static never reaches `ship` until the API restarts. | Confirmed |
| 4 | LOW-MED | `config/OpsSessionLifetimeFilter.java:61-68` | When the credential lookup fails (DB down), logout (`DELETE /api/v1/ops/session`) gets 503 and the session stays valid. This contradicts the "logout never fails" contract in `ops/OpsSessionController.java:37,123`. | Confirmed |
| 5 | LOW | `rest/KrRadarFrames.java:43` | `echo_cells.asInt()` throws on a non-numeric value, so `/api/v1/radar/kr` returns 500. This is a gap in R-72, which the class's own doc at line 15 promises. | Confirmed |
| 6 | LOW | `ops/SettingsService.java:200` | `intRange` calls `asInt()` on long values, so `PUT` of 4294967306 returns 500 instead of 400. | Confirmed |
| 7 | LOW (latent) | `persist/TrackWriter.java:457-466`, `persist/ShipWriter.java:306-321` vs `persist/OrderedWriter.java:163-168` | Non-SQL exceptions are retried forever by the track and ship writers, blocking the head of the queue. OrderedWriter gives the same exceptions up after 3 attempts. | Confirmed (behaviour) |
| 8 | LOW | `rest/WeatherController.java:240-243` | A Redis error becomes 404 (contract §2 says 503) and corrupt base64 becomes 500. The controller does Redis I/O itself. | Static |
| 9 | LOW | `persist/MaintenanceJobs.java:330` | Concurrent `aggregateDay(d)` for the same day can fail with 23505. Callers are the 03:30 cron, the 3-hourly catch-up and `POST /ops/stats/aggregate`, on a 16-thread scheduler. | Needs confirmation |
| 10 | MEDIUM (known, deferred) | `application.yml:13`, `persist/Sql.java:29` | Public REST reads share Hikari pool 12 with all writers. Each read is time-limited (3 s) but their number is not. Under a read burst while the DB is slow, writers time out on connections, then retry, queues grow and rows are dropped. `change-contract-v5.md:371-373` defers a separate read pool. | Needs measurement |
| 11 | LOW | `config/RateLimiter.java:29-34`, `ops/OpsController.java:103`, `ws/ShipFanout.java:220-226` | Silent catch-alls: the public rate limiter fails open with no metric or log, and a Redis failure turns the provider switch events into an empty list. | Static |
| 12 | ARCH | all 12 technical packages | One strongly connected component holds 141 class-to-package imports. There are 11 rule violations: controllers doing JDBC/Redis, `domain` → `config`, and `rest`/`config` → `ws`. | Measured |
| 13 | ARCH hazard | `config/SessionSerializationConfig.java:45-46`, `config/PipelineEventMulticaster.java:38-42`, `logs/LogEvents.java:80`, 5 non-Java tests | Package moves can silently break:<br>• Redis-serialized sessions (class names are pinned)<br>• event-listener isolation (identity check on `IngestEvents`/`EngineEvents`)<br>• ops error resolutions (fingerprints include the logger FQCN)<br>• tests that read Java source paths | Static |
| 14 | PERF | `ingest/StreamConsumer.java:617-629` | The single consumer thread spends 84 ms per 10k-aircraft global message. Of that, 48.6 ms is payload schema validation and 16.4 ms is a second JSON parse. The timer has no tags, so the spike is hidden. | Measured (bench) |
| 15 | PERF | `engine/EngineService.java:109-112`, `logs/LogReader` | The engine runs a full cycle (10k aircraft: 33 ms) on every hot or focus snapshot. LogReader scans the whole log on every ops poll (4,200 entries: 119–139 ms). | Measured (bench) |

Target structure (details in §2):
- `platform.{config,web,data,support}` is infrastructure with no feature imports.
- `geo` is a leaf.
- `aircraft`, `ships` and `weather` each get `{core,data,web}`.
- Flat leaf features: `ops`, `settings`, `status`, `history`, `traffic`, `coverage`, `demand`, `route`, `portcalls` and `logs`.
- `ingest` is the stream adapter.
- `ws` is the WebSocket transport, and nothing imports it.

---

## 1. Current architecture

### 1.1 Packages and roles (149 classes)

| Package | # | Controllers / transport | Services / rules | Data access / adapters | Config / infra / values |
|---|---|---|---|---|---|
| (root) | 1 | | | | WakelineApplication (boot + CLI) |
| config | 18 | OpsSessionLifetimeFilter, RateLimitFilter, RequestIdFilter, ProblemAdvice, ProblemErrorReportValve | | RateLimiter (Redis) | AppProperties, ApiPaths, ClientIp, EventConfig, PipelineEventMulticaster, Problem, ProblemJson, RedisConfig, SchedulingConfig, SecurityConfig, SessionSerializationConfig, WebSocketConfig |
| domain | 17 | | DestinationParser, UnlocodePorts, AisBboxes (parsers/rules) | | AircraftState, AisGap, AisScope, Alert, Bbox, DestinationInfo, Geo, GeoJson, HotCell, ShipCategory, ShipQuery, ShipState, ShipStatic, SigmetRecord |
| engine | 8 | | EngineService (listener + scheduler), IntersectionEngine, AlertStateMachine, SigmetIndex, DeadReckoning, AlertIds, PredictionAvailability | | EngineEvents |
| ingest | 17 | | in-memory state: SnapshotStore, Snapshot, ShipStore, ShipSweeper, SigmetStore, RadarStore, AisStatus | StreamConsumer, SchemaValidator, Codec, ShipCodec, StreamAckFinalizer, StreamMetrics, SingleInstanceGuard, IngestHealthIndicator | IngestEvents, Receipt |
| persist | 16 | | MaintenanceJobs (scheduled jobs) | AircraftRepository, AirportRepository, AlertRepository, ShipRepository, SigmetRepository, StatsRepository, TrackRepository, StoredStaticReader, TrackWriter, ShipWriter | OrderedWriter, ReceiptBatchQueue, ReadPool, Sql, SingleFlight |
| rest | 14 | AircraftController, HealthController, HistoryController, ShipController, ShipCoverageController, TrafficGridController, WeatherController | StatusService | TrafficGridReader, KrRadarFrames, KrRadarMissing (Redis-hash parsers) | Etags, Meta, SigmetGeoJson |
| ws | 16 | WakelineWsHandler, WsHub, ShipFanout, WsSession, SerialOutbox | DemandService, DiffCalculator, ShipGrid | RouteLookups, SelectionLookups, ShipLookups (async lookups) | AircraftJsonCache, WsMessages (encoders), ConnectionLimiter, SlidingWindowLimiter, OriginAllowList |
| ops | 18 | OpsController, OpsPipelineController, OpsSessionController, ResolutionController | AuditService, FailureWarnings, OpsSessionRegistry, OpsUserService, ProviderSwitchService, ResolutionService, SettingsService, RegionSettings, StartupMirror | IngestRunRepository, ResolutionRepository | OpsAuthentication, Resolution, Resolutions |
| logs | 10 | ClientErrorController, LogsController | LogEvents, LogMasker | LogSink, LogReader, LogStream, SinkAppender | LogEventSchema, ScheduledJobContext |
| coverage | 5 | | ShipCoverage, CoverageGrid | JdbcCoverageSource, CoverageSource (port) | IntIntMap |
| demand | 4 | | | RedisDemandLeases, DemandLeases (port) | CollectorDemandStatus, DemandStats |
| route | 2 | | | RouteReader (Redis + cache) | RouteInfo |
| portcalls | 3 | | PortCallReader (cache) | PortCallIndex (DB) | PortCallsInfo |

### 1.2 Package graph (imports and fully qualified references; built from `src/main/java`)

```
(root)    -> config, ops
config    -> engine, ingest, logs, ops, ws
coverage  -> domain, ingest, persist
domain    -> config
engine    -> domain, ingest
ingest    -> domain
logs      -> config, ops
ops       -> config, domain, ingest, persist, rest
persist   -> config, domain, engine, ingest, ops
portcalls -> domain, persist
rest      -> config, coverage, demand, domain, engine, ingest, ops, persist, route, ws
route     -> config, domain, persist
ws        -> config, demand, domain, engine, ingest, ops, persist, portcalls, rest, route
demand    -> (nothing)
```

**Cycles.** All 12 packages except `demand` and the root form **one strongly connected component**. 141 class-to-package imports sit inside it; this is the baseline for the guard test in §2.10. Some of the short cycles inside it:
- `domain → config → engine/ingest → domain`. The only edge that drags the innermost package into the cycle is `Bbox → Problem`.
- `config ↔ ops`, `config ↔ ws`, `config ↔ logs`.
- `rest ↔ ws`, `ops ↔ rest`, `persist ↔ ops`.
- `rest → coverage → persist → ops → rest`.
- `ws → portcalls → persist → ops → rest → ws`.

### 1.3 Wrong-way and cycle-closing edges (exact)

| # | Edge | Classes (file:line) | Why it is wrong | Fix in target |
|---|---|---|---|---|
| E1 | domain → config | `domain/Bbox.java:3`, `:16-28` (`Bbox.parse` throws `Problem.badRequest/unprocessable`) | A domain value type carries HTTP 400/422 semantics. | `platform.web.BboxParam.parse`; `geo.Bbox.checked` stays pure |
| E2 | engine → ingest | `engine/EngineService.java:6-8` (`IngestEvents`, `SigmetStore`, `SnapshotStore`) | Business rules depend on the stream-adapter package, because the state stores live there. | Stores and events move to `aircraft.core` / `weather.core` |
| E3 | config (infra) → features | `config/PipelineEventMulticaster.java:3-4` with identity check at `:38-42`; `config/ProblemAdvice.java:3` (`logs.LogMasker`); `config/SecurityConfig.java:42` and `config/SessionSerializationConfig.java:45-46` (`ops`); `config/WebSocketConfig.java:3-4` (`ws`) | Infrastructure knows about features. | `PipelineEvent` marker; LogMasker → `platform.support`; security wiring → `ops`; `WebSocketConfig` → `ws` |
| E4 | persist (infra) → ingest | `persist/OrderedWriter.java:6`, `persist/ReceiptBatchQueue.java:3` (`ingest.Receipt`); `TrackWriter.java:4-5`, `ShipWriter.java:5-7`, `SigmetRepository.java:6`, `AlertRepository.java:6` | Generic write queues depend on an ingest type. | `Receipt` → `platform.support`; events → feature core |
| E5 | persist → ops | `persist/MaintenanceJobs.java:5`, `persist/StatsRepository.java:47` (`RegionSettings`) | Data access depends on an ops service. | `RegionSettings` → `settings` |
| E6 | rest → ws (transport → transport) | `rest/AircraftController.java:14-15` (`WsHub.sources`, `WsMessages.encode`); `rest/ShipController.java:16-17` (`ShipFanout.MAX_SHIPS_PER_MESSAGE`, `WsMessages.encodeShip*`, `STATIC_*`); `rest/HistoryController.java:42` (`WsHub::status` for `GET /status`) | The JSON encoders and the 3-second status cache live in the WS adapter. | `aircraft.web.AircraftJson`, `ships.web.ShipJson`; status cache → `status.StatusService` |
| E7 | ws → rest | `ws/WsHub.java:18-19` (`SigmetGeoJson`, `StatusService`) | The status service and GeoJSON encoder live in the REST package. | → `weather.web`, `status` |
| E8 | ops → rest | `ops/OpsController.java:4`, `ops/ProviderSwitchService.java:4`, `ops/ResolutionService.java:4` (`StatusService`) | Same as E7. | → `status` |
| E9 | rest/ws → ops | `rest/StatusService.java:5`, `ws/DemandService.java:11` (`RegionSettings`) | Same as E5. | → `settings` |
| E10 | borrowed helpers | `TrackRepository.toInstant`: `ops/OpsUserService.java:103`, `portcalls/PortCallIndex.java:40,81-82`, `persist/{Aircraft,Airport,Alert,Sigmet}Repository`.<br>`StatusService.isoInstant`: `rest/KrRadarFrames`, `rest/KrRadarMissing`, `rest/TrafficGridReader`, `rest/WeatherController`.<br>`AircraftController.normalizeHex`: `rest/WeatherController.java:105`.<br>`TrackWriter.isPermanent`: `persist/ShipWriter.java:306`. | These create feature-to-feature edges for one-liners. | `Sql.toInstant`, `platform.support.Times.isoInstant`, `platform.web.Params.hex`, `platform.data.DbErrors` |
| E11 | controller does data access | `ops/OpsController.java:101,104,175,177,183,196,220` (JdbcClient and Redis streams); `ops/OpsPipelineController.java:185` (Redis hashes); `rest/WeatherController.java:221-244` (Redis pipelined EXISTS and GET) | Breaks the owner's "controllers do not access data" goal. | `ops.OpsQueries`, `ops.PipelineSignals`, `weather.data.KrRadarReader` (phase 3) |
| E12 | service takes web types | `ops/AuditService.java:29` (`record(HttpServletRequest …)`); `Problem` (HTTP status) thrown by `ProviderSwitchService`, `ResolutionService`, `Resolutions`, `SettingsService` | Acceptable in flat leaf features. It must not appear in `*.core` (the guard forbids it). | Optional: `AuditOrigin(ip, requestId)` value |

`logs → ops` (`logs/LogsController.java:4-6`) is a deliberate one-way edge and is already guarded by `OpsPackageDependencyTest`.

---

## 2. Target structure

### 2.1 Rules (the guard in §2.10 enforces all of them)

1. **No package cycles.** This applies at full package granularity, sub-packages included.
2. **`platform.*` imports only `platform.*` and `geo`.** It is infrastructure: config, web plumbing, DB/Redis plumbing and small support types.
3. **`geo` imports nothing from `dev.wakeline`.** It holds Bbox, Geo and GeoJson.
4. **A feature with shared domain logic gets `core` / `data` / `web`.** This applies to `aircraft`, `ships` and `weather`.
   - `*.core` may import only `*.core`, `geo` and `platform.support`. It may not import JDBC, Redis, servlet, spring-web or websocket APIs.
   - `*.data` may import only `*.core`, `geo` and `platform.{support,data,config}`. It may not import web APIs.
   - `*.web` may import anything except `ws`.
5. **Leaf features stay flat.** These are features nobody, or almost nobody, else imports. Inside them, the layering is by class role (`*Controller` / `*Service` / `*Repository|Reader`), enforced by rule 7.
6. **`ws` is terminal.** Nothing outside `ws` imports it.
   - `ingest` is the stream adapter. Once it no longer holds state stores, only `ops` and `status` may import it (they read pipeline signals).
7. **`@Controller` / `@RestController` classes do not import JDBC, Redis or Hikari APIs.**
8. **`ops` does not import `logs`.** This is the existing rule.

Feature-level cycles that pass through a `*.web` package are accepted. For example, `aircraft.web` uses `weather.core` (alerts for one aircraft) while `weather.core` uses `aircraft.core`. At sub-package granularity the graph stays acyclic.

### 2.2 Tree

```
dev.wakeline
├─ WakelineApplication
├─ platform.config   AppProperties RedisConfig SchedulingConfig EventConfig PipelineEventMulticaster
├─ platform.web      ApiPaths ClientIp Problem ProblemAdvice ProblemJson ProblemErrorReportValve RateLimitFilter RateLimiter
│                    RequestIdFilter Etags Meta  (+BboxParam, Params)
├─ platform.data     Sql(+toInstant) ReadPool OrderedWriter ReceiptBatchQueue  (+DbErrors: isTransient/isPermanent)
├─ platform.support  SingleFlight Receipt LogMasker  (+Times.isoInstant, PipelineEvent marker)
├─ geo               Bbox Geo GeoJson
├─ aircraft.core     AircraftState Snapshot SnapshotStore (+AircraftEvents)
├─ aircraft.data     TrackWriter TrackRepository AircraftRepository
├─ aircraft.web      AircraftController (+AircraftJson)
├─ ships.core        ShipState ShipStatic ShipCategory ShipQuery AisGap AisScope AisBboxes DestinationInfo DestinationParser
│                    UnlocodePorts ShipStore ShipSweeper AisStatus (+ShipEvents)
├─ ships.data        ShipRepository ShipWriter StoredStaticReader
├─ ships.web         ShipController (+ShipJson)
├─ weather.core      SigmetRecord Alert SigmetStore RadarStore EngineService IntersectionEngine AlertStateMachine SigmetIndex
│                    DeadReckoning AlertIds PredictionAvailability EngineEvents (+WeatherEvents)
├─ weather.data      SigmetRepository AlertRepository AirportRepository KrRadarFrames KrRadarMissing (+KrRadarReader, phase 3)
├─ weather.web       WeatherController SigmetGeoJson
├─ ingest            StreamConsumer SchemaValidator Codec ShipCodec StreamAckFinalizer StreamMetrics SingleInstanceGuard
│                    IngestHealthIndicator
├─ ws                WakelineWsHandler WsHub ShipFanout DemandService DiffCalculator AircraftJsonCache WsMessages WsSession
│                    SerialOutbox ConnectionLimiter SlidingWindowLimiter OriginAllowList RouteLookups SelectionLookups
│                    ShipLookups ShipGrid WebSocketConfig
├─ ops               OpsController OpsPipelineController OpsSessionController ResolutionController AuditService
│                    FailureWarnings OpsAuthentication OpsSessionRegistry OpsUserService ProviderSwitchService Resolution
│                    Resolutions ResolutionService ResolutionRepository IngestRunRepository StartupMirror
│                    SecurityConfig SessionSerializationConfig OpsSessionLifetimeFilter (+OpsQueries, PipelineSignals: phase 3)
├─ settings          RegionSettings SettingsService
├─ status            StatusService (+3 s public-status cache from WsHub) HealthController
├─ history           HistoryController StatsRepository MaintenanceJobs
├─ traffic           TrafficGridController TrafficGridReader
├─ coverage          CoverageGrid CoverageSource IntIntMap JdbcCoverageSource ShipCoverage ShipCoverageController
├─ demand            CollectorDemandStatus DemandLeases DemandStats RedisDemandLeases HotCell
├─ route             RouteInfo RouteReader
├─ portcalls         PortCallIndex PortCallReader PortCallsInfo
└─ logs              ClientErrorController LogsController LogEventSchema LogEvents LogReader LogSink LogStream
                     ScheduledJobContext SinkAppender
```

### 2.3 Full mapping (current → target)

All 149 classes are listed (count per row in brackets). New classes are marked `+`.

- **(root)** [1]: WakelineApplication → (root).
- **config** [18]
  - → `platform.config`: AppProperties, EventConfig, PipelineEventMulticaster, RedisConfig, SchedulingConfig.
  - → `platform.web`: ApiPaths, ClientIp, Problem, ProblemAdvice, ProblemErrorReportValve, ProblemJson, RateLimitFilter, RateLimiter, RequestIdFilter.
  - → `ops`: OpsSessionLifetimeFilter, SecurityConfig, SessionSerializationConfig.
  - → `ws`: WebSocketConfig.
- **domain** [17]
  - → `geo`: Bbox (minus `parse`), Geo, GeoJson.
  - → `aircraft.core`: AircraftState.
  - → `ships.core`: AisBboxes, AisGap, AisScope, DestinationInfo, DestinationParser, ShipCategory, ShipQuery, ShipState, ShipStatic, UnlocodePorts.
  - → `weather.core`: Alert, SigmetRecord.
  - → `demand`: HotCell.
- **engine** [8] → `weather.core`: AlertIds, AlertStateMachine, DeadReckoning, EngineEvents, EngineService, IntersectionEngine, PredictionAvailability, SigmetIndex.
- **ingest** [17]
  - Stays in `ingest`: Codec, IngestHealthIndicator, SchemaValidator, ShipCodec, SingleInstanceGuard, StreamAckFinalizer, StreamConsumer, StreamMetrics.
  - → `aircraft.core`: Snapshot, SnapshotStore.
  - → `ships.core`: AisStatus, ShipStore, ShipSweeper.
  - → `weather.core`: RadarStore, SigmetStore.
  - → `platform.support`: Receipt.
  - IngestEvents is **split** into:
    - `+aircraft.core.AircraftEvents` {SnapshotUpdated, AircraftBacklog}
    - `+ships.core.ShipEvents` {ShipsUpdated, ShipsSampled, AisGapReceived}
    - `+weather.core.WeatherEvents` {SigmetsUpdated, SigmetsExpired, SigmetSetReceived, RadarUpdated}
- **persist** [16]
  - → `platform.data`: OrderedWriter, ReadPool, ReceiptBatchQueue, Sql.
  - → `platform.support`: SingleFlight.
  - → `aircraft.data`: AircraftRepository, TrackRepository, TrackWriter.
  - → `ships.data`: ShipRepository, ShipWriter, StoredStaticReader.
  - → `weather.data`: AirportRepository, AlertRepository, SigmetRepository.
  - → `history`: MaintenanceJobs, StatsRepository.
- **rest** [14]
  - → `aircraft.web`: AircraftController.
  - → `ships.web`: ShipController.
  - → `weather.web`: WeatherController, SigmetGeoJson.
  - → `weather.data`: KrRadarFrames, KrRadarMissing.
  - → `status`: StatusService, HealthController.
  - → `history`: HistoryController (`GET /status` stays here, see §2.9).
  - → `traffic`: TrafficGridController, TrafficGridReader.
  - → `coverage`: ShipCoverageController.
  - → `platform.web`: Etags, Meta.
- **ops** [18]
  - Stays in `ops`: AuditService, FailureWarnings, IngestRunRepository, OpsAuthentication, OpsController, OpsPipelineController, OpsSessionController, OpsSessionRegistry, OpsUserService, ProviderSwitchService, Resolution, ResolutionController, ResolutionRepository, ResolutionService, Resolutions, StartupMirror.
  - → `settings`: RegionSettings, SettingsService.
- **logs** [10]: all stay except LogMasker → `platform.support`.
- **ws** [16], **coverage** [5], **demand** [4], **route** [2], **portcalls** [3]: unchanged.

New helper classes. Each is extracted from an existing method, so there is no new behaviour:
- `platform.web.BboxParam`: body of `Bbox.parse`.
- `platform.web.Params.hex`: `AircraftController.normalizeHex`.
- `platform.support.Times.isoInstant`: `StatusService.isoInstant`.
- `platform.data.Sql.toInstant`: `TrackRepository.toInstant`.
- `platform.data.DbErrors`: `OrderedWriter.isTransient` and `TrackWriter.isPermanent`.
- `platform.support.PipelineEvent`: marker interface.
- `aircraft.web.AircraftJson`: `WsMessages.encode/Encoding/encodingFor/round3` and `WsHub.sources/source`.
- `ships.web.ShipJson`: `WsMessages.encodeShipLite/State/Static`, `STATIC_*`, `ShipFanout.MAX_SHIPS_PER_MESSAGE`.

I simulated the full mapping by rewriting the class-level import graph with these extractions. The resulting **sub-package graph is acyclic**, with these edges:

```
aircraft.core -> platform.support          ships.core   -> geo, platform.support
aircraft.data -> aircraft.core, geo, platform.data, platform.support
ships.data    -> ships.core, platform.data, platform.support      (aircraft.data edge disappears with DbErrors)
weather.core  -> aircraft.core, geo, platform.support
weather.data  -> weather.core, geo, platform.data
aircraft.web  -> aircraft.core, aircraft.data, route, weather.core, geo, platform.web, platform.config
ships.web     -> ships.core, ships.data, geo, platform.web, platform.config
weather.web   -> weather.core, weather.data, geo, platform.web, platform.config
ingest        -> aircraft.core, ships.core, weather.core, demand, geo, platform.support
status        -> aircraft.core, ships.core, weather.core, weather.data, demand, ingest, settings, platform.config
settings      -> ships.core, geo, platform.web, platform.config
history       -> aircraft.data, weather.data, settings, geo, platform.*
ops           -> history, ingest, settings, status, platform.*
logs          -> ops, platform.*
ws            -> aircraft.core, ships.core, ships.data, weather.core, weather.web, aircraft.web, ships.web, demand, route,
                 portcalls, settings, status, geo, platform.*
```

### 2.4 Where a sub-package (or a feature package) is not worth it

- **`ops`** (19 classes after the move) stays flat.
  - `OpsAuthentication` and `OpsUserService$User` are Java-serialized into Redis sessions and named in `SessionSerializationConfig.FILTER_PATTERN` (`:45-46`). Moving them logs every operator out and fails deserialization.
  - Nothing outside imports `ops` except `logs` (resolutions) and the root (CLI).
  - An `ops.data` split creates a package cycle: `ops.data.ResolutionRepository` uses `ops.Resolution`, while `ops.ResolutionService` uses `ops.data`. An `ops.web` split forces package-private constructors public (`ResolutionService`, used by `ResolutionControllerTest`, `ResolutionDbTest` and `ResolutionServiceTest`).
- **`settings`, `status`, `history`, `traffic`, `coverage`, `demand`, `route` and `portcalls`** have 2–6 classes each. Sub-packages would only add import noise. Rule 7 keeps their controllers free of JDBC and Redis.
- **`ws`** stays one transport package. Splitting it per feature would scatter the session, outbox and limiter machinery (WsSession, SerialOutbox, lookups) that every job shares.
- **`ingest`** stays one adapter package. The codecs are 2 small classes.
- **`logs`** stays flat. Its only outward dependency is `ops` (resolutions).
- **Do not** create interfaces or ports for the repositories. The only existing ports (`CoverageSource`, `DemandLeases`) exist for tests, and that is the right bar.

### 2.5 Move order (each commit compiles and the full test suite is green)

Run on every commit:
- `cd apps/api && ./gradlew test` (about 5–6 min, single fork), or at least the test set listed in §5.3 plus `ArchitectureTest`, `OpenApiSnapshotIT` and `WsSchemaContractTest`.
- `make test-api contract` before merging.
- After each commit, lower `MAX_CYCLE_EDGES` and remove the `KNOWN` entries the commit fixed.

**Phase 0 (no moves)**
- 0.1 Add `ArchitectureTest` (§2.10). It is green today, with `KNOWN` = 11 entries and `MAX_CYCLE_EDGES` = 141.
- 0.2 Fix B1–B6. For each, add the failing test from §3 first, then the minimal fix.
- 0.3 Add the characterization tests in §5.4: listener wiring, session class names, `/actuator/health/ingest` states, and the status payload.

**Phase 1 (break the cycle; packages keep their technical names)**
1. **PipelineEvent marker.**
   - Make the nested records of `IngestEvents` and `EngineEvents` implement `platform.support.PipelineEvent` (create the package).
   - `PipelineEventMulticaster.isPipelineEvent` checks `payload instanceof PipelineEvent`.
   - Add a test that every record nested in a class named `*Events` implements the marker. Without it, a future event class silently loses listener isolation.
2. **platform + geo extraction.** Moves:
   - `config` classes → `platform.config` / `platform.web` (except the security and WebSocket wiring).
   - `persist.{Sql,ReadPool,OrderedWriter,ReceiptBatchQueue}` → `platform.data`.
   - `SingleFlight`, `Receipt`, `LogMasker` → `platform.support`.
   - `rest.{Etags,Meta}` → `platform.web`.
   - `domain.{Bbox,Geo,GeoJson}` → `geo`.

   Extractions:
   - `BboxParam` (5 call sites: `ShipController:97`, `WeatherController:66,248`, `HistoryController:57`, `AircraftController:64`).
   - `Params.hex`, `Times.isoInstant`, `Sql.toInstant`, `DbErrors`.

   Visibility changes (from a package-private access scan of main code):
   - `LogMasker.cut` and `clearSecrets` → public. They are used by `logs.ClientErrorController`, `LogEvents`, `LogSink` and four logs tests.
   - The `ReceiptBatchQueue` API → public: class, constructor, `Added`, `Batch`, `add`, `next`, `poll`, `resolved`, `releaseUpTo`, `size`, `pendingMarks`, `lastAddedSeq`, `settledUpTo`. ShipWriter uses all of them.
   - `OrderedWriter(MeterRegistry,long,long)` and `drainNow()` → public. Tests use them: PersistDbTest, ShipWriterTest, QueryPlanDbTest, ShipPersistDbTest.
   - `Etags` and `notModified` → public.

   Tests and other files:
   - Move each test with its class: config tests, OrderedWriterTest, ReceiptBatchQueueTest, SqlTest, ReadPool*Test, LogMaskerTest, EtagsTest, BboxTest.
   - Fix the fully qualified `dev.wakeline.config.SchedulingConfig.POOL_SIZE` in `it/SchedulingIT.java:29`.
   - Update the `config/RedisConfig.java` path in `apps/web/tests/route-pending.test.ts:132`.
3. **ops security wiring and WebSocketConfig.**
   - `SecurityConfig`, `SessionSerializationConfig`, `OpsSessionLifetimeFilter` → `ops`; `WebSocketConfig` → `ws`.
   - Their tests move along: SecurityCookieConfigTest, SessionSerializationConfigTest, OpsSessionLifetimeFilterTest.
4. **settings extraction.**
   - `RegionSettings` and `SettingsService` → `settings`.
   - `SettingsService.seedFromEnv(…, AuditService)` takes a hook, as `update` already does (`SettingsService.java:41,127`). Otherwise `settings ↔ ops` becomes a cycle.
   - RegionSettingsTest moves.
5. **status extraction.**
   - `StatusService` and `HealthController` → `status`.
   - Move the WsHub 3 s status-map TTL cache (`ws/WsHub.java:943-975`) into `StatusService`. WsHub keeps serializing the WS envelope; `HistoryController` takes the cache from `StatusService`.
   - `KrRadarFrames` and `KrRadarMissing` → `weather.data` (public, plus `frame`, `latest`, `from`, `MAX_STATIONS`).
   - Update the `rest/StatusService.java` path in `apps/web/tests/statusbar.test.ts:115`.
6. **JSON encoders.**
   - `AircraftJson` → `aircraft.web` (package created now), `ShipJson` → `ships.web`, `SigmetGeoJson` → `weather.web`.
   - After this commit, `rest` no longer imports `ws` and `ws` no longer imports `rest`.
   - `WsSchemaContractTest` must leave `apps/web/tests/fixtures/ws-samples.v1.json` byte-identical. `RestSamplesIT` + `make contract-rest` must pass.

   Simulated result after commit 6: **no package cycles** (`MAX_CYCLE_EDGES` → 0).

**Phase 2 (feature moves, one feature per commit)**

7. **aircraft**
   - `AircraftState`, `Snapshot`, `SnapshotStore` and `AircraftEvents` → `aircraft.core`.
   - `TrackWriter`, `TrackRepository`, `AircraftRepository` → `aircraft.data`; `AircraftController` → `aircraft.web`.
   - `SnapshotStore.build` → public. IngestHealthTest, StreamConsumerTest and StreamConsumerShipsTest use it.
   - Split the TrackWriter parts out of `PersistDbTest` and `PersistUnitTest`.
   - Update `tools/contract_check.py:725` (`JAVA_PERSIST`, which reads `TrackWriter.java` and `ShipWriter.java` for `MAX_MARKS`).
8. **weather**
   - `SigmetRecord`, `Alert`, `engine.*`, `SigmetStore`, `RadarStore` and `WeatherEvents` → `weather.core`.
   - `SigmetRepository`, `AlertRepository`, `AirportRepository` → `weather.data`; `WeatherController` → `weather.web`.
   - Engine tests move along. Split the rest of PersistUnitTest and PersistDbTest.
   - Update the `engine/EngineService.java` path in `apps/collector/tests/test_aircraft_job.py:389`.
9. **ships**
   - Ship domain types, `ShipStore`, `ShipSweeper`, `AisStatus` and `ShipEvents` → `ships.core`.
   - `ShipRepository`, `ShipWriter`, `StoredStaticReader` → `ships.data`; `ShipController` → `ships.web`.
   - `ShipStore(int,int)` → public (tests). `ShipStore()` is already public and used by StreamConsumer's test constructor.
   - ShipPersistDbTest needs the `MaintenanceJobs` test constructor public, or its partition set-up moved to `DbTestSupport`.
   - Update the `domain/ShipCategory.java` path in `apps/web/tests/ships-v5.test.ts:48`.
10. **Leaf features**
    - `history` (HistoryController, StatsRepository, MaintenanceJobs), `traffic`, `coverage` (+ShipCoverageController), `demand` (+HotCell).
    - Delete the now-empty `domain`, `engine`, `persist` and `rest` packages, and `IngestEvents`.
    - Flip `INGEST_IS_ADAPTER_ONLY = true`. Remove the `domain-imports` rule.

**Phase 3 (optional, behaviour-neutral)**
- `ops.OpsQueries`: the SQL and Redis reads in OpsController.
- `ops.PipelineSignals`: the Redis reads in OpsPipelineController.
- `weather.data.KrRadarReader`: the radar frame reads in WeatherController.
- After these, `KNOWN` is empty.
- Optional: `AuditOrigin` instead of `HttpServletRequest` in AuditService. Only if it pays for itself.

### 2.6 Package-private access tests rely on (scan of `src/test`)

Package-private access constrains only these moves. All other tests move together with their classes.

| Test (today) | Uses package-private | Resolution |
|---|---|---|
| persist.OrderedWriterTest | `TrackWriter.isPermanent` | `DbErrors` in platform.data (step 2) |
| persist.PersistDbTest | `AlertRepository.closeReason/idFloor`, `MaintenanceJobs` (ctor, `catchUp*`, `summarizeHour`), `OrderedWriter.drainNow`, `TrackWriter` (ctor, `enqueue`, `queued`, `pendingMarks`, `BATCH`, `QUEUE_MAX`) | Split per destination package (steps 7, 8, 10) |
| persist.PersistUnitTest | `AirportRepository.withAge`, `AlertRepository.closeReason`, `SigmetRepository.contentOf/db*Source`, `TrackWriter` (ctor, `enqueue`, `pendingMarks`, `MAX_MARKS`) | Split |
| persist.ShipWriterTest, QueryPlanDbTest, ShipPersistDbTest | `OrderedWriter` ctor and `drainNow`; `MaintenanceJobs` ctor; `ShipRepository.scope`; `TrackWriter.isPermanent` | Public test ctor, `DbErrors` |
| ingest.IngestHealthTest, StreamConsumerTest, StreamConsumerShipsTest | `SnapshotStore.build`, `ShipStore(int,int)` | Make public (steps 7, 9) |
| ingest.AisStatusTest | `ShipStore` ctor, `ShipSweeper.sweep` | All move to ships.core together |
| logs.LogEventsTest, ClientErrorControllerTest, LogReaderTest | `LogMasker.clearSecrets` | Public (step 2) |
| ops.OpsDbTest | `SettingsService.REDIS_KEY` (already public) | none |
| ws.WsMessagesTest | `WsHub.source` | Moves to aircraft.web with `AircraftJson` (step 6) |
| rest.StatusServiceTest, KrRadar*Test, TrafficGridReaderTest, ShipControllerTest, ShipCoverageControllerTest | own class internals | Move together |

### 2.7 Non-Java hazards (verify each in the commit that touches it)

1. **Session serialization.** `config/SessionSerializationConfig.java:45-46` allow-lists `dev.wakeline.ops.OpsAuthentication` and `dev.wakeline.ops.OpsUserService$User`. Keep both classes in `ops`. Add a test that `Class.forName` succeeds for every `dev.wakeline` name in `FILTER_PATTERN`.
2. **Listener isolation.** `config/PipelineEventMulticaster.java:38-42` checks `owner == IngestEvents.class || owner == EngineEvents.class`. Splitting `IngestEvents` without the marker (step 1) silently removes isolation for the new event classes. A throwing listener would then propagate into the stream consumer.
3. **Log fingerprints.** `logs/LogEvents.java:80` fingerprints include the logger name, which is the class FQCN. Every moved class that logs errors gets new fingerprints, so existing ops "resolutions" (`ResolutionService`, keyed by fingerprint) stop matching and old error groups show up as new.
   - No code fix is worth it. Say so in the release note and VERIFICATION entry.
   - `SinkAppender.OWN_PACKAGE = "dev.wakeline.logs."` (`logs/SinkAppender.java:18`) still matches, because `logs` does not move.
4. **Listener order.** Ties among `@EventListener` methods are broken by bean registration order, which is the classpath scan order. That is not a contract.
   - Today `EngineService.onSnapshot` runs before `WsHub.onSnapshot`. As a result, the `selected` message computes `PredictionAvailability` (from `EngineService.lastTurning`) after the engine cycle for that snapshot (`ws/WsHub.java:728`, `engine/EngineService.java:234-236`). After the moves, `weather.core` still sorts before `ws`.
   - Make the order explicit with `@Order` on the two listeners and pin it with the wiring test in §5.4.
5. **Cross-language source-path tests.** These read Java files by path:
   - `apps/web/tests/route-pending.test.ts:103-137` (RouteReader, WsHub, RedisConfig, RouteLookups)
   - `apps/web/tests/statusbar.test.ts:115` (StatusService)
   - `apps/web/tests/ships-v5.test.ts:48` (ShipCategory)
   - `apps/collector/tests/test_aircraft_job.py:389` (EngineService)
   - `apps/collector/tests/test_demand.py:176` (CollectorDemandStatus; unchanged)
   - `tools/contract_check.py:725` (`JAVA_PERSIST` = `…/persist`)

   `Makefile:94` and `contract_check.py:822` name `dev.wakeline.ws.WsSchemaContractTest`, which does not move.
6. **OpenAPI snapshot.** Tags come from controller simple names (`history-controller`, etc.). Package moves do not change them. **Moving an endpoint to another controller does** (e.g. a new StatusController), which is why `GET /status` stays in `HistoryController`.
7. **`@Profile("!cli & !migrate")`** annotations move with their classes. `WakelineApplication` excludes `UserDetailsServiceAutoConfiguration` and uses `OpsUserService` (`WakelineApplication.java:4,116`). It is unaffected because `ops` stays.

### 2.8 Visibility changes in main code (complete list, from the package-private access scan)

- **Phase 1:**
  - `LogMasker.cut`
  - `ReceiptBatchQueue` (whole API)
  - `OrderedWriter.isTransient`, now `DbErrors`
  - `Etags` and `notModified`
  - `StatusService.isoInstant`, now `Times`
  - `KrRadarFrames` (class, `frame`, `latest`, `MAX_STATIONS`)
  - `KrRadarMissing` (class, `from`)
- **Phase 2:**
  - `TrackWriter.isPermanent`, now `DbErrors`
  - `AircraftController.normalizeHex`, now `Params.hex`
  - `SnapshotStore.build` (tests)
  - `ShipStore(int,int)` (tests)

### 2.9 Small things to fold into the moves (not required)

- `config/RateLimitFilter.java:46-50` builds problem JSON by hand. It is safe today: request ids are validated (`RequestIdFilter.java:31`) and Tomcat rejects `"` in URIs. Still, it duplicates `ProblemJson.write`.
- `AppProperties.schemasDir` (`application.yml:89`) and `AppProperties.fixture()` (`config/AppProperties.java:33`) are bound but never read by main code.
- The `SchedulingConfig` comment at `:13,20` says "fixedDelay 10 · cron 3" / "13". There are 14 `@Scheduled` methods: 10 fixedDelay and 4 cron. The cron jobs are `MaintenanceJobs.java:107,114,164,302`. `SchedulingIT` only checks that the count is below 16.

### 2.10 Architecture guard test (JUnit + JDK only)

`apps/api/src/test/java/dev/wakeline/ArchitectureTest.java`:
- It is green on the current code. Both tests together take 0.3 s; the gradle run is about 2 s.
- **Mutation-checked:** adding `import dev.wakeline.ws.WsHub;` to `demand/DemandStats.java` fails both tests: `only-ws-imports-ws|demand.DemandStats|ws`, and the cycle count goes up because `demand` joins the cycle.
- It supersedes `ops/OpsPackageDependencyTest`, which can stay. That test only reads `import` lines, so it misses fully qualified references.

```java
package dev.wakeline;

import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Package rules, checked from source (no ArchUnit, no new dependency): imports + fully qualified references in src/main/java.
 * Ratchet: KNOWN lists today's rule violations and MAX_CYCLE_EDGES today's cycle size. A new violation fails; a KNOWN entry
 * that disappeared also fails (delete it), and so does a cycle count below the constant (lower it) — the numbers only go down.
 */
class ArchitectureTest {
    static final Path MAIN = Path.of("src/main/java");
    static final String ROOT = "dev.wakeline.";

    static final List<String> DATA_APIS = List.of("org.springframework.jdbc", "java.sql", "javax.sql", "com.zaxxer",
            "org.springframework.data.redis", "io.lettuce");
    static final List<String> WEB_APIS = List.of("jakarta.servlet", "org.springframework.web", "org.springframework.http",
            "org.apache.catalina", "org.apache.tomcat");

    /** Flip to true in the commit that empties ingest of state stores (end of the feature moves). */
    static final boolean INGEST_IS_ADAPTER_ONLY = false;
    /** Number of class-level imports inside package cycles today. May only go down; 0 at the end of phase 1. */
    static final int MAX_CYCLE_EDGES = 141;
    static final Set<String> KNOWN = Set.of(
            "controller-data-access|ops.OpsController|org.springframework.data.redis.connection",
            "controller-data-access|ops.OpsController|org.springframework.data.redis.connection.stream",
            "controller-data-access|ops.OpsController|org.springframework.data.redis.core",
            "controller-data-access|ops.OpsController|org.springframework.jdbc.core.simple",
            "controller-data-access|ops.OpsPipelineController|org.springframework.data.redis.core",
            "controller-data-access|rest.WeatherController|org.springframework.data.redis.core",
            "domain-imports|domain.Bbox|config",
            "only-ws-imports-ws|config.WebSocketConfig|ws",
            "only-ws-imports-ws|rest.AircraftController|ws",
            "only-ws-imports-ws|rest.HistoryController|ws",
            "only-ws-imports-ws|rest.ShipController|ws");

    record Src(String cls, String pkg, boolean controller, Set<String> refs) {}

    static final Pattern IMPORT = Pattern.compile("(?m)^import\\s+(?:static\\s+)?([\\w.]+?)(?:\\.\\*)?;");
    /** Inline fully qualified names (field types, `new dev.wakeline.x.Y`, string class names): package part only. */
    static final Pattern FQN = Pattern.compile("\\b((?:dev|org|java|javax|jakarta|com|io|tools)(?:\\.[a-z]\\w*)+)\\.[A-Z]");
    static final Pattern CONTROLLER = Pattern.compile("@(Rest)?Controller\\b");

    static List<Src> sources() throws IOException {
        List<Src> out = new ArrayList<>();
        try (Stream<Path> files = Files.walk(MAIN)) {
            for (Path p : files.filter(f -> f.toString().endsWith(".java")).sorted().toList()) {
                String code = Files.readString(p, StandardCharsets.UTF_8).replaceAll("(?s)/\\*.*?\\*/", "").replaceAll("(?m)//.*$", "");
                String cls = MAIN.relativize(p).toString().replace('\\', '/').replace('/', '.').replaceAll("\\.java$", "");
                Set<String> refs = new TreeSet<>();
                Matcher m = IMPORT.matcher(code);
                while (m.find()) refs.add(packageOf(m.group(1)));
                Matcher fq = FQN.matcher(code.replaceAll("(?m)^(import|package)\\s.*$", ""));
                while (fq.find()) refs.add(fq.group(1));
                out.add(new Src(cls, cls.substring(0, cls.lastIndexOf('.')), CONTROLLER.matcher(code).find(), refs));
            }
        }
        return out;
    }

    /** a.b.Cls / a.b.Cls.member / a.b → a.b */
    static String packageOf(String name) {
        StringBuilder b = new StringBuilder();
        for (String s : name.split("\\.")) {
            if (!s.isEmpty() && Character.isUpperCase(s.charAt(0))) break;
            if (!b.isEmpty()) b.append('.');
            b.append(s);
        }
        return b.toString();
    }

    static String rel(String pkg) { return pkg.startsWith(ROOT) ? pkg.substring(ROOT.length()) : pkg.equals("dev.wakeline") ? "(root)" : pkg; }
    static boolean ours(String pkg) { return pkg.equals("dev.wakeline") || pkg.startsWith(ROOT); }
    static boolean under(String pkg, String prefix) { return pkg.equals(prefix) || pkg.startsWith(prefix + "."); }
    static boolean anyUnder(String pkg, List<String> prefixes) { return prefixes.stream().anyMatch(a -> under(pkg, a)); }
    static String feature(String relPkg) { int i = relPkg.indexOf('.'); return i < 0 ? relPkg : relPkg.substring(0, i); }

    static Set<String> violations(List<Src> srcs) {
        Set<String> v = new TreeSet<>();
        for (Src s : srcs) {
            String from = rel(s.pkg());
            String who = rel(s.cls());
            for (String to : s.refs()) {
                if (!ours(to)) {
                    if (s.controller() && anyUnder(to, DATA_APIS)) v.add("controller-data-access|" + who + "|" + to);
                    if ((from.endsWith(".core") || from.equals("geo")) && (anyUnder(to, DATA_APIS) || anyUnder(to, WEB_APIS)))
                        v.add("core-imports-io|" + who + "|" + to);
                    if (from.endsWith(".data") && anyUnder(to, WEB_APIS)) v.add("data-imports-web|" + who + "|" + to);
                    continue;
                }
                String t = rel(to);
                if (t.equals(from)) continue;
                // target layout (vacuous until the packages exist)
                if (under(from, "platform") && !under(t, "platform") && !t.equals("geo")) v.add("platform-imports-feature|" + who + "|" + t);
                if (from.equals("geo")) v.add("geo-imports|" + who + "|" + t);
                if (from.endsWith(".core") && !(t.endsWith(".core") || t.equals("geo") || t.equals("platform.support")))
                    v.add("core-imports-outer|" + who + "|" + t);
                if (from.endsWith(".data") && !(t.endsWith(".core") || t.equals("geo") || t.equals("platform.support")
                        || t.equals("platform.data") || t.equals("platform.config")))
                    v.add("data-imports-outer|" + who + "|" + t);
                if (under(t, "ws") && !under(from, "ws")) v.add("only-ws-imports-ws|" + who + "|" + t);
                if (under(from, "ops") && under(t, "logs")) v.add("ops-imports-logs|" + who + "|" + t);
                if (INGEST_IS_ADAPTER_ONLY && under(t, "ingest") && !Set.of("ingest", "ops", "status").contains(feature(from)))
                    v.add("ingest-is-an-adapter|" + who + "|" + t);
                // current layout, until the technical packages are gone
                if (from.equals("domain")) v.add("domain-imports|" + who + "|" + t);
            }
        }
        return v;
    }

    /** class-level references whose two packages are in the same strongly connected component */
    static Set<String> cycleEdges(List<Src> srcs) {
        Map<String, Set<String>> g = new TreeMap<>();
        for (Src s : srcs) for (String to : s.refs())
            if (ours(to) && !to.equals(s.pkg())) g.computeIfAbsent(s.pkg(), k -> new TreeSet<>()).add(to);
        Map<String, Integer> comp = components(g);
        Set<String> out = new TreeSet<>();
        for (Src s : srcs) for (String to : s.refs())
            if (ours(to) && !to.equals(s.pkg()) && comp.containsKey(s.pkg()) && comp.get(s.pkg()).equals(comp.get(to)))
                out.add(rel(s.cls()) + " -> " + rel(to));
        return out;
    }

    /** Tarjan: package → component id, only for components with more than one package. */
    static Map<String, Integer> components(Map<String, Set<String>> g) {
        Map<String, Integer> idx = new HashMap<>(), low = new HashMap<>(), comp = new HashMap<>();
        Deque<String> stack = new ArrayDeque<>();
        Set<String> on = new HashSet<>();
        int[] counter = {0, 0};
        Set<String> nodes = new TreeSet<>(g.keySet());
        g.values().forEach(nodes::addAll);
        for (String n : nodes) if (!idx.containsKey(n)) strong(n, g, idx, low, stack, on, comp, counter);
        return comp;
    }

    private static void strong(String v, Map<String, Set<String>> g, Map<String, Integer> idx, Map<String, Integer> low, Deque<String> stack,
                               Set<String> on, Map<String, Integer> comp, int[] counter) {
        idx.put(v, counter[0]);
        low.put(v, counter[0]++);
        stack.push(v);
        on.add(v);
        for (String w : g.getOrDefault(v, Set.of())) {
            if (!idx.containsKey(w)) { strong(w, g, idx, low, stack, on, comp, counter); low.put(v, Math.min(low.get(v), low.get(w))); }
            else if (on.contains(w)) low.put(v, Math.min(low.get(v), idx.get(w)));
        }
        if (low.get(v).equals(idx.get(v))) {
            List<String> c = new ArrayList<>();
            String w;
            do { w = stack.pop(); on.remove(w); c.add(w); } while (!w.equals(v));
            if (c.size() > 1) { int id = ++counter[1]; c.forEach(p -> comp.put(p, id)); }
        }
    }

    @Test
    void packageRulesHold() throws IOException {
        assertThat(MAIN).as("run from apps/api (the gradle test working directory)").isDirectory();
        List<Src> srcs = sources();
        Set<String> now = violations(srcs);
        Set<String> added = new TreeSet<>(now);
        added.removeAll(KNOWN);
        Set<String> gone = new TreeSet<>(KNOWN);
        gone.removeAll(now);
        assertThat(added).as("new package-rule violations (see the rule name before the first '|')").isEmpty();
        assertThat(gone).as("fixed — delete these from KNOWN").isEmpty();
    }

    @Test
    void packageCyclesOnlyShrink() throws IOException {
        Set<String> edges = cycleEdges(sources());
        assertThat(edges.size()).as("imports inside package cycles went up (all of them below)\n" + String.join("\n", edges))
                .isLessThanOrEqualTo(MAX_CYCLE_EDGES);
        assertThat(edges.size()).as("cycle imports went down — lower MAX_CYCLE_EDGES to " + edges.size()).isEqualTo(MAX_CYCLE_EDGES);
    }
}
```

Rule summary, each line written as `rule-name: meaning`. Violation strings use the format `rule|class|target`.

```
cycle (count ratchet)     : no class-level import inside a package SCC
controller-data-access    : @Controller/@RestController must not reference JDBC/Hikari/spring-data-redis/lettuce packages
platform-imports-feature  : platform.** -> only platform.** and geo
geo-imports               : geo -> nothing in dev.wakeline
core-imports-outer        : *.core -> only *.core, geo, platform.support
core-imports-io           : *.core and geo -> no JDBC/Redis/servlet/spring-web/http/tomcat
data-imports-outer        : *.data -> only *.core, geo, platform.{support,data,config}
data-imports-web          : *.data -> no servlet/spring-web/http/tomcat
only-ws-imports-ws        : nothing outside ws references ws
ops-imports-logs          : ops -> not logs (the existing OpsPackageDependencyTest rule)
ingest-is-an-adapter      : (after phase 2) only ingest, ops, status reference ingest
domain-imports            : (until phase 2) the technical domain package references nothing in dev.wakeline
```

Known limits:
- The scan is text based. It does not see a reference that appears only as an unimported simple name from the same package, which is fine because same-package references never cross a rule.
- Comment stripping is naive: `//` inside a string literal drops the rest of that line, with no effect on any import today.
- Class names inside string literals are counted on purpose. `SessionSerializationConfig`'s allow-list is a real dependency.

---

## 3. Correctness and reliability findings

To reproduce any of them: copy the repo, put the test in the stated package, and run `cd apps/api && ./gradlew --offline test --tests '<class>'`. Every test in a finding marked **Confirmed** was run and **fails on HEAD `e0e1eba`** with the message shown. The other findings come with a test sketch only. The scratch copies are under `scratchpad/review/api-copy/apps/api/src/test/java/dev/wakeline/`.

### B1. MEDIUM: `/actuator/health/ingest` and `/actuator/health` return 500 when no region snapshot exists. Confirmed.

- **Where:** `ingest/IngestHealthIndicator.java:73-79`.
- **Evidence:** `return b.withDetail("region_lag_s", v.regionLagS() < 0 ? null : Math.round(...)).build();`. Boot 4's `Health.Builder.withDetail` asserts that the value is non-null, so the call throws `IllegalArgumentException: 'value' must not be null`.
  - `verdict()` already returns `UNKNOWN` (grace period) or `DOWN` with `no_region_snapshot`. The 500 replaces exactly those answers.
  - The indicator implements `HealthIndicator` directly, not `AbstractHealthIndicator`, so nothing converts the exception into DOWN.
  - `HealthController` (public `/healthz`) uses `verdict()`, not `health()`, so it is unaffected. The compose readiness check (`/actuator/health/readiness`) does not include the ingest contributor (`application.yml:57`), so it is unaffected too.
  - Affected: monitoring of `/actuator/health/ingest` (the documented alert path, `rest/HealthController.java:18`) and every call to the root `/actuator/health`. The exception leaves the endpoint as a 500, which the servlet container normally logs at ERROR with a stack. I did not run the full app to see that log line.
- **Root cause:** the detail is written unconditionally. The Boot 4 null check is new behaviour.
- **Why tests missed it:** `it/IngestIT.java:378` checks the endpoint only after a snapshot exists. `IngestHealthTest` exercises `verdict()` only.
- **Failing test (`dev.wakeline.ingest`):**
  ```java
  @Test void healthWithoutARegionSnapshotReportsUnknownInsteadOfThrowing() {
      AtomicLong clock = new AtomicLong(1_790_000_000_000L);
      SnapshotStore snapshots = new SnapshotStore();
      StreamConsumer consumer = new StreamConsumer(null, new SchemaValidator(), snapshots, new SigmetStore(), new RadarStore(), e -> { },
              JsonMapper.builder().build(), new SimpleMeterRegistry()) { @Override public long lastReadAgeMs() { return 500; } };
      StreamMetrics metrics = new StreamMetrics(null, new SimpleMeterRegistry()) { @Override public Sample sample(String s) { return new Sample(0, 0, 0, 0); } };
      IngestHealthIndicator h = new IngestHealthIndicator(snapshots, consumer, metrics, clock::get);
      assertThat(h.verdict().status()).isEqualTo(Status.UNKNOWN);
      assertThatCode(h::health).doesNotThrowAnyException();   // fails: IllegalArgumentException 'value' must not be null (IngestHealthIndicator.java:78)
  }
  ```
  Add the same check after `STARTUP_GRACE_MS`, expecting `DOWN`.
- **Fix:**
  ```java
  Health.Builder b = Health.status(v.status());
  if (!v.reasons().isEmpty()) b.withDetail("reasons", v.reasons());
  if (v.regionLagS() >= 0) b.withDetail("region_lag_s", Math.round(v.regionLagS()));
  return b.build();
  ```

### B2. MEDIUM: an anonymous WS message with a huge `zoom` produces an uncaught exception, an ERROR log with stack, and close 1011. Confirmed.

- **Where:** `ws/WakelineWsHandler.java:151`, `int zoom = z.isNumber() ? Math.max(0, Math.min(MAX_ZOOM, z.asInt())) : 7;`.
- **Evidence:** in Jackson 3, `asInt()` throws `JsonNodeException` for numbers outside the int range ("'DoubleNode' asInt() cannot convert 1.0E10"). The same happens for `LongNode` 2^31 and `BigIntegerNode`.
  - `handleTextMessage` (`:95-116`) catches only parse errors.
  - Spring's `ExceptionWebSocketHandlerDecorator` logs at ERROR and closes with `SERVER_ERROR` (1011).
  - Only `hello` is needed first. The edge allows 5 new WS connections/s per IP with a burst of 10, so one client can produce several ERROR stacks per second.
  - `LogSink` suppression limits the ops console, but stdout keeps the stacks, and operators see "server errors" caused by client input.
- **Root cause:** Jackson 2's lenient `asInt()` was replaced by a range-checked one in Jackson 3. `asInt(default)` / `asDouble()` are still lenient.
- **Failing test (`dev.wakeline.ws`):**
  ```java
  @Test void subscribeWithAnOutOfRangeZoomIsAProtocolErrorNotAnUncaughtException() throws Exception {
      try (WsTestKit k = new WsTestKit()) {
          FakeWsSession f = k.connect("s1", "1.2.3.4");
          k.msg(f, "{\"type\":\"hello\",\"proto\":1}");
          assertThatCode(() -> k.msg(f, "{\"type\":\"subscribe\",\"bbox\":[124,33,132,39],\"zoom\":1e10}"))
                  .doesNotThrowAnyException();          // fails: JsonNodeException from WakelineWsHandler.subscribe
      }
  }
  ```
- **Minimal fix:** `int zoom = z.isNumber() ? (int) Math.max(0, Math.min(MAX_ZOOM, z.asDouble())) : 7;`. This gives the same truncation as before for values in range.
  - Belt and braces: wrap the `switch` in `handleTextMessage` with `catch (RuntimeException e)`, then `hub.fatal(s, "BAD_MESSAGE", …, PROTOCOL_ERROR)` plus one rate-limited WARN without a stack. Any future coercion bug then stays a client error.
  - The other numeric reads in the handler are safe: `proto` uses `asInt(0)`, and bbox uses `asDouble()` after `isNumber()`.

### B3. MEDIUM: ship static info is lost after a dropped or failed batch and is not re-written until restart. Confirmed.

- **Where:** `persist/ShipWriter.java:94-95` (memo), `:183-185` (memo updated in `select`, on the consumer thread, before enqueue), `:212-219` (overflow drop in `enqueue`), `:306-316` (the whole batch is dropped after 3 permanent failures).
- **Evidence:**
  - `staticSeen.put(mmsi, updatedAt)` happens when a row is **queued**.
  - The rows are later dropped in two cases:
    - (a) `ReceiptBatchQueue.add` overflows (`QUEUE_MAX = 100_000`, `:49`), for example during a DB outage of a few minutes;
    - (b) the batch fails permanently. One bad position row (any SQLState 21/22/23/42, `TrackWriter.isPermanent`) takes the good statics in the same 2,000-row batch down with it.
  - The collector re-sends an unchanged static every 1,800 s **with the same `updated_at`** for "consumer restart recovery" (`apps/collector/wakeline_collector/ais/book.py:77,87,179-181,203`). `select` then skips it as "same content" (`!st.updatedAt().isAfter(prev)`).
  - The `ship` row stays missing or stale until the ship's static info changes or the API restarts. That affects DB ship search, the stored-static fallback (`StoredStaticReader`) and the port-call lookup.
- **Root cause:** the dedupe memo records *intent* (queued), not *outcome* (committed).
- **Failing test (`dev.wakeline.persist`, reuses `ShipWriterTest.FakeRepo`):**
  ```java
  @Test void aStaticWhoseWriteWasDroppedIsWrittenWhenTheCollectorResendsTheSameContent() throws Exception {
      ShipWriterTest.FakeRepo repo = new ShipWriterTest.FakeRepo();
      repo.fail = new DataIntegrityViolationException("poison batch", new SQLException("check violation", "23514"));
      ShipWriter w = new ShipWriter(repo, null, new SimpleMeterRegistry(), 1, 1);
      w.start();
      try {
          w.onShips(new IngestEvents.ShipsUpdated(ShipWriterTest.T, "aisstream", List.of(),
                  List.of(ShipWriterTest.stat("440000001", ShipWriterTest.T)), Set.of(), Set.of(), Receipt.NONE));
          long until = System.currentTimeMillis() + 5_000;
          while ((repo.attempts.get() < ShipWriter.PERMANENT_ATTEMPTS || w.queued() > 0) && System.currentTimeMillis() < until) Thread.sleep(10);
          Thread.sleep(100);
          assertThat(repo.statics).isEmpty();                      // dropped after 3 permanent failures
          repo.fail = null;
          w.onShips(new IngestEvents.ShipsUpdated(ShipWriterTest.T.plusSeconds(1800), "aisstream", List.of(),
                  List.of(ShipWriterTest.stat("440000001", ShipWriterTest.T)), Set.of(), Set.of(), Receipt.NONE));   // 30-min re-send, same updated_at
          until = System.currentTimeMillis() + 3_000;
          while (repo.statics.isEmpty() && System.currentTimeMillis() < until) Thread.sleep(10);
          assertThat(repo.statics).hasSize(1);                     // fails: Expected size: 1 but was: 0
      } finally { w.stop(); }
  }
  ```
  Add an overflow variant: fill past `QUEUE_MAX` with a gated repo, then re-send.
- **Minimal fix (no new structure):**
  - Add `private volatile boolean forgetStatics;`.
  - The writer thread sets it in the permanent-drop branch (`:309-316`) when the batch contains a `Stat`.
  - `enqueue` sets it when `a.dropped() > 0`.
  - At the top of `select`, if the flag is set: clear it, then call `staticSeen.clear()`. The memo stays consumer-thread-only.
  - Cost: after a rare drop, each static is re-written once at most, through an idempotent upsert guarded by `updated_at >=` (`ShipRepository.java:56-66`).
  - The same pattern applies to `kept` (the position downsampling memo). Today a dropped 60 s window only loses that window, which is acceptable.

### B4. LOW-MEDIUM: logout is blocked (503) while the credential store is unavailable, and the session stays valid. Confirmed.

- **Where:** `config/OpsSessionLifetimeFilter.java:61-68`.
- **Evidence:** for every `/api/v1/ops/**` request with a logged-in session, the filter looks up the current credential tag. If the lookup throws (DB down), it writes 503 and returns. That includes `DELETE /api/v1/ops/session`.
  - `OpsSessionController` documents the opposite: "로그아웃은 … 세션 종료가 우선 … 권한을 줄이는 쪽은 실패하지 않게" (`ops/OpsSessionController.java:37`; also `:123-124`).
  - An operator who clicks "log out" during a DB incident keeps a live session, valid for up to 8 h. The UI cannot tell.
- **Root cause:** the fail-closed rule ("unknown → neither end nor pass") was applied to the one request that only reduces privilege.
- **Failing test (`dev.wakeline.config`, moves to `ops` in step 3):**
  ```java
  @Test void logoutStillReachesTheControllerWhenTheCredentialLookupFails() throws Exception {
      Instant now = Instant.parse("2026-10-01T00:00:00Z");
      OpsSessionLifetimeFilter f = new OpsSessionLifetimeFilter(Duration.ofHours(8), Clock.fixed(now, ZoneOffset.UTC),
              uid -> { throw new IllegalStateException("db down"); });
      MockHttpSession s = new MockHttpSession();
      s.setAttribute(OpsSessionLifetimeFilter.AUTH_AT, now.minusSeconds(300).toEpochMilli());
      s.setAttribute(OpsSessionLifetimeFilter.USER_ID, 7);
      s.setAttribute(OpsSessionLifetimeFilter.CREDENTIAL, "tag");
      MockHttpServletRequest req = new MockHttpServletRequest("DELETE", "/api/v1/ops/session");
      req.setSession(s);
      MockHttpServletResponse res = new MockHttpServletResponse();
      MockFilterChain chain = new MockFilterChain();
      f.doFilter(req, res, chain);
      assertThat(res.getStatus()).isNotEqualTo(503);           // fails: 503
      assertThat(chain.getRequest()).isNotNull();             // the controller invalidates the session
  }
  ```
- **Fix:** skip the credential comparison (keep the max-age check) when the request is `DELETE` on the session path. For example, `ApiPaths`-style matching on the decoded path `/api/v1/ops/session`. Logout cannot raise privilege, so no check is needed.

### B5. LOW: Jackson 3 coercion throws in validated paths (one class of bug, five sites)

- **Root cause (shared):** `asInt()`, `asLong()` and `intValue()` throw `JsonNodeException` in Jackson 3 when the value is non-numeric or out of range. Guards such as `isIntegralNumber()` do not check range.
- **a) `rest/KrRadarFrames.java:43`, Confirmed.** `fr.put("echo_cells", f.path("echo_cells").asInt());` turns a non-numeric `echo_cells` in the collector hash into 500 on `/api/v1/radar/kr`.
  - This is a gap in R-72. The class doc at `:15` promises that collector values never cause a 500, and every other field there goes through `count(...)`.
  - The REST contract requires `echo_cells` (an integer ≥ 0) in each frame (`tools/rest_contract_check.py:100,105`). So the fix is to drop the frame on an *invalid* value and count the field, as for an invalid `tm`. A *missing* value keeps today's output, 0 (from `MissingNode.asInt()`):
    ```java
    JsonNode ec = f.path("echo_cells");
    if (!ec.isMissingNode() && !(ec.isIntegralNumber() && ec.canConvertToInt() && ec.intValue() >= 0)) { parseError.accept("echo_cells"); return null; }
    fr.put("echo_cells", ec.asInt(0));
    ```
  - Failing test (`dev.wakeline.rest`): `assertThatCode(() -> KrRadarFrames.frame(J.readTree("{\"tm\":\"202609291440\",\"obs_tm\":\"202609291440\",\"fetched_at\":\"2026-09-29T05:41:00Z\",\"echo_cells\":\"n/a\"}"), f -> {})).doesNotThrowAnyException();` fails with `'StringNode' asInt()`.
- **b) `ops/SettingsService.java:200`, Confirmed.** In `intRange`, `v.asInt()` on a `LongNode` such as 4294967306 throws, so an authenticated `PUT` gets 500 instead of 400 `BAD_VALUE`.
  - Fix: `if (!v.isIntegralNumber() || !v.canConvertToInt() || v.intValue() < min || v.intValue() > max) throw Problem.badRequest(...)`.
  - The test calls `SettingsService.validate("region_poll_s", J.readTree("4294967306"))` and expects `Problem`.
- **c) `rest/TrafficGridReader.java:155`** (`n.path("v").intValue()` after `isIntegralNumber()`) and **`demand/CollectorDemandStatus.java:37`** (`iv.asLong()` on a `BigIntegerNode`). Both need a collector-written value larger than long or int. Contrived; fix in the same commit with `canConvertToInt()` / `canConvertToLong()`.
- `ingest/Codec.java:48` (`integer()` → `asInt()`) runs after JSON-schema validation of the payload. Safe as long as the schemas keep range limits on those integer fields; a table test would pin that.
- **Characterization:** add one table test per site above, covering string, double, long and BigInteger values.

### B6. LOW (latent): retry classification differs between writers, and unknown exceptions block the track and ship queues forever. Confirmed (behaviour).

- **Where:** `persist/TrackWriter.java:457-466` (`isPermanent` is true only for SQLState 21/22/23/42), used by TrackWriter `:328-341` and ShipWriter `:306-321`. Compare `persist/OrderedWriter.java:163-168`: anything not transient is given up after 3 attempts.
- **Evidence:** a `RuntimeException` without an SQLState in its cause chain (a programming error in a write lambda, or a driver or translation exception without state) counts as transient in the track and ship writers. The same batch is retried at `backoffMax` forever:
  - the queue grows, then `dropped` rises for **new** rows;
  - receipts are held up to `MAX_MARKS`;
  - the only signal is a WARN on every retry.

  OrderedWriter treats the same exception as permanent (dropped after 3 attempts, receipt released).
- **Failing test (`dev.wakeline.persist`):** `FakeRepo.fail = new IllegalStateException("bug")`, then send one static and wait. Today the same batch gets 22 attempts in 3 s with 1 ms backoff (`expected ≤ PERMANENT_ATTEMPTS (3)`).
- **Fix:** one classifier, `platform.data.DbErrors`, with three outcomes:
  - transient (the SQLState and exception-type list from `OrderedWriter.isTransient`) → retry forever;
  - permanent (21/22/23/42) → drop after 3;
  - **unknown** → drop after 3 with ERROR, as OrderedWriter does today.

  This also removes `ShipWriter → TrackWriter.isPermanent`, an E10 edge.

### B7. LOW: the radar frame endpoint returns 404 on a Redis error and 500 on corrupt data. Static.

- **Where:** `rest/WeatherController.java:236-244`.
- **Evidence:**
  - `try { b64 = redis.opsForValue().get(...) } catch (RuntimeException e) { b64 = null; }`, then `Problem.notFound`. Contract §2, as quoted in `config/Problem.java`, says a temporarily unavailable DB or Redis answers 503 with `Retry-After: 10`. `ProblemAdvice` already maps `DataAccessResourceFailureException`, which `RedisConnectionFailureException` extends, to exactly that.
  - `Base64.getDecoder().decode(b64)` throws `IllegalArgumentException` on a corrupt value, which becomes 500. That contradicts R-72.
- **Owner decision:** `framesExist` (`:220-234`) deliberately treats a Redis error as "missing". If 404 is wanted for image tiles, document it in the contract. Otherwise remove the catch and let `ProblemAdvice` answer 503.
- **Fix:** let the Redis exception propagate. Catch the decode error, count `wakeline_radar_kr_parse_errors_total{field="frame_png"}` and return 404.
  - The phase 3 `KrRadarReader` removes the Redis access from the controller (guard rule `controller-data-access`).
- **Test:** a MockMvc or unit test with a `StringRedisTemplate` stub that throws `RedisConnectionFailureException` expects 503. A stub that returns `"%%%"` expects 404, not 500.

### B8. LOW, needs confirmation: concurrent `aggregateDay` for the same day fails with 23505

- **Where:** `persist/MaintenanceJobs.java:330-356`. The callers:
  - `aggregateDaily` cron 03:30 KST, `:302-304`;
  - `catchUp`, every 3 h from start + 60 s, `:191-201`;
  - `POST /api/v1/ops/stats/aggregate`, `ops/OpsController.java:69-79`.

  The scheduler has 16 threads (`config/SchedulingConfig.java:21`), so the cron and the catch-up can overlap. The manual call can overlap with either.
- **Reasoning (PostgreSQL READ COMMITTED):**
  1. Both transactions `DELETE` the day's rows; neither sees the other's uncommitted inserts.
  2. Both `INSERT` the marker rows. The marker always conflicts on `PRIMARY KEY (day, metric, dim)` (`V1__init.sql:154-157`).
  3. The second transaction waits for the first to commit, then fails with 23505.

  Impact:
  - The manual call answers 500. `DuplicateKeyException` is not in `ProblemAdvice`'s 503 set, and the audit row is rolled back with it.
  - The scheduled run logs a WARN and is retried on the next catch-up. The data stays correct, because the first transaction wins.
- **Confirm with a DB test:** two threads call `aggregateDay(sameDay)`, held at the first INSERT by a `CyclicBarrier` around the `tx.execute` callback (or by `pg_sleep` in a test-only family). Expect one 23505 today.
- **Fix:** `SELECT pg_advisory_xact_lock(hashtext('stats_daily'), :day_epoch)` as the first statement in the transaction. That serializes per day and adds no structure. Alternatively, catch `DuplicateKeyException` in `aggregate()` and treat it as "another run won".

### B9. MEDIUM (known, deferred), needs measurement: public REST reads can starve the writers of the shared pool

- **Where:** `application.yml:12-14` (Hikari: `maximum-pool-size 12`, `connection-timeout 5000`); `persist/Sql.java:29` (`publicRead`, 3 s statement limit). The WS lookups already use `ReadPool` (4 connections, `docs/VERIFICATION.md:362`).
- **Evidence:**
  - R-62 bounds how **long** a public read can hold a connection, but not **how many** can hold one. Requests run on unbounded virtual threads, and the edge limits each IP (10 r/s, burst 30), not the total.
  - When the DB slows down, 12 concurrent replay or track reads (3–4 statements each) can hold the whole pool. The track, ship and ordered writers then wait 5 s, get `SQLTransientConnectionException` (transient), and back off.
  - The queues (50k track rows, 100k ship rows, 50k ordered tasks) fill up and drop rows (`result=dropped`).
  - `change-contract-v5.md:371-373` acknowledges this ("공개 조회 전용 풀을 두는 것은 이 레인 밖") and defers it.
- **Confirm:** run k6 `perf/rest.js` with replay-heavy traffic (`/api/v1/replay` and `/api/v1/aircraft/{hex}/track`) at 30–50 VUs. At the same time:
  - (a) inject DB latency, for example `ALTER SYSTEM SET` a statement delay through a test-only `pg_sleep` wrapper, or pause PostgreSQL with `docker pause` on the isolated e2e stack only;
  - (b) watch `hikaricp_connections_pending{pool="HikariPool-1"}`, `hikaricp_connections_timeout_total`, `wakeline_track_rows_total{result="dropped"}`, `wakeline_persist_tasks_total{result="dropped"}` and the queue gauges.

  The risk is real if writer timeouts appear while reads are healthy.
- **Minimal fix (no new infrastructure), only if it is confirmed:** a `Semaphore(6)` around `Sql.publicRead` execution. It fails fast with 503 + `Retry-After`, the same as the statement timeout, and keeps 6 connections for writers. A second Hikari pool is the larger alternative; `ReadPool` already shows how to build one.

### B10. LOW: silent catch-alls

- **`config/RateLimiter.java:29-34`.** If Redis fails, the public limiter returns `{0, window}` (open) with no counter and no log. The fail-open is documented (the edge limit remains), but an outage of the API-level limit is invisible. Fix: count `wakeline_rate_limiter_errors_total{bucket}` and rate-limit a WARN.
- **`ops/OpsController.java:103`.** If Redis fails while reading `wakeline:events`, the result is an empty `switches` list, which looks the same as "no switches". The same controller marks Redis errors elsewhere (`:198`, `"error":"redis unavailable"`). Fix: add the same `error` field.
- **`ws/ShipFanout.java:220-226`.** `refreshSelected` swallows every `RuntimeException`. The swallow is needed so the fixed-delay timer is not cancelled, but it should log at DEBUG or count. Very low.

### Checked and dismissed (no finding)

- **Time zones.**
  - The Dockerfile pins `TZ=UTC` and `-Duser.timezone=UTC` (`Dockerfile:22,25`), and tests use `-Duser.timezone=UTC` (`build.gradle.kts:81`).
  - There are no `LocalDate.now()` / `LocalDateTime.now()` calls without an explicit zone (the only one is `MaintenanceJobs.today()`, which uses `DAY_ZONE`).
  - KST is explicit in cron zones and SQL (`AT TIME ZONE :zone`). JDBC binds use `OffsetDateTime` UTC (`Sql.ts`) or `Timestamp.from(Instant)` for `timestamptz`, both of which keep the instant whatever the JVM zone.
  - Partition names follow UTC days (`MaintenanceJobs.trackPartitionEnd`).
- **TrackWriter `seen_at` range.** The collector quarantines `seen_in_future` and stale positions (`apps/collector/wakeline_collector/quality.py:85-89`), so there is no partition-miss poison in practice.
- **`/sigmets` ETag.** The version changes on expiry within 30 s (REL-13) and `max-age=60`, so staleness is bounded by design.
- **`RateLimitFilter` hand-built JSON.** Not injectable; see §2.9.

---

## 4. Performance hot spots (measured locally; what to measure in production)

The numbers come from micro-benchmarks in the scratch copy (JDK 25, M-series Mac, median of repeated runs). They show the relative size of each cost, not production latency. Every change below should go in only with the before/after plan next to it. None of them is urgent: `docs/PERF.md` shows REST p95 ≤ 12 ms and engine p95 109 ms against a 300 ms budget.

| # | Hot spot | Where | Measured | How to measure before/after in prod |
|---|---|---|---|---|
| P1 | One 10k-aircraft **global** message takes 84 ms on the **single** consumer thread: envelope serialize 0.2, envelope validate 0.5, gunzip 3.0, **payload schema validation 48.6**, second parse (Jackson 3 `readTree`) 16.4, codec loop 12.5. Payload is 3.4 MB JSON (162 kB gzip+b64). Global arrives every 120 s (min 60 s, `collector config.py:45`). | `ingest/StreamConsumer.java:617-629`, `SchemaValidator` (networknt on Jackson 2 trees, so the payload is parsed twice) | 84 ms/msg, under 0.1 % CPU, but a head-of-line latency spike for region/hot/focus messages queued behind it | `wakeline_stream_process_seconds` has **no tags**, so its p95 hides one message per 120 s. Use `wakeline_stream_process_seconds_max` or temporarily add a bounded `kind`/`scope` tag. Correlate with the WS aircraft latency p99 (786 ms in PERF.md) via `make bench`. Options: (a) do nothing; (b) skip `validatePayload` for `scope=global` and rely on the codec plus per-record checks (trust-boundary decision, ADR-014); (c) a validator that accepts Jackson 3 trees (single parse, about −16 ms). |
| P2 | The engine runs a **full cycle** on every `SnapshotUpdated`, including hot and focus messages that change a handful of aircraft. Each run covers all merged aircraft, intersections, the 10-min prediction and the FSM. | `engine/EngineService.java:109-112` | 33.1 ms median (max 46.2) for 10k aircraft × 130 SIGMETs | `rate(wakeline_engine_cycle_seconds_count[5m]) × p50` = engine CPU per second. Compare with the number of focus leases (`wakeline_demand_leases`). If it is above about 5 % of one core, coalesce: run at most once per 1 s, or only for changed hexes plus the periodic 30 s full run. Verify with `EngineServiceTest`/`AlertStateMachineTest` and `wakeline_alerts_active` parity. |
| P3 | WS world-view fan-out per session: diff (10 % changed) plus fragment concat 0.73 ms; full snapshot 3.07 ms. Scales with sessions × aircraft. | `ws/WsHub` fan-out, `DiffCalculator`, `AircraftJsonCache` | 0.73 / 3.07 ms per session per tick (10k aircraft) | `wakeline_ws_fanout_seconds` p95 and count rate × `wakeline_ws_sessions`, run with `make bench` (k6 `ws.js`) at 50/100/200 sessions. Candidate change: share the encoded diff between sessions with the same zoom bucket and bbox cell. Only if fan-out CPU is above about 10 % of a core. |
| P4 | `AircraftJsonCache.get` increments a Micrometer counter **per aircraft per session per fan-out** (`hit.increment()`). | `ws/AircraftJsonCache.java:39-46` | about 10k increments per world fan-out per session (DoubleAdder, ~10–20 ns each) | Check with a JFR allocation/CPU profile during `make bench`. If visible, count once per fan-out (sum locally). |
| P5 | The ops log screens re-scan the whole log stream on every poll (list or groups). | `logs/LogReader` | 119 ms (list) / 139 ms (groups) for 4,200 entries | Time `/api/v1/ops/logs*` (Spring MVC `http_server_requests_seconds{uri=…}`) while the ops page is open. Candidate change: cache the decoded entries by stream last-id (`XINFO` / last id), so an unchanged stream costs 0. |
| P6 | Every region snapshot enqueues all aircraft. Unchanged `(hex, seen_at)` rows reach the DB, where `ON CONFLICT DO NOTHING` discards them; `writtenRows` counts attempted rows, not inserted ones. | `persist/TrackWriter.java:143-146, 434-450` | not measured | Compare `wakeline_track_rows_total{result="written"}` with `pg_stat_user_tables.n_tup_ins` summed over `track_point_*`. If more than about 30 % are conflicts, skip rows whose `seen_at` equals the last enqueued per hex (same pattern as ShipWriter's `kept`). |
| P7 | SIGMET replay predicate `valid_from <= :t AND coalesce(withdrawn_at, valid_to) > :t` cannot use `sigmet_valid (valid_to, valid_from)`, and SIGMETs are kept forever (`MaintenanceJobs.java:27`). | `persist/SigmetRepository.java:205-212`, `V1__init.sql:66-67` | not measured (table is small today) | `EXPLAIN (ANALYZE, BUFFERS)` on a copy with 200k synthetic SIGMETs (extend `QueryPlanDbTest`). Fix: add `AND valid_to > :t`. It is implied, because `withdrawn_at` is set only while `valid_to > fetched` and cleared on re-upsert (`SigmetRepository.java:148-180`). |
| P8 | `StatusService.providerStatuses` makes about 11 sequential `HGETALL` calls (one per provider). | `rest/StatusService.java:196-205` | not measured (ops-only plus the 3 s cache) | Redis `SLOWLOG` / latency per call × 11. Pipeline them only if the ops page latency matters. |
| P9 | `ShipStore.apply` (60k live, 1k changed) 4.0 ms; `SnapshotStore.build` (11k) 0.8 ms | ingest stores | measured | Fine. Listed only so nobody optimizes them first. |

The micro-benchmark code (`ReviewScratchPerfTest`, `ReviewScratchEnginePerfTest`, `ReviewScratchFanoutPerfTest`, `ReviewScratchLogReaderPerfTest`) is in the scratch copy. Re-run it after a change with the same inputs: 10k-aircraft global fixture built from `TestData`, 130 SIGMETs, and 4,200 log entries.

---

## 5. Tests and build

### 5.1 How tests run

- **`make test-api`** (`Makefile:59-62`):
  1. `docker build -t wakeline-db:local infra/db`, because DB tests use the production DB image (R-63);
  2. `cd apps/api && ./gradlew test jacocoTestReport jacocoTestCoverageVerification`;
  3. `make contract-rest` (`tools/rest_contract_check.py` over `apps/api/build/rest-samples`, written by `RestSamplesIT`).
- **`make contract`**: `tools/contract_check.py`, which checks:
  - Python↔Java schema copies;
  - receipt `MAX_MARKS` read from `persist/{Ship,Track}Writer.java`;
  - WS samples;
  - plus `contract-rest` if samples exist.
- **`make ws-samples`**: `./gradlew test --tests 'dev.wakeline.ws.WsSchemaContractTest' -PupdateWsSamples`. It rewrites `apps/web/tests/fixtures/ws-samples.v1.json`; commit the file.
- **`./gradlew updateOpenApi`** (`build.gradle.kts:101-106`): rewrites `apps/api/openapi/openapi-v1.json` via `OpenApiSnapshotIT`.
- **Test JVM:** `-Duser.timezone=UTC -Dfile.encoding=UTF-8`, single fork (no `maxParallelForks`).
  - Testcontainers: PostGIS (`wakeline-db:local`) and `redis:8-alpine` with ACL users. `ItStack` boots the full app for `*IT`.
- **JaCoCo floors** (`build.gradle.kts:131-132`): LINE 0.95, BRANCH 0.80. Last recorded: 97.1 % / 86.3 %.
- **CI** (`.github/workflows/ci.yml`) runs the same targets.
- **Single test:** `cd apps/api && ./gradlew test --tests 'dev.wakeline.ws.WsHubTest'`.

### 5.2 Size and duration (from `apps/api/build/test-results/test`, last full run)

968 tests. Per-class times sum to 319 s, so the wall time is about 5–6 min including JVM and container start.

| package | tests | time | package | tests | time |
|---|---|---|---|---|---|
| it | 115 | 223.0 s | logs | 90 | 4.6 s |
| persist | 99 | 29.9 s | coverage | 51 | 4.4 s |
| (root) | 32 | 21.3 s | ingest | 88 | 3.2 s |
| ws | 149 | 17.2 s | engine | 70 | 2.4 s |
| ops | 57 | 8.7 s | rest | 71 | 1.8 s |
| config | 39 | 1.5 s | route / portcalls / demand / domain | 19 / 26 / 7 / 55 | 0.5 / 0.4 / 0.1 / 0.1 s |

Slowest classes: ShipsIT 34.2 s, DemandIT 30.7 s, LogsIT 23.3 s, SecurityIT 20.7 s, TrafficGridIT 20.1 s, PortCallsIT 15.7 s, IngestIT 14.8 s, MigrationDbTest 13.3 s.

For quick iteration during the moves, run everything except `it.*` (about 95 s of test time), then the full suite before each commit.

### 5.3 Which tests protect each refactor step

| Step | Tests that must stay green (beyond compile) |
|---|---|
| 0.1 guard | ArchitectureTest, OpsPackageDependencyTest |
| 1 marker | PipelineEventMulticasterTest, new marker and wiring tests (§5.4), IngestIT, WsIT, StreamTrimLossIT |
| 2 platform + geo | config tests (ProblemAdviceTest, ProblemJsonTest, RequestIdFilterTest, RedisConfigTest, JacksonVersionTest, TomcatVersionTest), OrderedWriterTest, ReceiptBatchQueueTest, SqlTest, ReadPoolTest, ReadPoolDbTest, LogMaskerTest, EtagsTest, BboxTest, BboxValidationIT, DbTimeoutsIT, CacheMetricsIT, SchedulingIT, `route-pending.test.ts` |
| 3 security / WS wiring | SecurityIT, SecurityCookieConfigTest, SessionSerializationConfigTest, OpsSessionLifetimeFilterTest, OpsSessionControllerTest, WsIT, WsIntegrationTest, OriginAllowListTest, RateAndLimitTest |
| 4 settings | RegionSettingsTest, OpsDbTest, MigrationDbTest (settings seeds), DemandIT (region changes) |
| 5 status | StatusServiceTest, KrRadarFramesTest, KrRadarMissingTest, RadarKrIT, RestSamplesIT and `make contract-rest` (`/status`), WsSchemaContractTest (status message), OpenApiSnapshotIT, `statusbar.test.ts` |
| 6 encoders | WsMessagesTest, WsSchemaContractTest (ws-samples byte-identical), AircraftControllerTest, ShipControllerTest, RestSamplesIT and `contract-rest`, ShipsIT, AircraftTrackIT, ReplayIT |
| 7 aircraft | SnapshotStoreTest, StreamConsumerTest, IngestHealthTest, PersistDbTest/PersistUnitTest (track parts), AircraftTrackIT, ReplayIT, IngestIT, StreamTrimLossIT, CursorPagesIT, `contract_check.py` |
| 8 weather | AlertStateMachineTest, IntersectionEngineTest, EngineServiceTest, DeadReckoningTest, AlertIdsTest, PersistDbTest/PersistUnitTest (SIGMET/alert parts), JobsAndRadarIT, StatsIT, ReplayIT, `test_aircraft_job.py` |
| 9 ships | ShipStoreTest, AisStatusTest, StreamConsumerShipsTest, ShipWriterTest, ShipPersistDbTest, StoredStaticReaderTest, ShipCoverageTest, ShipsIT, StoredStaticIT, StaticPartsIT, PortCallsIT, `ships-v5.test.ts`, `contract_check.py` |
| 10 leaf features | StatsAggregationDbTest, RetentionDbTest, QueryPlanDbTest, StatsIT, OpsStatsIT, TrafficGridReaderTest, TrafficGridIT, CoverageBootstrapDbTest, ShipCoverageIT, HotCellTest, DemandIT, `test_demand.py` |

### 5.4 Missing characterization tests (add before moving)

1. **Listener wiring and order.** With the full context (an `IntegrationTest` subclass), read the `ApplicationEventMulticaster`'s listeners for each pipeline event type. Assert the exact set of `Class#method` names per event and that `EngineService#onSnapshot` comes before `WsHub#onSnapshot`. This catches a listener lost through a moved class with the wrong `@Profile`, and a silent order change (§2.7.4).
2. **Marker coverage.** Every record nested in a `*Events` class implements `PipelineEvent` (step 1). Extend `PipelineEventMulticasterTest` with one ship event and one weather event: a throwing listener must not stop the next listener.
3. **Session allow-list.** `Class.forName` succeeds for each `dev.wakeline.*` entry of `SessionSerializationConfig.FILTER_PATTERN`. Better still, a golden serialized `OpsAuthentication` blob deserializes.
4. **Health endpoint states.** `/actuator/health/ingest` answers 200 `UNKNOWN` in the grace period, 503 `DOWN` after it with no snapshot, and 200 `UP` after a snapshot (B1).
5. **Status payload golden.** REST `/api/v1/status` and the WS `status` message carry the same map before and after step 5. `RestSamplesIT` and `WsSchemaContractTest` partly cover this; add an equality assertion.
6. **WS input robustness table.** For each client message type, send out-of-range or wrong-type numbers and strings (zoom, proto, bbox members, hex, layers). Assert a protocol error and never an exception (B2).
7. **Jackson coercion table** for the B5 sites.
8. **ShipWriter recovery** (B3) and **unknown-exception give-up** (B6) as in §3.
9. **`aggregateDay` concurrency** (B8, DB test).
10. **Logout during a DB outage** (B4).

---

## 6. Files

- **Report:** `/private/tmp/claude-501/-Users-jinyoung-Projects-wakeline/75437490-c65b-4783-9ac0-e224c92a9bab/scratchpad/review/api.md`
- **Scratch evidence** (not in the repo), under `/private/tmp/claude-501/-Users-jinyoung-Projects-wakeline/75437490-c65b-4783-9ac0-e224c92a9bab/scratchpad/review/`:
  - Graph scripts: `deps.py` (import graph), `pkgpriv.py` and `pp_main.py` (package-private access across moves), `target_flatops.py` and `phase1_flatops.py` (target and phase-1 acyclicity simulations).
  - `api-copy/apps/api/src/test/java/dev/wakeline/ArchitectureTest.java`: the guard above, green.
  - `api-copy/apps/api/src/test/java/dev/wakeline/**/ReviewScratch*Test.java`: the 7 failing repro tests and 4 micro-benchmarks.
