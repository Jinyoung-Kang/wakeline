# 기준선(BASELINE) — 리뷰 1단계

측정 대상: 커밋 `80716cb`(계약 v4 기능 반영 뒤) · 측정 시각 2026-09-28 05:4x–06:xx UTC · 이 기계(Apple Silicon, macOS 26.6, Docker Desktop 29.8) ·
개발 스택(127.0.0.1:8700, 실데이터 수집 중). 원자료: `perf/results/review-baseline/`(요약 `summary.tsv`), k6: `perf/results/k6-*-<시각>.log`.
측정 명령은 하나로 묶었다 — `bash perf/review_measure.sh <label>`(4단계에서 같은 명령으로 다시 잰다).

## 1. 구조 요약

### 컴포넌트
| 컴포넌트 | 기술 | 역할 | 외부로 나가는 연결 |
|---|---|---|---|
| edge | nginx 1.30(비root) | 단일 공개 포트 127.0.0.1:8700 · Host 허용 목록(421) · XFF 덮어쓰기 · IP당 요청·연결 제한 · 보안 헤더 | 없음 |
| web | Next.js 16 · React 19 · MapLibre GL 6 · zustand | 화면(상황판·재생·통계·공항·운영·출처). 브라우저는 우리 서버(REST·WS)와 지도·레이더 타일만 부른다 | 없음(서버 렌더 시 api 만) |
| api | Spring Boot 4.1 · Java 25(가상 스레드) · JTS · networknt 스키마 검증 | 스트림 소비·검증 → 불변 스냅샷 → 교차·예측 엔진 → WS 팬아웃 · REST · 운영 · 수요 임대 · 이력 저장 | 없음(ADR-006) |
| collector | Python 3.13 asyncio · httpx · pydantic · shapely | 항공기(관심 지역·전세계·핫 리전·집중 추적)·SIGMET·METAR·레이더 수집, 노선 조회(adsbdb), 예산·속도 상한, 품질 게이트 | adsb.lol · adsb.fi · OpenSky · AWC · RainViewer · 기상청 · adsbdb |
| ais | 같은 이미지 · websockets | aisstream WebSocket(구역마다 1연결, 현재 2) → 대기열 → ShipBook → 10 s 배치 스트림 | aisstream.io |
| redis | Redis 8(ACL 사용자 3) | Streams(항공기·기상·선박), 예산 Lua, 세션, 수요 임대, 노선 캐시, 상태 해시 | 없음 |
| db | PostgreSQL 18 + PostGIS 3.6 | 항적(일 파티션)·선박 위치(일 파티션)·SIGMET·알림·METAR·감사·설정·통계 | 없음 |
| migrate | Flyway(일회성) | V1–V8 적용 후 종료(DDL 비밀번호는 여기만) | 없음 |

### 요청 흐름 1 — 선택한 항공기의 노선 보기(계약 v4 §A)
1. 브라우저 → edge `/ws/v1` → api `WakelineWsHandler` `{type:"select", hex}`.
2. api `DemandService` 가 1 s 모아 Redis `wakeline:demand:focus`(ZSET, 60 s 임대) + `:meta`(hex → {sessions, first_at, callsign}) 를 쓴다.
3. collector `DemandTracker`(5 s 주기)가 임대를 읽어 adsb.fi `/v2/icao/{hex}` 로 위치를 받고, 메타의 콜사인을 `RouteLookup` 에 넘긴다.
4. `RouteLookup` 이 캐시(`wakeline:route:{CALLSIGN}`)에 없으면 속도 상한·예산을 거쳐 adsbdb `/v0/callsign/{CALLSIGN}` → 검증 → `SET EX 1800`.
5. api `RouteReader`(5 s 메모리 캐시)가 캐시를 읽어 `selected` 메시지와 REST `/api/v1/aircraft/{hex}` 에 `route` 로 싣는다 → 웹 카드.
   (실측: 선택 뒤 6.6 s 에 found — THA656 Suvarnabhumi → Incheon.)

### 요청 흐름 2 — 관심 지역 항공기와 위험기상 판정
collector 10 s 주기: 예산 예약(Lua) → adsb.lol/adsb.fi readsb v2 → 정규화·품질 게이트 → `XADD wakeline:aircraft` →
api `StreamConsumer`(XREADGROUP) → 스키마 검증 → 스냅샷 교체 → `EngineService`(STRtree 교차 + 10분 예측 + 히스테리시스 FSM) →
WS diff(구독 bbox 별) + 알림 → XACK → 항적 배치 저장(가상 스레드, 큐 상한). REST `/api/v1/aircraft?bbox` 는 스냅샷에서 바로.

