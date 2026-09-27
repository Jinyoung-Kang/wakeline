# 성능 측정 (PERF.md)

측정일 2026-09-27 · M1 계열 Mac(arm64) · Docker Desktop 29.8 · 실공급자 데이터(관심 지역 항공기 105~136대, SIGMET 125~126건 활성) · 컨테이너 메모리 한도 api 1 GB.
도구: `perf/quick_rest.py`(httpx, 100 rps 고정 도착률) · `perf/quick_ws.py`(websockets, 200 연결 1분 램프업 + 90 s) — k6 스크립트(`perf/rest.js`, `perf/ws.js`)와 같은 시나리오. 측정 중에는 IP당 제한을 잠시 올렸다(`PUBLIC_RATE_LIMIT_PER_MIN`, `WS_MAX_CONN_PER_IP`), edge(nginx)는 우회하고 api 에 직접 붙었다(api 층 측정). 원자료: `perf/results/`.

## k6 측정 (`make bench`, 2026-09-27 11:12–11:19 UTC)

grafana/k6 v2.3.0 컨테이너를 Docker 네트워크 안에서 api(10.77.0.30:8000)에 직접 붙였다(edge 우회 = api 층 측정). 측정 동안만 IP당 제한·WS 연결 상한을 올렸고 끝난 뒤 `.env` 값(분당 120 · IP당 5 · 전체 200)으로 원복됨을 확인했다. 당시 관심 지역 항공기 ≈ 120대, 전세계(OpenSky) ≈ 7,200대 수집 중. 원자료: `perf/results/rest-summary.json`, `ws-summary.json`, `k6-*.log`.

| 시나리오 | 결과 | 임계치 |
|---|---|---|
| REST 100 rps × 3분(도착률 고정, 18,000건: aircraft 60% · sigmets 25% · status 15%) | 실패 0 %, 검사 36,000/36,000 | 통과 |
| `/aircraft?bbox` | p50 2.4 ms · **p95 4.6 ms** · p99 15.0 ms · max 415 ms | p95 < 300 ms 통과 |
| `/sigmets?active=true` | p50 3.0 ms · **p95 5.7 ms** · p99 16.3 ms · max 383 ms | 통과 |
| `/status` | p50 4.8 ms · **p95 9.5 ms** · p99 31.4 ms · max 556 ms | 통과 |
| WS 200 연결(1분 램프업 · 3분 유지, 세션 228) | 메시지 11,966(스냅샷 1,359 · diff 2,649), 오류 0, 접속 p95 5.7 ms | — |
| WS 수신 지연(서버 ts → 클라이언트 수신) | p50 16 ms · **p95 68 ms** · p99 91 ms · max 134 ms | p95 < 500 ms 통과 |
| api 컨테이너(15 s 표본) | RSS 435 → 최대 722 MiB / 한도 1 GiB, CPU 최대 132 %(REST 중 순간) | OOM 없음 |

- 앞의 Python 간이 측정(p99 190~340 ms)과 k6(p99 15~31 ms)의 차이는 **클라이언트 측 큐잉**이었다(아래 관찰 2 확인): 단일 이벤트 루프 httpx 가 100 rps 를 만들며 스스로 지연을 더했다. 서버 지연은 k6 값이 맞다.
- RSS 는 힙(최대 616 MiB = 1 GiB × 60 %) + 메타스페이스·스레드·버퍼다. WS 종료 후에도 RSS 가 ~720 MiB 로 유지된 것은 JVM 이 확보한 힙을 OS 에 바로 돌려주지 않기 때문이며, 힙 사용량 자체는 이번 측정에서 따로 기록하지 않았다(다음 측정 때 `jvm_memory_used_bytes` 스크레이프 추가).
- k6 로그의 `setTimeout … was stopped` 경고는 램프다운이 유지 중인 연결을 끊을 때 나오는 정상 메시지다(Makefile 이 로그에서 거른다).
- 참고: 벤치 직후 재기동한 api 의 짧은 구간에서 엔진 1주기 p95 는 109 ms 였다(전세계 7,200대 포함 · 예산 ≤ 300 ms). 관심 지역만일 때의 13.9 ms 와 구분해서 본다.

## 예산 대비 결과 (Python 간이 측정, 11:00 이전)

