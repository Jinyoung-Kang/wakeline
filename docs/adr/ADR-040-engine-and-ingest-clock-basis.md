# ADR-040 판정 · 순서의 시계 기준 — 기체 신선도 · 부재는 데이터 시각으로, 벽시계 역행은 '미래에 있는 지금 값'으로 알아본다

**상태** 채택 · 2026-10-18 · 사용자 위임("권장안대로 끝까지 진행") · 근거 [개선 계획](../improve/PLAN.md) IM-07 · IM-08 ·
[VERIFICATION](../VERIFICATION.md) #147 · 함께 보는 기록: [ADR-010](ADR-010-predicted-vs-observed.md)(관측 대 예측) · [ADR-018](ADR-018-system-log-pipeline.md)(로그 읽기의 미래 허용 60 s) ·
[ADR-032](ADR-032-redis-breaker-write-backlog.md) · [ADR-033](ADR-033-ais-positions-during-redis-outage.md)(Redis 장애) · 감사 REL-8(fetched_at 단조 가드)

## 맥락
api 는 두 군데에서 벽시계를 썼고, 둘 다 '수집기가 보낸 시각'과 'api 가 처리하는 시각'이 거의 같다고 가정했다.
- **판정 엔진**(IM-07): 기체 위치가 '현재'인지(`AircraftState.fresh` — 60 s, OpenSky 300 s)와 스코프 피드가 멈췄는지를 `Instant.now()` 로 쟀다.
  Redis 장애 동안 수집기는 계속 조회하고, 실패한 XADD 를 로컬 큐(1,000건)에 두었다가 복구 뒤 원래 `fetched_at` 그대로 순서대로 보낸다.
  api 는 지금 값보다 새로운지만 보므로 그것을 실시간 스냅샷으로 받는다. 그런데 처음 몇 개는 벽시계로 이미 60 s 넘게 지난 위치라, 끊김 없이
  관측된 기체가 메시지마다 '부재'로 세어졌다. 재현(100 s 장애): R1 에서 예측 알림이 지워지고 R3 에서 진입 알림이 LOST(신호 소실)로 닫혔다가,
  R5 · R6 에 새 id 로 다시 열렸다 — 한 번의 통과가 알림 두 건이 되고, 앞 건은 체류 통계에서 빠지며, WS · `/watch` 에 거짓 '닫힘 · 진입'이 나갔다.
- **수신 가드**(IM-08): 실시간 상태는 '최신만 의미'라 `fetched_at` 이 지금 값보다 새 것만 받는다(REL-8 — 장애 뒤 백로그가 상태를 되감지 않게).
  이 판단이 7곳에 따로 있었다(StreamConsumer 사전 검사 2 · SnapshotStore region/global · hot 셀 · focus hex · SigmetStore · WarningStore · RadarStore).
  `fetched_at` 은 수집기의 벽시계이고 수집기와 api 는 한 호스트(로컬 Docker VM · AWS EC2 한 대)의 같은 시계를 쓴다. 그 시계가 실행 중 X 만큼 뒤로 가면
  (NTP 계단 보정 · 수동 변경 — 수집기는 폴링을 단조 시계로 잰다) 그 뒤 메시지가 모두 '오래됨'으로 버려져, 약 X 동안 지도 · 알림 판정 · 새 SIGMET ·
  특보 · 레이더가 말없이 멈췄다. 흔적은 debug 한 줄과 `stale_skipped` 지표뿐이었다. 이 환경에서 그런 계단이 얼마나 자주 생기는지는 재지 않았다.

## 결정
1. **판정의 '데이터 시각'**: `ref = min(now, 판정 뷰의 스코프(region · global · focus · hot) fetched_at 최댓값)` — 받은 적 없는 스코프(EPOCH)는 빼고,
   아무것도 없으면 `now`(`EngineService.dataTime`). `now` 로 묶어, 앞서 가는 수집기 시계가 판정을 앞당기지 못하게 한다.
2. **ref 로 재는 것**: 알림 상태 기계의 '현재 관측이 있는가'(`a.fresh(ref)` — 곧 부재 계수), 부재 계수가 쓰는 피드 멈춤 판단
   (`ViewScopes.feedStale` · `Cycle.regionFeedStale/globalFeedStale`), 관측 판정(`IntersectionEngine.observe`)의 위치 신선도, 예측 대상 고르기
   (`availability(a, ref)`), 선회 이력에 넣을 위치(`updateTurning` — 예측 대상과 같은 집합이어야 한다: 아니면 재전송 중 이력에서 빠진 선회 기체가 직진으로
   보여 예측이 생겼다 지워졌다).
