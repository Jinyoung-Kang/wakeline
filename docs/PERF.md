# 성능 측정 (PERF.md)

측정일 2026-09-27 · M1 계열 Mac(arm64) · Docker Desktop 29.8 · 실공급자 데이터(관심 지역 항공기 105~136대, SIGMET 125~126건 활성) · 컨테이너 메모리 한도 api 1 GB.
도구: `perf/quick_rest.py`(httpx, 100 rps 고정 도착률) · `perf/quick_ws.py`(websockets, 200 연결 1분 램프업 + 90 s) — k6 스크립트(`perf/rest.js`, `perf/ws.js`)와 같은 시나리오. 측정 중에는 IP당 제한을 잠시 올렸다(`PUBLIC_RATE_LIMIT_PER_MIN`, `WS_MAX_CONN_PER_IP`), edge(nginx)는 우회하고 api 에 직접 붙었다(api 층 측정). 원자료: `perf/results/`.

## 예산 대비 결과

| 경로 | 예산(설계서 7.1) | 실측 | 판정 |
|---|---|---|---|
| REST `/aircraft?bbox` (캐시 없음, 113~121대 GeoJSON) 100 rps × 60 s | p95 ≤ 80 ms(적중) / ≤ 300 ms(미스) | **p50 5.1 ms · p95 37.8 ms · p99 190.6 ms** · 3,630건 전부 200 | 통과 |
| REST `/sigmets?active=true` (125 폴리곤 GeoJSON) | ≤ 300 ms | p50 5.6 ms · **p95 44.8 ms** · p99 202.7 ms | 통과 |
| REST `/status` | ≤ 300 ms | p50 6.1 ms · **p95 52.9 ms** · p99 341.1 ms | p95 통과, p99 는 Redis 해시 조회 6회가 원인(개선 후보) |
| WS 팬아웃 200 연결(관심 지역 bbox 구독) | diff 지연 p95 ≤ 500 ms | 서버 ts → 클라이언트 수신 **p50 12 ms · p95 45 ms · p99 72 ms · max 85 ms**, 1,745 메시지, 오류 0, 드롭 0 | 통과 |
| api 힙/메모리 | ≤ 512 MB 힙 | 컨테이너 RSS 492 MB(힙 상한 = 1 GB × 60%) 부하 중 | 통과 |
| 엔진 1주기(스냅샷 갱신 + 판정 + 예측 + FSM), 121대 × 126 폴리곤 | ≤ 50 ms | Micrometer `skywx_engine_cycle_seconds` **p50 8.7 ms · p95 13.9 ms** | 통과 |
| 스트림 처리(검증 + 디코드 + 교체 + 엔진 + 이벤트) | — | `skywx_stream_process_seconds` p50 52 ms · p95 109 ms(스키마 검증 포함) | 기록 |
| 10,000대 × 200 SIGMET 교차 판정(JUnit, 합성) | ≤ 50 ms(NFR-05) | 단위 테스트 상한 500 ms 안에서 통과(정확한 값은 JMH 미측정 — 다음 단계) | 미확정 |
| 수집 수신 → 브라우저 반영(NFR-01) | p95 ≤ 1.5 s | 상태 바 lag 배지 3~6 s 는 **공급자 관측 시각 기준**(adsb.lol 응답 1.2 s + 10 s 주기 포함). WS 팬아웃 자체는 위 45 ms | 측정 방식 분리 필요 |
| 브라우저 3,000대 30 fps(NFR-04) | — | 관심 지역은 ~130대라 미측정. 전세계 뷰(OpenSky)는 자격증명 후 측정 | 미측정 |

## 관찰과 개선 후보
1. `/status` p99 가 다른 경로보다 높다: Redis 해시 6개를 매 요청 읽는다. 5 s 로컬 캐시(Caffeine 없이 AtomicReference + 타임스탬프)로 p99 를 낮출 수 있다.
2. REST p99(190~340 ms)는 100 rps 를 한 프로세스에서 만드는 클라이언트 측 큐잉이 섞여 있다(httpx 단일 이벤트 루프). k6 로 재측정해 클라이언트 병목을 분리한다.
3. `/aircraft` 는 매 요청 GeoJSON 을 새로 직렬화한다. 스냅샷 버전별 직렬화 결과 캐시(ETag 와 같은 키)로 CPU 를 아낄 수 있다.
4. 항적 배치 저장: 큐 드롭 0, 2,000행 배치 — 5분 기동에 2,710행(관심 지역만). 전세계 수집(10k대/120 s)을 켜면 ~1,150만 행/일 예상(설계 7.2)이라 파티션·BRIN 만으로 충분한지 그때 측정한다.

## 재현
```bash
# 제한 상향(측정 전용) → api 재기동
sed -i '' 's/^PUBLIC_RATE_LIMIT_PER_MIN=.*/PUBLIC_RATE_LIMIT_PER_MIN=1000000/; s/^WS_MAX_CONN_PER_IP=.*/WS_MAX_CONN_PER_IP=500/' .env
docker compose -f infra/compose.yml --env-file .env up -d api
docker run --rm --network skywx_skywx -v "$PWD/perf:/perf:ro" python:3.13-slim sh -c \
  "pip install -q httpx websockets && python /perf/quick_rest.py http://10.77.0.30:8000 100 60 && python /perf/quick_ws.py ws://10.77.0.30:8000/ws/v1 200 90"
# 또는 k6: make bench (BASE_URL=http://localhost:8700)
```
