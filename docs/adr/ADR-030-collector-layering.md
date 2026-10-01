# ADR-030 수집기 계층: 진입 · 작업 · 어댑터 · 순수 규칙 — import 는 아래로만, test_layering 이 지킨다

**상태** 채택 · 2026-10-01 · CTO 리뷰 2026-10 [PLAN](../review/cto-2026-10/PLAN.md) Phase 0 · 3B · 4 · 근거 [collector-review](../review/cto-2026-10/collector-review.md) §1 · §2 · §4 ·
함께 보는 결정: [ADR-028](ADR-028-api-package-boundaries.md)(api 패키지 경계) · [ADR-029](ADR-029-web-data-access.md)(웹 데이터 접근)

## 맥락
- 리뷰 기준(`e0e1eba`)의 수집기(`wakeline_collector`, 78개 모듈)에는 import 순환이 없었다. 그러나 방향이 틀린 import 가 7개 있었다(collector-review §1.4):
  - `errors → http`: 순수한 오류 글자 만들기가 HTTP 어댑터(가져올 때 설정 · 환경을 읽는다)를 가져왔다.
  - `retry → http` · `retry → budget`: 재시도 정책이 Redis 예산 어댑터를 상수 하나 때문에 가져왔다.
  - `fallback → status` · `fallback → chain_store`: 공급자 체인의 결정 상태기계가 Redis 어댑터를 품고, 고를 때마다 후보마다 Redis 를 기다렸다.
  - `portcalls → route`: 항만 기능이 노선 기능의 글자 도우미를 빌렸다.
  - `ais.sink → publisher._size`: AIS 쪽이 발행기의 비공개 이름을 쓰고, 순수 함수 하나를 부르려고 `Publisher` 를 만들었다.
- 두 작업 모듈이 규칙 · HTTP · Redis · 로그를 한 클래스에 섞었다:
  - `jobs/kma_radar.py` 1,626줄(이 브랜치의 D2 수정 `e520cca0` 뒤 1,663줄) — 이미 순수한 블록 약 375줄이 클래스 안팎에 섞여 있었다.
  - `jobs/traffic_grid.py` 1,627줄 — 순수 블록 약 320줄과, 같은 차단기 사다리 논리 두 벌이 있었다.
- 그래서 규칙만 따로 시험하기 어려웠고, Redis 실패를 다루는 규칙(D2 — KMA 작업이 Redis 오류를 던지면 실행 기록이 사라졌다)이 입출력 코드 사이에 흩어졌다.

## 결정
1. **네 층.** import 는 아래로만 한다.

   | 층 | 하는 일 | 모듈 |
   |---|---|---|
   | entry | 실행 진입 | `main` · `ais.main` · `health` · `__main__` · `tools` |
   | jobs | 조율: 예약 → 어댑터 호출 → 규칙으로 판정 → 어댑터로 쓰기 | `jobs/*` |
   | adapters | 입출력 | Redis · HTTP(`providers/*` 포함) · Postgres · 파일 · 환경 변수(`config`) — `budget` · `status` · `chain_store` · `publisher` · `db` · `raw_store` · `kma_store` · `fallback`(얇은 겉면) … |
   | rules | 규칙: 어댑터를 import 하지 않는다 — Redis · HTTP · DB · 파일 · 환경 변수에 스스로 닿지 않는다(아래 2 '순수'의 뜻) | 모델 · 파서 · 판정 · KERNEL 의 실행 도우미 |

