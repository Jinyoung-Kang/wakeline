# ADR-025 WS 세션 우편함은 DB 를 기다리지 않는다: 선택 선박 조회는 우편함 밖 실행기와 전용 읽기 풀로

**상태** 채택 · 2026-09-30 · 계약 v5 §G18 · VERIFICATION #51 '남은 것' · 리뷰 뒤 고침(같은 날 — 결정 2 · 4 · 5 · 6, '스레드 · 연결이 묶이는 시간', 대안) ·
개정(같은 날 — 계약 v5 §G21: 선택 항공기 노선의 Redis 읽기도 우편함 밖으로, 아래 '개정' 절)

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
2. **세대 확인으로 늦은 결과를 버린다.** 세션의 조회는 하나(`WsSession.shipLookup` — 그 객체가 세대). 결과는 그 객체에 담기고, 우편함은 그것이
   지금 조회이고 물음(선박 · 메모리 정적 정보가 있는가 · 그 호출부호 — `ShipFanout.Question`)이 같을 때만 쓴다. 다른 선박을 골랐거나 선택을 풀었으면 버리고,
   답을 보내지 않은 조회만 센다. 같은 물음의 다시 계산(선박 이동 · 15 s 주기)은 새 조회를 맡기지 않는다 — 답이 오면 그때의 최신 선박 상태와 함께 보낸다.
   **'답을 보냄' 과 '읽는 중' 은 다르다**(리뷰 뒤 고침): `ShipLookups.load` 는 `Flight(answer, settled)` 를 준다 — answer 는 늦어도 마감, settled 는 그
   조회의 읽기가 모두 끝남(마감과 무관). 세션은 settled 까지 조회를 들고 있어, 마감에 답한 뒤의 다시 계산도 새 읽기를 올리지 않고 캐시 또는 그 답과 최신
   선박 상태로 보낸다. 읽기가 끝나면 곧바로 다시 계산해 캐시에 든 값을 보낸다.
3. **마감.** 답은 늦어도 읽기 풀이 답하는 한 번 읽기의 상한(연결 대기 2 s + 문장 3 s = 5 s, 설정값 — `ReadPool.readBoundMs`)에 나간다. 끝나지 않은 부분은
   계약에 이미 있는 값으로 답한다(static → `stored_unavailable`, 입출항 → `error`). 읽기는 계속돼 캐시를 채우고, 끝나면 바뀐 값을 곧바로 보낸다 — 실패를
   붙잡아 두지 않는다.
4. **같은 키의 읽기는 하나, 세션의 실행기 작업도 하나 이하**(리뷰 뒤 고침). 같은 MMSI(저장 정적 보고) · 같은 호출부호(입출항)의 동시 읽기는
   `persist.SingleFlight` 가 합친다 — 기다리는 쪽은 진행 중인 읽기의 future 에 이어 붙어 스레드를 잡지 않는다(`StoredStaticReader.lookupAsync` ·
   `PortCallReader.forStaticAsync`). 한 세션의 다음 물음의 읽기는 앞 조회가 settled 된 뒤 시작하고(`WsSession.shipLookupTail`), 그사이 물음이 또 바뀌면
   그 읽기는 하지 않는다(`outcome=skipped`). 그래서 한 세션이 실행기에 두는 작업(실행 중 + 대기)은 늘 하나 이하다. 마감은 물음 때부터 세므로 느린 앞
   읽기 뒤에 선 물음도 5 s 에 답한다(읽지 못함 — 그 뒤 제 읽기가 끝나면 실제 값).
5. **실행기는 작고 넘치면 거절한다.** 스레드 = 읽기 풀 연결 수(4 — 스레드마다 연결 하나라 풀 안에서 서로 기다리지 않는다), 대기열 = max(256,
   `wakeline.ws-max-conn`)(세션마다 작업 하나 이하 — 연결 상한까지의 세션이 모두 읽어도 넘치지 않는다), 가득 차면 `AbortPolicy` → 읽지 않고 읽지 못함으로
   답하고 센다(`outcome=rejected` — 기억하지 않아 다음 다시 계산이 다시 올린다).
