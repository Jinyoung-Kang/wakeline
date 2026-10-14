# 수집기 · AIS — AWS 공개 데모판 출시 QA(2026-10-14)

- 대상: 브랜치 `qa/aws-2026-10`(= `main` `29d39e38` + QA 도구) · `apps/collector`(패키지 `wakeline_collector` 와 `wakeline_collector.ais`).
- 환경 **U** = 이 Mac 의 pytest(`uv run --offline`), 외부 호출 없음(respx 가로챔 · 저장된 실제 응답 `fixtures/` · `tests/fixtures/` · `tests/fakes.py` 의 가짜 Redis).
  **R** = 버리는 Redis 컨테이너(`redis:8-alpine`, 이름 `wlqa-collector-redis`, `127.0.0.1:56391`, 비밀번호 없음 — 시험 뒤 지움). 스택 A · B 는 로그 읽기만 했다.
- 재현 시험은 모두 **지금 실패**한다(아래 실패 글 · `evidence/collector/qa-*.txt`). 고치지 않았다.
- 시험 키 · 비밀값은 모두 이 시험만의 가짜 값이다(`QA1140fakeKmaKey…` 등). `.env` · QA env 파일은 열지 않았다.

## 점검한 것(결함이 아닌 결과 포함)

| 후보 | 결과 | 증거 |
|---|---|---|
| 1 금요일 마지막 약 10분의 `provider_budget_day` | **재현 — AWS 리뷰 C-3 와 같다**(고치지 않기로 한 항목). 아래 '앞선 리뷰와 같음' | `c3_friday_budget_sim.*` |
| 2 `release_key` 의 TTL 없는 음수 키 | **결함 QA-1220** | `qa-1220-pytest.txt` |
| 3 오류 본문을 자른 뒤 가리기 | **결함 QA-1140**(비밀값) — 자르는 자리가 다섯 곳 | `qa-1140-pytest.txt` |
| 4 원천 보관이 성공 본문을 가리지 않음 | 재현(가짜 키가 디스크에 남음). 원문 불변 보관이라는 설계 — **개선 제안**. 저장된 실제 응답에 키 · 키 이름이 되돌아온 것은 0 | `c4_raw_store_keeps_echoed_key.*` |
| 5 Redis 장애 중 AIS 재시작 | 재현 — 손실은 ADR-033 '남은 한계'와 같다(아래). 덧붙여 **부팅 때 ais 가 Redis 보다 먼저 뜨면 밤 · 주말 공백이 기록되지 않음**도 재현(AWS 리뷰 C-4 와 같은 것으로 보임) | `c5_*` · `c5b_*` |
| 6 fixture 모드 전체 주기 외부 호출 0 | **통과** — 단언 시험을 더했다(주기 작업 9종 각 3회 이상 동안 httpx 전송 · asyncio 연결 · socket.connect 시도 0). 같은 시험을 실시간 모드로 바꾸면 시도가 잡힌다(대조). 스택 A 수집기 로그에도 공급자 호스트 0 | `candidate6-fixture-no-external.txt` |
| 7 운영 설정 범위 검사가 수집기에 일부만 | **결함 QA-1221**(region_center 를 api 와 다르게 읽음 · NaN 으로 외부 호출). 주기 상한 없음은 같은 결함에 덧붙임 | `qa-1221-pytest.txt` · `c7_runtime_settings_probe.py` |
| 8 호스트 단위 429 쉼(#141) | 재현만 — **미확인(기대 동작 결정 필요)** | `c8_host_429_blocks_other_service.*` |
| 9 특보 MAX_LEN · OverflowError 로 버린 줄 → api 의 dropped | **정상** — 두 줄을 덧붙이면 봉투 `dropped=2`, 나머지 3건 발행. 같은 점검에서 **한 줄의 글자 풀기 실패가 목록 전체를 버림**을 찾음 → 결함 QA-1222 | `c9_warning_dropped_probe.*` · `qa-1222-pytest.txt` |

수집기 전체 시험: `uv run --offline pytest -q` → 16 실패 · 1,997 통과 · 28 건너뜀(기준선 1,994 통과 · 27 건너뜀). 실패 16 = 이 영역 재현 시험 14 + 다른 영역(보안)의
`test_qa_1130_*` 2. 새 시험 파일은 `ruff check` · `ruff format --check` 통과(`evidence/collector/full-suite.txt`).

## 결함

### QA-1140 · 낮음(비밀값 영역) · 수집기 · AIS — 공급자 오류 글을 먼저 자르고 나중에 가린다: 경계에 걸친 키의 앞부분이 남는다
- **환경**: U(pytest · respx · 가짜 키).
- **재현 절차**: `cd apps/collector && uv run --offline pytest tests/qa/test_qa_1140_error_body_cut_before_masking.py -q`
  1. 기상청 특보 공급자(실제 `KmaWarningProvider` · `HttpClient`)가 401 과 함께 키를 되돌려 주는 본문을 받는다 — 키가 120 · 200 글자 경계에 걸치게.
  2. `KmaWarningJob.run_once()` 의 실패 기록 세 곳(공급자 상태 `last_error` · `ingest_run.error_text` · 경고 로그)과 예외 글(`str(e)`)을 본다.
- **기대**: masking.py 의 약속대로 "설정 비밀값 자체를 어디에 나오든 가린다"(R-83 — 공급자가 키를 되돌려 주는 경우를 막으려고 더한 규칙). 키 조각 0.
- **실제**(가짜 키 35글자):
  - 경고 로그 · `last_error` · `error_text`: `… HTTP 401 Unauthorized — EEEE…EQA1140fakeKm` — 앞 12글자.
  - JSON 모양(`"authKey":"…`)이 120 에서 잘리면 닫는 따옴표가 없어 모양 규칙도 맞지 않는다 → 앞 **25글자**(`QA1140fakeKmaKey012345678`).
  - `str(e)`(트레이스백 · `%s` 로그) — 200 에서 잘린 앞 10글자. 200 응답의 '특보 목록 아님' 오류(`text[:80]`) — 앞 11글자.
  - AIS: WebSocket close 사유(최대 123 바이트)를 120 에서 자른 뒤 가린다 → 끝 3글자만 잘려도 **32글자**가 공백 원인으로 남고, 그 원인은 ais_gap 봉투 → api
    `/api/v1/ais/gaps` 의 `reason`(공개 경로)으로 간다.
- **증거**: `evidence/collector/qa-1140-pytest.txt`(6 실패 · 1 통과 — 통과한 1건은 키 전체가 잘리지 않은 대조군: 값으로 가리기는 맞게 동작).
- **의심 원인**: 가리기(`mask` · `redact`)보다 자르기가 먼저다.
  - `apps/collector/wakeline_collector/http.py:218` `ProviderHttpError(status, body[:200]…)` · `http_errors.py:37-39`(`body_head[:200]`)
  - `apps/collector/wakeline_collector/errors.py:71` `_one_line(body)[:BODY_HEAD]`(120) → `errors.py:146` 에서야 `mask`
  - `apps/collector/wakeline_collector/kma_warning_rules.py:154` `text.strip()[:80]` · `providers/kma_radar.py:58` `text[:120]`(같은 모양)
  - `apps/collector/wakeline_collector/ais/client.py:117 · 121 · 248` `reason[:120]` → `client.py:212` `self.redact(reason)`
- **심각도 근거**: 구조는 확인(가짜 키로 재현)했지만, 조건이 둘 겹쳐야 한다 — 공급자가 오류 글에 키를 되돌려 주고(실제로 그러는 공급자는 확인하지 못함:
  저장된 실제 응답 · 앞선 리뷰의 운영 로그 350줄에서 0건) 키가 자르는 경계에 걸쳐야 한다. 남는 곳은 대부분 운영자만 보는 곳(/ops · /logs · docker logs — AWS 에서는
  Caddy 가 /ops · /logs 를 막는다)이고, 공개 경로는 AIS 공백 원인 하나다. 같은 위험의 원래 항목 R-83 이 Low 였다. 비밀값 노출 영역이라 번호는 QA-114x.

### QA-1220 · 낮음 · 수집기 · 예산 — 시간 창 돌려주기(`release_key`)가 키가 없으면 TTL 없는 음수 키를 만든다
- **환경**: U(가짜 Redis) · R(실제 Redis 8).
- **재현 절차**: `cd apps/collector && WAKELINE_TEST_REDIS_URL=redis://127.0.0.1:56391/0 uv run --offline pytest tests/qa/test_qa_1220_release_key_creates_ttl_less_key.py -q`
  1. `reserve_hour("mof_grid4", 390, window="mof")` — 키 `budget:mof:h:2026101608` 이 TTL 2 h 로 생긴다.
  2. 키가 사라진다(Redis 가 죽어 AOF `everysec` 의 마지막 1 s 를 잃음 · 운영자가 지움 — 시험은 DEL 로 흉내).
  3. 보내지 않은 호출이라 `release_key(key)` 로 돌려준다.
- **기대**: 하루 예산의 돌려주기(F3 이후 `RELEASE_LUA`)와 같다 — 키가 없거나 사용량이 cost 보다 적으면 아무것도 하지 않는다.
- **실제**: `release_key left budget:qa1220:h:2026101608: fields={'used': '-1'} ttl=-1 (-1 = no expiry)` — 가짜 Redis 에서도 `{'used': '-1'}`.
  그 시의 다음 예약이 없으면(시 끝 무렵 — 다음 예약은 다음 시 키) `noeviction` Redis 에 영영 남고, 같은 시에 다음 예약이 있으면 그 창이 한도보다 1 더 받는다.
- **증거**: `evidence/collector/qa-1220-pytest.txt`.
- **의심 원인**: `apps/collector/wakeline_collector/budget.py:149-154` — `hincrby(key, "used", -cost)` 한 줄. 같은 파일의 `RELEASE_LUA`(45-54)는 이 경우를 막지만
  `release` 만 쓴다. 부르는 곳: `jobs/traffic_grid.py:472 · 494 · 816 · 833`, `jobs/portcalls_index.py:620 · 634`. CTO 리뷰 F3(collector-review.md)가 하루 키만 고쳤다.
- **심각도 근거**: 키가 예약과 돌려주기 사이(수 ms – 40 s)에 사라져야 한다 — 드문 조건. 결과는 작은 키 하나 · 한 시간 창의 1 호출.

### QA-1221 · 낮음 · 수집기 · 운영 설정 — Redis 의 `region_center` 를 api 와 다르게 읽어 NaN 좌표로 외부를 부른다(fixture 는 매 주기 예외)
- **환경**: U(가짜 Redis · respx).
- **재현 절차**: `cd apps/collector && uv run --offline pytest tests/qa/test_qa_1221_region_center_non_finite.py -q`
  1. `wakeline:settings` 의 `region_center` 에 `nan,nan`(또는 `inf,127.8` · `36.5,-infinity` · `1_0,127.8`)을 둔다 — 운영 API 를 거치지 않은 값.
  2. `RuntimeSettings.region` 을 읽고, 실시간 관심 지역 작업(`AircraftJob("region")` + 실제 `adsb_lol` 공급자)을 한 번 돌린다.
- **기대**: api `RegionSettings.parse`(`RegionSettings.java:107-129` — 주석 "collector runtime_settings.region 과 같은 해석")와 같이 해석 실패 · 유한하지 않은 값은
  .env 기본값(36.5, 127.8). 공급자 호출에 `nan` 이 실리지 않는다.
- **실제**: `'nan,nan' → (nan, nan)` · `'inf,127.8' → (inf, 127.8)` · `'36.5,-infinity' → (36.5, -inf)` · `'1_0,127.8' → (10.0, 127.8)`(api 는 모두 기본값),
  관심 지역 작업은 `https://api.adsb.lol/v2/point/nan/nan/250` 을 부른다. fixture 모드에서는 `FixtureAircraftProvider._moved` 가 `ValueError: math domain error`
  로 매 주기 실패한다. 같은 자리에서 주기 상한도 없다 — `global_poll_s=999999999` 를 그대로 쓴다(api 는 60–3600 만 받는다).
- **증거**: `evidence/collector/qa-1221-pytest.txt`(5 실패) · `c7_runtime_settings_probe.py`.
- **의심 원인**: `apps/collector/wakeline_collector/runtime_settings.py:63-71`(`float(x)` 만 — 유한 · 범위 검사 없음), `runtime_settings.py:43-56`(하한만).
  api 는 쓸 때만 검사하고(`SettingsService.validate`) 미러(`SettingsService.java:126` `mirror()`)는 app_setting 을 검사 없이 Redis 로 옮긴다.
- **심각도 근거**: 운영 API 는 이런 값을 거절한다(앞선 QA 기능 점검 — NaN 400). 값이 Redis · DB 에 직접 들어가야 하는 드문 조건. 생기면 관심 지역 레이어가 비고
  두 프로세스의 관심 지역이 갈린다.

### QA-1222 · 낮음 · 수집기 · 특보 — EUC-KR 로 풀리지 않는 바이트가 한 줄에만 있어도 특보 목록 전체를 버린다
- **환경**: U(저장된 실제 응답 `tests/fixtures/kma_warning/wrn_now_data_preliminary.txt` + 덧붙인 한 줄).
- **재현 절차**: `cd apps/collector && uv run --offline pytest tests/qa/test_qa_1222_warning_one_undecodable_line.py -q`
  — 특보 3줄 뒤에 (a) 구역 이름에 CP949(UHC) 확장 한글 '똠'이 있는 줄(cp949 로 인코딩), (b) 끝에 0xFF 바이트 하나가 있는 줄을 덧붙여 `KmaWarningJob.run_once()`.
- **기대**: 모듈 규칙("모르는 모양의 줄은 버리고 센다 — 목록 전체를 버리지 않는다", ADR-036 결정 2 · 앞선 QA-602 · 603 과 같은 규칙) — 그 줄만 `dropped=1`, 특보 3건 발행.
- **실제**: 아무것도 발행하지 않는다 — `WarningResponseError — neither UTF-8 nor EUC-KR (byte 1743)`. 그 줄이 목록에 있는 동안 5분마다 같고, 화면은 옛 목록과 그 나이.
- **증거**: `evidence/collector/qa-1222-pytest.txt` · `c9_warning_dropped_probe.txt`.
- **의심 원인**: `apps/collector/wakeline_collector/kma_warning_rules.py:68-78` — 본문 전체를 한 번에 UTF-8 → EUC-KR 로 풀고 실패하면 목록 전체를 거절한다(줄 단위
  격리는 풀기 뒤 `parse` 에만 있다 — 159-163).
- **심각도 근거**: 기상청이 그런 글자를 실제로 보내는지는 확인하지 못했다(받은 실제 응답에는 없다 — 응답 머리는 `charset=EUC-KR`, 한국 서버는 흔히 CP949 를 그 이름으로 보낸다).
  드문 조건 · 같은 규칙의 QA-603(낮음)과 같은 무게.

## 앞선 리뷰 · ADR 과 같음(새 결함으로 올리지 않음)

- **후보 1 = AWS 리뷰 C-3**('금요일 마지막 10분 예산 통계', `docs/review/aws-2026-10/PLAN.md` §2.3 — 고치지 않기로 함). 지금도 남아 있다:
  유지보수는 기동 30 s 뒤 · 매시(`main.py:301`) 오늘 키와 어제 키만 다시 적는다(`jobs/maintenance.py:36-45`). 평일에는 다음 날 첫 유지보수가 '오늘 키'로 전날을 마감하지만,
  금요일(UTC) 키는 월요일 기동(일요일 23:5x UTC — 어제 = 토요일) 때 보지 않고, 그 전에 TTL 48 h(`budget.py:108`, 마지막 예약 ≈ 금 09:00 UTC 기준 → 일 09:00 UTC 만료)로
  사라진다. 모의 실행(평일 08:52–18:00 KST): 특보(5분) 1회 · 관심 지역(10 s) 45회가 금요일 행에서 빠진다(`c3_friday_budget_sim.txt`).
- **후보 5 = ADR-033 '남은 한계'**: 장애 중에 ais 가 멈추면 모은 분당 위치는 메모리와 함께 사라진다. 모의 실행(선박 2척, 장애 185 s): 멈출 때 메모리에만 있던 위치 8건,
  저장될 행에서 2분이 빠진다. **Redis 가 새 프로세스 기동 뒤에 돌아오면 ais_gap 도 없다**(ADR 이 적은 대로). Redis 가 기동 전에 돌아오면 장애 직전의 상태 해시로
  `ais process restart` 공백(장애 시작 ~ 첫 수신)이 남는다 — 원인 이름은 다르지만 빈 곳은 설명된다(`c5_ais_restart_during_redis_outage.txt`).
- **부팅 때 ais 가 Redis 보다 먼저 뜸 = AWS 리뷰 C-4 와 같은 것으로 보임**('기동 때 Redis 한 번 읽기 — 실측에서는 정상', PLAN §2.3 — 리뷰 문서에 대상이 적혀 있지
  않아 같은 항목인지 확정하지 못했다). `ais/main.py:140` 이 이전 상태를 기동 때 한 번만 읽고(`sink.py` `read_previous_status` — 실패하면 빈 값, 다시 읽지 않음),
  첫 상태 쓰기가 그 해시를 덮는다. 모의 실행: 63 h 정지 뒤 ais 가 Redis 보다 2 s 먼저 뜨면 `ais_gap: 없음` · 이전 `gap_open_since` 도 사라진다(Redis 가 먼저면 63 h 공백이
  `ais process stopped` 로 남는다 — `c5b_ais_boot_before_redis.txt`). redis-py 짧은 재시도(`redis_retry.py` — 연결 오류 2회, 1 s 안)는 AOF LOADING(BusyLoadingError ⊂
  ConnectionError)보다 짧을 수 있다. AWS 는 평일마다 dockerd 가 순서 없이 띄운다(QA 계획 §1.2) — 2026-10-01 로컬 재시작 실측에서는 redis 가 5 s 먼저 떴다
  (`docs/review/evidence/host-restart-2026-10-01.txt`).
- **후보 8 = VERIFICATION #141**(기대 동작 미정 — 아래 '미확인').

## 미확인
- **호스트 단위 429 쉼이 같은 포털의 다른 서비스를 막음(#141)** — 재현: PORT-MIS 가 429 를 받으면 `apis.data.go.kr` 가 30 s(이어지면 60 · 120 · 300 s) 쉬고,
  그동안 KOMSA 교통 · 해양수산부 격자 호출이 `Throttled` 로 보내지 않는다(`c8_host_429_blocks_other_service.txt`: 보낸 호출 PORT-MIS 1 · KOMSA 0 · WFS 0).
  포털이 429 를 키 단위로 주는지 서비스 단위로 주는지 알 수 없어 기대 동작을 코드 · 문서로 정할 수 없다(QA 계획 §5 멈춤 조건 예시) — 결정이 필요하다.
- **실제 스택에서 'ais 가 Redis 보다 먼저'**: 장애 주입 스택 B 는 다른 영역 에이전트가 함께 쓰므로 Redis 를 멈추지 않았다 — 구성 요소 모의 실행으로만 확인했다.
  AWS 부팅에서 경합이 실제로 얼마나 자주 나는지는 AWS 에 접속하지 않아 모른다.
- **공급자가 오류 글 · close 사유에 키를 되돌려 주는지**(QA-1140 의 전제): 실제 공급자를 부르지 않는 조건이라 확인하지 못했다.

## 개선 제안(결함 수에 넣지 않음)
1. **원천 보관 가림(후보 4)**: `raw_store.save` 는 성공 본문을 그대로 72 h 보관한다(가짜 키가 디스크에 그대로 — `c4_raw_store_keeps_echoed_key.txt`). 원문 불변 보관이 목적이라
   설계 판단이다. 공급자가 키를 성공 본문에 되돌려 주는 경우가 생기면, 등록한 비밀값이 들어 있는 본문은 보관하지 않거나(raw_ref `unsaved:secret`) 값만 바꿔 보관하는
   것을 고려한다. 지금 저장된 실제 응답에는 키 · 키 이름이 0건이다.
2. **ais 이전 상태 다시 읽기(C-4 와 같은 것으로 보임)**: 기동 때 읽기가 실패하면, Redis 가 처음 답하는 틱에 **첫 상태 쓰기보다 먼저** 이전 상태 해시를 한 번 더 읽어
   이어받는다(쓰고 나면 덮여 되살릴 수 없다). 밤 · 주말 공백과 장애 중 재시작 구간(후보 5 의 A)이 `/api/v1/ais/gaps` 에서 빠지지 않게 된다.
3. **금요일 예산 통계(C-3)**: 기동 때 한 번, TTL 안에 남은 예산 키(`budget:{p}:*` — 3일 이내)를 모두 다시 적는다. 키가 이미 만료된 금요일은 정지 직전(SIGTERM)의
   마지막 스냅샷으로만 살릴 수 있다 — 종료 경로에서 유지보수 스냅샷을 한 번 더 부르는 것이 가장 작다.
4. **자르기 전에 가리기(QA-1140 의 근본 규칙)**: 오류 글을 만드는 모든 곳이 `mask(…, None)` 뒤에 자르게 한 곳으로 모은다 — `ProviderHttpError` 는 원문 앞부분을 더 길게
   (예: 4 KiB) 들고 있다가 글로 만들 때 가린 뒤 자른다. 정적 검사(`[:N]` 뒤에 mask 가 오는 자리)를 test_masking 에 더하면 새 자리도 막힌다.
5. **수집기 설정 해석의 단일 규칙(QA-1221)**: api `RegionSettings.parse` · `SettingsService.validate` 와 수집기 `runtime_settings` 가 같은 시험 벡터
   (`schemas/vectors/` 처럼)를 쓰면 두 언어의 해석이 갈리지 않는다. 미러(`mirror()`)도 validate 를 거치게.

## 더한 시험 · 점검 스크립트
- 시험(`apps/collector/tests/qa/`): `test_qa_1140_error_body_cut_before_masking.py` · `test_qa_1220_release_key_creates_ttl_less_key.py` ·
  `test_qa_1221_region_center_non_finite.py` · `test_qa_1222_warning_one_undecodable_line.py` · `test_qa_aws_fixture_mode_makes_no_external_calls.py`(통과 — 회귀 시험).
- 점검 스크립트 · 출력(`docs/qa/2026-10-aws/evidence/collector/`): `c3_friday_budget_sim` · `c4_raw_store_keeps_echoed_key` · `c5_ais_restart_during_redis_outage` ·
  `c5b_ais_boot_before_redis` · `c7_runtime_settings_probe` · `c8_host_429_blocks_other_service` · `c9_warning_dropped_probe`(각 `.py` 머리에 실행 명령).
