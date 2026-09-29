# ADR-025 WS 세션 우편함은 DB 를 기다리지 않는다: 선택 선박 조회는 우편함 밖 실행기와 전용 읽기 풀로

**상태** 채택 · 2026-09-30 · 계약 v5 §G18 · VERIFICATION #51 '남은 것'

## 맥락
- 세션마다 우편함(ADR-008 · REL-2 — `SerialOutbox`)이 전송과 '이 세션에 무엇을 보냈는가' 를 한 번에 하나씩 처리한다. 작업 종류별 단일 비행이라 대기열이
  자라지 않고, 느린 세션은 자기 가상 스레드만 막는다. 이 모델은 **작업이 빠르다**는 것을 전제로 한다 — 한 작업이 오래 걸리면 그 세션의 다른 모든 메시지가
  그 뒤에 선다.
- 선택 선박의 `ship_selected` 계산(`ShipFanout.runSelected`)이 이 우편함에서 DB 를 읽었다: 메모리에 정적 정보가 없으면 저장 정적 보고(§G17 —
  `StoredStaticReader.lookup`), 그리고 늘 입출항 색인(ADR-022 개정 — `PortCallReader.forStatic`: Redis heartbeat 한 번 + 문장 둘). 둘 다 공유 Hikari 풀
  (12 연결 · 연결 대기 5 s)에 공개 조회 문장 상한 3 s.
- 그래서 풀에 연결이 없는 동안(기록기가 몰림 · DB 에 닿지 않음) 선택 하나가 그 세션의 항공기 · 선박 diff · pong · heartbeat 를 붙잡았다 — 설정값으로 저장
  정적 보고 한 번 5 + 3 = 8 s, 입출항까지 3 + 2 × 8 = 19 s, 실패 기억(15 s)이 끝날 때마다 되풀이. 지도는 그동안 멈춘다.
  `ShipSelectionLookupTest` 의 첫 판이 가짜 DB 로 이것을 재현했다(pong · diff · ships_diff 가 읽기가 끝난 뒤, ship_selected 다음에야 나간다).

## 결정
1. **우편함은 주인으로 남고 I/O 는 밖으로.** 우편함 작업은 읽는 쪽의 메모리 캐시만 본다(`StoredStaticReader.cached` · `PortCallReader.cachedForStatic` — 둘 다
   I/O 없음). 다 답할 수 있으면 그 자리에서 보낸다. 읽어야 하면 `ShipLookups.load` 가 조회 실행기에서 읽고, 결과는 `SHIP_SELECTED` 우편함 작업으로 돌아온다.
   세션 상태(`shipSelectedSent` · 강제 전송 표시 · 진행 중인 조회)는 여전히 우편함만 바꾼다.
2. **세대 확인으로 늦은 결과를 버린다.** 진행 중인 조회는 세션에 하나(`WsSession.shipLookup` — 그 객체가 세대). 결과는 그 객체에 담기고, 우편함은 그것이
   지금 조회이고 물음(선박 · 메모리 정적 정보가 있는가 · 그 호출부호 — `ShipFanout.Question`)이 같을 때만 쓴다. 다른 선박을 골랐거나 선택을 풀었거나 캐시가
   먼저 답했으면 버리고 센다. 같은 물음의 다시 계산(선박 이동 · 15 s 주기)은 새 조회를 맡기지 않고 기다린다 — 결과가 오면 그때의 최신 선박 상태와 함께 보낸다.
3. **마감.** 조회는 늦어도 읽기 풀의 한 번 읽기 상한(연결 대기 2 s + 문장 3 s = 5 s, 설정값)에 끝난다. 끝나지 않은 부분은 계약에 이미 있는 값으로 답한다
   (static → `stored_unavailable`, 입출항 → `error`). 읽기는 계속돼 캐시를 채우고 다음 다시 계산이 바뀐 값을 보낸다 — 실패를 붙잡아 두지 않는다.
4. **실행기는 작고 넘치면 거절한다.** 스레드 = 읽기 풀 연결 수(4 — 스레드마다 연결 하나라 풀 안에서 서로 기다리지 않는다), 대기열 256(세션마다 진행 중인 조회
   하나 × 한 조회의 읽기는 차례로 하나 — 기본 WS 연결 상한 200 보다 크다), 가득 차면 `AbortPolicy` → 읽지 않고 읽지 못함으로 답하고 센다(`outcome=rejected`).