6. **전용 읽기 풀 `wakeline-read`.** 이 두 읽기만 쓴다. 연결 대기 2 s — 문장 상한 3 s 이하만 받고(넘으면 기동 실패), 서버 `statement_timeout=3s` ·
   `default_transaction_read_only=on`(쓰기 불가) · 최소 유휴 0 · 기동 때 DB 없어도 뜬다 · Micrometer 지표. 공유 풀과 격벽: 선택 조회가 몰리거나 느려도 기록기 ·
   REST 의 공유 풀을 잡지 않고, 공유 풀이 바닥나도 선택 조회는 제 풀로 읽는다. **망에 기대지 않는 상한**(리뷰 뒤 고침): 두 문장 상한은 서버가 답할 때만
   문장을 끝낸다 — 서버가 멈췄거나 망이 끊기면 이미 소켓을 기다리는 읽기는 pgjdbc `socketTimeout`(기본 0 = 끝없이)만 끝낼 수 있다. 그래서 `socketTimeout`
   = 문장 상한 + 2 s = 5 s, `connectTimeout` = 연결 대기를 초로 올림(2 s). `ReadPoolDbTest` 가 서버 → 클라이언트 방향을 멈추는 중계로 재현했다(고치기 전: 8 s
   뒤에도 막힘, 고친 뒤: 약 5 s 에 `SocketTimeoutException`).
7. **WS 계약은 그대로.** 키 · 값이 같고 늦게 나갈 수 있을 뿐이다. 웹은 첫 `ship_selected` 전에는 입출항 절을 "—" 로 둔다.

## 새 최악(설정값에서 — 잰 값 아님)
| 경우 | 전 | 후 |
|---|---|---|
| 그 세션의 pong · diff · heartbeat | 선택 조회 뒤에 선다(최대 약 8 s — 입출항까지 약 19 s) | 선택 조회를 기다리지 않는다 |
| ship_selected(조회가 필요할 때) | 읽기가 끝날 때(위와 같음) | ≤ 5 s(마감), 끝나지 않은 부분은 읽지 못함 — 읽기가 끝나면 곧바로 실제 값 |
| 읽기 풀이 바닥남 · DB 에 닿지 않음 | 연결 대기 5 s + 문장 3 s | 연결 대기 2 s 에 읽지 못함(`StoredStaticIT` — 1.8–2.8 s) |
| 서버가 멈춤 · 망 단절(연결은 열림) | 문장이 끝나지 않음(TCP keepalive 까지) | 소켓 5 s 에 예외(`ReadPoolDbTest`) |
| 조회 실행기 포화(4 + max(256, 연결 상한)) | — | 곧바로 읽지 못함 · 센다 — 세션마다 작업 하나 이하라 연결 상한 안에서는 대기열이 넘치지 않는다 |

**스레드 · 연결이 묶이는 시간**(리뷰 뒤 고침 — 포화를 정하는 것은 답의 마감이 아니라 이것이다). 실행기 작업 하나 = 읽기 하나, 스레드 하나 · 문장마다 읽기 풀
연결 하나(문장이 끝나면 돌려준다). 문장 하나 ≤ 연결 대기 2 s + 문장 3 s = 5 s(서버가 답할 때 — `readBoundMs`), ≤ 2 s + 소켓 5 s = 7 s(서버가 멈출 때 —
`hardReadBoundMs`).

| 스레드 하나를 잡는 작업 | 서버가 답할 때 | 서버가 멈출 때 |
|---|---|---|
| 저장 정적 보고(문장 하나) | ≤ 5 s | ≤ 7 s |
| 입출항(Redis heartbeat 3 s — 15 s 기억 · 범위 문장 — 15 s 기억 · 호출부호 문장) | ≤ 3 + 2 × 5 = 13 s | ≤ 3 + 2 × 7 = 17 s |
| 한 조회가 settled 되기까지(위 두 작업이 차례로 — 사이에 스레드를 놓는다) | ≤ 18 s | ≤ 24 s |