3. **now 그대로 두는 것**: 구역의 유효 시간(`validAt`) · 만료 · 철회(`Cycle.ended`, `rebuildForExpiry` — 모든 기체 피드가 멈춘 동안에도 만료된 SIGMET 의
   알림을 닫는다, DH-6), 사건 시각(`entered_at` · `left_at` · `judged_at`)과 근거의 `position_age_s`, 예측의 추측 항법과 `eta_s` · `eta_at`(계약:
   `eta_at = judged_at + eta_s`), 병합 뷰 자체(`SnapshotStore.view(now)` — WS · REST 가 같이 쓴다)와 `coverage_ended`, WS `selected` 의 예측 가능 여부
   (브라우저의 벽시계 STALE 표시와 맞춘다).
4. **예측 지평**: 예측 진입은 `ref` 에서 10분(`PREDICT_HORIZON_S`) 안이어야 한다. 신선도를 ref 로 재고 진행은 now 까지 하면, 기체 피드만 멈추고 SIGMET 은
   오는 동안 다시 판정할 때 멈춘 위치를 장애 시간만큼 밀어 새 예측을 만들었다(가드를 뺀 시험에서 15분 된 위치로 새 PREDICTED). ref = now 이면 아무것도
   하지 않는다(eta ≤ 600 s 그대로).
4-1. **새로 여는 것은 now 기준 신선한 위치로만**(독립 검토 R2): 아직 아무 관측도 세지 않은 트랙의 첫 셈과 새 예측(PREDICTED)은 `a.fresh(now)` 일 때만이다.
   모든 기체 피드가 멈춰 ref 가 멈춘 동안 새 구역(SIGMET 수신 · 공역 판 교체)이 멈춘 위치를 덮으면, 그 위치가 ref 로는 '현재'라 진입 확정의 첫 관측이 되거나
   예측이 열렸다 — '모든 피드가 멈추면 아무것도 바꾸지 않는다'를 깬다. 이미 있는 것(셈이 시작된 트랙 · 열린 예측)의 유지 · 부재는 ref 그대로라 재전송 수정은 유지된다.
   재전송 동안 새로 구역에 들어간 기체는 재전송이 now 근처에 닿은 뒤에 확정된다(예전 동작).
5. **수신 가드 한 곳**: 7곳 모두 `platform.support.FetchedAtGuard.judge(candidate, current, nowMs)` 를 쓴다(`*.core` 가 import 해도 되는 유일한 기능 없는
   패키지 — ArchitectureTest). 저장소는 시계를 읽지 않고 `nowMs` 를 받는다(`ShipStore.apply(nowMs)` 와 같은 방식).
6. **벽시계 역행을 알아보는 규칙**: 같은 호스트에서는 지금 값의 `fetched_at` 이 api 의 지금보다 미래일 수 없다(수집기가 받은 뒤에 api 가 처리한다).
   그래서 지금 값이 지금보다 60 s(`CLOCK_BACK_TOLERANCE_MS` — ADR-018 의 로그 읽기 미래 허용과 같은 값) 넘게 미래이고 받은 값은 지금 + 60 s 이하이면
   시계가 뒤로 간 것으로 보고 받는다 — 단 받은 값도 지금 − 60 s 이상이어야 한다(아래 한계 — 독립 검토 R3: 없으면 지금 값이 미래인 동안 아주 오래된 PEL · 백로그
   엔트리가 받아들여져 실시간 상태를 되감았다). 받는 순간 지금 값이 지금 근처로 내려와 그 뒤는 평소처럼 돈다. 지금 값이 과거인 재전송 · 백로그 · 중복은 그대로
   거부하고, 계단 전에 쓴 엔트리 중 그 자신도 60 s 넘게 미래인 것(PEL 재처리 · 직전 값의 중복)도 거부한다. 선박의 봉투 `fetched_at` 표식도 같은 규칙이다.
6-1. **알림 상태 기계의 '같은 관측' 판단도 같은 규칙**(독립 검토 R1): 트랙마다 `seen_at` 이 지난번보다 새로울 때만 세는데, 시계가 뒤로 가면 새 관측의
   `seen_at` 도 작아진다(수집기는 공급자 시각이 어긋나면 수신 시각을 쓴다). 그 비교를 `FetchedAtGuard`(seen_at · 판정 시각 now)로 해, 역행 뒤 이미 추적 중인 기체의
   이탈 · 확정이 약 X 동안 멈추지 않게 한다. 역행 전 관측을 다시 판정하는 것(미래 seen_at)은 여전히 세지 않는다.