5. **전용 읽기 풀 `wakeline-read`.** 이 두 읽기만 쓴다. 연결 대기 2 s — 문장 상한 3 s 이하만 받고(넘으면 기동 실패), 서버 `statement_timeout=3s` ·
   `default_transaction_read_only=on`(쓰기 불가) · 최소 유휴 0 · 기동 때 DB 없어도 뜬다 · Micrometer 지표. 공유 풀과 격벽: 선택 조회가 몰리거나 느려도 기록기 ·
   REST 의 공유 풀을 잡지 않고, 공유 풀이 바닥나도 선택 조회는 제 풀로 읽는다.
6. **WS 계약은 그대로.** 키 · 값이 같고 늦게 나갈 수 있을 뿐이다. 웹은 첫 `ship_selected` 전에는 입출항 절을 "—" 로 둔다.

## 새 최악(설정값에서 — 잰 값 아님)
| 경우 | 전 | 후 |
|---|---|---|
| 그 세션의 pong · diff · heartbeat | 선택 조회 뒤에 선다(최대 약 8 s — 입출항까지 약 19 s) | 선택 조회를 기다리지 않는다 |
| ship_selected(조회가 필요할 때) | 읽기가 끝날 때(위와 같음) | ≤ 5 s(마감), 끝나지 않은 부분은 읽지 못함 |
| 읽기 풀이 바닥남 · DB 에 닿지 않음 | 연결 대기 5 s + 문장 3 s | 연결 대기 2 s 에 읽지 못함(`StoredStaticIT` — 1.8–2.8 s) |
| 조회 실행기 포화(4 + 256) | — | 곧바로 읽지 못함 · 센다 |

DB 연결 수: 역할별 상한이 없고(`infra/db/init/01-roles.sh`) 서버 max_connections 는 기본 100(compose 가 바꾸지 않는다, 슈퍼유저 예약 3). api 는 12 + 4 = 16,
수집기 프로세스는 각 2.

## 대안과 기각 이유
- **공유 풀의 연결 대기를 줄인다**: 기록기(항적 · 선박 · 알림 — 재시도 · 백오프가 있다)는 더 기다려도 된다. 그래도 우편함은 2 + 3 s 막힌다.
- **가상 스레드 + 세마포어**: 같은 효과. 스레드 수를 연결 수와 같게 정하고 대기열 길이를 지표로 보이려고 고정 크기 `ThreadPoolExecutor` 를 골랐다.
- **읽는 쪽이 `CompletableFuture` 로 같은 MMSI 한 번 읽기**: 같은 선박을 동시에 고른 세션의 조회 스레드가 진행 중인 읽기를 `join` 으로 기다리지 않게 된다. 지금은
  그 기다림이 읽기 한 번의 상한 안이고 연결을 쓰지 않는다 — 코드를 늘릴 만큼의 이득이 없다.
- **ship_selected 에 '조회 중' 상태를 싣는다**: 스키마 두 사본 · 웹 검증기 · 표본이 늘지만, 사용자에게 보이는 것은 이미 "—" 와 같다.
- **항공기 `selected` 의 노선(Redis — 3 s 상한, 5 s 캐시)도 같이 옮긴다**: 같은 모양이지만 이 결정의 범위 밖이다(남은 일로 적는다).

## 결과
- 지표: `wakeline_ws_ship_lookups_total{outcome=ok|deadline|rejected|error}` · `wakeline_ws_ship_lookup_seconds` · `wakeline_ws_ship_lookup_queue` ·
  `wakeline_ws_ship_lookup_dropped_total` · `hikaricp_connections_*{pool="wakeline-read"}`.
- 설정: `wakeline.read-pool.size`(4) · `wakeline.read-pool.connection-timeout-ms`(2,000) — application.yml.
- 되돌리기: 이 변경의 커밋을 되돌린다 — 읽기가 우편함으로 돌아오고 읽기 풀이 없어진다(스키마 · 데이터 변화 없음).