Redis 상한은 `spring.data.redis.timeout` 3 s. 보통은 heartbeat · 범위가 기억에 있어 입출항 작업도 문장 하나다. 같은 키는 세션을 가로질러 읽기 하나,
세션마다 작업 하나 이하이므로 스레드 4 개가 모두 묶이려면 서로 다른 키를 읽는 세션이 넷 있어야 하고, 그동안 다른 세션의 물음은 마감(5 s)에 읽지 못함으로
답한 뒤 제 차례에 읽는다.

DB 연결 수: 역할별 상한이 없고(`infra/db/init/01-roles.sh`) 서버 max_connections 는 기본 100(compose 가 바꾸지 않는다, 슈퍼유저 예약 3). api 는 12 + 4 = 16,
수집기 프로세스는 각 2.

## 대안과 기각 이유
- **공유 풀의 연결 대기를 줄인다**: 기록기(항적 · 선박 · 알림 — 재시도 · 백오프가 있다)는 더 기다려도 된다. 그래도 우편함은 2 + 3 s 막힌다.
- **가상 스레드 + 세마포어**: 같은 효과. 스레드 수를 연결 수와 같게 정하고 대기열 길이를 지표로 보이려고 고정 크기 `ThreadPoolExecutor` 를 골랐다.
- **(처음 기각했다가 리뷰 뒤 채택) 읽는 쪽이 `CompletableFuture` 로 같은 키 한 번 읽기**: 처음에는 '기다림이 읽기 한 번의 상한 안이고 연결을 쓰지 않는다' 고
  기각했다. 리뷰가 보인 것: 같은 선박을 고른 N 세션이 스레드 N 개를 잡고(한 읽기에 스레드 셋 — `ShipSelectionLookupTest`), 마감 뒤의 다시 계산이 같은
  호출부호를 되풀이해 읽어 한 세션 · 한 선박이 스레드 넷을 잡았다(느린 DB — 이 결정이 겨냥한 바로 그 경우). 그래서 `SingleFlight` 로 바꿨다.
- **세션의 조회 표시를 답과 함께 지우고 읽는 쪽의 합치기만 둔다**: 같은 키의 되풀이 읽기는 막지만, 마감 뒤의 다시 계산마다 새 마감(5 s)을 기다리며 선박
  상태를 보내지 않고, 한 세션이 선박을 연달아 바꾸면 서로 다른 키의 읽기를 여럿 올린다. 세션이 settled 까지 들고 있고 다음 읽기를 그 뒤에 두는 쪽을 골랐다.
- **ship_selected 에 '조회 중' 상태를 싣는다**: 스키마 두 사본 · 웹 검증기 · 표본이 늘지만, 사용자에게 보이는 것은 이미 "—" 와 같다.
- **항공기 `selected` 의 노선(Redis — 3 s 상한, 5 s 캐시)도 같이 옮긴다**: 같은 모양이지만 이 결정의 범위 밖이다(남은 일로 적는다). → 같은 날 개정
  (계약 v5 §G21 — 아래 '개정' 절)에서 옮겼다.

## 결과
- 지표: `wakeline_ws_ship_lookups_total{outcome=ok|deadline|rejected|error|skipped}` · `wakeline_ws_ship_lookup_seconds` · `wakeline_ws_ship_lookup_queue` ·
  `wakeline_ws_ship_lookup_dropped_total`(답을 보내지 않은 조회) · `wakeline_cache_requests_total{cache=stored_static|portcalls,result=hit}`(진행 중인 읽기에
  붙은 것 포함) · `hikaricp_connections_*{pool="wakeline-read"}`.
- 시험: `ShipSelectionLookupTest`(마감 뒤 다시 계산 넷 → 읽기 하나 · 스레드 하나 · 끝나면 곧바로 실제 값 / 한 세션이 선박 넷을 바꿈 → 실행기 작업 하나 ·
  바뀐 물음은 읽지 않음 / 세 세션 한 선박 → 스레드 하나) · `StoredStaticReaderTest` · `PortCallReaderTest`(future 합치기 · 거절은 표시를 남기지 않음) ·
  `ReadPoolTest` · `ReadPoolDbTest`(멈춘 서버 → 소켓 5 s).
- 설정: `wakeline.read-pool.size`(4) · `wakeline.read-pool.connection-timeout-ms`(2,000) — application.yml.
- 되돌리기: 이 변경의 커밋을 되돌린다 — 읽기가 우편함으로 돌아오고 읽기 풀이 없어진다(스키마 · 데이터 변화 없음).

