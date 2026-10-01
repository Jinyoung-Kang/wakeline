# ADR-028 api 패키지 경계: 기능 단위 패키지(core · data · web)와 platform · geo — 의존은 바깥 → 업무 규칙 한 방향, ArchitectureTest 가 지킨다

**상태** 채택 · 2026-10-01 · CTO 리뷰 2026-10 [PLAN](../review/cto-2026-10/PLAN.md) Phase 3A(승인된 계획 — 사용자 결정 §5-1 '옮긴 클래스의 로그 지문이 바뀌는 것은
받아들이고 적는다') · 근거 [api-review](../review/cto-2026-10/api-review.md) §1 · §2 · ADR-018(시스템 로그 — 지문) · ADR-024(해결 표시)

## 맥락
- 리뷰 기준(`e0e1eba`)의 api 패키지는 기술 단위였다: `config` · `domain` · `engine` · `ingest` · `persist` · `rest` · `ws` · `ops` · `logs` …(149개 클래스).
  `demand` 와 루트를 뺀 **12개 패키지가 하나의 순환**이었고, 그 안의 클래스 사이 import 가 141개였다.
- 방향이 틀린 의존이 순환을 닫았다(api-review §1.3, E1–E12). 예:
  - 값 타입 `domain.Bbox` 가 HTTP 오류형 `config.Problem`(400 · 422)을 던졌다.
  - 업무 규칙 `engine.EngineService` 가 스트림 어댑터 `ingest` 의 상태 저장소 · 이벤트에 기댔다.
  - REST 와 WS 가 서로의 JSON 인코더 · 3 s 상태 캐시를 빌려 썼다(`rest ↔ ws`). 상태 서비스가 `rest` 에 있어 `ops` · `ws` 가 `rest` 를 불렀다.
  - 저장 계층이 운영 서비스(`persist → ops.RegionSettings`)를, 인프라(`config`)가 기능(`ops` · `ws` · `logs`)을 알았다.
  - 컨트롤러 셋이 데이터에 직접 닿았다: `OpsController`(SQL · Redis), `OpsPipelineController` · `WeatherController`(Redis).
- 새 클래스를 '어디에 두나'의 규칙이 없어 아무 방향으로나 붙었고, 클래스를 옮기거나 나눌 때 무엇이 깨지는지(세션 직렬화 · 리스너 순서 · 다른 언어 시험이
  읽는 파일 경로) 미리 알 수 없었다.

## 결정
1. **기능 단위 패키지.** 업무 규칙을 공유하는 기능(항공기 · 선박 · 기상)은 셋으로 나누고, 작은 기능은 평평하게 둔다(163개 클래스 — 이 작업이 더한 것 포함).
   ```
   dev.wakeline
   ├─ WakelineApplication
   ├─ platform.config   AppProperties RedisConfig SchedulingConfig EventConfig PipelineEventMulticaster
   ├─ platform.web      ApiPaths ClientIp Problem ProblemAdvice ProblemJson ProblemErrorReportValve RateLimitFilter RateLimiter RequestIdFilter
   │                    Etags Meta BboxParam Params
   ├─ platform.data     Sql ReadPool OrderedWriter ReceiptBatchQueue DbErrors
   ├─ platform.support  SingleFlight Receipt LogMasker Times PipelineEvent
   ├─ geo               Bbox Geo GeoJson
   ├─ aircraft.core     AircraftState Snapshot SnapshotStore AircraftEvents
   ├─ aircraft.data     TrackWriter TrackRepository AircraftRepository
   ├─ aircraft.web      AircraftController AircraftJson
   ├─ ships.core        ShipState ShipStatic ShipCategory ShipQuery AisGap AisScope AisBboxes DestinationInfo DestinationParser UnlocodePorts
   │                    ShipStore ShipSweeper AisStatus ShipEvents
   ├─ ships.data        ShipRepository ShipWriter StoredStaticReader AisStatusReader
   ├─ ships.web         ShipController ShipJson
   ├─ weather.core      SigmetRecord Alert SigmetStore RadarStore EngineService IntersectionEngine AlertStateMachine SigmetIndex DeadReckoning
   │                    AlertIds PredictionAvailability EngineEvents WeatherEvents
   ├─ weather.data      SigmetRepository AlertRepository AirportRepository KrRadarFrames KrRadarMissing KrRadarReader
   ├─ weather.web       WeatherController SigmetGeoJson
   ├─ ingest            StreamConsumer SchemaValidator Codec ShipCodec StreamAckFinalizer StreamMetrics SingleInstanceGuard IngestHealthIndicator
   ├─ ws                WakelineWsHandler WsHub ShipFanout DemandService DiffCalculator AircraftJsonCache WsMessages WsSession SerialOutbox
   │                    ConnectionLimiter SlidingWindowLimiter OriginAllowList RouteLookups SelectionLookups ShipLookups ShipGrid WebSocketConfig
   ├─ ops               운영 컨트롤러 넷 · 감사 · 세션 · 공급자 스위치 · 해결 · 보안 배선(SecurityConfig · SessionSerializationConfig ·
   │                    OpsSessionLifetimeFilter · OpsOriginFilter) · OpsQueries · PipelineSignals · IngestRunRepository
   ├─ settings          RegionSettings SettingsService
   ├─ status            StatusService(3 s 공개 상태 캐시 포함) HealthController
   ├─ history           HistoryController(GET /status 포함) StatsRepository MaintenanceJobs
   ├─ traffic           TrafficGridController TrafficGridReader
   ├─ coverage          CoverageGrid CoverageSource IntIntMap JdbcCoverageSource ShipCoverage ShipCoverageController
   ├─ demand            CollectorDemandStatus DemandLeases DemandStats RedisDemandLeases HotCell
   ├─ route · portcalls · logs   그대로
   ```
   - `core` = 업무 규칙과 메모리 상태(판정 · 상태기계 · 스냅샷 · 저장소 아닌 store). `data` = DB · Redis 를 읽고 쓰는 곳. `web` = 컨트롤러와 응답 JSON.
   - 새 클래스를 둘 곳: 판단이면 그 기능의 `core`, DB · Redis 면 `data`, HTTP 면 `web`. 둘 이상의 기능이 쓰는 기반이면 `platform.*`(기능을 모르는 것만),
     좌표 값이면 `geo`. 작은 기능(아래 4)은 그 패키지 안에서 역할 이름(`*Controller` · `*Service` · `*Repository|Reader`)으로 나눈다.
2. **의존 규칙**(api-review §2.1):
   1. 패키지 순환이 없다(하위 패키지 단위까지).
   2. `platform.*` 는 `platform.*` 와 `geo` 만 import 한다 — 기반은 기능을 모른다.
   3. `geo` 는 `dev.wakeline` 의 아무것도 import 하지 않는다.
   4. `*.core` 는 `*.core` · `geo` · `platform.support` 만, JDBC · Redis · 서블릿 · spring-web · http · tomcat API 를 import 하지 않는다. `*.data` 는
      `*.core` · `geo` · `platform.{support,data,config}` 만, 웹 API 를 import 하지 않는다. `*.web` 은 `ws` 를 뺀 무엇이든.
   5. 작은 기능은 평평하게 둔다(아래 4).
   6. `ws` 는 끝이다 — `ws` 밖의 누구도 `ws` 를 import 하지 않는다. `ingest` 는 스트림 어댑터라 `ops`(파이프라인 신호) · `status`(수집 상태)만 읽는다.
   7. `@Controller` · `@RestController` 는 JDBC · Hikari · Redis API 를 import 하지 않는다 — 읽기는 `*Repository` · `*Reader` · `*Queries` 가 한다.
   8. `ops` 는 `logs` 를 import 하지 않는다(로그 조회가 해결 기록을 읽는 한 방향 — ADR-024).
   하위 패키지를 지나는 기능 사이 순환은 받아들인다: `aircraft.web` 은 한 기체의 알림(`weather.core`)을 쓰고 `weather.core` 는 `aircraft.core` 를 쓴다 —
   하위 패키지 단위 그래프에는 순환이 없다.
3. **가드: `ArchitectureTest`**(`apps/api/src/test/java/dev/wakeline/ArchitectureTest.java`, JUnit + JDK 만 — 새 의존성 없음).
   - `src/main/java` 의 소스를 읽어 import 와 코드 안의 완전한 이름(`new dev.wakeline.x.Y` · 문자열 속 클래스 이름 포함 — `SessionSerializationConfig`
     의 허용 목록은 진짜 의존이다)을 모으고, 위 규칙을 규칙 이름(`controller-data-access` · `core-imports-io` · `core-imports-outer` · `data-imports-outer` ·
     `data-imports-web` · `geo-imports` · `platform-imports-feature` · `only-ws-imports-ws` · `ops-imports-logs` · `ingest-is-an-adapter`)으로 검사한다.
     순환은 Tarjan 으로 강한 연결 요소를 찾아 그 안의 클래스 import 수로 센다.
   - 래칫: `KNOWN`(받아들인 위반)과 `MAX_CYCLE_EDGES`(순환 안 import 수)는 줄기만 한다 — 새 위반은 실패, 고친 위반이 `KNOWN` 에 남아 있어도 실패, 순환 수가
     상수보다 작아도 실패(상수를 낮추라고 알린다). 옮기는 커밋마다 낮췄다: 순환 import 141 → 0(Phase 1 끝), `KNOWN` 11 → 0(Phase 3 끝 — 지금 둘 다 0).
   - 변이 확인: 규칙마다 한 줄 import 를 넣으면 그 규칙이 이름으로 실패한다(10개 규칙 모두 · 순환 시험 포함 — 커밋 `492f018` 메시지).
   - 한계: 텍스트 검사다. 같은 패키지 안의 단순 이름 참조는 보지 않지만 규칙을 넘지 않는다. 주석 제거는 문자열 · 문자 · 텍스트 블록을 안다(`stripComments` — 최종 리뷰 전에는 정규식이라 `"/api/**"` 속 `/*` 부터 다음 주석 끝까지를 지워, 그 사이의 완전한 이름 참조를 놓쳤다. 오늘 코드에서 놓친 참조는 없었다).
   - 함께 지키는 시험: `OpsPackageDependencyTest`(ops → logs, import 줄만 — 그대로 둔다) · `PipelineEventTest`(아래 5-3) · `ListenerWiringIT`(아래 5-2) ·
     `SessionSerializationConfigTest`(아래 5-1) · infra `GitIgnoreScopeTest`(아래 5-7).
4. **평평하게 두는 것과 이유**(api-review §2.4):
   - `ops`(22개): `OpsAuthentication` · `OpsUserService$User` 가 Redis 세션에 Java 직렬화되고 `SessionSerializationConfig.FILTER_PATTERN` 에 이름이 있다 —
     옮기면 운영자가 모두 로그아웃되고 역직렬화가 실패한다. `ops.data` 로 나누면 `ResolutionRepository → Resolution` · `ResolutionService → data` 가 순환이 되고,
     `ops.web` 으로 나누면 시험이 쓰는 패키지 전용 생성자를 공개해야 한다. 밖에서 `ops` 를 부르는 것은 `logs`(해결)와 루트(CLI)뿐이다.
   - `settings` · `status` · `history` · `traffic` · `coverage` · `demand` · `route` · `portcalls`(2–6개): 하위 패키지는 import 소음만 늘린다. 규칙 7 이
     컨트롤러에서 JDBC · Redis 를 막는다.
   - `ws` 는 한 전송 패키지다 — 세션 · 우편함 · 제한기 · 조회 실행기(WsSession · SerialOutbox · *Lookups)를 모든 작업이 같이 쓴다.
   - `ingest` 는 한 어댑터 패키지다(코덱은 작은 둘). `logs` 는 `ops` 만 바라본다.
5. **옮길 때의 함정과 처리**(api-review §2.7 — 커밋마다 확인했다):
   1. **세션에 직렬화되는 클래스는 옮기지 않았다**(`OpsAuthentication` · `OpsUserService$User` — `ops` 에 그대로). `SessionSerializationConfigTest` 가
      허용 목록의 이름마다 `Class.forName` 과 저장된 직렬화 세션 하나(`ops-security-context.v1.b64`)의 역직렬화를 본다(커밋 `160e664`).
   2. **리스너 순서는 `@Order` 로 적었다**(`93a9607`): 같은 스냅샷에서 `EngineService#onSnapshot` 이 `WsHub#onSnapshot` 보다 먼저다 — WS 의 selected 가 싣는
      예측 가능 여부가 그 스냅샷의 엔진 주기 뒤 값이어야 한다. 예전에는 클래스 경로 스캔 순서(패키지 이름)에 기댔다. `ListenerWiringIT` 가 이벤트마다
      리스너 집합과 이 순서를 고정한다(`cc1ad5d`) — 옮기는 커밋마다 같았다.
   3. **리스너 격리는 `PipelineEvent` 표시로**(`4c8d5bb`): 멀티캐스터가 페이로드를 감싼 클래스 이름(`IngestEvents` · `EngineEvents`)으로 판단하던 것을
      표시 인터페이스로 바꾼 뒤 `IngestEvents` 를 `AircraftEvents` · `WeatherEvents` · `ShipEvents` 로 나눴다(record 는 그대로 옮김 — `IngestEvents` 는 없어졌다).
      `PipelineEventTest` 가 이름이 `*Events` 인 클래스의 모든 record 와 `dev.wakeline` 페이로드의 모든 `@EventListener` 가 표시를 갖는지 본다 — 새 이벤트 묶음이
      조용히 격리를 잃지 않는다. 지표 태그(event · listener)는 단순 이름이라 그대로다.
   4. **로그 지문이 바뀐 클래스**(사용자 결정 §5-1 — 받아들이고 적는다, 데이터는 바꾸지 않는다): 지문(`LogEvents.fingerprint`)에 로거 이름 = 클래스의 완전한
      이름이 들어가므로, 옮긴 클래스가 남기는 WARN · ERROR 는 새 묶음(fp)으로 보이고 그 묶음에 걸려 있던 운영자의 '해결'(ADR-024)은 맞지 않는다 — 같은 오류가
      다시 보이면 새 fp 에 다시 해결한다. 싱크는 WARN · ERROR 만 싣는다(DEBUG · INFO 만 남기는 클래스는 해당 없음).
      | 예전 로거 | 지금 로거 |
      |---|---|
      | `dev.wakeline.config.PipelineEventMulticaster` | `dev.wakeline.platform.config.PipelineEventMulticaster` |
      | `dev.wakeline.config.ProblemAdvice` | `dev.wakeline.platform.web.ProblemAdvice` |
      | `dev.wakeline.config.RateLimiter` | `dev.wakeline.platform.web.RateLimiter` |
      | `dev.wakeline.persist.OrderedWriter` | `dev.wakeline.platform.data.OrderedWriter` |
      | `dev.wakeline.config.SessionSerializationConfig` | `dev.wakeline.ops.SessionSerializationConfig` |
      | `dev.wakeline.ops.RegionSettings` | `dev.wakeline.settings.RegionSettings` |
      | `dev.wakeline.ops.SettingsService` | `dev.wakeline.settings.SettingsService` |
      | `dev.wakeline.persist.TrackWriter` | `dev.wakeline.aircraft.data.TrackWriter` |
      | `dev.wakeline.engine.EngineService` | `dev.wakeline.weather.core.EngineService` |
      | `dev.wakeline.persist.SigmetRepository` | `dev.wakeline.weather.data.SigmetRepository` |
      | `dev.wakeline.persist.ShipWriter` | `dev.wakeline.ships.data.ShipWriter` |
      | `dev.wakeline.persist.MaintenanceJobs` | `dev.wakeline.history.MaintenanceJobs` |
      | `dev.wakeline.ws.OriginAllowList`(허용 Origin 정리의 WARN 두 줄 — '비었다 · 기본 목록' · "'*' ignored") | `dev.wakeline.platform.config.AppProperties`(3e1a3c92 가 정리를 옮겼다 — 최종 리뷰가 찾은 빠진 줄) |

      DEBUG · INFO 만 남겨 지문과 무관한 옮긴 클래스: `AlertRepository` · `StatusService` · `SecurityConfig` · `WebSocketConfig` · `StoredStaticReader` ·
      `UnlocodePorts`, 그리고 AIS 상태 해시 읽기 실패의 DEBUG 한 줄(`AisStatus` → `AisStatusReader`). `SinkAppender.OWN_PACKAGE`(`dev.wakeline.logs.`)는
      `logs` 가 그대로라 맞다. 예약 작업의 MDC job 은 단순 이름(`MaintenanceJobs.dropOldPartitions` 등)이라 그대로다 — 5 s AIS 상태 읽기만
      `ShipSweeper.refreshStatus` → `AisStatusReader.refresh` 로 바뀌었다(DEBUG 뿐).
   5. **다른 언어 시험이 읽는 Java 파일 경로를 같은 커밋에서 고쳤다**: `apps/web/tests/route-pending.test.ts`(RedisConfig → `platform/config`),
      `apps/web/tests/statusbar.test.ts`(StatusService → `status`), `apps/web/tests/ships-v5.test.ts`(ShipCategory → `ships/core`),
      `apps/collector/tests/test_aircraft_job.py`(EngineService → `weather/core`), `tools/contract_check.py`(`JAVA_WRITERS` — TrackWriter → `aircraft/data`,
      ShipWriter → `ships/data` 의 `MAX_MARKS`). `apps/collector/tests/test_demand.py`(CollectorDemandStatus) · `WsSchemaContractTest` 의 이름(Makefile ·
      contract_check)은 옮기지 않아 그대로다.
   6. **계약은 바이트 그대로**: OpenAPI 태그는 컨트롤러의 단순 이름이라 패키지 이동으로 바뀌지 않는다 — 그래서 엔드포인트를 다른 컨트롤러로 옮기지 않았다
      (`GET /status` 는 `HistoryController` 에 남았다, 새 `StatusController` 를 만들면 태그가 바뀐다). `apps/api/openapi/openapi-v1.json` · `apps/web/tests/fixtures/ws-samples.v1.json`
      은 모든 이동 커밋에서 sha256 이 같았고(a25876c4… · c6d98cb7…), REST 표본(`RestSamplesIT` 37개)은 시계에서 나온 값(시험 SIGMET id · 순서)만 달랐다 ·
      `rest_contract_check` 통과. `@Profile("!cli & !migrate")` 는 클래스와 함께 옮겨졌다.
   7. **이름이 `data` 인 패키지는 `.gitignore` 의 `data/` 에 걸렸다**: `git mv` 로 옮긴 파일은 추적되지만 그 디렉터리에 새로 만든 파일은 `git status` 에도
      나오지 않아 커밋에서 빠졌다(`DbErrors` · `KrRadarReader` 등 다섯 — 작업 트리에는 있어 시험은 통과했다). `.gitignore` 에 Java 소스의 `data` 패키지 예외를 두고
      빠진 파일을 커밋했으며(`0bc57f2`), infra `GitIgnoreScopeTest` 가 '추적 중인 파일이 무시 규칙에 걸리지 않는다'를 지킨다.
6. **규칙 4 · 7 을 위해 읽기를 떼어 냈다**(동작 그대로 — 문장 · 키 · 오류의 뜻을 옮겼다):
   - `AisStatus` 는 스스로 Redis(`wakeline:ais:status`)를 읽어 `ships.core` 에 둘 수 없었다(리뷰의 목표 트리가 놓친 것 — core 에 Redis 금지). 읽기를
     `ships.data.AisStatusReader`(5 s 예약 작업 — 예전 `ShipSweeper.refreshStatus`)로 떼고 `AisStatus` 는 받은 해시를 검사 · 판단만 한다.
   - `ops.OpsQueries`: `OpsController` 의 SQL · Redis 읽기(전환 이벤트 · 예산 · 품질 · DLQ · 감사). Redis 오류는 던지고, 그것을 응답의 `error` 로 바꾸는 일은
     컨트롤러에 남았다. 컨트롤러가 만들던 `IngestRunRepository` 는 빈이 됐다.
   - `ops.PipelineSignals`: `OpsPipelineController` 의 수집기 · ais 해시 읽기(없거나 못 읽으면 빈 맵 → 모름).
   - `weather.data.KrRadarReader`: `WeatherController` 의 기상청 레이더 읽기. 목록 · 메타는 Redis 오류를 '모름'으로, 프레임 존재 확인은 '없음'으로,
     프레임 PNG 는 던져 `ProblemAdvice` 가 503 + Retry-After(리뷰 A3 · 사용자 결정 §5-6) — 없음 404 · 깨짐 404 + 카운터는 컨트롤러 그대로.

## 대안(하지 않은 것)
- **저장소 인터페이스 · 포트 계층**: 구현이 하나뿐인 인터페이스는 간접만 늘린다. 이미 있는 둘(`CoverageSource` · `DemandLeases`)은 시험에서 바꿔 끼우려고 있는 것이고,
  그것이 기준이다 — 새로 만들지 않았다. 업무 규칙(core)이 저장소를 부르지 않도록 의존 방향을 규칙으로 막는 것으로 충분하다(`ShipSweeper` 의 5 s 읽기처럼
  core 가 Redis 를 불러야 하던 곳은 포트 대신 그 읽기를 `data` 쪽 예약 작업으로 옮겼다).
- **`ws` · `ingest` · `ops` 를 기능별로 쪼개기**: 위 결정 4 의 이유. 특히 `ops` 는 세션 직렬화 때문에 옮기는 것 자체가 운영자 로그아웃이다.
- **ArchUnit 같은 라이브러리**: 같은 검사가 JDK 로 200줄이 안 되고 두 시험이 1 s 안이다. 의존성을 더하지 않았다(사용자 원칙).
- **Gradle 다중 모듈 · JPMS 모듈**: 경계를 컴파일러가 지키게 되지만 빌드 · 이미지 · 시험 배치가 바뀐다. 한 프로세스 · 한 배포의 앱에서 필요가 입증되지 않았다 —
  같은 규칙을 시험이 지킨다.
- **옛 로거 이름을 지키는 장치**(클래스마다 옛 이름으로 `LoggerFactory.getLogger("…")`): 다음에 옮길 때도 이름과 위치가 어긋난 채 남는다. 운영자가 다시 해결하면
  되는 일이라 값이 작다(사용자 결정 §5-1).
- **엔드포인트를 새 컨트롤러로(StatusController 등)**: OpenAPI 태그 · 계약이 바뀐다 — 패키지만 옮겼다.

## 결과
- 패키지 순환 import 141 → 0, 받아들인 위반 11 → 0. 컨트롤러는 JDBC · Redis 에 닿지 않는다. 기술 패키지 `config` · `domain` · `engine` · `persist` · `rest` 와
  `IngestEvents` 는 없어졌다.
- 동작 · 계약 변화 없음: 옮긴 커밋은 패키지 줄 · import · 한정자만 바꿨고(시험도 같다 — 나눈 시험은 메서드를 그대로 옮겼다), OpenAPI 스냅샷 · WS 표본은 바이트
  그대로, REST 표본은 같다. api 시험 수는 이동 내내 1,047 이었고 `KrRadarReaderTest` 3개를 더해 1,050 이다.
- 알려진 비용: 위 표의 로거 열세 개의 WARN · ERROR 묶음이 새 fp 로 보인다 — 운영자가 다시 해결한다(VERIFICATION · 최종 보고에 적는다).
- 새 코드의 규칙: 결정 1 의 '둘 곳'과 결정 2 의 규칙을 따르고, 어기면 `ArchitectureTest` 가 규칙 이름과 클래스로 알린다. `KNOWN` 에 더하는 것은 이유를 적은
  일시적 예외일 때만이고, 고치면 지운다(남아 있으면 시험이 실패한다).
- 되돌리기: 패키지 이동과 읽기 분리뿐이라 데이터 · 계약 · URL 과 무관하다(세션 직렬화 클래스는 옮기지 않았다).