### 데이터 흐름
외부 공급자 → collector/ais(유일한 외부 호출자) → Redis Streams(at-least-once, MAXLEN) → api(검증·메모리 상태) → WS/REST → 브라우저.
이력: api → PostgreSQL(비동기 배치, 파티션·보존). 상태·설정: api ↔ Redis 해시(설정 미러·수요 임대·상태), collector/ais 는 읽기(설정)·쓰기(상태·캐시).

### 외부 연동 지점
| 공급자 | 호출 주체 | 방식 | 한도·약관(문서 근거) |
|---|---|---|---|
| adsb.lol | collector | REST 10 s | ODbL, 429 시 백오프 |
| adsb.fi | collector | REST(관심 지역 대체·핫 리전 30 s·집중 5 s) | 비상업, 초당 1회 이하 → 0.8 req/s 버킷 |
| OpenSky | collector | REST 120 s(OAuth2) | 연구·비상업, 크레딧 |
| AviationWeather.gov | collector | REST | 분당 20회 자체 상한 |
| RainViewer · 기상청 API허브 | collector | 이미지/바이너리 | 개인·교육 / 활용신청 |
| aisstream.io | ais | WebSocket(키당 3연결 — 2 사용) | 재전송 없음 |
| adsbdb.com | collector | REST(선택 시만) | 노선 자료 복사·DB 편입 금지(ADR-016) — 30분 캐시만 |
| OpenFreeMap 타일 | 브라우저 | 타일 | OpenMapTiles/OSM 표기 |

## 2. 측정 결과

### 2.1 시험·커버리지
| 항목 | 도구 | 결과 |
|---|---|---|
| collector · ais | pytest + pytest-cov | 682 통과(5 건너뜀 — 실 Redis 필요 시험) · 줄 커버리지 96 % |
| api | JUnit 5 + Testcontainers(PostGIS·Redis 실물) + JaCoCo | 457 통과 · 실패 0 · LINE 95.7 % · BRANCH 83.1 %(빌드 하한 95 / 80) |
| web | Vitest + @vitest/coverage-v8(측정 때만 `--no-save` 설치) | 286 통과 · Lines 92.1 % · Branches 79.9 % |
| E2E | Playwright(격리 fixture 스택 8701) | 16 통과 |
| 계약 | tools/contract_check.py · rest_contract_check.py | 스키마 사본 일치 · REST 27/27 |

### 2.2 린트·정적 분석
| 항목 | 도구(선택 이유) | 결과 |
|---|---|---|
| Python | ruff(린트·포맷) · mypy(타입) — 저장소 CI 와 같은 설정 | 0 · 0 |
| TypeScript | eslint(next 설정) · tsc --noEmit | 0 오류 0 경고 · 0 |
| Java | 정적 분석 도구(SpotBugs·PMD·Error Prone)가 **구성돼 있지 않다**. 빌드를 바꾸지 않고 `javac -Xlint:all`(init 스크립트)로 경고만 셈 | 19(this-escape 12 · serial 3 · rawtypes 2 · unchecked 2) |
| 여러 언어 SAST | Semgrep 1.177.0(`p/owasp-top-ten` · java · python · typescript · nginx · dockerfile, `--metrics=off`) | 9건: Dependabot cooldown 없음 6 · nginx `$host` 사용 3 / 파싱 실패 6(셸 스크립트 4·gradlew·Python 3.13 문법 1 — 도구 한계) |

### 2.3 성능(개발 스택, api 층 직접 — `make bench SHIPS=1`, k6 2.3.0)
| 경로 | p50 | p95 | p99 | 최대 | 오류율 |
|---|---|---|---|---|---|
| REST `/aircraft?bbox` (100 rps 중 60 %) | 2.5 ms | 9.4 ms | 87.7 ms | 525 ms | 0 %(17,996건) |
| REST `/sigmets?active` (25 %) | 2.7 ms | 10.9 ms | 86.5 ms | 569 ms | 0 % |
| REST `/status` (15 %) | 2.6 ms | 13.7 ms | 130.0 ms | 647 ms | 0 % |
| WS 항공기 diff 200 연결(서버 ts → 수신) | 23 ms | 151 ms | 225 ms | 320 ms | 오류 0(메시지 20,516) |
| WS 선박 메시지 | 6 ms | 35 ms | — | 68 ms | 오류 0(4,320) |