## 개정(2026-09-30 · 계약 v5 §G21): 선택 항공기 노선의 Redis 읽기도 우편함 밖으로
사용자 요청 "항공기 노선 조회도 권장 방안으로 진행해" — 위 대안의 마지막 항목(남은 일)을 같은 구조로 옮긴다.

### 맥락
- `WsHub.sendSelected`(우편함 작업 — 선택 · 팬아웃 · focus 관측 · 초기 세트)가 selected.route(계약 v4 §A)를 `RouteReader.forAircraft` 로 그 자리에서 읽었다:
  Redis GET `wakeline:route:{CALLSIGN}` — 명령 상한 `spring.data.redis.timeout` 3 s, 콜사인별 5 s 메모리 캐시(실패도 5 s 기억).
- 그래서 Redis 가 느리거나 답하지 않는 동안 선택 항공기 하나가 그 세션의 pong · 항공기 · 선박 diff · heartbeat 를 읽기 한 번마다 최대 명령 상한만큼 붙잡고,
  캐시가 지날 때마다 되풀이했다. `RouteSelectionLookupTest` 의 첫 시험이 옛 API 로 먼저 재현했다(GET 을 막은 동안 pong · diff 가 5 s 안에 오지 않음 —
  timed out).
- Redis 연결이 어떻게 기다리는가(`config.RedisConfig` — 코드에서 확인, 설정값 · 라이브러리 기본값이지 잰 값이 아니다): 기본 연결은 `RedisConfig` 가 만든
  `LettuceConnectionFactory` 다. 사용자 정의 팩토리가 있으면 Boot 의 Redis 자동 구성이 물러나므로(spring-boot-data-redis 4.1.1 의
  `@ConditionalOnMissingBean(RedisConnectionFactory)`), `spring.data.redis.*` 중 `RedisConfig` 가 읽지 않는 키(예: `connect-timeout`)는 효과가 없다.
  - 명령 상한: `RedisConfig` 가 `spring.data.redis.timeout`(application.yml 3s, 없으면 3s)을 읽어 Lettuce 명령 상한으로 둔다. 연결은 살아 있는데 서버가
    답하지 않거나(멈춤 · 과부하) 끊긴 줄 모르면(패킷이 사라짐) 명령마다 이만큼 기다린다.
  - 끊긴 것을 아는 연결: `DisconnectedBehavior.REJECT_COMMANDS` 라 자동 재연결 동안 명령은 기다리지 않고 곧바로 실패한다.
  - 연결 맺기: 연결 상한은 설정하지 않아 lettuce-core 7.5.2 의 `SocketOptions.DEFAULT_CONNECT_TIMEOUT` 10 s 다. 공유 연결은 처음 쓸 때 맺고
    (`eagerInitialization` 을 켜지 않았다), 맺지 못했으면 다음 명령이 다시 맺는다 — 그때만 시도마다 ≤ 10 s 가 더해진다. 시도는 팩토리 잠금 안에서
    하나씩이라(spring-data-redis 4.1.1 `SharedConnection.getConnection` → `doInLock`) 그동안 다른 스레드의 명령은 앞 시도들을 기다린다.

### 결정
1. **같은 틀을 나눠 쓴다 — 복사하지 않고 일반화했다.** `ShipLookups` 에서 선박에 매이지 않은 부분(캐시 · 비동기 읽기 출처 `Source`, 답 · 끝남 `Flight`,
   차례 · wanted · 거절 · 예외 표시 `Reads`, 마감, 지표, 세션 쪽 세대 `Pending`)을 `ws.SelectionLookups` 로 옮기고, `ShipLookups`(두 단계 사슬 — 저장 정적
   보고 → 입출항)와 `RouteLookups`(한 단계 — 콜사인 → 노선)가 그 위에 제 사슬과 '읽지 못함' 값만 둔다. 까닭: 마감 · settled 순서 · 드롭 셈처럼 틀리기 쉬운
   순서가 두 벌로 갈라지지 않게. `ShipLookups` 의 동작 · 지표 이름은 그대로다(옮긴 뒤 선박 시험 그대로 통과).
