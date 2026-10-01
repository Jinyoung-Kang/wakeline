"""기상청 레이더 합성 수집(5분): 목록에서 저장된 최신 프레임보다 새 tm 만 고르고 → 바이너리 → 해석·웹 메르카토르 PNG → Redis(최근 12프레임).
활용신청 전(403)에는 사유만 상태에 남긴다. 격자·투영은 문서 값(kma_grid.py 참조)만 쓴다.

- 예산: budget:kma_radar(한도 settings.budget_kma_radar)로 목록·바이너리 호출을 모두 예약한다. Redis 가 안 되면 호출하지 않는다.
- 후보: 보관 창(현재 이하 목록의 최신 12개) 안에서 아직 저장되지 않은 tm 중 최신 4개(R-03). 저장된 최신보다 오래됐어도
  창 안의 빈 프레임(늦게 생긴 프레임·일시 오류로 놓친 프레임)은 채우고, 창보다 오래된 프레임은 받지 않는다.
- 옛 tm(지금에서 영상 TTL FRAME_TTL_S = 3 h 넘게 지난 tm — 도전 2026-10-01 · 레인 kma 7차): 목록이 멈췄는데 파일은 있으면 영상이 만료된 뒤 보관 창의 옛 tm 을
  다시 받아 저장했고, meta fetched_at(STALE 시계 — latest_tm 을 처음 저장한 시각)을 지금으로 옮겨 몇 시간 지난 영상이 STALE 없이 보였다(3 h 마다 되풀이).
  이제 (1) 옛 tm 중 이미 파일이 있던 tm(meta latest_tm 이하 · 이 프로세스가 받아 본 옛 tm 이하)은 고르지 않는다 — 받아 본 적 없는 옛 tm 은 고른다(다시 띄운
  수집기가 버린 연속을 R-03 으로 다시 여는 길). (2) gzip 을 받은 옛 tm(연속의 확인 — 목록이 멈춘 동안의 옛 tm)은 연속을 닫되 저장하지 않는다(보이지 않는다 ·
  INFO 한 줄). (3) meta fetched_at 은 앞선 latest_tm 보다 새 tm 을 저장할 때만 옮긴다(같은 tm 을 다시 받은 것은 새 프레임이 아니다).
  경계는 3 h 다(리뷰 2026-10-01 · 레인 kma 8차 — 뜻을 적고 시험으로 못 박았다): 3 h 안의 tm 이 목록이 멈춘 뒤 새 latest_tm 이 되면(22:35 에 19:50 등) 저장하고
  fetched_at 은 그 저장 시각이다 — 그 tm 을 처음 저장한 때가 그때다. 그 뒤 15분은 STALE 이 없다. 앞선 fetched_at 을 두면 웹 '최신 tm 첫 수집'이 그 tm 을 받은
  적 없는 시각을 말하므로(짓는 값) 고르지 않았다.
- 목록에 있으나 바이너리가 아직 없는 tm("file not exist" 등 gzip 아닌 응답)은 일시 상태다. tm 마다 MAX_NOT_READY_TRIES 번까지
  다음 주기에 다시 받고, 그래도 없으면 품질 이벤트(kma_radar_missing)를 남기고 건너뛴다. 해석 불가(_BadFrame·크기 초과)만 바로 제외한다.
- '파일 없음' 연속(운영 로그 2026-09-30 — 목록은 EXT 로 계속 싣는데 내려받기는 08:15 KST 부터 모든 tm 에 "file not exist (RDR_CMP_HSR_PUB_…)"):
  tm 이 MAX_NOT_READY_TRIES 번 없다고 답했고 그보다 새 파일이 없으면(저장된 프레임 · 같은 주기에 받은 파일 — 주기의 후보를 모두 본 뒤에 가린다:
  후보는 오래된 것부터라 한 tm 씩 바로 가리면 뒤이어 온 R-03 의 늦은 파일을 보기 전에 연속을 열었다, 리뷰 2026-09-30) 연속(MissingStreak — 첫 tm ·
  없다는 답을 받은 tm 수 · 마지막 확인 · 답의 파일 이름 · 목록의 종류)을 연다. 첫 tm · 수에는 이 프로세스에서 없다는 답을 받은, 파일이 있던 가장 새
  tm 보다 새 tm 을 모두 넣는다(세 번을 채우기 전에 후보에서 밀려난 tm 포함 — 다시 띄운 수집기가 연속 한가운데서 시작해도 첫 tm 이 늦지 않게).
  연 순간 WARN 한 번, 그 뒤로는 MISSING_REMIND_S(60분, 선택값)마다 한 번만 WARN.
  연속 동안은 옛 tm 마다 세 번씩 부르지 않고 주기마다 두 tm 만 확인한다(streak_probes — 저장 안 됨 · 해석 불가 아님): 목록의 가장 새 tm 과
  MISSING_RECHECK_S(10분, 선택값 — R-03 의 마지막 시도 나이) 넘게 앞선 가장 새 tm. 뒤의 것은 목록이 먼저 싣고 파일은 늦게 생기는 tm(R-03)
  때문이다 — 가장 새 tm 하나만 보면 회복 뒤에도 그 tm 은 아직 없어서 연속이 닫히지 않았다(리뷰 2026-09-30). 예산: 목록 1 + 확인 2 = 주기당 3,
  하루 3 × 288 = 864(+ KST 자정 직후 창 3 — streak_calls_per_day) < 한도 1,000(설정값 계산 — 전에는 목록 1 + 바이너리 4). 둘 중 어느 것이든 gzip 을 받으면 INFO(공백 길이)로 닫고
  다음 주기부터 전처럼 보관 창의 빈 곳을 다시 시도한다 — 그 공백 안의 tm 을 포기할 때는 이미 알렸으므로 INFO(알린 공백은 meta 해시
  missing_gap_* 에도 남겨 다시 띄운 수집기도 읽는다 — 끝 tm 이 3 h 넘으면 버린다). 더 새 파일은 받았는데(같은 주기에 받은 것 포함) 한 tm 만
  없으면 연속이 아니다(전처럼 그 tm 에 WARN 한 번).
  연속은 meta 해시와 공급자 해시(wakeline:provider:kma_radar)의 missing_* 에 싣고(api /radar/kr · /status · /ops/providers), 닫으면 빈 값으로
  지운다. 수집기를 다시 띄우면 마지막 확인이 MISSING_CARRY_S(15분, 선택값 — 늦춘 연속은 확인 간격 × 3, 아래 '긴 연속의 확인 간격') 안인 연속만
  이어받는다(아니면 그 주기 첫머리에 지운다 — 옛 연속을 지금처럼 보이지 않게. 주기가 'error' · 예산 상태로 끝나도 — 리뷰 2026-10-01). KMA_APIHUB_KEY 가 없어 수집하지 않으면 남은 연속 · 알린 공백을 지운다. 수집기가 아예
  멈추면 지울 주체가 없다 — 웹이 마지막 확인의 나이로 '확인 멈춤'을 적는다(이어받기와 같은 기준 — 5분마다면 15분, 늦춘 연속은 45분). 연속의 tm 수(missing_tms)는 없다는 답을 받은 서로 다른 tm 수 — 확인하지 않은 tm 은 세지 않는다.
- 긴 연속의 확인 간격(운영 2026-09-30 — 기상청이 08:15 KST 부터 모든 바이너리 합성에 'file not exist' 로 답했고 언제 돌아올지 알리지 않았다. 연속 동안에도
  5분마다 목록 1 + 확인 2 를 불러 18:34 KST 에 예산 417 / 1,000 — 하루가 끝나기 전에 한도를 넘을 속도였다): 연속의 나이(첫 tm 부터 지금까지, KST 벽시계)가
  MISSING_SLOW_AFTER_S(60분, 선택값) 이상이면 MISSING_SLOW_EVERY_S(15분, 선택값) 이상인 주기의 가장 작은 배수(slow_probe_every_s)마다만 확인한다. 확인하는 주기는 전과 같다(목록 1 +
  확인 ≤ 2 — 둘째 확인을 두는 까닭은 위 '늦게 생기는 tm' 그대로다). 그 사이 주기는 기상청을 부르지 않고 실행 'waiting'(http 없음 · 오류 글자에 확인 간격과
  마지막으로 기상청을 부른 주기 뒤 지난 분 — 목록이 실패한 주기도 센다)을 남긴다 — 'missing' 은 기상청이 그 주기에 '파일 없음'으로 답했다는 뜻이라 쓰지 않는다. 확인 간격은 마지막으로 기상청을 부른
  주기(목록 예약 — 실패한 목록 포함)부터 센다. 지금 확인 간격은 연속 해시의 missing_probe_every_s(초 — 5분마다면 주기)로 싣는다(웹이 'N분마다 확인'을 적는다).
  파일이 다시 오면(확인하는 주기의 gzip) 연속이 닫히고 다음 주기부터 전처럼 5분마다다. '확인 멈춤'과 이어받기 상한은 확인 간격 × MISSING_STALE_PROBES
  (3, 선택값 — 전의 15분 = 5분 × 3 과 같은 규칙, 아래로는 MISSING_CARRY_S): 늦춘 연속은 45분(missing_carry_s). 이어받은 연속은 마지막 확인에서 간격을
  센다(다시 띄워도 곧바로 부르지 않는다). 예산(설정값 계산 — streak_calls_per_day): 연속만 이어지는 UTC 하루 5분마다 288 × 3 + 3 = 867(다시 부르기 최악 1,734),
  늦춘 뒤 96 × 3 + 1 = 289(최악 578) — 한도 1,000. +3 · +1 은 KST 자정 직후 창(00:00–00:14)의 확인 주기마다 하나 — 전날 목록을 더 읽고 확인도 둘일 수 있다
  (목록 2 + 확인 2 — 레인 kma 7차가 빠진 것을 더했다. 전에는 864 · 288(최악 576)이라 적었다). 최악은 호출마다 일시 오류 뒤 한 번 다시 부르기(확인에 필요한
  전날 목록 포함 — 아래 '일시 오류')다.
- 실행 기록 상태(주기마다 하나): 프레임을 저장했거나 새로 받을 tm 이 없으면 'ok', 새 tm 이 있었는데 저장한 프레임이 없으면 — 바이너리 예약이
  거절돼 멈췄으면 'budget_exhausted'(· 'budget_unavailable'), '파일 없음' 답이 있었으면 'missing', 해석 불가만이면 'quarantined'. 'ok' 가 아닌 주기는 공급자 성공(last_success_at · last_records)으로 적지 않는다 — 예산 사용량만 적는다
  (운영 화면이 '성공 5분 전 · 기록 0'으로 프레임이 멈춘 것을 가리지 않게).
- 목록만 읽은 확인(운영 2026-10-01 00:50 KST — 계약 v5 §G26 개정): '파일 없음' 연속 중 확인하는 주기에 목록은 답했는데 확인할 tm 이 없으면(목록이 자라지 않고
  빈 새 날 목록만 읽었다 등) 그것도 확인이다 — 연속의 마지막 확인을 옮기고, 실행은 'ok' 가 아니라 'missing'(오류 글자 'nothing to probe: the KMA listing …' —
  목록이 보인 것 · 연속 요약)이다(저장한 프레임이 없고 기상청에 새 파일도 없다 — 공급자 성공으로 적지 않는다). 연속 밖의 '새로 받을 tm 없음'은 'ok' —
  다만 아래 '연속 밖의 목록 멈춤'이 되면 'missing'.
  전에는 'ok' · http 200 · 마지막 확인 그대로라 웹이 '확인 멈춤'을 잘못 붙였고 운영 LAST SUCCESS 가 프레임 없이 갱신됐다. 확인마다(목록만 읽은 확인 · '파일 없음'
  답을 받은 확인) 목록이 보인 것을 연속에 싣는다: missing_list_tm(읽은 목록의 가장 새 tm — 그 시각 이하, 없으면 빈 값) · missing_list_newer(확인 전 last_tm
  뒤로 실은 tm 수 — 0 이면 목록도 자라지 않았다: 로그 · 오류 글자 · 웹이 '목록에도 … 뒤 새 tm 없음'을 적는다. 읽은 목록이 last_tm 의 날을 덮지 못했으면 빈 값 —
  짓지 않는다). 연속을 여는 주기는 둘 다 빈 값(첫 확인이 채운다). 목록 호출이 실패한 주기(504 · 시간 초과 — 오늘 목록, 그리고 확인에 필요한 전날 목록:
  아래 'KST 자정 직후')는 'error' — 확인하지 않았으니 둘 다 · 마지막 확인도 그대로다(그러면 '확인 멈춤'이 맞다). 확인에 필요한 전날 목록의 예산 예약이
  거절된 주기는 예산 상태('budget_exhausted' · 'budget_unavailable'), 전날 목록이 429 · 속도 상한이면 'throttled' — 둘 다 확인으로 치지 않는다.
- 연속 밖의 목록 멈춤(ListIdle — 리뷰 2026-10-01 · 레인 kma 8차, 계약 v5 §G26): '파일 없음' 연속이 없고, 읽은 목록(그 시각 이하)이 이 작업이 저장했거나 파일을
  받아 본 가장 새 tm(meta latest_tm · 받아 본 옛 tm) 뒤로 새 tm 을 싣지 않은 채 meta fetched_at(latest_tm 을 처음 저장한 시각 — 웹 · api 의 STALE 시계)이
  LIST_IDLE_AFTER_S(900 s — STALE 기준과 같은 값, 선택값) 넘게 지났으면, 받을 새 tm 이 없는 주기도 'ok' 가 아니라 'missing'(오류 글자 'no new frame stored —
  the KMA listing <날> has no tm after tm=<tm> (newest listed tm=… | no tm listed); newest frame tm=<latest_tm> first stored N min ago') — 공급자 성공으로 적지
  않는다. meta note 에 '기상청 목록에 tm <tm>(KST) 뒤 새 tm 없음'(tm 만 — 주기마다 바뀌는 값은 넣지 않는다)을 싣는다: 프레임이 모두 만료되면(저장 3 h 뒤 —
  옛 tm 은 다시 받지 않는다) 웹 패널 · 상세 표가 '사용 불가 — <note>'로 까닭을 적는다(전에는 '아직 수집되지 않음'). WARN 은 멈춤마다 한 번('no new frame —
  …') + MISSING_REMIND_S(60분)마다 한 번('still no new frame — …'), 목록이 그 tm 뒤를 다시 실으면 INFO 한 줄 · note 를 지운다. 전에는 목록이 멈추고 파일은
  있는 동안 주기마다 'ok' · 기록 0 · 공급자 성공 · WARN 없음이었다(§G22 가 연속 안에서 없앤 모양). 목록 실패 · 429 · 예산으로 멈춘 주기는 판정하지 않는다.
- 속도 상한(운영 로그 2026-09-30 — 기상청 HTTP 429 '현재 요청을 처리할 수 없습니다' 네 번, 모두 같은 주기의 앞선 요청 0.1–0.5 s 뒤): KMA 호출은 모두
  호스트 버킷(ratelimit.KMA_APIHUB_RPS 0.5 req/s · burst 1 — 선택값)을 지나 2 s 간격으로 나간다('파일 없음' 연속이 닫힌 뒤 보관 창의 빈 곳을 이어 받는
  묶음 포함). 429 는 HttpClient 가 그 호스트를 멈추고(Retry-After — 초 · HTTP-date — 가 있으면 따른다, 없으면 30 → 60 → 120 → 300 s) 이 작업은 그 주기의
  KMA 호출을 멈춘다(남은 tm · 다시 받기는 다음 주기). 실행은 'throttled'(http 429 · 쉰 초 · Retry-After 를 오류 글자에) — 공급자 오류가 아니므로
  공급자 last_error 에 적지 않는다(계약 v5 §G14: 공급자 오류는 'error' 만). WARN 한 줄. 쉼 때문에 보내지 않은 호출(속도 상한 Throttled — 다음 주기가
  쉼 안일 때)도 'throttled' · INFO(이미 알렸다) · 예산을 돌려준다. 그 밖의 속도 상한(대기 상한 · 대기열 상한)은 'throttled' · WARN.
  바이너리 중 멈춰도 주기 끝은 그대로 지난다(리뷰 2026-09-30): 이미 포기한 tm 의 품질 이벤트 · 격리 수는 그 실행 기록에, 프레임을 저장했으면 공급자
  성공, 같은 주기에 열고 닫은 '파일 없음' 연속의 발행, heartbeat. 정규 부분에 다른 까닭('파일 없음' 등)이 있었으면 오류 글자에 함께 싣는다.
  다시 받기(아래)의 429 도 같다 — WARN 한 줄 · 남은 다시 받기를 멈추고, 정규 부분이 'ok' 면 실행은 'throttled'(http 429), 아니면 그 상태 그대로
  오류 글자에 덧붙인다. 목록이 답했으니 정규 부분이 'ok' 면 공급자 성공은 적는다.
- KST 자정 직후(00:00–00:14)에는 전날 목록도 본다(전날 23:5x 프레임이 아직 보관 창 안이다). '파일 없음' 연속의 last_tm 이 전날 이전이고
  새 날 목록이 답했으나 아직 그 시각 이하의 tm 을 싣지 않았으면(빈 답) 그 뒤에도 확인하는 주기마다 본다(_streak_needs_prev_day — 운영 2026-10-01: 새 날
  목록이 비어 있는 동안 last_tm 뒤를 싣는 목록은 전날 것이다. 빈 새 날 목록을 '파일 없음'으로 세지 않는다 — 연속의 tm 수 · 마지막 tm 은 답을 받은 tm 만).
  새 날 목록 자체가 504 · 시간 초과면 전날 목록을 읽지 않는다 — 목록이 실패한 주기('error' · 아무것도 옮기지 않는다, 확인 간격 × 3 뒤 '확인 멈춤')다. 그때
  확인은 전날의 가장 새 tm 하나다(지금 −10분이 전날 tm 을 모두 넘어 둘째 확인이 첫째와 같다) — 목록 2 + 확인 1 = 주기당 3 그대로. 이 전날 목록은
  확인에 필요한 목록이라(자정 직후 창 안이어도) 호출이 실패하면(504 · 시간 초과 — 시간 초과 · 연결 실패는 5 s 뒤 한 번 다시 부른 뒤, 아래 '일시 오류')
  'error'(전날 목록 단계 · 공급자 오류 · WARN), 예산이
  없으면 예산 상태 — 둘 다 마지막 확인 · 목록 필드를 옮기지 않는다(리뷰 2026-10-01 — 전에는 오늘 목록만으로 이어가 확인할 tm 이 없는 'missing' 으로 마지막
  확인을 옮겼다: 수집기가 몇 시간 동안 아무 tm 도 묻지 않았는데 '확인 멈춤'이 뜨지 않았다). 연속이 없어도 새 날 목록이 답했으나 비었고 이 작업이 저장했거나
  파일을 받아 본 가장 새 tm(남은 프레임 · meta latest_tm — 프레임이 만료돼도 남는다, 리뷰 2026-10-01 레인 kma 8차 · 받아 본 옛 tm)이 전날 끝(23:55)에 닿지
  않았으면 전날 목록을 읽는다(_behind_prev_day — 다시 띄운 수집기가 버린 연속을 R-03 으로 다시 연다). 그 주기가 읽을 것은 전날
  목록뿐이라 이것도 필요한 목록이다 — 실패하면 'error'(전날 목록 단계 · 공급자 오류 · WARN), 예산이 없으면 예산 상태(리뷰 2026-10-01 — 운영 02:23:54 KST 에
  ReadTimeout 인 주기가 WARN 'using today's only' 뒤 'ok' · 공급자 성공이었다: 기상청에 쓸 만한 것을 하나도 묻지 못한 주기가 §G22 가 없앤 모양으로 남았다).
  연속과 상관없고 그 주기에 다른 것이 있는(새 날 목록에 그 시각 이하의 tm 이 있거나 23:55 까지 저장했다) 자정 직후 창의 전날 목록만 덧붙이는 목록이라 예산이
  없거나 실패하면 오늘 목록만으로 주기를 계속한다(실패는 WARN 한 줄). 다만 429 · 속도 상한이면 목록의 429 와 같다(리뷰 2026-09-30 — 전에는 WARN 한 줄뿐이고 실행 기록은
  새 tm 이 없으면 'ok' · http 200, 있으면 쉼 때문에 보내지 않은 바이너리의 'throttled' · http 없음이었다): 이 주기의 KMA 호출(바이너리 · 다시 받기)을
  멈추고 실행은 'throttled'(http 429 · 쉰 초 · Retry-After — 그 전날 목록 단계로)다.
- 목록(frames)과 이미지(frame:{tm}) 일관성: 목록에서 빠진 프레임의 이미지는 지우고, 이미지가 없어진 항목은 목록에서 뺀다.
  목록 키도 이미지와 같은 TTL 을 갖는다(수집기가 멈추면 함께 만료). 각 항목에 expires_at 을 둔다.
- 해석(gzip 해제·재투영·PNG)은 CPU 작업이라 스레드에서 돈다(이벤트 루프를 막지 않게).
- 일시 오류(시간 초과 · 연결 실패 · 프로토콜 오류 — retry.RETRY_ERRORS)는 실패한 호출마다 같은 주기 안에서 RETRY_DELAY_S 뒤 한 번 다시
  부른다(예산 1 을 따로 예약한다 — 규칙은 retry.py, 기상 작업도 같은 것을 쓴다). 다시 불러도 실패하면 그 주기를 끝낸다(남은 tm 은 다음 주기).
  전날 목록은 연속의 확인에 필요한 것(_streak_needs_prev_day)만 다시 부른다(조사 F2 2026-10-01 — 전에는 '덧붙이는 것'이라 다시 부르지 않았는데, 연속의
  확인에서는 그 목록이 확인할 tm 을 싣는다: 한 번 멈추면 확인 하나(15분)를 잃었다. 같은 주기의 빈 오늘 목록은 다시 불렀다). 새 날 목록이 빈 주기
  (_behind_prev_day — 하루 내내 이어질 수 있어 5분마다 다시 부르면 최악 (1 + 1) × 2 × 288 = 1,152 > 한도)와 자정 직후 창의 덧붙이는 전날 목록은 다시
  부르지 않는다. 전날 목록을 읽을 때마다 INFO 한 줄(날 · 무엇에 필요한지 · tm 수 · HTTP ms · 단계 ms — 실행 기록의 latency_ms 는 오늘 목록만이다) —
  다시 부르기가 얼마나 살리는지(INFO 'retrying once' 뒤 이 줄 · WARN 'retried once after 5 s')를 운영 로그로 센다. HTTP 오류(ProviderHttpError — 403
  활용신청 전 등)·속도 상한(Throttled)도 다시 부르지 않는다. 5 s·1회는 선택값이다(재어서 정한 값이 아니다). 보내지 않은 시도(연결 전 실패 · 연결 풀 대기 초과 · 속도 상한 — retry.NOT_SENT)는
  예산 1 을 돌려준다(전날 목록 포함). 다시 부르기 예약에는 기상 작업과 달리 여유(headroom)를 두지 않는다 — 정규 호출 수가 주기마다
  다르고(목록 1 + 바이너리 0–4, 상한 5 × 288 = 1,440 > 한도 1,000) 계속 실패하는 서버에서는 첫 호출이 두 번 실패하는 즉시 주기가 끝나
  하루 최대 2 × 288 = 576 이다(설정값 계산).
- 주기 길이(설정값으로 계산한 상한 — 잰 값이 아니다): 최악은 다시 부른 호출이 모두 첫 시도에서 전체 상한(KMA_TOTAL_S 40 s)을 채우고
  실패한 뒤 다시 40 s 걸려 성공하는 경우다 — 오늘 목록 (40 + 5 + 40) + 전날 목록 40(KST 00:00–00:14 · 새 날 목록이 빈 주기) + 바이너리 4 × (40 + 5 + 40)
  + 부분 합성 다시 받기 2 × 40(다시 부르지 않는다, ADR-021) = 545 s. 연속의 확인에 필요한 전날 목록은 다시 불러 85 s 일 수 있지만 그 주기는 확인이 둘
  이하라 85 + 85 + 2 × 85 + 80 = 420 s 로 위 상한 안이다. 속도 상한 대기(호출마다 최대 DEFAULT_WAIT_S 10 s, 최대 13번)는 전체 상한
  밖이라 더 붙을 수 있다(+130 s). 주기(300 s)를 넘을 수 있지만
  run_periodic 은 한 주기가 끝난 뒤 주기만큼 쉬고 다음을 시작하므로 겹치지 않는다 — 다음 주기가 늦어질 뿐이고, 놓친 프레임은 보관 창
  안에서 채운다. 계속 실패하는 서버에서는 첫 호출이 두 번 실패하는 즉시 끝난다.
- 실패 기록(상태 last_error · 실행 기록 · 경고 로그)에는 실패한 단계(목록 날짜 · 바이너리 tm)와 그 호출에 걸린 시간을 싣는다.
- 부분 합성(ADR-021): 합성은 tm 마다 일찍 올라오고 레이더 지점이 보고하는 대로 채워진다(2026-09-29 관찰). 프레임마다 헤더 STN_LIST 의
  지점 수(stations)·코드(station_ids)를 싣고, 기준(stations_ref) = 가장 새 저장 tm 에서 REF_WINDOW_S 안(경계 포함)의 저장된 프레임 중 가장
  많은 지점 수(그 프레임 포함), partial = stations < stations_ref(annotate_partial — 저장할 때마다 다시 계산). partial=False('기준 도달' —
  완전하다는 뜻이 아니다)는 기준에 닿은 프레임이 REF_MIN_SUPPORT(2)개 이상일 때만 — 기준이 자기 자신뿐이면 판정하지 않는다. 지점 수를 모르는
  옛 항목은 세지 않고 판정도 두지 않는다(모름). 60분 · 2개는 선택값이다.
- 다시 받기(ADR-021): 정규 후보를 다 받은 뒤, 부분 합성 프레임 중 tm 이 REFETCH_MAX_AGE_S(30분) 안이고 마지막 시도(처음 받은 시각 또는
  다시 받은 시각)가 REFETCH_SPACING_S(4분) 넘게 지난 것을 주기마다 REFETCH_MAX_PER_CYCLE(2)개까지 다시 받는다 — 다시 받은 횟수가 적은 것 →
  마지막 시도가 오래된 것 → 오래된 tm 순(계속 부분 합성인 프레임이 자리를 독차지하지 않게). 헤더의 지점
  수가 늘었을 때만 PNG · 항목(지점 · 에코 셀 · raw_ref · fetched_at) · (최신 프레임이면) meta 의 헤더 값을 바꾸고, 쓰지 않은 원본은 보관하지
  않는다. meta fetched_at(latest_tm 을 처음 저장한 시각 — STALE 시계)은 다시 받기로 옮기지 않는다.
  시도(refetches · refetched_at)와 바꾼 수(upgrades)는 항목에 남는다. 예산은 한 번에 1 을 예약하되 남은 하루(UTC)의 정규 주기 몫(주기당
  REGULAR_CALLS_PER_CYCLE = 목록 1 + 새 프레임 1 + 일시 오류 다시 부르기 1)을 남기고만(budget.regular_headroom — 기상 작업의 다시 부르기와
  같은 규칙). 오류는 INFO 한 줄 — 주기를 끝내지 않고, 다시 부르지 않고, 공급자 실패로 기록하지 않는다(보내지 않은 시도는 예산 1 을
  돌려준다). 429 · 속도 상한만은 위 '속도 상한'처럼 WARN · 실행 상태로 올린다. 30분 · 4분 · 2개 · 3은 선택값이다(잰 값이 아니다).
"""