7. **알림**: `wakeline_stream_clock_back_total{scope}`(region · global · hot · focus · sigmet · wx_warnings · radar, 0 으로 미리 등록) — 역행으로 받은 메시지
   수. 스코프마다 WARN 한 번, 그 뒤 10분은 세기만 한다(단조 시계로 잰다 — 틀린 것이 벽시계다).

## 버린 대안
- **수신 시각으로 다시 매기기**(api 가 받은 때를 관측 시각으로): 재전송된 오래된 위치가 '방금 관측'이 되어 정직성 규칙(관측 시각을 그대로 적는다)을 깬다.
- **재전송 메시지를 판정에서 빼기**(늦게 온 것은 기록만): 그동안의 진입 · 이탈을 놓친다 — 장애 뒤 알림이 늦게 열리거나 아예 열리지 않는다.
- **엔진 전용 병합 뷰(ref 로 만료)**: focus · hot 전용 기체도 ref 로 남긴다. 스냅샷마다 약 9,000 항목을 한 번 더 합치는 성능 변경이라 재지 않고는 하지 않는다(아래 '남은 것').
- **수신 순서를 Redis 스트림 id 로**(시계에 기대지 않음): 스트림 id 는 Redis 시계로 단조다. 그러나 hot 셀 · focus hex 단위의 순서와 부트스트랩(최신 엔트리부터)을
  다시 설계해야 해 범위가 크다. 지금 구성(한 호스트 · 한 시계)에서는 결정 6 으로 충분하다.
- **허용치를 더 작게**(예: 5 s): 정상 운영의 전달 지연 · 처리 지연과 겹친다. 60 s 보다 작게 뒤로 간 경우는 예전처럼 그 폭(폴링 간격을 빼고)만큼 기다린다.

## 결과 · 감수한 단점
- 시험: `EngineServiceTest`(주입 시계 · StreamConsumer 와 같은 replaceIfNewer 경로 — 100 s 장애 뒤 재전송이 알림 하나로 남는다 · 선회 기체 · 살아 있는 피드의 멈춘
  위치는 여전히 LOST · 기체 피드만 멈춘 동안 SIGMET 재판정 · 데이터 시각 계산), `AlertStateMachineTest` · `IntersectionEngineTest`(ref 와 now 의 나눔 · 예측 지평),
  `FetchedAtGuardTest` · `SnapshotStoreTest` · `StreamConsumerTest`(7개 상태 · 지표 · 스코프마다 WARN 한 번) · `ShipStoreTest`. 기존 시험(stalePosition · globalFeedStale ·
  totalOutage · dh2 · REL-8 거부)은 그대로 통과한다.
- 정상 운영에서 신선도 기준이 전달 지연(수 초, SIGMET 이 부른 판정에서 길게 약 10 s)만큼 느슨해진다.
- 남은 것: 병합 뷰는 벽시계라, 따라잡기가 focus 60 s · hot 90 s(장애가 10분을 넘으면 global 600 s)보다 길면 그 피드로만 보이는 기체는 여전히 부재로 셀 수 있다
  (관심 지역 기체는 나이로 거르지 않고, focus · hot 기체는 대개 300 s 안의 global 관측도 있다). 벽시계 역행 뒤 SIGMET · 특보 **이력** 저장의 중복 막기
  (`SigmetRepository` · `WarningRepository` 의 lastSetAt)와 `/healthz` 의 'no_region_snapshot'(지금 값이 미래일 때 — 공개 사유라 그대로, 이제 길어야 관심 지역 한 주기)은
  같은 원인이 남은 곳이다. 역행 뒤 곧바로 LEFT 가 나면 `left_at`(판정 시각 now)이 `entered_at` 보다 이를 수 있다(300 s 역행 시험에서 약 270 s) — 체류 통계에 음수
  체류가 섞일 수 있다(DB 제약 없음 · 자르지 않았다). 지금 값이 미래인 동안 api 가 60 s 넘게 늦게 처리하는 계단 뒤 값은 받지 않는다(결정 6 의 아래 한계 — SIGMET · 특보는 다음 폴링을 기다린다). 수집기를 시계가 60 s 넘게 앞선 다른 호스트에 두면 오래된 재전달을 역행으로 볼 수 있다(지금 구성에는 없다).