2. **실행기는 따로 둔다(격벽).** 선박 실행기의 스레드 수는 DB 읽기 풀 연결 수에 맞춘 값이다(스레드마다 연결 하나). Redis 가 멈추면 노선 읽기가 스레드를
   명령 상한만큼 잡는데, 같은 실행기면 선박 DB 조회 스레드를 잡는다. 노선 실행기: 데몬 스레드 4(`route-lookup-N` — **고른 값, 잰 값 아님**: Lettuce 는
   연결 하나를 여러 스레드가 나눠 써 스레드 수가 Redis 연결 수와 무관하다. Redis 가 멈춘 동안의 처리량은 4 / 3 s ≈ 1.3 읽기/s 이고 그래도 답은 마감에 나간다),
   대기열 max(256, `wakeline.ws-max-conn`), 가득 차면 `AbortPolicy` → 읽지 않고 unavailable 로 곧바로 답하고 센다(`outcome=rejected` — 기억하지 않는다).
3. **우편함은 캐시만 본다.** `RouteReader.cached`(I/O 없음). 없으면 세션의 조회(같은 물음)의 답, 그것도 없으면 조회를 맡기고 selected 를 **곧바로** 보낸다 —
   route 는 pending("노선 조회 중"), 다만 이 세션에 이미 보낸 같은 물음(같은 항공기 · 같은 콜사인)의 값이 있으면 그 값(5 s 캐시가 지나 다시 읽는 중 — 화면이
   5 s 마다 "조회 중" 으로 깜박이지 않게). 답이 오면 `SELECTED_ROUTE` 우편함 작업이 다시 계산해 바뀌었으면 보낸다. 다시 읽는 동안 보던 값을 두는 것은 옮기기
   전과 같다 — 그때도 다시 읽기가 끝나야 selected 가 나갔으므로 화면은 그동안 보던 값이었다. 그 값은 이 세션이 마지막으로 받은 답이고, 새 답이 오면
   (unavailable 포함) 늦어도 마감에 정해져 바뀐다. 처음 묻는 물음(다른 항공기 · 바뀐 콜사인)은 늘 pending 부터다.
4. **마감 = Redis 명령 상한.** api 는 늦어도 물음 뒤 Redis 명령 상한(운영 3 s — 설정값)에 답을 정한다. 설정 식은 한 곳 `RedisConfig.COMMAND_TIMEOUT`
   (`${spring.data.redis.timeout:3s}`)이고 `RedisConfig.commandTimeout`(Boot 의 Duration 해석과 같은 `DurationStyle` — 단위가 없으면 ms)으로 읽는다 —
   기본 연결의 Lettuce 명령 상한 · 이 마감(WsHub) · REST 기다림(RouteReader — 아래 7)이 같은 식 · 같은 값이다. 해석할 수 없거나 0 이하면 기동하지 않는다.
   끝나지 않았으면 unavailable("노선 조회 실패" — 계약 v4 §A 의 'Redis 오류'). 읽기는 계속돼 캐시를 채우고, 마감 뒤에 끝나면 곧바로 다시 계산해 실제 값을
   보낸다. 정한 답은 `SELECTED_ROUTE` 우편함 작업으로 나가므로 화면에 닿는 때는 그 세션 우편함의 차례다 — Redis 가 멈춘 동안에는 앞선 status 작업(아래
   '남은 것')이 먼저 기다릴 수 있고, 그 상한은 말하지 않는다.
5. **세대 · 단일 비행은 선박과 같다.** 물음 = (hex, 정규화한 콜사인). 다른 항공기 · 선택 해제 · 콜사인 바뀜 · 세션 닫힘이면 그 답은 버리고 답을 보내지 않은
   조회를 센다. 세션의 다음 읽기는 앞 조회가 settled 된 뒤 시작하고 그사이 바뀐 물음은 읽지 않는다(세션마다 실행기 작업 하나 이하 — 대기열이 연결 상한 안에서
   넘치지 않는다). 같은 콜사인은 세션을 가로질러 Redis 읽기 하나(`RouteReader` 의 `SingleFlight` — REST 항공기 상세도 붙는다, 기다림의 상한은 7). 캐시
   시각은 읽기가 끝난 때.
