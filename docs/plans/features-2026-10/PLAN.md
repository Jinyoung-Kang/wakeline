# Wakeline 차별화 기능 설계 계획서 (2026-10)

- 기준 커밋: `main` `2562d9e3` — 문서 브랜치 `feat/features-plan-2026-10`
- 상태: **승인**(2026-10-09 — §9 의 결정 아홉 가지 모두 권장안). 단계마다 결과는 VERIFICATION 과 각 ADR 에 적는다. 무엇을 만드는지는 [SPEC.md](SPEC.md). 이 문서는 "어디를 어떻게 바꾸고, 어떤 순서로, 무엇으로 확인하나"와 **결정이 필요한 것**(§9)을 적는다.
- 아래의 파일 · 클래스 이름은 2026-10-09 코드 조사로 확인한 것이다. 새로 만들 이름은 제안이며 구현 때 바뀔 수 있다(바뀌면 이 문서를 고친다).

---

## 0. 한눈에 보기

| 단계 | 기능 | 브랜치(제안) | DB | 계약 | ADR | 크기 |
|---|---|---|---|---|---|---|
| 0 | 이 계획 승인 · 결정 §9 | (이 브랜치) | — | — | — | — |
| 1 | F1 공역 레이어 · F2 공역 진입 판정 | `feat/airspace-2026-10` | V18 · V19 | §G47 · §G48 | 034 · 035 | 대 |
| 2 | F3 기상특보 | `feat/wx-warnings-2026-10` | V20 | §G49 | 036 | 중 |
| 3 | F4 관심 대상 · 브라우저 알림 | `feat/watchlist-2026-10` | — | §G50 | 037(ADR-029 §5 개정) | 중 |
| 4 | F5 근거 공유 · F6 신뢰도 한 줄 | `feat/evidence-share-2026-10` | — | §G51 | — | 중 |
| 5 | F7 보존 연장 · F8 모바일 화면 | `feat/retention-mobile-2026-10` | V21 | §G52 | 038 | 중 |
| — | F9 선박 × 해상특보 구역 | 보류(구역 경계 자료가 생기면) | — | — | — | — |

- 단계마다 따로 병합한다. **main 병합 · 배포 · push 는 단계마다 먼저 묻는다.**
- 번호(V · §G · ADR)는 앞 단계가 쓰지 않으면 당겨 쓴다. `docs-contract-g11.test.ts` 와 README 의 'ADR N건'(`ReadmeFactsTest`)을 함께 고친다.

---

## 1. 작업 규칙(모든 단계)

- 커밋: 한 주제씩. **리팩터링(동작 불변)과 기능 · 수정은 다른 커밋.** 버그를 만나면 실패하는 시험을 먼저 쓰고 실패 글을 커밋 메시지에.
- 커밋마다 건드린 앱의 검사를 통과시킨다:
  - api: `./gradlew --offline test jacocoTestReport jacocoTestCoverageVerification`(LINE 95 · BRANCH 80) · `ArchitectureTest`(KNOWN 빈 채로).
  - collector: ruff · ruff format · mypy · pytest · `test_layering`(ALLOWED 빈 채로) — 새 모듈은 층 · 기능을 정한다.
  - web: eslint · tsc · vitest · `npm run build` · `check:first-js --in-image`. **첫 화면 JS 바이트 변화를 커밋 메시지에.**
  - 계약을 건드리면 `make contract` · `make ws-samples` · OpenAPI 스냅샷(`-PupdateOpenApi`) · `make contract-rest`.
- 단계 끝: `make test` · `make e2e` · `make security` · (DB · Redis 를 건드렸으면) `make infra-docker-test`. 그 전에 운영 이미지를 `:mainsafe` 로 태그하고 끝나면 되돌린다
  (zsh 에서는 `${s}:mainsafe` 처럼 감싼다).
- 기록: 결정은 ADR, 공개 API · 메시지 변경은 계약 v5 §G, 겪은 문제 · 확인은 VERIFICATION `## #118`~, 성능 전후는 PERF 새 절(§16~)과 재현 명령.
- Next.js 코드를 쓰기 전에 `apps/web/node_modules/next/dist/docs/` 의 해당 절을 읽는다(새 경로 `/alerts/[id]` · `/m` · `useSearchParams`).
- 새 의존성은 **넣지 않는 것이 목표**다(XML · zip · HTML 표는 Python 표준 라이브러리, 도형 검사는 PostGIS, 지도는 MapLibre). 필요해지면 이유를 먼저 말하고 묻는다.

---

## 2. 설계 — 기능별

### 2.1 F1 공역 자료 · 레이어

```
운영자 PC 의 KMZ ──stdin──▶ collector 컨테이너: tools.airspace_import ──▶ PostGIS airspace_edition · airspace (V18)
                                                                          │ (60 s 마다 '켜진 차수' 확인)
                                                         api airspace.data.AirspaceRefresher ──▶ airspace.core.AirspaceStore(불변 스냅샷)
                                                                          ├─▶ GET /api/v1/airspace (표시용 GeoJSON, ETag = 차수)
                                                                          └─▶ 판정 엔진의 구역 공급원(F2)
```

**가져오기(collector, 1회성 명령)**
- `make airspace-import f=<경로> edition="AIP 25년 5차"` → `$(COMPOSE) exec -T collector python -m wakeline_collector.tools.airspace_import --edition … < <경로>`.
  파일은 표준 입력으로만 들어간다(컨테이너는 읽기 전용 루트 · 볼륨을 더 열지 않음). 같은 SHA-256 이면 "이미 있는 차수" 로 끝난다.