2. **규칙 모듈은 기능별로 나눈다.**
   - 공통 규칙(KERNEL)은 어느 규칙이든 쓸 수 있다: `models` · `geo` · `masking` · `errors` · `http_errors` · `send_outcome` · `budget_rules` · `textutil` · `timeutil` · `diag` · `retry` · `chain_state` · `ratelimit` · `scheduler` …
   - 기능 규칙은 KERNEL 과 같은 기능만 import 한다(기능 사이 의존 금지): aircraft(`normalize` · `quality`) · weather · kma(`kma_grid` · `kma_rules`) · marine(`marine_grid` · `grid_tiles` · `traffic_grid` · `traffic_grid_plan`) · portcalls · route · ais.
   - **'순수'의 뜻.** 규칙 층이 지키는 것은 어댑터를 import 하지 않는 것이다 — Redis · HTTP · DB · 파일 · 환경 변수에 스스로 닿지 않는다(입출력은 부르는 쪽이 주거나 주입한다). 입출력이 하나도 없다는 뜻은 아니다:
     - KERNEL 의 실행 도우미는 asyncio 위에서 돈다: `scheduler`(작업 루프 · `asyncio.wait_for`) · `ratelimit`(asyncio future · 타이머) · `retry`(잠들고 · 로그를 남기고 · 주입받은 입출력 호출을 부른다) · `diag.LoopLag.run`(끝없이 도는 태스크 — WARN 이 로그 싱크로 간다).
     - 규칙 모듈도 `logging` 으로 로그를 남긴다(`normalize` · `chain_state` · `ais.shards` · `ais.reconnect` …). WARN 이상은 진입이 붙인 `logsink` 가 Redis 로 보낸다. ais 규칙은 asyncio 이벤트 · 큐 · 타이머를 쓴다.
     - 가드는 패키지 안 import 만 센다. 표준 · 외부 라이브러리 import 는 세지 않는다(`errors` · `http_errors` 는 httpx 를 예외 형으로만 쓴다).
3. **가드는 `apps/collector/tests/test_layering.py`.** 표준 라이브러리 `ast` 만 쓰고, 함수 안의 늦은 import 도 센다. 규칙은 여섯 가지다(가드 설명의 번호와 같다):
   1. 위 층을 import 하지 않는다.
   2. 작업 사이에는 `jobs.context` 만 쓴다(설계상 `jobs.demand → jobs.route` 는 허용).
   3. entry 모듈을 import 하는 것은 같은 패키지의 `__main__` 뿐이다(`X.__main__ → X.main`).
   4. 규칙 모듈은 KERNEL 이나 같은 기능의 규칙만 import 한다(위 2).
   5. 다른 모듈의 비공개 이름(`_x`)을 import 하지 않는다.
   6. `ais` 는 격벽이라, 밖에서는 정해 둔 공유 모듈만 쓴다.

   그리고 새 모듈은 반드시 층(과 기능)을 정한다 — 정하지 않으면 실패한다.

   허용 목록 `ALLOWED` 는 처음 7개로 시작해 **지금은 비었다**. 고친 위반이 목록에 남아 있어도 실패한다.
4. **떼어 낸 모듈.** 모두 동작을 바꾸지 않는 커밋으로 옮겼고, 기존 시험은 import 줄만 바뀌었다.

   | 새 모듈 | 층 · 기능 | 출처 · 내용 |
   |---|---|---|
   | `http_errors` | rules · kernel | `http` 의 실패 형과 '보내지 않음' 집합 — `http` 가 다시 내보낸다 |
   | `send_outcome` | rules · kernel | `classify_send`. 세 작업과 OpenSky 토큰이 '보냈나'를 한 규칙으로 판정한다(R-65) |
   | `budget_rules` | rules · kernel | `UNKNOWN` · `regular_headroom` — `retry` · `kma_rules` 가 Redis 어댑터 없이 쓴다 |
   | `textutil` | rules · kernel | `clean_text` — 항만이 노선 기능을 import 하지 않는다 |
   | `timeutil` | rules · kernel | KST 정의 하나. `kst_now()` 는 +09:00 aware 시각을 돌려준다(전: KST 벽시계에 UTC 표시 — 잠복 함정 C4) |
   | `diag` | rules · kernel | `WindowMax` · `LoopLag`(ais 와 공유 — `LoopLag.run` 은 실행 도우미, 결정 2) |
   | `chain_state` | rules · kernel | 공급자 체인의 순수 상태기계. 끈 공급자 목록은 주기마다 한 번 읽어 넘긴다 |
   | `kma_rules` | rules · kma | KMA 작업의 순수 블록과 전날 목록 · 목록 정체 · 실행 상태 판정 |
   | `kma_store` | adapter | KMA 프레임 · meta 의 키 · 직렬화 · TTL 과 Redis 접근. Redis 오류는 삼키지 않고 올린다 — 그 뜻(D2: 단계별 'error' 실행 하나)은 작업의 `run_once` 의 `except (RedisError, OSError)` 와 `_redis_failed` 에 있다 |
   | `traffic_grid_plan` | rules · marine | 연안 교통량 작업의 순수 블록과 `Breaker` 하나(두 벌의 차단기 사다리를 대신한다) |

   결과 크기(리뷰 기준 `e0e1eba` → 떼어 낸 뒤 `f455dae1`): `jobs/kma_radar.py` 1,626 → 1,255줄(그 사이 D2 수정 `e520cca0` 이 37줄을 더했다), `jobs/traffic_grid.py` 1,627 → 1,334줄, `fallback.py` 580 → 257줄.