from __future__ import annotations

import asyncio
import base64
import concurrent.futures
import functools
import logging
import re
import time
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime, timedelta

import httpx
import orjson
from redis.exceptions import RedisError

from wakeline_collector.budget import UNKNOWN
from wakeline_collector.config import settings
from wakeline_collector.errors import describe_error
from wakeline_collector.http import ProviderHttpError, ResponseTooLarge
from wakeline_collector.jobs.context import JobContext
from wakeline_collector.kma_grid import read_echo, read_header, render_mercator_png
from wakeline_collector.kma_rules import (
    FRAME_TTL_S,
    GAP_KEYS,
    KEEP_FRAMES,
    LIST_IDLE_AFTER_S,
    MAX_BAD,
    MAX_NOT_READY_TRIES,
    MISSING_FILE_RE,
    MISSING_KEYS,
    MISSING_RECHECK_S,
    MISSING_REMIND_S,
    MISSING_SLOW_AFTER_S,
    MISSING_SLOW_EVERY_S,
    PREV_DAY_LIST_MIN,
    Exhausted,
    ListCheck,
    ListIdle,
    MissingStreak,
    annotate_partial,
    gap_expired,
    is_throttle,
    iso,
    latest_station_fields,
    listed_text,
    missing_carry_s,
    old_tm_cut,
    outcome,
    parse_iso,
    refetch_until,
    select_candidates,
    select_refetch,
    site_count,
    streak_probe_every_s,
    streak_probes,
    tm_dt,
    tm_span,
)
from wakeline_collector.kma_rules import refetch_headroom as _refetch_share
from wakeline_collector.models import ProviderResult
from wakeline_collector.providers.kma_radar import KmaRadarProvider, kst_now
from wakeline_collector.ratelimit import KMA_APIHUB_HOST as KMA_HOST
from wakeline_collector.ratelimit import Throttled
from wakeline_collector.raw_store import archive
from wakeline_collector.retry import NOT_SENT, CallFailed, call_retry_once
from wakeline_collector.status import AUX_TIMEOUT_S