6. **WS 계약은 그대로**(키 · 값 · 스키마 · 웹 검증기 · 표본 변화 없음). pending 의 뜻만 넓어진다 — '수집기가 아직 쓰지 않음' 에 'api 가 그 결과를 읽는 중'
   (답은 ≤ 3 s 에 정해진다)이 더해졌다. 웹의 "노선 조회 중" 설명(title)이 그 읽기와 상한을 적고, 그 상한은 api 가 답을 정하는 때이지 화면에 닿는 때가 아니라고
   적는다(Redis 가 멈춘 동안은 더 걸릴 수 있다 — `lib/route.ROUTE_API_READ_BOUND_S`, 시험이 application.yml · RedisConfig 와 대조).
7. **(리뷰 뒤) REST 의 기다림에도 상한 · 닫을 때 버린 읽기는 끝낸다.** `SingleFlight` 는 진행 중 표시를 실행기에 올리기 전에 두므로, REST 항공기 상세
   (`RouteReader.forCallsign`)가 아직 노선 조회 실행기의 대기열에 있는 WS 읽기에 붙을 수 있다 — Redis 가 멈추면 대기열 순서만큼(스레드 4, 한 읽기 ≤ 3 s)
   상한 없이 기다렸다(시험: 스레드 하나가 멈춘 읽기를 잡은 동안 대기열의 읽기에 붙은 REST 가 8 s 에 timed out). 이제 붙은 쪽은 Redis 명령 상한까지만
   기다리고 unavailable 로 답하며 센다(`wakeline_route_read_wait_timeouts_total` — 그 읽기는 건드리지 않아 제 값으로 캐시를 채운다). REST 가 표시를 얻었으면
   전처럼 제 스레드에서 한 번 읽는다(≤ 명령 상한). 또 `SelectionLookups.close`(WsHub.stop)의 `shutdownNow` 가 대기열에서 버린 읽기는 돌지 않아 그 future 가
   끝나지 않고 표시가 남았다 — 같은 콜사인의 REST 가 끝나지 않는 future 에 붙었다(WsHub 는 Tomcat 의 우아한 종료보다 먼저 멈춘다). 버린 읽기는
   `SingleFlight.abandon` 으로 거절처럼 끝내고 표시를 지운다(선박 조회도 같은 틀이라 같이 고쳐졌다).

### 새 최악(설정값에서 — 잰 값 아님)
| 경우 | 전 | 후 |
|---|---|---|
| 그 세션의 pong · diff · heartbeat ping | 노선 읽기 뒤에 선다(읽기마다 ≤ 3 s, 공유 연결을 아직 맺지 못했으면 연결 맺기 — 시도마다 ≤ 10 s, 잠금 안에서 하나씩 — 가 더해진다 — 5 s 마다 되풀이) | 노선 읽기를 기다리지 않는다(`RoutePausedRedisTest` 가 멈춘 Redis 에서 각 500 ms 미만을 단언) |
| 첫 selected(노선이 캐시에 없을 때) | 읽기가 끝날 때 | 곧바로 — route pending |
| api 가 노선의 답을 정하는 때 | 읽기가 끝날 때 | ≤ 3 s(마감), 읽지 못하면 unavailable — 읽기가 끝나면 곧바로 실제 값. 화면에 닿는 것은 그 세션 우편함의 차례(Redis 가 멈춘 동안은 status 작업 뒤 — '남은 것') |
| REST 항공기 상세의 노선 | 제 스레드에서 GET(≤ 3 s — 공유 연결을 맺어야 하면 연결 맺기가 더해진다) | 같음. 다른 쪽의 읽기에 붙으면 ≤ 3 s 기다리고 unavailable · 센다(결정 7) |
| 노선 실행기 포화(4 + max(256, 연결 상한)) | — | 곧바로 unavailable · 센다 — 세션마다 작업 하나 이하라 연결 상한 안에서는 넘치지 않는다 |
| 스레드 하나를 잡는 시간(읽기 하나) | — | ≤ 3 s(서버가 답하지 않을 때) · 곧바로(끊긴 것을 아는 연결 — REJECT_COMMANDS) · 공유 연결을 아직 맺지 못했을 때는 연결 맺기(시도마다 ≤ 10 s, 잠금 안에서 하나씩 — 앞 시도들을 기다린다) + 3 s. 어느 쪽이든 WS 답은 마감에, REST 는 붙었으면 ≤ 3 s |