- 모듈(ADR-030 층):
  - `tools/airspace_import.py`(entry) — 인자 · 표준 입력 · 보고 출력.
  - `airspace.py`(rules, 새 기능 `airspace`) — KMZ(zip)에서 `.kml` 멤버 하나만 이름으로 읽기(디스크에 풀지 않음) · 압축 해제 크기 상한 · 설명 HTML 표 읽기
    (`html.parser`) · 고도 정규화 · 종류 코드 표. 입력은 bytes, 출력은 레코드 목록과 건너뛴 목록.
  - `xml_intake.py`(rules, 공용) — `marine_grid` 의 강화 XML 읽기(크기 상한 · 엄격 UTF-8 · DOCTYPE 거부)를 **동작 불변 리팩터링 커밋으로** 공용 모듈로 옮긴다
    (ADR-030: 규칙 모듈은 다른 기능의 규칙을 import 하지 않는다). KML 의 `xsi` 접두사 선언 누락은 여기서 고치지 않고 `airspace.py` 가 보정한다.
  - DB 쓰기는 기존 `db.py` 의 `_GuardedPool`(VERIFICATION #111) — 한 트랜잭션: 차수 행 → 도형 행(COPY 또는 묶음 INSERT) → `ST_MakeValid` · `ST_IsValid` 검사 →
    새 차수 `active = true`, 옛 차수 `false`.
- 고도 정규화(SPEC F2-2):

  | 원본 `_UOM` · `_Code` | 저장 `*_ft` | `*_basis` |
  |---|---|---|
  | FT + ALT/MSL | 값 그대로 | `MSL` |
  | FL | 값 × 100 | `FL` |
  | FT/M + HEI/AGL(Height) | 값(ft 로) | `AGL` — 판정에 쓰지 않음 |
  | GND · SFC | 0 | `SFC` |
  | UNL · UNLTD · Unlimited | NULL | `UNL` |
  | 그 밖 · 빈 값 | NULL | `UNKNOWN` — 판정에 쓰지 않음, 보고에 수를 적음 |

**DB — V18** (collector 가 쓰고 api 가 읽는다 — V14 · V15 와 같은 방식, V9 이후 기본 권한이 없으므로 GRANT 를 적는다)
```sql
CREATE TABLE airspace_edition (
  id bigserial PRIMARY KEY, label text NOT NULL, source_sha256 char(64) NOT NULL UNIQUE, source_name text,
  imported_at timestamptz NOT NULL DEFAULT now(), active boolean NOT NULL DEFAULT false, counts jsonb NOT NULL);
CREATE UNIQUE INDEX airspace_edition_one_active ON airspace_edition ((true)) WHERE active;
CREATE TABLE airspace (
  id bigserial PRIMARY KEY, edition_id bigint NOT NULL REFERENCES airspace_edition(id),
  type_code text NOT NULL, type_ko text NOT NULL, ident text, name text NOT NULL, class_code text, remarks text,
  lower_ft int, lower_basis text NOT NULL, lower_raw text NOT NULL, upper_ft int, upper_basis text NOT NULL, upper_raw text NOT NULL,
  geom geometry(Geometry, 4326) NOT NULL, geom_display geometry(Geometry, 4326) NOT NULL,
  CHECK (lower_basis IN ('MSL','FL','AGL','SFC','UNL','UNKNOWN')), CHECK (upper_basis IN ('MSL','FL','AGL','SFC','UNL','UNKNOWN')));
CREATE INDEX airspace_edition_idx ON airspace (edition_id);
GRANT SELECT, INSERT, UPDATE ON airspace_edition TO wakeline_collector;  GRANT SELECT, INSERT ON airspace TO wakeline_collector;
GRANT USAGE ON SEQUENCE airspace_edition_id_seq, airspace_id_seq TO wakeline_collector;
GRANT SELECT ON airspace_edition, airspace TO wakeline_api;
```
- 옛 차수는 지우지 않는다(옛 알림이 `airspace.id` 를 가리킨다 — V19). 크기는 차수당 수 MB 라 지울 까닭이 적다. 지우기가 필요해지면 따로 묻는다.
- `geom_display` = `ST_SimplifyPreserveTopology(geom, 0.0005)`(약 50 m) — 표시 전용. 판정은 `geom`.

**api** — 새 기능 패키지 `airspace`(ADR-028 의 core / data / web)
- `airspace.core`: `AirspaceRecord`(불변) · `AirspaceStore`(차수 하나의 불변 스냅샷 교체 — JDBC · 서블릿 없음).
- `airspace.data`: `AirspaceRepository`(WKB 읽기) · `AirspaceRefresher`(60 s 마다 `SELECT id FROM airspace_edition WHERE active` — 바뀌면 다시 읽어 교체 · 이벤트 발행).
- `airspace.web`: `AirspaceController` — `GET /api/v1/airspace`(GeoJSON FeatureCollection, 속성: id · type · ident · name · 하한 · 상한(값 · 기준 · 원문) · edition,
  `ETag` = 차수 id + SHA 앞 12자, `Cache-Control: public, max-age=300`). 자료가 없으면 200 + 빈 목록 + `edition: null`(SPEC F1-4 의 '자료 없음' 표시).
- 응답 크기: 다각형 383 + 항공로 314 의 표시용 좌표 — **재서** 압축 후 400 KB 를 넘으면 `?types=` 로 나눈다(기본: 금지 · 원전 · 제한 · 위험만).

**web**
- 지연 레이어 `components/map/AirspaceLayer.tsx`(ReceptionLayer 와 같은 틀) + 작은 모듈 `lib/airspace-meta.ts`(종류별 색 · 선 모양 · 기본 켜짐).
- 레이어 열쇠 `airspace`: `lib/ui-store.ts`(Layers) · `lib/prefs.ts`(`LAYER_KEYS`) · `LayerPanel.tsx`(ITEMS) · `MapLegend.tsx`(종류 하위 필터 — 새 저장 열쇠 `wakeline.airspaceTypes`) ·
  `useMapLifecycle.ts`(보임 표) · `lib/map-pointer.ts`(`PICK_LAYERS` — 툴팁). 출처: `AttributionFooter.tsx` · `/about` 의 '출처·한계'.
- 첫 화면에는 레이어 단추 · 범례 이름만. 그리기 코드 · 툴팁 형식은 지연 조각(`DashboardParts.tsx` `lazyPart`, `tests/first-screen-lazy.test.ts` 목록 갱신).

**fixture**(저장소에 커밋 — 가짜 자료)
- `apps/collector/tests/fixtures/airspace/synthetic.kml`: 실제 KML 과 같은 구조(설명 HTML 표 · 속성 열쇠 · `xsi` 선언 누락까지)를 가진 **가짜 이름 · 가짜 좌표**
  (예: "시험 금지구역 A", 동해 바다 위 사각형). 종류마다 하나 이상, 고도 기준 표의 모든 줄을 덮는다.
- 격리 스택(`make e2e` · `make demo`)은 기동 뒤 이 파일을 가져온다 — E2E · 설명서 그림은 실제 AIP 도형을 쓰지 않는다(§7).

### 2.2 F2 판정 엔진 일반화 · 공역 판정

**1a. 동작 불변 리팩터링(먼저, 따로 커밋)** — `weather.core` 안에서 "SIGMET" 을 "구역(zone)" 으로 일반화한다.
- `Zone`(인터페이스): `ZoneKey key()`(`type` = `sigmet` | `airspace`, `id`) · 다각형들 · `bandContains(altFt)` · 유효 시간 · `level()`(`ALERT` | `INFO`) ·
  근거에 넣을 구역 필드. `SigmetRecord` 가 이것을 구현한다.
- `SigmetIndex.Item` → `Zone` 을 담는다. `IntersectionEngine.Hit` · `Prediction` · `AlertStateMachine.Key`(hex, ZoneKey) · `Alert`(zone 필드, SIGMET 필드는 SIGMET 일 때만).
- `ZoneSource`(인터페이스, `weather.core`): 구역 목록과 판(version). `EngineService` 가 여러 공급원의 구역으로 색인을 다시 짓는다 —
  SIGMET 은 지금처럼 `onSnapshot`, 공역은 `ZonesChanged` 이벤트(이 이벤트 타입도 `weather.core`). **`weather.core` 는 `airspace` 를 import 하지 않는다**
  (`airspace.core` 가 `weather.core` 의 인터페이스를 구현 — core → core 는 `ArchitectureTest` 가 허용, 순환 없음).
- 로그를 남기는 클래스(`EngineService` 등)의 **이름 · 패키지는 바꾸지 않는다** — 로그 지문에 로거 이름이 들어가 운영자의 '해결' 표시가 풀린다(ADR-028 §5-4).
  엔진을 중립 패키지(`zones`)로 옮기는 것은 이번에 하지 않는다.
- 확인: 기존 weather 시험 · `ListenerWiringIT` · REST · WS 표본(`make ws-samples` 결과 바이트 같음) · OpenAPI 스냅샷이 **바뀌지 않는다**. 엔진 측정 시험(§6)의 전 수치를 여기서 잰다.

**1d. 공역 판정**
- `airspace.core.AirspaceZones implements ZoneSource` — 켜진 차수에서 판정 대상만: 비행금지(P) · 원전 임시비행금지 → `ALERT`, 비행제한(R) → `INFO`.
  위험구역(D)과 그 밖은 엔진에 넣지 않는다(SPEC F2 표).
- 고도: 하한 · 상한이 `MSL` · `FL` · `SFC` · `UNL` 일 때만 고도를 비교하고, 한쪽이라도 `AGL` · `UNKNOWN` 이면 그 구역은 **판정 대상에서 뺀다**(보고에 수를 적음 —
  비행제한 85개 중 고도 기준이 없는 1개 등). 전이고도 14,000 ft 아래에서 한계와 500 ft 안이면 근거에 `altitude_uncertain: true`.
- 근거(evidence) 추가 필드: `zone_type` · `airspace`(id · type · ident · name · edition) · `band`(하한 · 상한 · 기준) · `assumptions`(기압고도 = 해면 고도, QNH 보정 없음).
- 차수가 바뀌면 열린 공역 알림을 닫는다: 새 닫힘 사유 `edition_replaced`(SIGMET 의 `sigmet_ended` 와 같은 길).
- **그림자 운전**(결정 D4): 새 설정 `airspace_alerts` = `off` | `shadow` | `on`(운영 설정 · 감사 기록). `shadow` 는 판정만 하고 저장 · 방송 없이
  `wakeline_zone_events_total{zone_type,level,event}` 만 센다 — 배포 뒤 24 h 수치로 비행제한의 '정보' 사건 양을 보고 `on` 을 정한다.

**DB — V19** (`alert_event` 를 구역 일반으로. SIGMET 경로의 INSERT · 자연키는 그대로)
```sql
ALTER TABLE alert_event ADD COLUMN zone_type text NOT NULL DEFAULT 'sigmet' CHECK (zone_type IN ('sigmet','airspace'));
ALTER TABLE alert_event ADD COLUMN level text NOT NULL DEFAULT 'alert' CHECK (level IN ('alert','info'));
ALTER TABLE alert_event ADD COLUMN airspace_id bigint REFERENCES airspace(id);
ALTER TABLE alert_event ALTER COLUMN sigmet_id DROP NOT NULL;
ALTER TABLE alert_event ADD CONSTRAINT alert_event_zone_ck CHECK (
  (zone_type = 'sigmet' AND sigmet_id IS NOT NULL AND airspace_id IS NULL) OR (zone_type = 'airspace' AND airspace_id IS NOT NULL AND sigmet_id IS NULL));
CREATE UNIQUE INDEX alert_event_airspace_uk ON alert_event (hex, airspace_id, kind, entered_at) WHERE airspace_id IS NOT NULL;
-- close_reason CHECK 에 'edition_replaced' 추가(V4 와 같은 방식: DROP 후 ADD)
```
- `AlertRepository`: 공역 알림은 `ON CONFLICT (hex, airspace_id, kind, entered_at) WHERE airspace_id IS NOT NULL DO NOTHING`, id 로 찾는 UPDATE 의 자연키 맞춤도 구역별로.
- 보존 · 통계(`MaintenanceJobs` 의 30 일 삭제 · `alerts_by_kind`)는 그대로 — 통계에 `zone_type` 을 더할지는 구현 때(계약 §G 에 적음).
- 확인할 것: api 역할이 `airspace` 에 SELECT 만 있어도 `alert_event` INSERT 의 FK 검사가 통과하는지(DB 시험으로).

**계약**(§G47 공역 레이어 REST, §G48 공역 알림)
- WS `schemas/ws/server.v1.json` `$defs/alert`(`additionalProperties: false` 유지): 선택 필드 `zone_type`(`sigmet` | `airspace`, 없으면 sigmet) · `level` ·
  `airspace`(객체). `if zone_type = airspace then required [airspace] else required [sigmet_id, fir_id, hazard]`. 옛 SIGMET 메시지는 그대로 유효.
- REST `/api/v1/alerts` · `/alerts/history`: 같은 모양 + 거르기 `zone_type=` · `level=`. 웹 `lib/ws.ts validateServerMessage` · `EvidenceCard`(공역 변형) ·
  `AlertPanel`(거르기: SIGMET / 공역, 알림 / 정보) · 항공기 카드 "들어 있는 공역"(api `AircraftController` 상세에 `inside_airspace` — 위험구역은 요청 때
  `AirspaceStore` 로 수평만 계산, 엔진 사건 아님).
- 배포 순서: web 이 새 필드를 받을 수 있게 된 뒤 api 가 보낸다. 공역 알림은 차수를 가져오고 `airspace_alerts` 를 켠 뒤에야 생기므로 순서 창이 없다.

### 2.3 F3 기상특보

```
API허브 wrn_now_data(5분) ─▶ collector jobs.kma_warning ─XADD─▶ wakeline:wxwarn (kind wx_warnings, 전체 교체)
                                                          ─▶ api StreamConsumer ─▶ weather.core.WarningStore ─▶ GET /api/v1/warnings
                                                                               └─▶ weather.data.WarningRepository(V20 이력)
```
- collector:
  - `providers/kma_warning.py`(adapter): `wrn_now_data.php` 호출 — 기존 API허브 호스트 버킷(0.5 req/s · burst 1, 레이더와 공유)과 `Throttled` 규칙을 그대로 탄다.
    키는 `KMA_APIHUB_KEY`(이미 있음), 로그 · 오류에는 가린 URL 만(`masking`). 응답은 UTF-8 먼저, 실패하면 EUC-KR(조사 때 확인).
  - `kma_warning_rules.py`(rules, 기능 `kma`): 머리 주석 건너뛰기 · 열 10개(REG_UP · REG_UP_KO · REG_ID · REG_KO · TM_FC · TM_EF · WRN · LVL · CMD · ED_TM) ·
    KST → UTC · 예비특보 발효 시각 규칙(`hh:59` · `hh:58` → 시간 범위 글자로) · 모르는 모양의 줄은 버리고 센다. 종류 · 수준 · 명령 코드표는 응답 머리 주석의 정의대로.
  - `jobs/kma_warning.py`(jobs): 300 s 주기, 전체 목록을 `complete: true` 로 발행. 실패하면 발행하지 않는다(api 는 마지막 목록 + 나이를 보인다).
  - 연결: `publisher.STREAM_WXWARN` · `config.budget_kma_warning`(기본 400/일) · `build_limits` · `DEFAULT_STRICT` · `test_main` · fixture 공급자(데모 · E2E 용 특보 2건).
- 계약(§G49): `schemas/stream_envelope.v1.json` kind enum + `$defs/wx_warnings_payload` → Java 사본(바이트 같게) → `tools/contract_check.py`(`need_kind` · payload 검사) →
  Python 모델 → `tools/qa/stream_db_integrity.py` STREAMS.
- Redis ACL(`infra/redis/start.sh`): `COLLECTOR_KEYS` 에 `~wakeline:wxwarn`, api 읽기 쪽도. ACL 시험(`infra/tests`)에 쓰기 · 읽기 · 금지 확인 추가.
- api: `StreamConsumer`(STREAMS · parse/apply · 기동 때 마지막 엔트리로 복원 — SIGMET 과 같은 방식) · `SchemaValidator` · `weather.core.WarningStore` ·
  `weather.data.WarningRepository`(V20) · `weather.web` 에 `GET /api/v1/warnings`(지금, ETag) · `GET /api/v1/warnings/history?from&to&zone`(≤ 30 일) ·
  `StatusService.PROVIDERS` 에 `kma_warning` · `ListenerWiringIT`.
- **WS 메시지는 더하지 않는다**(결정 D6): 특보는 몇 분 단위로 바뀌므로 웹은 보이는 동안 60 s 주기 REST(`useVisibleInterval`).
- DB — V20: `wx_warning(id, zone_code, zone_name, parent_code, parent_name, wrn, lvl, cmd, issued_at, effective_at, effective_text, end_notice, preliminary,
  first_seen, last_seen, ended_at, raw_line, UNIQUE(zone_code, wrn, lvl, issued_at))` — 목록에서 사라지면 `ended_at`. 보존 90 일(`MaintenanceJobs`). api 가 쓴다.
- web: 지연 조각 `WarningPanel`(오른쪽 패널 탭 "특보" — 해상 먼저 · 육상 접음 · 오래됨 경고), `lib/endpoints/warnings.ts`, 선박 카드 한 줄(카드 전용 모듈).
- 운영: `/ops` 공급자 표에 자동으로 보인다(PROVIDERS). 키가 없으면 `no_key`.

### 2.4 F4 관심 대상 · 브라우저 알림

- api(§G50): `GET /api/v1/watch?aircraft=<hex,…>&ships=<mmsi,…>&airports=<icao,…>` — 합쳐 50개까지, 형식이 틀리면 400(문제 형식). 메모리에서만 답한다:
  항공기 마지막 위치 시각 · 열린 알림 id · 최근 15분 안에 닫힌 알림(id · 사유 — 엔진이 닫힌 알림을 15분 · 상한 수만큼 메모리에 둔다), 선박 마지막 위치 시각,
  공항 비행 등급(METAR). `Cache-Control: private, max-age=5`. 패키지: 작은 기능이라 평평하게 `watch`(ADR-028).
- web:
  - `lib/watch.ts`(React 없음): 목록(최대 50) · 저장소 읽기 검증(깨진 값은 버리고 알림) · 이전 답 ↔ 새 답 비교로 사건 만들기 · 사건 열쇠 · 10분 반복 억제.
  - `lib/notify.ts`: `Notification` 감싸기 — 허락 요청은 단추를 누를 때만, 지원하지 않으면 화면 배너만.
  - `components/watch/useWatch.ts`: 보이는 동안 30 s 주기(`useVisibleInterval`) + WS 알림(이미 모두 받음 — 지역 거르기 없음).
    **숨은 탭 예외**(결정 D5): 목록이 비지 않았고 `Notification.permission === "granted"` 일 때만 숨은 동안에도 30 s 에 한 번. 다른 주기 요청 · WS 는 지금처럼 멈춘다.
  - 카드의 "관심 대상" 단추는 카드 전용 모듈, 목록 탭 `WatchPanel` 은 지연 조각. 첫 화면에는 탭 이름만.
- ADR-037: ADR-029 §5-2('숨은 탭은 멈춤')의 예외 하나를 적는다(조건 · 요청 하나 · 주기 · 끄는 법). 예외가 이 하나뿐임을 시험으로 고정한다.

### 2.5 F5 근거 공유

- api(§G51): `GET /api/v1/alerts/{id}` — 메모리(열린 알림)에서 먼저, 없으면 `alert_event`(id 는 이미 DB 의 id 와 같다 — `AlertIds`). 응답에 그 구역의 사본
  (SIGMET 원문 · 유효 시간 / 공역 이름 · 고도대 · 차수)을 함께. 숫자가 아니면 400, 없으면 404.
- web:
  - `app/alerts/[id]/page.tsx`: 근거 카드 전체(EvidenceCard 재사용) · 그 시각 위치 표 · "그 시각 재생" 링크 · JSON 내려받기(`lib/copy.ts downloadText`).
  - 인쇄: `@media print`(흰 바탕 · 지도 대신 좌표 표 · A4 한 쪽). 서버 PDF 없음.
  - 재생 URL: `lib/replay-url.ts`(React 없음) — `at`(31 일 안 UTC) · `bbox`(넓이 상한) · `hex`(형식) 검증, 틀린 값은 버리고 안내. `app/replay/page.tsx` 가 읽는다
    (지금은 URL 값을 읽지 않는다 — 새 규칙).

### 2.6 F6 신뢰도 한 줄

- `lib/reliability.ts`(React 없음): 위치 나이 · 공급자 지연 · 최근 공백을 받아 구성 요소별 등급(정상 · 주의 · 경고 · 모름)과 글자. 합친 점수는 만들지 않는다.
- 쓰는 곳: 항공기 카드 · 선박 카드 · 근거 카드(모두 카드 전용 모듈 — 첫 화면 0 B). 공급자 지연은 이미 받는 상태 값, 공백은 항적을 불러온 경우에만(아니면 "모름").

### 2.7 F7 지정 대상 기록 보존 연장

- 설정 `retain_targets`(`SettingsService.KEYS` · `validate` — hex · MMSI 쉼표 목록 20개까지, If-Match · 감사 기록 그대로). `/ops` 설정 화면에 입력 칸.
- DB — V21: `retained_track(kind, target_id, minute, lat, lon, alt_ft, gs_kt, track_deg, sog_kn, cog_deg, PRIMARY KEY (kind, target_id, minute))` 월 파티션.
- `MaintenanceJobs`: 매시간 지정 대상의 지난 시간 점을 1분 첫 점으로 복사(`track_point` · `ship_position` 파티션을 지우기 전에), 365 일 지난 월 파티션 삭제.
- 항적 조회가 기존 보존 밖이면 이 표에서 읽고 응답에 `resolution: "1m_retained"`(계약 §G52).
- 크기 추정(재야 함): 대상 20개가 1년 내내 끊김 없이 보이면 20 × 525,600 ≈ 1,050만 행 — 행당 약 80 B 로 잡으면 약 0.8 GB/년 + 색인.

### 2.8 F8 모바일 화면 `/m`

- `app/m/page.tsx`: 지도 · MapLibre · WS 를 싣지 않는다. 알림 목록(REST 15 s, 보이는 동안) · 관심 대상(F4 의 `lib/watch.ts` 재사용) · 줄을 누르면 `/alerts/[id]`.
- 확인: 이 경로의 JS 에 MapLibre 조각이 없음을 시험으로(`first-screen-lazy` 와 같은 방식), 375 · 320 px Playwright, axe 위반 0.

---

## 3. 단계별 커밋 순서

### 단계 1 — 공역(`feat/airspace-2026-10`)
1. `refactor(collector): move the hardened XML intake into a shared rules module` — 동작 불변.
2. `test(collector)`: 합성 KML fixture + 가져오기 규칙 시험(실패 먼저) → `feat(collector): airspace KML parser and importer`.
3. `feat(db)`: V18 + 권한 시험(`infra-docker-test` 의 db 권한) + `make airspace-import` + README 실행 방법.
4. `feat(api)`: `airspace` 패키지 · `GET /api/v1/airspace` · OpenAPI · REST 계약(§G47).
5. `feat(web)`: 공역 레이어(지연) · 범례 · 툴팁 · 출처 — 첫 화면 바이트 기록.
6. `refactor(api)`: 엔진 구역 일반화(1a) — 동작 불변, 표본 · 스냅샷 바이트 같음, 엔진 측정 '전'.
7. `test(api)` → `feat(api)`: 공역 판정 · V19 · 그림자 모드 · WS/REST 계약(§G48) · `make ws-samples`.
8. `feat(web)`: 공역 근거 카드 · 알림 패널 거르기 · 항공기 카드 줄.
9. `docs`: ADR-034(공역 자료 — 가져오기 · 저작권 · 차수), ADR-035(판정 구역 일반화 · 고도 가정 · 알림 수준), README · VERIFICATION · PERF §16.
- 배포 뒤(물어본 뒤): 운영자가 KMZ 를 가져오고 → `airspace_alerts=shadow` 24 h → 수치 보고 → `on` 여부를 묻는다.

### 단계 2 — 기상특보(`feat/wx-warnings-2026-10`)
1. 스키마 · 계약 검사 · Python 모델(§G49) → 2. 파서 시험 → 파서 → 3. 공급자 · 작업 · 예산 · fixture → 4. Redis ACL + 시험 →
5. api 수신 · 저장소 · V20 · REST → 6. web 패널 · 선박 카드 줄 → 7. ADR-036 · README(환경 변수 표 · 공급자 표) · VERIFICATION.

### 단계 3 — 관심 대상(`feat/watchlist-2026-10`)
1. api `/api/v1/watch`(§G50) + 닫힌 알림 15분 메모리 → 2. `lib/watch.ts` · `lib/notify.ts` 시험 → 3. 단추 · 패널 · 훅 → 4. 숨은 탭 예외 + 고정 시험 →
5. E2E(가짜 Notification) → 6. ADR-037 · VERIFICATION.

### 단계 4 — 근거 공유 · 신뢰도(`feat/evidence-share-2026-10`)
1. api `/api/v1/alerts/{id}`(§G51) → 2. `/alerts/[id]` 화면 · 인쇄 · JSON → 3. 재생 URL → 4. 신뢰도 한 줄 → 5. VERIFICATION.

### 단계 5 — 보존 연장 · 모바일(`feat/retention-mobile-2026-10`)
1. 설정 키 · V21 · 복사 작업 · DB 시험(§G52) → 2. 항적 조회 연결 → 3. `/m` → 4. ADR-038 · README · VERIFICATION.

---

## 4. 문서 · 계약 · 번호

| 항목 | 지금 | 이번에 더함(제안) |
|---|---|---|
| ADR | 033 까지(33건) | 034 공역 자료 · 035 판정 구역 일반화 · 036 기상특보 · 037 관심 대상 · 숨은 탭 예외 · 038 보존 연장 → README 'ADR 38건' |
| Flyway | V1–V17 | V18 공역 · V19 알림 구역 일반화 · V20 특보 이력 · V21 지정 보존 → CLAUDE.md · README 의 범위 |
| 계약 v5 | §G46 까지 | §G47–§G52 — `docs-contract-g11.test.ts` 고정 범위 갱신 |
| README | — | 주요 기능 · 아키텍처 그림(특보 스트림) · 실행 방법(`make airspace-import`) · API 표 · 공급자 표 · 출처 |
| `.env.example` | `KMA_APIHUB_KEY` 있음 | 새 비밀값 없음. 예산을 환경 변수로 받는 방식이면 그 이름만 추가 |

---

## 5. 시험 계획

| 기능 | 단위 | 통합 · DB | 계약 | E2E(격리 8701) | 측정 |
|---|---|---|---|---|---|
| F1 | KML 규칙(종류 · 고도 표 전부 · 거부 경로 · zip 상한) | 가져오기 → V18 행 · 한 번에 바뀜 · 같은 SHA 재실행 · 권한 | REST 표본 · OpenAPI | 레이어 켜기 · 툴팁 · 자료 없음 표시 | 응답 크기 · 첫 화면 JS |
| F2 | 고도 비교 경계값 · 불확실 표시 · 수준 | 진입 · 이탈 · 예측 · 차수 교체 닫힘 · V19 제약 · 그림자 모드 | WS 표본(옛 SIGMET 바이트 같음) · REST | 합성 공역 진입 주입 → 근거 카드 | 엔진 1회 시간 전후 |
| F3 | 고정폭 파서 · 시각 규칙 · 인코딩 · 키 가림 | 수신 → 저장소 · 이력 · 끝남 · DLQ | 스트림 계약 · ACL | 특보 0 · N · 오래됨 · 꺼짐 | — |
| F4 | 사건 비교 · 열쇠 · 억제 · 저장소 실패 | `/watch` 검증 · 50개 상한 | REST 표본 | 가짜 Notification 한 번 · 숨은 탭 요청 수 | 첫 화면 JS |
| F5 | 재생 URL 검증 | `/alerts/{id}` 메모리 · DB · 404 | REST 표본 · OpenAPI | 링크 열기 · 인쇄 미리보기 | — |
| F6 | 등급 경계값 · 모름 | — | — | 카드 한 줄 | 첫 화면 0 B |
| F7 | 설정 검증 | 파티션 지운 뒤 남음 · 지정 해제 | 설정 · 항적 응답 | — | 복사 작업 시간 |
| F8 | — | — | — | 375 · 320 px · axe | 경로 JS(MapLibre 없음) |

- 실패 시험을 먼저 쓴 경우 **바꾼 코드를 되돌리면 실패하는지**도 한 번 확인한다(변이 확인).

---

## 6. 성능 예산 (같은 조건 전후로만 판단)

| 대상 | 지금 | 예산 | 재는 법 |
|---|---|---|---|
| 첫 화면 JS | 547,751 B / 550,000 B(여유 2,249 B) | 다섯 단계 합쳐 **+600 B 이하**. 넘으면 그 단계에서 멈추고 보고 | `check:first-js --in-image` |
| 엔진 1회(전세계 항공기 + 구역) | 1a 에서 잰다 | 공역 ~100개를 더해 p95 **+10 % 이하**. 넘으면 원인과 함께 보고 | 새 `@Tag("perf")` 시험(PERF §16) |
| `/api/v1/airspace` | — | 압축 후 400 KB 이하(넘으면 종류별로 나눔) | 격리 스택 `curl --compressed` |
| 특보 호출 | — | 하루 ≤ 300회, 레이더 호출 수 변화 0 | 상태 해시 · 예산 카운터 24 h |
| 숨은 탭 요청 | 0 | 조건을 만족할 때만 30 s 에 1건 | Playwright 요청 기록 |
| `retained_track` | — | 1년 ≤ 1 GB(추정 — 재서 바로잡음) | `pg_total_relation_size` |

---

## 7. 보안 · 이용 조건

- **AIP 자료는 저장소에 넣지 않는다**(저장소가 공개). 가져오기는 표준 입력으로만, KMZ 는 운영자의 PC 에. 인프라 정책 시험을 더한다:
  저장소의 `.kmz` · `.kml` 은 `apps/collector/tests/fixtures/airspace/synthetic*.kml` 만 허용.
- README · 설명서 · 포트폴리오 그림은 합성 공역(격리 스택)으로 찍는다. 운영 화면에는 출처 · 차수 · "비상업 · 최신 여부 확인 안 함"을 적는다.
- 가져오기 입력 방어: zip 멤버 이름 고정 · 디스크에 풀지 않음 · 압축 해제 상한 · DOCTYPE/외부 개체 거부 · 점 수 상한 · 좌표 범위 · 도형 유효성(PostGIS).
- 새 외부 호스트 없음(API허브는 이미 허용 목록). 키는 환경 변수만, 로그에는 가린 URL.
- `/api/v1/watch` 는 공개 자료만 돌려주지만 **요청 URL 에 관심 목록이 실린다** — edge 접근 기록(`docker logs wakeline-edge-1`)에 남는다. 로컬 1인 운영이라 받아들이고 ADR 에 적는다.
- 브라우저 알림은 외부 푸시 서비스를 쓰지 않는다(서비스 워커 · 푸시 구독 없음 — 탭이 열려 있을 때만).

---

## 8. 하지 않는 것

SPEC §0 '하지 않는 것'과 같다. 덧붙여 이번 계획에서 미루는 것: 공역 툴팁의 '안에 있는 항공기 수' · 엔진을 중립 패키지로 옮기기 · 특보 WS 메시지 ·
특보 구역 목록(`wrn_reg`) · 공역 차수 자동 확인(AIRAC 주기 알림) · 브라우저를 닫아도 오는 알림(웹 푸시).

---

## 9. 결정이 필요한 것 (권장안대로 진행하려면 계획 승인만으로 충분)

| # | 질문 | 권장안 | 이유 |
|---|---|---|---|
| D1 | AIP 공역 자료(국토교통부 저작물, 상업 이용 · 변경 제한)를 어떻게 다루나 | **저장소에 넣지 않고 운영자가 로컬에서 가져온다. 화면에 출처 · 차수, 공개 그림은 합성 자료** | 저장소가 공개라 커밋은 재배포다. 로컬 비상업 표시는 출처를 밝히면 조건 안으로 본다(법률 판단은 아님 — 필요하면 국토교통부에 문의) |
| D2 | 공역별 판정 수준 | **금지 · 원전 = 알림, 비행제한 = 정보, 위험구역 = 카드만, 그 밖 = 표시만** | 고도 기준이 해면 · FL 로 확실한 것만 알림. 위험구역은 상한이 지면 기준이라 수평만 보면 순항기가 모두 걸린다 |
| D3 | 기압고도 ↔ 해면 고도 차이 | **보정하지 않고 가정 · 경계 ±500 ft 불확실 표시** | METAR QNH 로 보정하면 '어느 공항의 값을 썼나'라는 새 가정이 생긴다. 먼저 단순한 쪽으로 사건 양을 보고 정한다 |
| D4 | 공역 알림을 언제 켜나 | **배포 뒤 24 h 그림자 운전(세기만) → 수치를 보고하고 묻는다** | 비행제한 86개가 만드는 '정보' 사건 양을 아직 모른다 |
| D5 | 숨은 탭에서 관심 대상 알림 | **관심 대상이 있고 알림을 허락했을 때만 30 s 에 한 요청(ADR-029 §5-2 의 유일한 예외)** | 숨은 탭에서 못 받으면 브라우저 알림의 의미가 없다. 조건 · 양을 최소로 묶는다 |
| D6 | 기상특보 전달 방식 · 보존 | **REST 60 s 주기(WS 메시지 없음) · 이력 90 일** | 몇 분 단위로 바뀌는 자료라 WS 계약을 늘릴 까닭이 작다 |
| D7 | 보존 연장 상한 | **20개 · 365 일 · 1분 해상도** | 최악 약 0.8 GB/년(추정). 원해상도는 크기가 수십 배 |
| D8 | 단계 순서 | **공역 → 특보 → 관심 대상 → 근거 공유 · 신뢰도 → 보존 · 모바일** | 판정(공역)이 알림(관심 대상)과 공유(근거)의 재료라 먼저. 단계마다 병합 · 배포를 따로 묻는다 |
| D9 | 보류 · 제외 확인 | **F9(선박 × 특보 구역)는 경계 자료가 생길 때까지 보류, 공항경보 실시간 · 이메일/웹훅은 제외** | 받쳐 줄 공개 자료 · 운영 조건이 없다 |

---

## 10. 위험과 대응

| 위험 | 대응 |
|---|---|
| AIP 차수가 낡는다(AIRAC 28일 주기) | 화면에 차수 · "최신 여부 확인 안 함". 차수 교체는 같은 명령 한 번, 옛 알림은 옛 차수를 그대로 가리킨다 |
| 비행제한 '정보' 사건이 너무 많다 | 그림자 운전 수치로 판단(D4). 필요하면 비행제한을 카드 전용으로 내린다 |
| 고도 기준 오차로 틀린 진입 · 이탈 | 근거에 가정 · 불확실 표시(D3), 알림 수준은 고도 기준이 확실한 구역만(D2) |
| API허브 504 · 지연 · 레이더와 버킷 다툼 | 실패하면 발행하지 않고 나이를 보임, 호출 예산 · 버킷 공유를 시험으로 고정 |
| 특보가 있는 응답 모양을 아직 못 봤다 | 열 정의로 만든 표본에서 시작, 모르는 줄은 버리고 셈 → 처음 발효 때 실제 응답으로 fixture 교체 · VERIFICATION 에 기록 |
| 엔진 일반화가 SIGMET 동작을 바꾼다 | 동작 불변 커밋을 따로, 표본 · 스냅샷 바이트 비교, 기존 시험 그대로 |
| 첫 화면 JS 여유(2,249 B)가 모자란다 | 새 코드는 지연 조각 · 카드 전용 모듈, 단계마다 바이트 기록, 예산을 넘으면 멈추고 보고 |
| 숨은 탭 예외가 넓어진다 | 예외 조건 · 요청 하나를 시험으로 고정(조건 밖 숨은 탭 요청 0건) |
| `make e2e` 가 운영 이미지 태그를 덮는다 | 단계마다 `:mainsafe` 태그 → 끝나면 되돌림(CLAUDE.md) |