log = logging.getLogger("job.kma_radar")
KEY_META = "wakeline:radar_kr:meta"  # hash
KEY_FRAMES = "wakeline:radar_kr:frames"  # JSON list (오래된 → 최신)
KEY_FRAME = "wakeline:radar_kr:frame:{tm}"  # base64 PNG, TTL
_sleep = asyncio.sleep  # 다시 부르기 전 기다림 — 시험이 바꿔 끼운다


def _now() -> datetime:  # 다시 받기 간격 · 예산 여유 계산의 시각 — 시험이 바꿔 끼운다
    return datetime.now(UTC)


def refetch_headroom(now: datetime, poll_s: float | None = None) -> int:
    """kma_rules.refetch_headroom — 주기를 주지 않으면 이 수집기의 설정(settings.kma_radar_poll_s)."""
    return _refetch_share(now, poll_s or settings.kma_radar_poll_s)


# 격자 해석(수십 MB numpy 버퍼)은 전용 스레드 하나에서만 — 공용 기본 풀(asyncio.to_thread, 최대 8)의 아무 스레드에서 돌면 스레드마다
# glibc malloc 아레나가 최고점을 따로 쥐어 RSS 가 계단식으로 늘었다(리뷰 4단계 측정). 해석은 원래 한 번에 하나씩이라 처리량 차이는 없다.
_DECODE_POOL = concurrent.futures.ThreadPoolExecutor(max_workers=1, thread_name_prefix="kma-decode")


def _decode(raw: bytes):
    header, grid = read_echo(raw)
    png, meta = render_mercator_png(header, grid)
    return header, png, meta


def _decode_if_more(raw: bytes, have: int):
    """다시 받은 자료: 헤더의 지점 수가 have 보다 많을 때만 전체 해석 · PNG(아니면 (header, None, None)). 판정에는 헤더(앞 1,024 B)만 푼다 —
    바꾸지 않는 흔한 경우에 자료 블록(해제 약 40 MB)을 풀고 버리지 않게(해석 스레드 · RSS)."""
    header = read_header(raw)
    if len(header.stations) <= have:
        return header, None, None
    return _decode(raw)


class _BadFrame(Exception):
    """이 tm 의 자료 자체가 해석 불가(폭탄·형식 오류). 다시 받아도 같으므로 건너뛴다."""


_StepFailed = CallFailed  # 한 단계(목록 · 바이너리 · 저장)의 실패 — retry.CallFailed(단계 · 걸린 시간 · 첫 시도)


class _ListingRefused(Exception):
    """필요한 전날 목록(_streak_needs_prev_day — 연속의 확인 · _behind_prev_day — 새 날 목록이 비었고 저장했거나 받아 본 tm 이 전날 끝에 닿지 않았다)의 예산 예약이
    거절됐다 — 실행은 예산 상태 하나(status · error_text), 연속의 마지막 확인은 그대로."""

    def __init__(self, status: str, error_text: str) -> None:
        super().__init__(error_text)
        self.status, self.error_text = status, error_text


