# ADR-011 설계서 v0.2 와 달라진 점(구현 시 결정)

| 항목 | 설계서 | 구현 | 이유 |
|---|---|---|---|
| 명령 도구 | justfile | Makefile | 기존 포트폴리오와 동일, `just` 미설치 |
| DB 이미지 | postgis/postgis:18-3.6 + platform amd64 | imresamu/postgis:18-3.6 (arm64) | 에뮬레이션 회피(ADR-004) |
| Redis DB 분리(db0/db1) | 스트림·예산 / 캐시·세션 | 단일 DB, `maxmemory-policy noeviction` | LRU 는 인스턴스 전체에 적용되므로 DB 분리로 보호되지 않음. 스트림 MAXLEN·캐시 TTL 로 상한 |
| 스트림 payload | gzip JSON | gzip + base64 문자열 | 문자열 필드로 두 언어 클라이언트 모두 단순하게(320 KB → 430 KB, 120 s 주기라 무시 가능) |
| 공항 목록 | AWC airport API 일 1회 | METAR bbox 응답의 관측소로 생성 | AWC airport bbox 가 한국 공항 1곳만 반환(실측) |
| 비행 카테고리 | 저장 시 계산 | AWC `fltCat` 우선, 없을 때만 계산해 `computed` 로 표기 | 실제 값이 있으면 그것을 쓴다(정직성) |
| 보간 워커 | lib/interpolate.worker.ts | public/interpolate.worker.js + 일치 테스트 | Turbopack 워커 제약(ADR-002) |
| 공개 포트 | 8080 | 8700 | 8080 은 SmartCollab 사용 |
| 통계 차트 | Recharts | 의존성 없는 SVG 막대 | 번들 크기·의존성 최소화 |
| CSRF 헤더 | X-CSRF-Token | X-CSRF-Token(쿠키 WAKELINE_CSRF) | Spring Security `csrf.spa()` 에 이름만 지정 |
| 429 처리 | 지수 백오프 2→300 s | 60→120→240→300 s 후 폴백, 성공 시 초기화 | adsb.lol 이 10 s 주기에서 실제로 429 를 돌려줌(실측) |
| 부하 도구 | k6 | k6 스크립트 + `perf/quick_*.py`(k6 미설치 시) | 로컬에 k6 가 없어 같은 시나리오를 Python 으로도 제공 |
| 서비스 이름 | SkyWx | Wakeline | 항공기·선박·기상을 함께 다루게 되어 이름을 넓혔다(ADR-015). DB·역할·Redis 키·볼륨을 데이터 손실 없이 옮김 |
| 컨테이너 | 6개 | 상시 7개(edge·web·api·collector·ais·redis·db) + 일회성 migrate | DDL 비밀번호를 api 에서 빼려고 migrate 분리, AIS 푸시 수신을 항공기 폴링과 격벽으로 분리(ADR-014) |
| 추적 주기 | 관심 지역 10 s · 전세계 120 s 고정 | + 뷰포트 핫 리전 30 s · 선택 항공기 집중 추적 5 s(수요 기반 임대) | 확대해 보거나 고른 항공기만 촘촘히 — 호출량은 수집기 전체 상한 안(ADR-013) |
| 선박 | 없음 | AIS(aisstream.io) 실시간 · 0~45°E 제외 전 해역 | 공급자 연결 하나의 전달 한계를 재서 정함(ADR-014 부록 A) |
| 컨테이너 PID 1 | 앱 | api·collector·ais·redis 는 docker-init | 신호 전달·좀비 회수, 앱이 죽으면 재시작 정책이 동작(VERIFICATION #22) |
| 부하 도구 | k6 설치 | grafana/k6 컨테이너(`make bench`) | 호스트에 설치하지 않고 같은 도커 네트워크에서 api 층 직접 측정 |