5. **시험이 기대는 자리는 남긴다.** 시험이 바꿔 끼우는 이름은 그대로 동작한다:
   - `jobs.kma_radar` 의 `_now` · `_sleep` · `kst_now` · `_decode` · `_decode_if_more`
   - `jobs.traffic_grid` 의 `MAX_TRACKED` · `WFS_PER_TICK` · `UNCHANGED_BACKOFF_S` — `GridGeometry` 는 3줄 하위 클래스로 남겼다
   - `fallback.time`
   - 작업 클래스의 차단기 속성 넷
   - `jobs.kma_radar` 가 다시 내보내는 `KEY_*`

   옮긴 규칙은 시계 · 설정을 인자로 받는다.

## 측정한 것 (변경은 수치로 판단 — [PERF](../PERF.md) §12)
- **공급자 체인**(C7): 운영자 스위치 읽기를 주기마다 한 번에 함께 읽는다. 읽기 하나가 50 ms 멈추는 Redis 에서 429 뒤 주기는 153 → 51 ms 이고, 실제 시간 초과(1.5 s)로는 약 4.6 → 1.5 s.
- **이벤트 루프 지연 지표**(D0): heartbeat 에 `loop_lag_max_s` · `loop_stalls_total` · `loop_tick_s` 를 싣는다. 깨우기 0.1 s 의 비용은 쉬는 루프에서 1.2–1.5 CPU ms/s 였다(20 ms 멈춤을 잡으려고 고른 값).
- **KMA 그림**(D3): int16 격자를 정수 임계값과 견준다. 전체 격자 렌더 182–216 → 167–178 ms, 최대 메모리 +73.4 → +23.3 MiB, PNG sha256 은 같다.
- **demand 정규화**(D2): 이벤트 루프에 그대로 둔다. 600대에서 지연 p99 10.6–10.9 ms 이고, 스레드로 옮겨도 GIL 때문에 최악값이 줄지 않았다(19.8–21.7 ms).

## 하지 않은 것
- `logsink` · 항만 계획기 · 얇은 작업(`aircraft` · `weather` · `route` · `maintenance`) · `ais/*` 는 이미 나뉘어 있거나 얇다.
- `db.py` 의 항만 SQL 은 그 기능을 다시 만질 때 옮긴다.
- 새 도구(import-linter 등) · 새 인프라 · 인터페이스 계층은 두지 않았다.
- 작업 모듈 docstring 의 사고 기록은 줄이지 않았다. VERIFICATION · ADR 와 겹치지만 규칙의 근거라 남겼다.

## 결과
- 규칙을 입출력 없이 표로 시험할 수 있다: `kma_rules` 표 시험 · 차단기 사다리 단위 시험 · `chain_state`.
- Redis · HTTP 를 만나는 곳이 어댑터 몇 곳으로 좁혀졌다.
- 새 모듈은 층을 정하지 않으면 가드가 실패한다. 방향이 틀린 import 는 리뷰 전에 시험이 잡는다.