class KmaRadarJob:
    job_name = "radar_kr"

    def __init__(self, provider: KmaRadarProvider, ctx: JobContext):
        self.p, self.ctx = provider, ctx
        self._warned = False
        self._bad: dict[str, str] = {}  # tm → 까닭("parse" 해석 불가 · "missing" 끝내 없음). 삽입 순서 유지(오래된 것부터 버림)
        self._not_ready: dict[str, int] = {}  # tm → '아직 없음' 응답 횟수(R-03)
        self.missing: MissingStreak | None = None  # '파일 없음' 연속(열려 있을 때만)
        # 이 주기의 마지막 '파일 없음' 답(원문 · 목록 종류) — 연속을 열 때 싣는다
        self._last_answer: tuple[str, str] | None = None
        # 마지막으로 닫은 연속 [첫 tm, 파일이 다시 있던 tm) — 그 안의 빈 곳을 포기할 때는 INFO(이미 알렸다)
        self._closed_gap: tuple[str, str] | None = None
        self._loaded = False  # Redis 의 연속을 읽었는가(첫 주기 한 번)
        # 마지막으로 기상청을 부른 주기의 시작(_now — UTC). 늦춘 연속은 여기서 확인 간격을 센다. 이어받은 연속이면 앞 프로세스의 마지막 확인
        self._probe_at: datetime | None = None
        self._published: dict[str, str] = dict.fromkeys(MISSING_KEYS, "")  # 해시에 마지막으로 쓴 missing_*
        self._published_gap: dict[str, str] = dict.fromkeys(GAP_KEYS, "")  # meta 해시에 마지막으로 쓴 알린 공백
        # 부분 합성 누계(프로세스 기동 뒤 — heartbeat): 부분 합성으로 처음 저장한 프레임 · 다시 받기 시도 · 지점이 늘어 바꾼 수
        self.partial_stored = 0
        self.refetch_attempts = 0
        self.upgrades = 0
        # 이 프로세스가 gzip 을 받았으나 영상 보관(3 h)보다 오래돼 저장하지 않은 가장 새 tm — 그 이하의 옛 tm 은 다시 고르지 않는다(select_candidates known)
        self._old_seen = ""
        # 이 주기 전날 목록(_listing)의 429 · 속도 상한 — 주기가 KMA 호출을 멈추고 'throttled' 로 적는다(run_once)
        self._prev_day_throttle: _StepFailed | None = None
        # 이 주기에 읽은 목록의 날(오름차순 — _listing: 연속의 확인이 목록이 무엇을 덮었는지 싣는다)
        self._list_days: tuple[str, ...] = ()
        # 연속 밖의 목록 멈춤(ListIdle)을 알린 것: (목록이 그 뒤로 싣지 않는 tm, 마지막 WARN — _now). 멈춤마다 WARN 한 번 + MISSING_REMIND_S 마다 한 번
        self._idle: tuple[str, datetime] | None = None

    async def _frames(self) -> list[dict]:
        raw = await self.ctx.status.redis.get(KEY_FRAMES)
        try:
            frames = orjson.loads(raw) if raw else []
        except orjson.JSONDecodeError:
            return []
        return [f for f in frames if isinstance(f, dict) and isinstance(f.get("tm"), str)] if isinstance(frames, list) else []

    async def _save_frames(self, frames: list[dict]) -> None:
        """목록 저장 + 일관성: 목록 키 TTL = 가장 새 이미지의 남은 TTL(expires_at). 비면 키를 지우고 available=0."""
        r = self.ctx.status.redis
        if not frames:
            await r.delete(KEY_FRAMES)
            await r.hset(KEY_META, "available", "0")
            return
        ttl = FRAME_TTL_S
        try:
            exp = datetime.fromisoformat(str(frames[-1].get("expires_at", "")).replace("Z", "+00:00"))
            ttl = max(1, min(FRAME_TTL_S, int((exp - datetime.now(UTC)).total_seconds())))
        except ValueError:
            pass  # 옛 항목(expires_at 없음) — 최대 TTL
        await r.set(KEY_FRAMES, orjson.dumps(frames).decode(), ex=ttl)

    async def prune(self) -> list[dict]:
        """이미지가 만료·삭제된 항목을 목록에서 뺀다. 남은 목록을 돌려준다(비었으면 available=0)."""
        r = self.ctx.status.redis
        frames = await self._frames()
        if frames:
            pipe = r.pipeline(transaction=False)
            for f in frames:
                pipe.exists(KEY_FRAME.format(tm=f["tm"]))
            flags = await pipe.execute()
            kept = [f for f, ok in zip(frames, flags, strict=True) if ok]
            if len(kept) == len(frames):
                return kept
            log.info("kma radar: pruned %d list entries whose image expired", len(frames) - len(kept))
            frames = kept
        await self._save_frames(frames)
        return frames

    async def _fail(self, started: datetime, f: _StepFailed) -> None:
        e = f.error
        http_status = e.status if isinstance(e, ProviderHttpError) else None
        note = "활용신청 필요(API허브에서 레이더합성자료 신청 후 승인 대기)" if http_status == 403 else f"{type(e).__name__}"
        detail = f.detail()  # 가린 한 줄(R-83: 응답 본문 앞부분이 실릴 수 있다) · 단계 · 걸린 시간 · 첫 시도
        await self.ctx.status.failure(
            self.p.name, at=datetime.now(UTC), error=note if http_status == 403 else detail, http_status=http_status
        )
        self.ctx.db.record_run(self.job_name, self.p.name, started, status="error", http_status=http_status, error_text=detail)
        await self.ctx.status.hset_meta(
            KEY_META, {"status": str(http_status or ""), "note": note[:200], "checked_at": iso(datetime.now(UTC))}
        )
        if http_status == 403:
            log.warning("kma radar: %s — %s", f.step, note)
            return
        log.warning("kma radar: %s", f.log_text())

    def _redis_failed(
        self, started: datetime, f: _StepFailed, *, called: bool, stored: int = 0, quality: list | None = None, note: str = ""
    ) -> None:
        """Redis(프레임 목록 · meta · 프레임 저장)를 읽거나 쓰지 못했다(D2 — 전에는 redis-py 예외가 스케줄러까지 올라가 그 주기의 실행 기록 · 품질
        사례가 사라졌다): 실행 'error' 하나(단계 · 예외 — 가린 글자, 그 주기의 품질 사례 · 글)와 WARN 한 줄. 공급자 오류가 아니다 — 공급자 last_error ·
        연속 실패 수에는 적지 않는다. called = 이 주기에 기상청을 불렀다(아니면 'no KMA call this cycle')."""
        text = f.detail() + (f" · {note}" if note else "")
        quality = quality or []
        self.ctx.db.record_run(
            self.job_name,
            self.p.name,
            started,
            status="error",
            records_in=stored,
            records_quarantined=len(quality),
            error_text=text,
            quality=quality,
        )
        log.warning("kma radar: %s%s", text, "" if called else " — no KMA call this cycle")

    @staticmethod
    def _throttle_text(f: _StepFailed) -> tuple[str, int | None]:
        """429 · 속도 상한(모듈 설명 '속도 상한')의 로그 한 줄과 (실행 기록 오류 글자, http 상태). 공급자 last_error · consecutive_failures 에는 적지
        않는다(공급자 오류가 아니다). 429 는 WARN(HttpClient 가 호스트를 멈춘 초 · Retry-After), 그 쉼 때문에 보내지 않은 호출은 INFO(429 가 이미
        알렸다), 그 밖의 속도 상한은 WARN. 목록 · 바이너리 · 다시 받기 모두 같은 글이다."""
        e = f.error
        if isinstance(e, ProviderHttpError):
            ra = str(e.headers.get("retry-after", "")).strip()[:40]
            given = (f"Retry-After {ra} s" if ra.isdigit() else f"Retry-After '{ra}'") if ra else "no Retry-After — step backoff"
            paused = "pause unknown" if e.pause_s is None else f"paused {e.pause_s:.0f} s"
            note = f"{KMA_HOST} {paused} ({given})"
            log.warning("kma radar: %s — %s — %s; no more KMA calls this cycle", f.step, describe_error(e), note)
            return f"{f.detail()} · {note}", e.status
        level = logging.INFO if isinstance(e, Throttled) and e.cooldown_s > 0 else logging.WARNING  # 쉼은 429 가 이미 알렸다
        log.log(level, "kma radar: %s — not called (%s)", f.step, describe_error(e))
        return f"{f.detail()} · not called — rate limiter", None

    async def _throttled(self, started: datetime, f: _StepFailed) -> None:
        """목록이 429 · 속도 상한으로 멈췄다: 실행 'throttled' 하나(이 주기에 한 일이 아직 없다 — 바이너리 · 다시 받기는 주기 끝에서 함께 적는다)."""
        text, http_status = self._throttle_text(f)
        self.ctx.db.record_run(
            self.job_name, self.p.name, started, status="throttled", http_status=http_status, records_in=0, error_text=text
        )

    async def _call(self, step: str, fn: Callable[[], Awaitable[ProviderResult]]) -> ProviderResult:
        """step 호출. 실패는 모두 _StepFailed(단계·걸린 시간)로 올린다. 일시 오류면 예산 1 을 예약할 수 있을 때 5 s 뒤 한 번 다시
        부른다(호출마다 한 번 — retry.call_retry_once). HTTP 오류·속도 상한은 다시 부르지 않는다."""
        return await call_retry_once(
            step,
            fn,
            reserve=lambda: self.ctx.budget.reserve(self.p.name, 1),
            log=log,
            label="kma radar",
            sleep=lambda s: _sleep(s),
            release=lambda: self.ctx.budget.release(self.p.name, 1),  # 보내지 않은 시도(연결 전 실패 · 속도 상한)는 돌려준다
        )

    async def _try_reserve(self) -> tuple[str, str] | None:
        """예산 1 을 예약한다. 되면 None, 안 되면 (실행 상태, 오류 글자)와 WARN 한 줄 — 실행 기록은 부르는 쪽이 남긴다(한 주기 = 기록 하나)."""
        ok, used = await self.ctx.budget.reserve(self.p.name, 1)
        if ok:
            return None
        unavailable = used == UNKNOWN
        log.warning("kma radar: budget %s", "unavailable" if unavailable else f"exhausted (used={used})")
        if unavailable:
            return "budget_unavailable", "budget store unavailable (fail closed)"
        return "budget_exhausted", f"daily budget exhausted (used={used})"

    async def _reserve(self, started: datetime) -> bool:
        """주기 첫 예약(목록): 안 되면 예산 상태의 실행 기록을 남기고 False(주기를 끝낸다)."""
        refused = await self._try_reserve()
        if refused is not None:
            self.ctx.db.record_run(self.job_name, self.p.name, started, status=refused[0], error_text=refused[1])
        return refused is None

    def _mark_bad(self, tm: str, why: str) -> None:
        self._not_ready.pop(tm, None)
        self._bad[tm] = why
        while len(self._bad) > MAX_BAD:
            self._bad.pop(next(iter(self._bad)))

    def _not_ready_again(self, tm: str) -> int:
        """'아직 없음' 횟수를 1 늘려 돌려준다(기억 상한 MAX_BAD, 오래된 것부터 버림)."""
        n = self._not_ready.pop(tm, 0) + 1
        self._not_ready[tm] = n
        while len(self._not_ready) > MAX_BAD:
            self._not_ready.pop(next(iter(self._not_ready)))
        return n

    def _streak_needs_prev_day(self, day: str, now_tm: str, today: list[str]) -> bool:
        """연속의 확인에 전날 목록이 필요한가(자정 직후 창 안이어도): 연속의 last_tm 이 전날 이전이고 새 날 목록이 답했으나 아직 그 시각 이하의 tm 을 싣지
        않았다. 운영 2026-10-01: 00:15 KST 뒤 확인은 빈 새 날 목록만 읽어 확인할 tm 이 없었다 — last_tm 뒤를 싣는 목록은 전날 것이다. 이때 확인은 전날의
        가장 새 tm 하나만 본다(현재 시각 −10분이 전날 tm 을 모두 넘는다 — 둘째 확인이 첫째와 같다): 목록 2 + 확인 1 = 주기당 3(STREAK_CALLS_PER_PROBE
        그대로 — 자정 직후 00:00–00:09 만 확인 둘일 수 있다: streak_calls_per_day 의 +1). 참이면 전날 목록은 덧붙이는 목록이 아니다 — 읽지 못하면 확인이
        아니다(_listing — 일시 오류면 한 번 다시 부른다)."""
        s = self.missing
        return s is not None and s.last_tm[:8] < day and not any(tm <= now_tm for tm in today)

    @staticmethod
    def _prev_end(day: str) -> str:
        """전날 끝 tm(전날 23:55 — 5분 생산 주기의 마지막)."""
        return (datetime.strptime(day, "%Y%m%d") - timedelta(days=1)).strftime("%Y%m%d") + "2355"

    @classmethod
    def _behind_prev_day(cls, day: str, now_tm: str, today: list[str], reached: str) -> bool:
        """연속이 없어도 전날 목록을 읽는가: 새 날 목록이 답했으나 아직 그 시각 이하의 tm 을 싣지 않았고, 이 작업이 저장했거나 파일을 받아 본 가장 새
        tm(reached — Redis 에 남은 프레임 · meta latest_tm · 받아 본 옛 tm)이 전날 끝(23:55)에 닿지 않았다. 운영 2026-10-01 02:07 KST — 다시 띄운 수집기가
        오래된 연속을 버린 뒤 빈 새 날 목록만 읽어 확인할 tm 이 없었고(주기마다 'ok'), 연속이 다시 열리지 않았다. 전날 끝까지 받았으면 전날 목록에 새로 받을
        것이 없다 — 새 날 목록이 하루 내내 비어도 호출을 늘리지 않는다. reached 는 Redis 에 남은 프레임만이 아니다(리뷰 2026-10-01 · 레인 kma 8차): 프레임은
        저장 3 h 뒤 만료되고 옛 tm 은 다시 받지 않으므로(select_candidates), 남은 프레임만 보면 03:00 뒤 주기마다 받을 것이 없는 전날 목록을 필요한 목록으로
        읽어 그 목록이 한 번 멈추면 'error' 였다.
        참이면 그 주기가 읽을 것은 전날 목록뿐이다 — 덧붙이는 목록이 아니라 필요한 목록이다(_listing: 실패 'error' · 예산 없음 예산 상태 — 리뷰 2026-10-01,
        운영 02:23:54 KST 에 전날 목록이 ReadTimeout 인 주기가 'ok' · 공급자 성공으로 남았다)."""
        return not any(tm <= now_tm for tm in today) and reached < cls._prev_end(day)

    def _prev_day_why(self, day: str, needed: bool, stored: str) -> str:
        """필요한 전날 목록을 읽지 못한 주기의 오류 글자 뒷부분 — 왜 필요한 목록인지(연속 · 목록 · 저장한 프레임 · 받아 본 옛 tm 이 보인 것만).
        stored = 저장한 가장 새 tm(Redis 에 남은 프레임 · meta latest_tm)."""
        s = self.missing
        if needed and s is not None:
            return f"the missing-file streak's newest tm={s.last_tm} is on {s.last_tm[:8]} and the listing {day} lists no tm yet — not a check"
        shown = f"newest stored tm={stored}" if stored else "none stored"
        if self._old_seen > stored:
            shown += (
                f"; newest tm with a file not stored (older than the {FRAME_TTL_S // 3600} h image retention) tm={self._old_seen}"
            )
        return (
            f"the listing {day} lists no tm yet and no stored frame reaches tm={self._prev_end(day)} ({shown}) — "
            "nothing else to fetch this cycle"
        )

    async def _listing(self, have: list[str] | None = None, latest: str = ""):
        """오늘(KST) 목록. 자정 직후(00:00–00:14)에는 전날 목록도 합친다 — '파일 없음' 연속의 last_tm 이 전날이고 새 날 목록이 아직 그 시각 이하의 tm 을
        싣지 않았으면 그 뒤에도(_streak_needs_prev_day), 연속이 없어도 새 날 목록이 비었고 이 작업이 저장했거나 파일을 받아 본 가장 새 tm(have — Redis 에
        남은 프레임 · latest — meta latest_tm, 프레임이 만료돼도 남는다 · 받아 본 옛 tm)이 전날 끝에 닿지 않았으면 그 뒤에도(_behind_prev_day). 첫 결과(오늘)를
        돌려준다. 읽은 날은 self._list_days 에 남긴다.
        자정 직후 창에만 드는 전날 목록(새 날 목록에 그 시각 이하의 tm 이 있거나 저장한 프레임이 전날 끝에 닿았다)은 덧붙이는 것이다 — 예산이 없거나 호출이
        실패하면 오늘 목록만 쓴다(주기를 잃지 않고, 실행 기록을 따로 남기지 않는다 — 실패는 WARN 한 줄). 필요한 전날 목록은 덧붙이는 것이 아니다: 연속의
        확인에 필요한 것(_streak_needs_prev_day — 창 안이어도: 그것 없이는 확인할 tm 을 모른다 — 리뷰 2026-10-01, 전에는 오늘 목록만으로 이어가 확인할 tm 이
        없는 'missing' 으로 마지막 확인을 옮겼다)과 연속이 없어도 그 주기가 읽을 것이 그것뿐인 것(_behind_prev_day — 리뷰 2026-10-01, 운영 02:23:54 KST 에
        ReadTimeout 인 주기가 'ok' · 공급자 성공으로 남았다). 호출이 실패하면(504 · 시간 초과) 오늘 목록의 실패와 같게 _StepFailed(전날 목록 단계 —
        run_once 가 'error'), 예산 예약이 거절되면 _ListingRefused(예산 상태).
        429 · 속도 상한이면 그 실패를 self._prev_day_throttle 에 남긴다 — run_once 가 이 주기의 KMA 호출을 멈추고 'throttled' 로 적는다(로그도 그때 한 줄)."""
        self._prev_day_throttle = None
        self._list_days = ()
        now_kst = kst_now()
        day = now_kst.strftime("%Y%m%d")
        today = await self._call(f"listing {day}", lambda: self.p.file_list(day))
        self._list_days = (day,)
        now_tm = now_kst.strftime("%Y%m%d%H%M")
        window = now_kst.hour == 0 and now_kst.minute < PREV_DAY_LIST_MIN
        needed = self._streak_needs_prev_day(day, now_tm, today.data)
        stored = max(max(have or [], default=""), latest)
        behind = (
            self.missing is None
            and have is not None
            and self._behind_prev_day(day, now_tm, today.data, max(stored, self._old_seen))
        )
        if not window and not needed and not behind:
            return today
        prev_day = (now_kst - timedelta(days=1)).strftime("%Y%m%d")
        step = f"previous-day listing {prev_day}"
        # 필요한 목록(연속의 확인 · 새 날 목록이 비었고 저장했거나 받아 본 tm 이 전날 끝에 닿지 않았다 — 그 주기가 읽을 것은 이 목록뿐이다): 예산이 없으면 예산 상태,
        # 실패하면 'error'. 자정 직후 창에만 드는 전날 목록은 덧붙이는 목록이다(아래 else)
        required = needed or behind
        if required:  # WARN 은 _try_reserve
            refused = await self._try_reserve()
            if refused is not None:
                raise _ListingRefused(refused[0], f"{refused[1]} — {step} not read: {self._prev_day_why(day, needed, stored)}")
        else:
            ok, used = await self.ctx.budget.reserve(self.p.name, 1)
            if not ok:
                log.info(
                    "kma radar: previous-day listing skipped — budget %s",
                    "unavailable" if used == UNKNOWN else f"exhausted (used={used})",
                )
                return today
        purpose = (
            "the streak check" if needed else "frames short of the previous day's end" if behind else "the KST 00:00–00:14 window"
        )
        t0 = time.monotonic()
        try:
            if needed:
                # 연속의 확인에 필요한 목록 — 일시 오류면 5 s 뒤 한 번 다시 부른다(_call: 예산 1 을 따로 예약 · 보내지 않은 시도는 돌려준다 · HTTP 오류 · 429 ·
                # 속도 상한은 다시 부르지 않는다 — 조사 F2 2026-10-01). 새 날 목록이 빈 주기 · 자정 직후 창의 전날 목록은 다시 부르지 않는다(모듈 설명)
                prev = await self._call(step, lambda: self.p.file_list(prev_day))
            else:
                prev = await self.p.file_list(prev_day)
        except _StepFailed as f:  # _call 의 실패(확인에 필요한 목록)
            if is_throttle(f.error):  # 429 · 속도 상한 — 목록의 429 와 같게 주기가 적는다
                self._prev_day_throttle = f
                return today
            raise
        except Exception as e:  # noqa: BLE001
            if isinstance(e, NOT_SENT):  # 보내지 않았다 — 예산을 돌려준다(retry.py 와 같은 규칙)
                await self.ctx.budget.release(self.p.name, 1)
            # 기상청이 호스트를 멈췄다(429) · 속도 상한 — 목록의 429 와 같게 주기가 적는다(WARN · INFO 는 _throttle_text)
            if is_throttle(e):
                self._prev_day_throttle = _StepFailed(step, e, time.monotonic() - t0)
                return today
            if required:  # 필요한 목록 — 오늘 목록의 실패와 같다(run_once 가 'error' · 공급자 오류 · WARN)
                raise _StepFailed(step, e, time.monotonic() - t0) from e
            log.warning(
                "kma radar: previous-day listing %s — %s after %.1f s — using today's only",
                prev_day,
                describe_error(e),
                time.monotonic() - t0,
            )
            return today
        # 잴 수 있게(조사 F2 · 도전 2026-10-01): 전날 목록은 실행 기록의 latency_ms(오늘 목록)에 들지 않는다 — 읽을 때마다 한 줄. HTTP = 답한 시도의 응답
        # 시간, step = 호스트 버킷 대기 · 다시 부르기(5 s 포함)까지 이 단계 전체(실패 로그의 'after N s' 와 같은 셈)
        log.info(
            "kma radar: previous-day listing %s read for %s — %d tms, HTTP %d ms, step %d ms (host-bucket wait and any retry included)",
            prev_day,
            purpose,
            len(prev.data),
            prev.latency_ms,
            round((time.monotonic() - t0) * 1000),
        )
        self._list_days = (prev_day, day)
        today.data = sorted({*prev.data, *today.data})
        kinds = {**(prev.extra.get("kinds") or {}), **(today.extra.get("kinds") or {})}
        if kinds:
            today.extra["kinds"] = kinds
        return today

    async def run_once(self) -> None:
        ctx = self.ctx
        if not self.p.configured:
            if not self._warned:
                log.info("kma radar: KMA_APIHUB_KEY not set — disabled")
                self._warned = True
            await self._drop_missing()  # 수집하지 않는 동안 앞서 남은 연속을 지금 것처럼 두지 않는다(리뷰 2026-09-30)
            return
        try:
            stored = await self.prune()
        except (RedisError, OSError) as e:
            self._redis_failed(datetime.now(UTC), _StepFailed("frame list (Redis)", e, None), called=False)
            return
        if not self._loaded:
            await self._load_missing()
        if self.missing is None and any(self._published.values()):
            # 해시에 이 프로세스가 다루지 않는 연속이 남았다(이어받기 상한 밖이라 버렸다 · 앞 주기가 닫은 뒤 발행 전에 'error' 로 끝났다) — 주기가 어떻게
            # 끝나든('error' · 예산 상태 주기는 발행하지 않는다) 먼저 지운다. 리뷰 2026-10-01(도전): 버린 연속이 목록 실패 주기 동안 두 해시에 남아 웹이
            # 아무도 확인하지 않는 연속을 '파일 없음 · 확인 멈춤'으로 적었다
            await self._publish_missing()
        now = _now()
        if self.missing is not None and self._waiting(now):
            await self._wait(now)
            return
        started = datetime.now(UTC)
        # meta latest_tm — 프레임이 모두 만료돼도 남는다: 전날 끝에 닿았는가(_behind_prev_day) · 옛 tm(select_candidates known) · 목록 멈춤(ListIdle —
        # fetched_at 은 그 tm 을 처음 저장한 시각, STALE 시계). 예약 앞에서 읽는다 — 못 읽으면 기상청을 부르지 않고 예산도 쓰지 않는다(D2)
        try:
            latest, fetched = await self._latest_stored()
        except (RedisError, OSError) as e:
            self._redis_failed(started, _StepFailed("meta (Redis)", e, None), called=False)
            return
        self._probe_at = now  # 이 주기는 기상청을 부른다(목록 예약부터 — 실패해도 확인 간격은 여기서 센다)
        if not await self._reserve(started):
            return
        try:
            listing = await self._listing([f["tm"] for f in stored], latest)
        except _StepFailed as f:
            if is_throttle(f.error):
                await self._throttled(started, f)
            else:
                await self._fail(started, f)
            return
        except _ListingRefused as b:  # 확인에 필요한 전날 목록의 예산이 없다 — 예산 상태 하나, 마지막 확인은 그대로
            self.ctx.db.record_run(self.job_name, self.p.name, started, status=b.status, error_text=b.error_text)
            return
        except Exception as e:  # noqa: BLE001 — 목록 호출 밖(예: 전날 목록 준비)의 예상 밖 오류도 주기 실패로
            await self._fail(started, _StepFailed("listing", e, None))
            return
        now_tm = kst_now().strftime("%Y%m%d%H%M")
        old_cut = old_tm_cut(now_tm)  # 이 tm 이하는 영상 보관(3 h)보다 오래됐다 — 받아도 보이지 않는다(아래)
        kinds: dict = listing.extra.get("kinds") or {}
        have = [f["tm"] for f in stored]
        if self.missing is not None:
            # '파일 없음' 연속: 옛 tm 마다 세 번씩 부르지 않고 가장 새 tm 과 MISSING_RECHECK_S 넘은 가장 새 tm 만 확인한다(회복하면 다음 주기부터 전처럼)
            parse_bad = {tm for tm, why in self._bad.items() if why == "parse"}
            candidates = streak_probes(listing.data, have, now_tm, self.missing.since_tm, parse_bad)
        else:
            known = max(latest, self._old_seen)
            candidates = select_candidates(listing.data, have, now_tm, frozenset(self._bad), known)
        self._last_answer = None
        # 파일이 있던 가장 새 tm(저장된 것 · 이 주기에 gzip 을 받은 것) — 끝내 없는 tm 이 이보다 오래됐으면 그 tm 하나만 빠진 것이다(연속이 아니다)
        newest = max(have, default="")
        # 이 주기에 MAX_NOT_READY_TRIES 번째도 없던 tm — 연속인지는 주기 끝에 가린다(_settle_exhausted)
        exhausted: list[Exhausted] = []
        stored_n = missing_n = 0
        note = ""
        quality: list[tuple[str, str | None, dict]] = []
        budget_stop: tuple[str, str] | None = None  # 바이너리 예약이 거절돼 멈췄다(상태 · 오류 글자)
        store_failed: _StepFailed | None = None  # 프레임 저장(Redis)이 실패해 멈췄다 — 주기 끝에서 'error' 하나로(D2)
        # 429(기상청이 거절 — 호스트를 멈췄다) · 속도 상한(보내지 않았다)으로 이 주기의 KMA 호출을 멈췄다. 곧바로 끝내지 않고 주기 끝(품질 이벤트 ·
        # 공급자 성공 · 연속 발행 · heartbeat)을 그대로 지난다 — 리뷰 2026-09-30: 전에는 return 해서 이미 포기한 tm 의 품질 이벤트와 같은 주기에
        # 열고 닫은 연속의 발행을 잃었다(Retry-After 가 길면 다음 주기도 멈춰 10분까지)
        throttle: _StepFailed | None = self._prev_day_throttle
        if throttle is not None:  # 전날 목록이 429 · 속도 상한 — 바이너리 · 다시 받기도 이번 주기에는 부르지 않는다
            candidates = []
        # 확인하는 연속(이 주기가 여는 연속이 아니다 — 여는 주기의 목록 필드는 모른다: 첫 확인이 채운다)과 이 주기의 목록이 보인 것(계약 v5 §G26 개정 2026-10-01).
        # 전날 목록이 429 · 속도 상한이면 목록을 다 읽지 못했다 — 확인으로 치지 않는다(확인에 필요한 전날 목록의 그 밖의 실패 · 예산은 _listing 이 주기를 끝냈다)
        streak = self.missing if self._prev_day_throttle is None else None
        check = ListCheck.of(listing.data, self._list_days, now_tm, streak.last_tm) if streak else None
        checked_before = streak.checked_at if streak else None
        # 끝내 없던 tm 은 후보를 모두 본 뒤에 가린다 — 목록 · 바이너리 오류로 주기가 중간에 끝나도(포기한 tm 을 조용히 잊지 않게)
        try:
            for tm in candidates:
                if (budget_stop := await self._try_reserve()) is not None:
                    break
                try:
                    res = await self._call(f"binary tm={tm}", functools.partial(self.p.binary, tm))
                except _StepFailed as f:
                    err = f.error
                    if isinstance(err, ResponseTooLarge):
                        self._skip_bad(tm, err, quality)
                    elif isinstance(err, ValueError):
                        missing_n += 1
                        listed = kinds.get(tm)
                        note = self._not_ready_or_missing(tm, err, quality, ",".join(listed) if listed else "", exhausted)
                    elif is_throttle(err):
                        throttle = f  # 이 주기의 KMA 호출을 멈춘다(남은 tm · 다시 받기는 다음 주기) — 기록은 주기 끝에서
                        break
                    elif isinstance(err, ProviderHttpError | httpx.HTTPError | OSError):
                        await self._fail(started, f)
                        return
                    else:
                        raise err from None  # 예상 밖 — 스케줄러가 기록한다(이전과 같다)
                    continue
                self._file_back(tm)  # gzip 을 받았다 — '파일 없음' 연속이 있으면 닫는다(해석은 그다음 일)
                newest = max(newest, tm)  # 이 tm 의 파일은 있다(해석하지 못해도 — '파일 없음' 과 다르다)
                if tm <= old_cut:
                    # 영상 보관(3 h)보다 오래된 tm(연속의 확인이 목록이 멈춘 동안 옛 tm 을 묻는다 — 파일이 돌아왔다): 저장하지 않는다. 저장하면 새 latest_tm 으로
                    # meta fetched_at(STALE 시계)을 지금으로 옮겨 몇 시간 지난 영상이 STALE 없이 보였다(도전 2026-10-01). 그 이하의 옛 tm 은 다시 고르지 않는다
                    self._old_seen = max(self._old_seen, tm)
                    self._not_ready.pop(tm, None)
                    log.info(
                        "kma radar: tm=%s has a file but is older than the %d h image retention — not stored (not shown as a frame)",
                        tm,
                        FRAME_TTL_S // 3600,
                    )
                    continue
                try:
                    await self._store(tm, res)
                except _BadFrame as e:
                    self._skip_bad(tm, e, quality)
                    continue
                except (RedisError, OSError) as e:  # Redis 장애 · OOM(noeviction) — 공급자 오류가 아니다
                    store_failed = _StepFailed(f"store tm={tm}", e, None)
                    break
                self._not_ready.pop(tm, None)
                stored_n += 1
        finally:
            settled = self._settle_exhausted(exhausted, newest, kinds)
        note = settled or note
        # 프레임 저장(Redis)이 실패했다 — 이 주기에 모은 품질 사례 · 글(포기한 tm · 아직 없는 tm)도 함께 적는다. 다음 주기가 그 tm 을 다시 받는다
        if store_failed is not None:
            self._redis_failed(started, store_failed, called=True, stored=stored_n, quality=quality, note=note)
            return
        # 연속의 확인(연속이 그대로 열려 있을 때): 목록이 답했는데 확인할 tm 이 없었으면(새 날 목록이 비었다 · 목록이 자라지 않고 확인할 tm 이 없다) 목록만 읽은
        # 확인이다 — 마지막 확인을 옮긴다(전에는 옮기지 않아 웹이 '확인 멈춤'을 잘못 붙였다, 운영 2026-10-01). '파일 없음' 답을 받은 확인과 함께 목록 필드를 싣는다.
        # 확인이 없던 주기(예산 · 429 로 한 tm 도 묻지 못함)는 둘 다 그대로다
        list_only = False
        if streak is not None and check is not None and self.missing is streak:
            list_only = not candidates
            if list_only or streak.checked_at != checked_before:
                if list_only:
                    streak.checked_at = _now()
                streak.list_tm, streak.list_newer = check.newest, check.newer
                note = (
                    f"nothing to probe: {check.text(streak.last_tm)}; {self._streak_text()}"
                    if list_only
                    else self._missing_note()
                )
        self._remind_missing()  # 주기에 한 번 — 이 주기의 확인을 모두 센 뒤(확인이 둘이라 첫 확인 뒤에 알리면 요약이 한 tm 늦다)
        if throttle is None:
            partial_now, refetch_stop = await self._refetch_partial()
        else:  # 호스트가 멈췄다 — 다시 받기도 이번 주기에는 하지 않는다(부분 합성 수만 센다)
            partial_now, refetch_stop = await self._partial_count(), None
        status, error_text = outcome(stored_n, missing_n, quality, note)
        if list_only:  # 연속 중 목록만 읽은 확인 — 저장한 프레임이 없고 기상청에 새 파일도 없다: 'ok'(공급자 성공)가 아니라 'missing'(계약 v5 §G26 개정)
            status, error_text = "missing", f"no new frame stored — {note}"
        # 새 tm 이 있었는데 예산이 없어 하나도 저장하지 못했다 — 성공이 아니다(리뷰 2026-09-30)
        if budget_stop is not None and not stored_n:
            status, error_text = budget_stop[0], budget_stop[1] + (f" — {note}" if note else "")
        # 연속 밖의 목록 멈춤(리뷰 2026-10-01 · 레인 kma 8차 — 계약 v5 §G26): 주기를 끝까지 보았으면(429 · 예산으로 멈추지 않았다) 목록이 저장했거나 받아 본 가장
        # 새 tm 뒤로 새 tm 을 싣는지 본다. LIST_IDLE_AFTER_S 넘게 없으면 받을 새 tm 이 없는 주기도 'ok'(공급자 성공)가 아니라 'missing' — 전에는 목록이 멈추고 파일은
        # 있는 동안 'ok' · 기록 0 · 공급자 성공이었고, 3 h 뒤 프레임이 만료되면 웹은 KMA 칩을 숨기고 '아직 수집되지 않음'이라 적었다(까닭은 meta note — 아래)
        idle = None
        if throttle is None and budget_stop is None:
            idle = self._list_idle(listing.data, now_tm, latest, fetched)
            self._note_idle(idle, listing.data, now_tm)
        if idle is not None and status == "ok" and not stored_n:
            status, error_text = "missing", f"no new frame stored — {idle.text()}"
        # 공급자 성공: 프레임을 저장했거나, 정규 부분이 멈추지 않고 'ok' 로 끝났다(다시 받기의 429 는 목록 · 정규 부분의 답을 지우지 않는다)
        succeeded = stored_n > 0 or (status == "ok" and throttle is None)
        http_status = listing.http_status
        stop = throttle or refetch_stop
        if stop is not None:
            text, stop_http = self._throttle_text(stop)
            if throttle is not None or status == "ok":  # 정규 부분이 멈췄거나 다른 문제가 없었다 — 주기의 답은 'throttled'
                error_text = text if error_text is None else f"{text} · {status}: {error_text}"
                status, http_status = "throttled", stop_http
            else:  # 정규 부분의 상태('파일 없음' 등)가 주기의 답이다 — 다시 받기의 429 는 덧붙인다
                error_text = f"{error_text} · {text}"
        ctx.db.record_run(
            self.job_name,
            self.p.name,
            started,
            status=status,
            http_status=http_status,
            latency_ms=listing.latency_ms,
            records_in=stored_n,
            records_quarantined=len(quality),
            error_text=error_text,
            quality=quality,
        )
        used, limit = await ctx.budget.usage(self.p.name)
        if succeeded:
            await ctx.status.success(
                self.p.name, at=datetime.now(UTC), latency_ms=listing.latency_ms, records=stored_n, used=used, limit=limit
            )
        else:  # 저장한 프레임이 없다 — 성공(last_success_at)으로 적지 않는다. 예산 사용량은 적는다(운영 공급자 표)
            await ctx.status.hset_meta(
                ctx.status.key(self.p.name), {"budget_limit": str(limit)} | ({} if used is None else {"budget_used": str(used)})
            )
        await self._publish_missing()
        idle_note = idle.note() if idle is not None else ""  # 목록 멈춤의 까닭(웹 '사용 불가 — <note>') — 아니면 지운다
        if not stored_n:
            await ctx.status.hset_meta(KEY_META, {"checked_at": iso(datetime.now(UTC)), "status": "200", "note": idle_note})
        elif idle_note:  # 멈춘 동안 보관 창의 빈 곳을 채웠다(_store 가 note 를 지웠다) — 목록은 여전히 멈춤
            await ctx.status.hset_meta(KEY_META, {"note": idle_note})
        await self._heartbeat(partial_now)

    async def _latest_stored(self) -> tuple[str, datetime | None]:
        """meta 해시의 (latest_tm — 이 작업이 저장한 가장 새 tm, 프레임이 모두 만료돼도 남는다 · 다시 띄워도 읽는다, fetched_at — 그 tm 을 처음 저장한
        시각 = STALE 시계). 없거나 틀리면 (빈 글자, None)."""
        v, f = await self.ctx.status.redis.hmget(KEY_META, "latest_tm", "fetched_at")
        latest = v if isinstance(v, str) and tm_dt(v) is not None else ""
        return latest, parse_iso(f) if latest else None

    def _list_idle(self, listing: list[str], now_tm: str, latest: str, fetched: datetime | None) -> ListIdle | None:
        """연속 밖의 목록 멈춤인가(ListIdle): 연속이 없고, 읽은 목록(그 시각 이하)이 이 작업이 저장했거나 파일을 받아 본 가장 새 tm 뒤로 새 tm 을 싣지 않고,
        meta fetched_at(latest 를 처음 저장한 시각)이 LIST_IDLE_AFTER_S 넘게 지났다. 저장한 것이 없거나 시각을 모르면(음수 — 시계가 어긋났다 포함) None."""
        if self.missing is not None or not latest or fetched is None:
            return None
        seen = max(latest, self._old_seen)
        listed = [tm for tm in listing if tm <= now_tm]
        age = (_now() - fetched).total_seconds()
        if any(tm > seen for tm in listed) or not LIST_IDLE_AFTER_S < age:
            return None
        return ListIdle(seen, max(listed, default=""), self._list_days, latest, age)

    def _note_idle(self, idle: ListIdle | None, listing: list[str], now_tm: str) -> None:
        """목록 멈춤의 로그: 시작에 WARN 한 번, 그 뒤 MISSING_REMIND_S 마다 한 번(선택값 — '파일 없음' 연속의 알림과 같은 간격), 목록이 다시 자라면 INFO 한 줄.
        주기를 끝까지 본 주기만 부른다(목록 실패 · 429 · 예산으로 멈춘 주기는 모른다 — 알린 것을 그대로 둔다)."""
        now = _now()
        if idle is None:
            if self._idle is not None and self.missing is None:
                newest = max((tm for tm in listing if tm <= now_tm), default="")
                log.info(
                    "kma radar: the KMA listing has a tm after tm=%s again (newest listed tm=%s)", self._idle[0], newest or "none"
                )
            self._idle = None
            return
        if self._idle is None:
            log.warning(
                "kma radar: no new frame — %s; stored frames expire %d h after they were stored; reminder every %d min (chosen)",
                idle.text(),
                FRAME_TTL_S // 3600,
                MISSING_REMIND_S // 60,
            )
            self._idle = (idle.tm, now)
        elif (now - self._idle[1]).total_seconds() >= MISSING_REMIND_S:
            log.warning("kma radar: still no new frame — %s", idle.text())
            self._idle = (idle.tm, now)
        else:
            self._idle = (idle.tm, self._idle[1])

    async def _heartbeat(self, partial_now: int | None) -> None:
        await self.ctx.status.heartbeat(
            self.job_name,
            lag_s=None,  # 재지 않은 값은 0 이 아니라 모름(R-20)
            fixture=self.ctx.fixture,
            extra={  # 부분 합성(ADR-021): 지금 목록의 부분 합성 수(모르면 빈 값) · 기동 뒤 누계
                "radar_kr_partial": "" if partial_now is None else str(partial_now),
                "radar_kr_partial_stored": str(self.partial_stored),
                "radar_kr_refetches": str(self.refetch_attempts),
                "radar_kr_upgrades": str(self.upgrades),
            },
        )

    def _waiting(self, now: datetime) -> bool:
        """열린 연속의 확인 간격을 정하고(늦출 때 INFO 한 번) 이 주기가 기다리는 주기인가 — 늦춘 간격이고 마지막으로 부른 주기가 그만큼 지나지 않았다."""
        s = self.missing
        assert s is not None
        poll = settings.kma_radar_poll_s
        every = streak_probe_every_s(s.since_tm, kst_now(), poll)
        if every != s.every_s:
            if every > poll and s.every_s <= poll:
                log.info(
                    "kma radar: the missing-file streak since tm=%s has lasted %s of tms — probing every %d min from now on "
                    "(chosen, after %d min); the %d min cadence resumes when a file comes back",
                    s.since_tm,
                    tm_span(s.since_tm, kst_now().strftime("%Y%m%d%H%M")),
                    every // 60,
                    MISSING_SLOW_AFTER_S // 60,
                    poll // 60,
                )
            s.every_s = every
        return every > poll and self._probe_at is not None and (now - self._probe_at).total_seconds() < every

    async def _wait(self, now: datetime) -> None:
        """늦춘 연속의 기다리는 주기: 기상청을 부르지 않는다 — 실행 'waiting'(http 없음 · 확인 간격과 마지막으로 부른 뒤 지난 분), 연속 발행(확인 간격이
        바뀌었으면), heartbeat. 마지막 확인(missing_checked_at) · meta checked_at 은 옮기지 않는다(확인하지 않았다)."""
        s = self.missing
        assert s is not None and self._probe_at is not None
        text = (
            f"not called — probing every {s.every_s // 60} min (chosen) while the KMA download has no file "
            f"(since tm={s.since_tm}, {tm_span(s.since_tm, kst_now().strftime('%Y%m%d%H%M'))} of tms); "
            f"last probe {(now - self._probe_at).total_seconds() / 60:.0f} min before this cycle"
        )
        self.ctx.db.record_run(self.job_name, self.p.name, datetime.now(UTC), status="waiting", records_in=0, error_text=text)
        log.info("kma radar: %s", text)
        await self._publish_missing()
        await self._heartbeat(await self._partial_count())

    async def _refetch_partial(self) -> tuple[int | None, _StepFailed | None]:
        """정규 후보 뒤: 부분 합성 프레임을 다시 받는다(select_refetch). 예산이 정규 주기 몫을 남기지 못하면 멈춘다.
        429 · 속도 상한이면 남은 다시 받기를 멈추고 그 실패를 돌려준다 — 부르는 쪽이 WARN · 실행 상태 'throttled' 로 적는다(리뷰 2026-09-30: 전에는
        INFO 로 삼켜 실행이 'ok' 였다). 그 밖의 실패는 주기를 끝내지 않는다(INFO 한 줄).
        돌려주는 값: (끝난 뒤 목록의 부분 합성 프레임 수 — Redis 를 못 읽으면 None, 멈추게 한 429 · 속도 상한 — 없으면 None)."""
        try:
            frames = await self._frames()
            todo = select_refetch(frames, kst_now(), _now())
        except Exception as e:  # noqa: BLE001 — 다시 받기는 덧붙이는 일이다
            log.info("kma radar: refetch of partial frames skipped — %s", describe_error(e))
            return None, None
        stop: _StepFailed | None = None
        for tm in todo:
            ok, used = await self.ctx.budget.reserve(self.p.name, 1, headroom=refetch_headroom(_now()))
            if not ok:
                log.info(
                    "kma radar: refetch of partial frames skipped — budget %s (the regular cycles' share is kept)",
                    "unavailable" if used == UNKNOWN else f"used={used}, share kept={refetch_headroom(_now())}",
                )
                break
            self.refetch_attempts += 1
            try:
                await self._refetch_one(tm, frames)
            except _StepFailed as f:  # 429 · 속도 상한 — 이 주기의 KMA 호출을 멈춘다
                stop = f
                break
            except Exception as e:  # noqa: BLE001 — 저장 중 예상 밖 오류도 주기를 끝내지 않는다
                log.info("kma radar: refetch tm=%s — %s — kept the stored frame", tm, describe_error(e))
        return await self._partial_count(), stop

    async def _partial_count(self) -> int | None:
        """목록의 부분 합성 프레임 수(Redis 를 못 읽으면 None — 모름)."""
        try:
            return sum(1 for f in await self._frames() if f.get("partial") is True)
        except Exception:  # noqa: BLE001
            return None

    async def _refetch_one(self, tm: str, frames: list[dict]) -> None:
        """한 프레임을 다시 받는다(다시 부르지 않는다). 지점 수가 늘었을 때만 바꾸고, 시도는 항상 항목에 남긴다.
        429 · 속도 상한은 _StepFailed('refetch tm=…')로 올린다(_refetch_partial 이 남은 다시 받기를 멈춘다)."""
        have = next((site_count(f) for f in frames if f.get("tm") == tm), None) or 0
        at = _now()
        t0 = time.monotonic()
        try:
            res = await self.p.binary(tm)
            header, png, meta = await asyncio.get_running_loop().run_in_executor(_DECODE_POOL, _decode_if_more, res.raw, have)
        except Exception as e:  # noqa: BLE001 — 오류는 INFO(경고를 쌓지 않는다) · 저장본을 그대로 둔다. 429 · 속도 상한만 올린다
            if isinstance(e, NOT_SENT):  # 보내지 않았다 — 예산을 돌려준다(retry.py 와 같은 규칙)
                await self.ctx.budget.release(self.p.name, 1)
            if is_throttle(e):
                await self._note_refetch(tm, at)
                raise _StepFailed(f"refetch tm={tm}", e, time.monotonic() - t0) from e
            log.info(
                "kma radar: refetch tm=%s — %s after %.1f s — kept the stored frame (%d sites)",
                tm,
                describe_error(e),
                time.monotonic() - t0,
                have,
            )
            await self._note_refetch(tm, at)
            return
        if png is None:
            log.info("kma radar: refetch tm=%s — %d sites (stored %d) — kept the stored frame", tm, len(header.stations), have)
            await self._note_refetch(tm, at)
            return
        raw_ref = await archive(self.ctx.raw, "kma_radar", res.raw, res.fetched_at)  # 바꿀 때만 — 보이는 영상의 원본
        replaced = await self._note_refetch(tm, at, upgrade=(header, png, meta, raw_ref, res.fetched_at))
        if replaced:
            self.upgrades += 1
            log.info(
                "kma radar: refetch tm=%s — %d → %d sites, echo cells %d — replaced",
                tm,
                have,
                len(header.stations),
                meta["echo_cells"],
            )

    async def _note_refetch(self, tm: str, at: datetime, upgrade: tuple | None = None) -> bool:
        """시도를 항목에 남기고(refetches · refetched_at), upgrade 가 있으면 PNG · 항목 · (최신 프레임이면) meta 의 헤더 값을 바꾼다(fetched_at 은 둔다).
        그 사이 목록에서 빠진 프레임이면 아무것도 쓰지 않는다(목록에 없는 이미지를 만들지 않는다). 바꿨으면 True."""
        r = self.ctx.status.redis
        frames = await self._frames()
        entry = next((f for f in frames if f.get("tm") == tm), None)
        if entry is None:
            return False
        entry["refetches"] = int(entry.get("refetches") or 0) + 1
        entry["refetched_at"] = iso(at)
        mapping: dict[str, str] = {}
        if upgrade is not None:
            header, png, meta, raw_ref, fetched_at = upgrade
            now = datetime.now(UTC)
            # 이미지를 먼저 바꾼다: 목록 저장이 실패하면 항목은 더 적은 지점(부분 합성)을 말한다 — 반대 순서면 부분 합성 영상을 완전하다고 말할 수 있다
            await r.set(KEY_FRAME.format(tm=tm), base64.b64encode(png).decode("ascii"), ex=FRAME_TTL_S)
            entry |= {
                "obs_tm": header.tm.strftime("%Y%m%d%H%M"),
                "fetched_at": iso(fetched_at),
                "expires_at": iso(now + timedelta(seconds=FRAME_TTL_S)),
                "bytes": len(png),
                "echo_cells": meta["echo_cells"],
                "raw_ref": raw_ref,
                "stations": len(header.stations),
                "station_ids": list(header.stations),
                "upgrades": int(entry.get("upgrades") or 0) + 1,
            }
            # meta 의 헤더 값은 latest_tm 프레임(보이는 영상)을 설명한다 — 그 프레임을 바꿨을 때만. meta fetched_at 은 바꾸지 않는다:
            # 그것은 latest_tm 을 처음 저장한 시각 = STALE 시계(REL-19 — API meta.stale · 웹 KMA STALE 이 그 나이 > 900 s 로 뜬다)다.
            # 다시 받은 시각으로 옮기면 새 tm 이 오지 않는 동안 마지막 프레임을 채울 때마다 STALE 이 늦어진다. 다시 받은 시각은 항목의
            # fetched_at(보이는 영상을 받은 시각 — 영상 URL 버전) · refetched_at 에만 둔다.
            if frames[-1].get("tm") == tm:
                mapping |= self._header_meta(header, meta)
        annotate_partial(frames)
        await self._save_frames(frames)
        mapping |= latest_station_fields(frames)  # 다른 프레임이 늘어 기준이 바뀌면 최신 프레임의 판정도 바뀐다
        await r.hset(KEY_META, mapping=mapping)  # type: ignore[arg-type]
        return upgrade is not None

    def _skip_bad(self, tm: str, e: Exception, quality: list[tuple[str, str | None, dict]]) -> None:
        """이 tm 의 자료 자체가 해석 불가(폭탄·형식 오류) — 다시 받아도 같으므로 기억해 두고 건너뛴다."""
        self._mark_bad(tm, "parse")
        quality.append(("kma_radar_parse", None, {"tm": tm, "error": str(e)[:200]}))
        log.warning("kma radar: tm=%s skipped — %s", tm, str(e)[:160])

    def _not_ready_or_missing(
        self, tm: str, e: Exception, quality: list[tuple[str, str | None, dict]], listed: str, exhausted: list[Exhausted]
    ) -> str:
        """gzip 아닌 응답("file not exist" 등): 목록에는 있으나 바이너리가 없다. 실행 기록에 실을 한 줄을 돌려준다.
        - 연속 중: 연속만 갱신한다(tm 마다 포기하지 않는다 · INFO). 선택한 간격마다의 WARN 은 주기 끝에 한 번(_remind_missing).
        - 아니면 R-03: MAX_NOT_READY_TRIES 번까지 다음 주기에 다시 받는다(INFO). 끝내 없으면 포기(품질 이벤트)하고 exhausted 에 넣는다 — 그 tm 하나만
          빠졌는지 연속인지는 이 주기의 후보를 모두 본 뒤에 가린다(_settle_exhausted). 후보는 오래된 것부터라 여기서 바로 가리면, 같은 주기에 뒤이어
          받은 더 새 파일(R-03 의 늦게 생긴 파일)을 보기 전에 연속을 열고 곧바로 닫았다(리뷰 2026-09-30 — '연속 시작' WARN 과 5분 공백 INFO)."""
        tries = self._not_ready_again(tm)
        answer = str(e)[:160]
        if self.missing is not None:
            s = self._saw_missing(tm, answer, listed)
            log.info("kma radar: tm=%s has no file either — missing since tm=%s (%d tms)", tm, s.since_tm, s.tms)
            return self._missing_note()
        self._last_answer = (answer, listed)
        if tries < MAX_NOT_READY_TRIES:
            log.info("kma radar: tm=%s not available yet (try %d/%d)", tm, tries, MAX_NOT_READY_TRIES)
            return f"tm={tm} not available yet (try {tries}/{MAX_NOT_READY_TRIES}): {answer}"
        self._mark_bad(tm, "missing")
        quality.append(("kma_radar_missing", None, {"tm": tm, "tries": tries, "error": str(e)[:200]}))
        exhausted.append(Exhausted(tm, tries, answer, listed))
        return f"tm={tm} still unavailable after {tries} tries: {answer}"

    def _settle_exhausted(self, exhausted: list[Exhausted], newest: str, kinds: dict) -> str:
        """주기 끝: 이 주기에 MAX_NOT_READY_TRIES 번째도 없던 tm 을 가린다. newest = 파일이 있던 가장 새 tm(저장된 것 · 이 주기에 받은 것).
        - newest 보다 오래된 tm: 그 tm 하나만 빠졌다 — WARN 한 번(이미 알린 공백 안이면 INFO).
        - 아니면(그보다 새 파일이 없다) 연속을 연다(WARN 한 번, _open_missing). 실행 기록에 실을 한 줄을 돌려준다(가린 것이 없으면 빈 글자)."""
        note = ""
        opening: list[Exhausted] = []
        for x in exhausted:
            if x.tm >= newest:
                opening.append(x)
                continue
            gap = self._closed_gap
            if gap is not None and gap[0] <= x.tm < gap[1]:
                log.info(
                    "kma radar: tm=%s still unavailable after %d tries — skipped (inside the gap reported from tm=%s to tm=%s): %s",
                    x.tm,
                    x.tries,
                    gap[0],
                    gap[1],
                    x.answer,
                )
            else:
                log.warning("kma radar: tm=%s still unavailable after %d tries — skipped: %s", x.tm, x.tries, x.answer)
            note = f"tm={x.tm} still unavailable after {x.tries} tries — skipped: {x.answer}"
        if opening and self.missing is None:
            self._open_missing(opening, newest, kinds)
            note = self._missing_note()
        return note

    def _streak_text(self) -> str:
        s = self.missing
        assert s is not None
        return f"KMA download has no file since tm={s.since_tm} ({s.tms} tms answered missing, newest tm={s.last_tm})"

    def _missing_note(self) -> str:
        s = self.missing
        assert s is not None
        idle = s.list_idle()
        return f"{self._streak_text()}; last answer: {s.answer}" + (f"; {idle}" if idle else "")

    def _open_missing(self, opening: list[Exhausted], newest: str, kinds: dict) -> None:
        """연속을 연다(WARN 한 번). 이 프로세스에서 '파일 없음'으로 답한 tm 중 파일이 있던 가장 새 tm(newest)보다 새 것을 모두 센다 — 끝내 없던 tm
        (opening)과 아직 시도 중이던 tm(_not_ready). 다시 띄운 수집기처럼 보관 창의 옛 빈 tm 이 후보(최신 MAX_PER_CYCLE 개)에서 밀려나 세 번을 채우지
        못해도 없다는 답을 받았으면 첫 tm 이 된다(리뷰 2026-09-30 — 전에는 늦은 tm 에서 열려 앞선 tm 이 회복 뒤 tm 마다 WARN 했다).
        마지막 답(파일 이름 · 목록 종류 · 원문)은 이 주기의 마지막 '파일 없음' 답이다(연속 중 _saw_missing 과 같다)."""
        now = _now()
        first = min(opening, key=lambda x: x.tm)
        answer, listed = self._last_answer or (first.answer, first.listed)
        m = MISSING_FILE_RE.search(answer)
        s = MissingStreak(first.tm, first.tm, 1, now, now, m.group(0) if m else "", listed, answer, seen={first.tm})
        for tm in sorted({x.tm for x in opening} | {t for t, n in self._not_ready.items() if n >= 1 and t > newest}):
            s.count(tm)
        s.every_s = streak_probe_every_s(s.since_tm, kst_now(), settings.kma_radar_poll_s)
        self.missing = s
        since_kinds = kinds.get(s.since_tm)
        log.warning(
            "kma radar: KMA download has no file from tm=%s on — %d tms answered missing (newest tm=%s); the listing has tm=%s (%s); "
            "tm=%s answered %d times: %s; probing only the newest listed tm and the newest one at least %d min old once per cycle, "
            "every %d min once the gap is %d min old, reminder every %d min (chosen)",
            s.since_tm,
            s.tms,
            s.last_tm,
            s.since_tm,
            listed_text(",".join(since_kinds) if since_kinds else ""),
            first.tm,
            first.tries,
            first.answer,
            MISSING_RECHECK_S // 60,
            MISSING_SLOW_EVERY_S // 60,
            MISSING_SLOW_AFTER_S // 60,
            MISSING_REMIND_S // 60,
        )

    def _saw_missing(self, tm: str, answer: str, listed: str) -> MissingStreak:
        """연속 중 또 '파일 없음' — 처음 확인한 tm 만 센다(MissingStreak.count). 마지막 확인 · 답 · 파일 이름 · 목록 종류는 이 답의 것."""
        s = self.missing
        assert s is not None
        s.count(tm)
        m = MISSING_FILE_RE.search(answer)
        s.checked_at, s.answer, s.file, s.listed = _now(), answer, m.group(0) if m else "", listed
        return s

    def _remind_missing(self) -> None:
        s = self.missing
        if s is None or (s.checked_at - s.warned_at).total_seconds() < MISSING_REMIND_S:
            return
        s.warned_at = s.checked_at
        args = (
            s.since_tm,
            s.tms,
            s.last_tm,
            listed_text(s.listed),
            tm_span(s.since_tm, s.last_tm),
            max(s.every_s, settings.kma_radar_poll_s) // 60,
            s.answer,
        )
        if s.list_idle():  # 목록도 자라지 않는다(계약 v5 §G26 개정 2026-10-01) — 알림이 그 까닭도 적는다(따로 한 지문)
            log.warning(
                "kma radar: KMA download still has no file — since tm=%s, %d tms answered missing, newest tm=%s (%s), %s of tms; "
                "probing every %d min (chosen); last answer: %s; the KMA listing has no tm after tm=%s either (newest listed tm=%s)",
                *args,
                s.last_tm,
                s.list_tm or "none",
            )
            return
        log.warning(
            "kma radar: KMA download still has no file — since tm=%s, %d tms answered missing, newest tm=%s (%s), %s of tms; "
            "probing every %d min (chosen); last answer: %s",
            *args,
        )

    def _file_back(self, tm: str) -> None:
        """gzip 을 받았다: 열린 연속의 첫 tm 이후면 연속을 닫는다(INFO — 공백 = 첫 tm 부터 다시 온 tm 앞까지). 다시 온 tm 보다 새 tm 이 '없음'으로
        답했을 수 있다(10분 넘은 tm 이 먼저 돌아오면 — 아직 생기지 않은 tm) — 공백에 넣지 않고 다음 주기부터 전처럼 다시 시도한다."""
        s = self.missing
        if s is None or tm < s.since_tm:
            return
        log.info(
            "kma radar: KMA download has the file again at tm=%s — the gap from tm=%s is %s of tms "
            "(%d tms answered missing, the newest tm=%s); normal retries resume",
            tm,
            s.since_tm,
            tm_span(s.since_tm, tm),
            s.tms,
            s.last_tm,
        )
        self._closed_gap = (s.since_tm, tm)
        self.missing = None

    async def _load_missing(self, carry: bool = True) -> None:
        """첫 주기: 앞선 프로세스가 meta 해시에 남긴 연속과 알린 공백을 읽는다. 연속은 마지막 확인이 MISSING_CARRY_S 안이면 이어받고(WARN 은 앞
        프로세스가 했다), 아니면 옛 값이라 run_once 가 이 주기 첫머리에 지운다(_publish_missing — 주기가 'error' 로 끝나도). 알린 공백은 끝 tm 이 MISSING_GAP_KEEP_S 안이면 이어받는다.
        carry=False 면 읽기만 한다(해시에 무엇이 있는지 — 지울 때). Redis 를 못 읽으면 다음 주기에 다시 읽는다."""
        try:
            async with asyncio.timeout(AUX_TIMEOUT_S):
                h = await self.ctx.status.redis.hgetall(KEY_META)
        except Exception as e:  # noqa: BLE001 — 부가 기능
            log.info("kma radar: could not read the missing-file streak — %s (read again next cycle)", describe_error(e))
            return
        self._loaded = True
        self._published = {k: str(h.get(k) or "") for k in MISSING_KEYS}
        self._published_gap = {k: str(h.get(k) or "") for k in GAP_KEYS}
        if not carry:
            return
        g_from, g_to = self._published_gap["missing_gap_from"], self._published_gap["missing_gap_to"]
        if tm_dt(g_from) is not None and tm_dt(g_to) is not None and g_from < g_to and not gap_expired(g_to, kst_now()):
            self._closed_gap = (g_from, g_to)
        since, last = self._published["missing_since_tm"], self._published["missing_last_tm"]
        checked = parse_iso(self._published["missing_checked_at"])
        try:
            n = int(self._published["missing_tms"])
        except ValueError:
            n = 0
        now = _now()
        if tm_dt(since) is None or tm_dt(last) is None or checked is None or n < 1:
            return
        # 앞 프로세스의 확인 간격(없거나 틀리면 주기 — 늦추기 전 수집기가 남긴 연속). 이어받는 상한 = 간격 × MISSING_STALE_PROBES(아래로 MISSING_CARRY_S)
        raw_every = self._published["missing_probe_every_s"]
        every = int(raw_every) if raw_every.isdigit() and 0 < int(raw_every) <= 86_400 else settings.kma_radar_poll_s
        if not 0 <= (now - checked).total_seconds() <= missing_carry_s(every):
            log.info(
                "kma radar: dropped the missing-file streak since tm=%s left in Redis — last checked %s", since, iso(checked)
            )
            return
        # 마지막 확인의 목록 필드(계약 v5 §G26 개정)도 이어받는다 — 다음 확인까지 해시가 빈 값으로 흔들리지 않게. 틀린 값은 모름(빈 값)
        list_tm = self._published["missing_list_tm"]
        raw_newer = self._published["missing_list_newer"]
        self.missing = MissingStreak(
            since,
            last,
            n,
            checked,
            now,
            self._published["missing_file"],
            self._published["missing_listed"],
            "",
            carried=(since, last),
            every_s=every,
            list_tm=list_tm if tm_dt(list_tm) is not None else "",
            list_newer=int(raw_newer) if re.fullmatch(r"[0-9]{1,6}", raw_newer) else None,
        )
        self._probe_at = checked  # 늦춘 연속이면 마지막 확인에서 간격을 센다(다시 띄워도 곧바로 부르지 않는다)
        log.info("kma radar: carried over the missing-file streak since tm=%s (%d tms, last checked %s)", since, n, iso(checked))

    async def _drop_missing(self) -> None:
        """수집하지 않는 동안(KMA_APIHUB_KEY 없음): 해시에 남은 연속 · 알린 공백을 지운다 — 없으면 쓰지 않는다. 실패하면 다음 주기에 다시."""
        if not self._loaded:
            await self._load_missing(carry=False)
            if not self._loaded:
                return
        self.missing = self._closed_gap = None
        await self._publish_missing()

    async def _publish_missing(self) -> None:
        """연속(없으면 빈 값)을 meta 해시와 공급자 해시에, 알린 공백(없거나 오래되면 빈 값)을 meta 해시에만 싣는다 — 마지막으로 쓴 값과 다를 때만.
        쓰기에 실패하면 다음 주기에 다시 쓴다(닫은 연속을 지우지 못한 채 '쓴 것'으로 기억하면 화면에 옛 연속이 남는다)."""
        fields = self.missing.fields() if self.missing is not None else dict.fromkeys(MISSING_KEYS, "")
        if self._closed_gap is not None and gap_expired(self._closed_gap[1], kst_now()):
            self._closed_gap = None
        g = self._closed_gap
        gap = dict(zip(GAP_KEYS, g, strict=True)) if g is not None else dict.fromkeys(GAP_KEYS, "")
        if fields == self._published and gap == self._published_gap:
            return
        r = self.ctx.status.redis
        try:
            async with asyncio.timeout(AUX_TIMEOUT_S):
                await r.hset(KEY_META, mapping=fields | gap)  # type: ignore[arg-type]
                if fields != self._published:
                    await r.hset(self.ctx.status.key(self.p.name), mapping=fields)  # type: ignore[arg-type]
        except Exception as e:  # noqa: BLE001 — 부가 기능
            log.info("kma radar: could not write the missing-file streak — %s (written again next cycle)", describe_error(e))
            return
        self._published, self._published_gap = fields, gap

    def _header_meta(self, header, meta: dict) -> dict[str, str]:
        """meta 해시의 헤더 값 — latest_tm 프레임을 설명할 때만 쓴다. fetched_at(STALE 시계)은 여기 없다 — 새 latest_tm 을 저장할 때만(_store)."""
        return {
            "product": header.product,
            "cmp": self.p.cmp,
            "coordinates": orjson.dumps(meta["coordinates"]).decode(),
            "width": str(meta["width"]),
            "height": str(meta["height"]),
            "projection": meta["projection"],
            "grid": orjson.dumps(meta["grid"]).decode(),
            "legend": orjson.dumps(meta["legend"]).decode(),
            "min_dbz": str(meta["min_dbz"]),
            "observed_cells": str(meta["observed_cells"]),
        }

    async def _store(self, tm: str, res) -> None:
        ctx = self.ctx
        raw_ref = await archive(ctx.raw, "kma_radar", res.raw, res.fetched_at)  # 이미 gzip → 그대로 .bin.gz(R-21)
        try:
            header, png, meta = await asyncio.get_running_loop().run_in_executor(_DECODE_POOL, _decode, res.raw)
        except Exception as e:  # noqa: BLE001 — 해석 실패는 격리(원천은 남는다)
            raise _BadFrame(f"{type(e).__name__}: {e} (raw={raw_ref})") from e
        r = ctx.status.redis
        now = datetime.now(UTC)
        prev_latest, prev_fetched = await r.hmget(KEY_META, "latest_tm", "fetched_at")  # STALE 시계를 옮길지(아래)
        await r.set(KEY_FRAME.format(tm=tm), base64.b64encode(png).decode("ascii"), ex=FRAME_TTL_S)
        frames = [f for f in await self._frames() if f["tm"] != tm]
        entry: dict = {
            "tm": tm,
            "obs_tm": header.tm.strftime("%Y%m%d%H%M"),
            "fetched_at": iso(res.fetched_at),
            "expires_at": iso(now + timedelta(seconds=FRAME_TTL_S)),
            "bytes": len(png),
            "echo_cells": meta["echo_cells"],
            "raw_ref": raw_ref,
            "stations": len(header.stations),  # 헤더 STN_LIST 의 지점 코드 수(합성에 든 레이더)
            "station_ids": list(header.stations),
            "refetches": 0,  # 부분 합성이라 다시 받은 횟수 · 지점이 늘어 바꾼 횟수
            "upgrades": 0,
        }
        until = refetch_until(tm)
        if until is not None:
            entry["refetch_until"] = until
        frames.append(entry)
        frames = sorted(frames, key=lambda f: f["tm"])
        dropped, frames = frames[:-KEEP_FRAMES], frames[-KEEP_FRAMES:]
        annotate_partial(frames)
        if entry.get("partial") is True:
            self.partial_stored += 1
        mapping: dict[str, str] = {
            "available": "1",
            "status": "200",
            "note": "",
            "latest_tm": frames[-1]["tm"],
            "checked_at": iso(now),
            **latest_station_fields(frames),  # 기준이 바뀌면 최신 프레임의 판정도 바뀐다 — 저장할 때마다 최신 프레임 값으로
        }
        # 헤더 값·fetched_at 은 latest_tm 프레임을 설명한다. 보관 창 안의 오래된 빈 곳을 채운 경우(R-03)에는 그대로 둔다 —
        # 옛 프레임 값으로 덮으면 meta 가 latest_tm 과 다른 프레임을 설명하고, fetched_at 이 새로 보여 STALE 이 가려진다.
        if frames[-1]["tm"] == tm:
            mapping |= self._header_meta(header, meta)
            # fetched_at(STALE 시계 — latest_tm 을 처음 저장한 시각)은 앞선 latest_tm 보다 새 tm 일 때만 옮긴다: 같은(또는 더 옛) tm 을 다시 받은 것은 새 프레임이
            # 아니다(영상이 사라져 다시 받은 최신 tm — 전에는 다시 받은 시각으로 옮겨 새 tm 이 오지 않는 동안 STALE 이 늦어졌다, 도전 2026-10-01)
            if not prev_fetched or tm_dt(prev_latest) is None or tm > str(prev_latest):
                mapping["fetched_at"] = iso(res.fetched_at)
        # 쓰는 순서: 이미지(위) → meta → 목록(D2). 어디서 실패해도 목록이 meta(latest_tm · fetched_at — STALE 시계)보다 앞서지 않는다 — 앞서면 그 tm 은
        # 목록에 있어 다시 받지 않으므로 더 새 tm 이 올 때까지 meta 가 뒤처졌다. meta 가 앞선 채 멈추면(목록 쓰기 실패) 그 tm 은 목록에 없어 다음 주기가
        # 다시 받는다(fetched_at 은 처음 저장한 그대로). 남는 것은 목록에 없는 이미지(TTL 3 h)뿐이다
        await r.hset(KEY_META, mapping=mapping)  # type: ignore[arg-type]
        await self._save_frames(frames)
        if dropped:
            await r.delete(*[KEY_FRAME.format(tm=f["tm"]) for f in dropped])  # 목록에서 빠진 이미지는 바로 지운다
        log.info(
            "kma radar: tm=%s %s stations=%d%s echo cells=%d png=%d B (%d frames)",
            tm,
            header.product,
            len(header.stations),
            f"/{entry['stations_ref']} partial" if entry.get("partial") else "",
            meta["echo_cells"],
            len(png),
            len(frames),
        )