**남은 것(이 개정의 범위 밖 — 같은 종류)**: heartbeat · 초기 세트의 status 메시지는 여전히 우편함에서 Redis 를 읽는다 — `WsHub.statusPayload`
(3 s 캐시)가 허브 전체 잠금(`statusLock`) 안에서 `StatusService.publicStatus` 를 부르고, 그 안의 `safeHash` 셋(collector heartbeat · radar_kr meta · active
providers — HGETALL)이 각 명령 상한 3 s 를 기다릴 수 있다(설정값의 합 ≤ 9 s, 잰 값 아님). Redis 가 멈춘 동안에는 heartbeat 주기(30 s)마다 한 세션이 그만큼
만들고 다른 세션의 heartbeat · 초기 세트 작업은 그 잠금을 기다린다 — 노선과 같은 방법(우편함 밖에서 만들고 우편함은 만든 값만 본다)으로 옮길 일이다.
연결 맺기 상한도 `RedisConfig` 가 설정하지 않는다(Lettuce 기본 10 s — 공유 연결을 맺을 때만, 모든 Redis 사용자에 걸린다). `spring.data.redis.connect-timeout`
을 적어도 효과가 없다 — `RedisConfig` 가 제 팩토리를 만들어 Boot 의 Redis 자동 구성이 물러나고, `RedisConfig` 는 이 키를 읽지 않는다.

### 결과
- 지표: `wakeline_ws_route_lookups_total{outcome=ok|deadline|rejected|error|skipped}` · `wakeline_ws_route_lookup_seconds` · `wakeline_ws_route_lookup_queue` ·
  `wakeline_ws_route_lookup_dropped_total` · `wakeline_cache_requests_total{cache=route,result=hit}`(진행 중인 읽기에 붙은 것 포함) ·
  `wakeline_route_read_wait_timeouts_total`(REST 가 붙은 읽기를 명령 상한까지 기다렸지만 끝나지 않아 unavailable 로 답한 수 — 결정 7).
- 시험: `RouteSelectionLookupTest`(pending 동안 pong · diff · heartbeat 주기 · 마감의 unavailable 과 늦은 실제 값 · 마감 뒤 다시 계산은 새 읽기 없음 · 늦은 답
  버리기(다른 항공기 · 해제 · 콜사인 바뀜 · 세션 닫힘) · 포화 · 세션을 가로지른 한 읽기 · 항공기를 바꿔도 작업 하나 · 다시 읽는 동안 깜박이지 않음 · 배선 ·
  명령 상한을 읽는 곳이 모두 `RedisConfig.COMMAND_TIMEOUT` · 닫을 때 버린 읽기는 거절로 끝나고 REST 가 곧바로 제가 읽음) · `WsIntegrationTest`(스프링이 만든
  허브의 마감 = 속성 2500ms) · `RedisConfigTest`(식 · 해석 · Lettuce 명령 상한) · `RoutePausedRedisTest`(Testcontainers Redis 를 docker pause — pong · diff ·
  heartbeat 각 < 500 ms, 시험이 고른 명령 상한 1.5 s 에 unavailable, 같은 동안 REST 도 그 안에 unavailable, 다시 풀면 found) · `RouteReaderTest`(캐시만 읽기 ·
  한 읽기 · 거절은 기억하지 않음 · 캐시 시각 · 대기열의 읽기에 붙은 REST 는 명령 상한에 unavailable · 운영 생성자가 속성에서 상한을 읽음).
- 되돌리기: 이 개정의 커밋(route 조회 이동 · 웹 설명 · 문서)을 되돌린다 — 노선 읽기가 우편함으로 돌아온다(스키마 · 데이터 · 설정 변화 없음). 공통 틀
  (`SelectionLookups` 추출)은 선박 조회만으로도 그대로 쓸 수 있다.