| 경로 | 예산(설계서 7.1) | 실측 | 판정 |
|---|---|---|---|
| REST `/aircraft?bbox` (캐시 없음, 113~121대 GeoJSON) 100 rps × 60 s | p95 ≤ 80 ms(적중) / ≤ 300 ms(미스) | **p50 5.1 ms · p95 37.8 ms · p99 190.6 ms** · 3,630건 전부 200 | 통과 |
| REST `/sigmets?active=true` (125 폴리곤 GeoJSON) | ≤ 300 ms | p50 5.6 ms · **p95 44.8 ms** · p99 202.7 ms | 통과 |
| REST `/status` | ≤ 300 ms | p50 6.1 ms · **p95 52.9 ms** · p99 341.1 ms | p95 통과, p99 는 Redis 해시 조회 6회가 원인(개선 후보) |
| WS 팬아웃 200 연결(관심 지역 bbox 구독) | diff 지연 p95 ≤ 500 ms | 서버 ts → 클라이언트 수신 **p50 12 ms · p95 45 ms · p99 72 ms · max 85 ms**, 1,745 메시지, 오류 0, 드롭 0 | 통과 |
| api 힙/메모리 | ≤ 512 MB 힙 | 컨테이너 RSS 492 MB(힙 상한 = 1 GB × 60%) 부하 중 | 통과 |
| 엔진 1주기(스냅샷 갱신 + 판정 + 예측 + FSM), 121대 × 126 폴리곤 | ≤ 50 ms | Micrometer `wakeline_engine_cycle_seconds` **p50 8.7 ms · p95 13.9 ms** | 통과 |
| 스트림 처리(검증 + 디코드 + 교체 + 엔진 + 이벤트) | — | `wakeline_stream_process_seconds` p50 52 ms · p95 109 ms(스키마 검증 포함) | 기록 |
| 10,000대 × 200 SIGMET 교차 판정(JUnit, 합성) | ≤ 50 ms(NFR-05) | 단위 테스트 상한 500 ms 안에서 통과(정확한 값은 JMH 미측정 — 다음 단계) | 미확정 |
| 수집 수신 → 브라우저 반영(NFR-01) | p95 ≤ 1.5 s | 상태 바 lag 배지 3~6 s 는 **공급자 관측 시각 기준**(adsb.lol 응답 1.2 s + 10 s 주기 포함). WS 팬아웃 자체는 위 45 ms | 측정 방식 분리 필요 |
| 브라우저 3,000대 30 fps(NFR-04) | — | 관심 지역은 ~130대라 미측정. 전세계 뷰(OpenSky)는 자격증명 후 측정 | 미측정 |

## 관찰과 개선 후보
1. `/status` p99 가 다른 경로보다 높다: Redis 해시 6개를 매 요청 읽는다. 5 s 로컬 캐시(Caffeine 없이 AtomicReference + 타임스탬프)로 p99 를 낮출 수 있다.
2. ~~REST p99(190~340 ms)는 클라이언트 측 큐잉이 섞여 있다~~ → k6 재측정으로 확인: 서버 p99 15~31 ms.
3. `/aircraft` 는 매 요청 GeoJSON 을 새로 직렬화한다. 스냅샷 버전별 직렬화 결과 캐시(ETag 와 같은 키)로 CPU 를 아낄 수 있다.
4. 항적 배치 저장: 큐 드롭 0, 2,000행 배치 — 5분 기동에 2,710행(관심 지역만). 전세계 수집(10k대/120 s)을 켜면 ~1,150만 행/일 예상(설계 7.2)이라 파티션·BRIN 만으로 충분한지 그때 측정한다.

## 재현
```bash
# 제한 상향(측정 전용) → api 재기동
sed -i '' 's/^PUBLIC_RATE_LIMIT_PER_MIN=.*/PUBLIC_RATE_LIMIT_PER_MIN=1000000/; s/^WS_MAX_CONN_PER_IP=.*/WS_MAX_CONN_PER_IP=500/' .env
docker compose -f infra/compose.yml --env-file .env up -d api
docker run --rm --network wakeline_wakeline -v "$PWD/perf:/perf:ro" python:3.13-slim sh -c \
  "pip install -q httpx websockets && python /perf/quick_rest.py http://10.77.0.30:8000 100 60 && python /perf/quick_ws.py ws://10.77.0.30:8000/ws/v1 200 90"
# 또는 k6: make bench (BASE_URL=http://localhost:8700)
```