- 목표(설계서 7.1 · PERF.md): REST p95 ≤ 300 ms, WS p95 ≤ 500 ms — 모두 충족. api 5xx: 기동 이후 0(Prometheus `http_server_requests`).
- 측정 조건: 관심 지역 항공기 약 250대, 전세계 약 10,000대, SIGMET 약 125, 선박 약 14,000척 추적(2구역 수신).

### 2.4 프론트엔드
| 항목 | 도구 | 결과 |
|---|---|---|
| 정적 JS+CSS | `next build` 산출물(.next/static) 크기 · gzip(6) 계산 | 1,992 KiB · gzip 553 KiB · 21 파일, 가장 큰 청크 gzip 272 KiB(MapLibre 로 보임) |
| Lighthouse 12(데스크톱 프리셋, headless Chromium · SwiftShader WebGL) | `/` | **성능 39** · 접근성 100 · 권장 96 · LCP 3.1 s · **TBT 2,165 ms** · **CLS 0.133** |
| | `/about` | 98 · 100 · 96 · LCP 0.5 s · TBT 0 · CLS 0 |
| | `/stats` | 99 · 100 · 96 · LCP 0.6 s · TBT 69 ms · CLS 0 |
| | `/ops` | 71 · 100 · 96 · LCP 0.6 s · TBT 660 ms · CLS 0 |

- 주의: 상황판(`/`)은 WebGL 지도라 headless 의 소프트웨어 렌더링(SwiftShader)이 TBT 를 키운다. 같은 조건으로 전·후를 비교하는 데는 쓸 수 있지만 실제 GPU 브라우저의 값은 아니다.
- 모바일 프리셋 Lighthouse 는 재지 않았다(데스크톱 전용 상황판) — 반응형은 5단계 UI 검토에서 캡처로 본다.

### 2.5 의존성 취약점·비밀값
| 항목 | 도구 | 결과 |
|---|---|---|
| web npm 의존성 | npm audit | 0 |
| collector 런타임 의존성(uv.lock, 해시 고정) | pip-audit 2.10.1 | 0 / 26 패키지 |
| api 이미지 | Trivy 0.74(이미지) | **CRITICAL 3**(tomcat-embed-core 11.0.24 — CVE-2026-65182 · 65905 · 68525, 11.0.25 에서 수정) · MEDIUM 36 · LOW 4 |
| web 이미지 | Trivy | HIGH 4 — 모두 **node 기본 이미지에 든 npm** 의 내부 패키지(brace-expansion · ip-address · tar). 실행에는 npm 이 필요 없다 |
| collector 이미지 | Trivy | HIGH 46 · MEDIUM 54 · LOW 57 — 44건은 Debian 기본 패키지(수정판 없음), 2건은 **python 기본 이미지의 pip 가 품은** msgpack 1.1.2 · setuptools 70.3.0(앱 가상환경에는 없음 — pip-audit 0 과 일치) |
| git 이력 전체 비밀값 | gitleaks 8.30.1 | 2건 — 둘 다 시험용 가짜 값(`test-ais-key-…` · 공개 예제 JWT) |
| 작업 트리 비밀값(.env 제외) | Trivy secret | 3건 — pytest 캐시·gitleaks 보고서 안의 같은 예제 JWT(측정 산출물 — 오탐) |
| 실제 .env 비밀값의 저장소·이력 노출 | 자체 대조(값은 출력하지 않음) | 추적 파일 0 · git 이력 0 |

### 2.6 런타임(측정 직후)
| 컨테이너 | 메모리 |
|---|---|
| api | 611 MiB(힙 사용 144 MiB / 최대 616) |
| collector 142 MiB · db 210 MiB · ais 54 MiB · web 57 MiB · redis 44 MiB · edge 7 MiB | |

## 3. 측정하지 못한 것과 이유
- **Java 정적 분석(버그 패턴)**: SpotBugs·PMD·Error Prone 이 빌드에 없다. 추가하면 빌드가 바뀌므로 1단계에서는 `javac -Xlint` 경고 수만 쟀다(2단계에서 제안).
- **실제 GPU 브라우저의 상황판 성능**: headless 에서는 WebGL 이 소프트웨어로 돈다(위 주의).
- **운영 환경 오류율·지연**: 운영 배포가 없다. 부하 시험의 실패율(0 %)과 api 5xx 카운터(0)만 있다.
- **느린 쿼리 로그**: `log_min_duration_statement` 가 꺼져 있다. 2단계에서 실제 쿼리에 EXPLAIN (ANALYZE) 로 본다.
