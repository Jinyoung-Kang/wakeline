# ADR-036 기상특보 — 기상청 API허브 특보현황을 5분마다 받아 목록 전체를 교체하고, 이력은 끝나는 시각까지 남긴다

**상태** 채택 · 2026-10-09 · 사용자 승인("권장안대로" — [계획](../plans/features-2026-10/PLAN.md) §9 결정 D6 · D9) · [SPEC](../plans/features-2026-10/SPEC.md) F3 ·
계약 [v5 §G49](../audit/change-contract-v5.md) · 함께 보는 기록: [ADR-011](ADR-011-deviations-from-design-v0.2.md) · [VERIFICATION](../VERIFICATION.md) #120

## 맥락
- 상황판에 위험기상(SIGMET)은 있지만 한국 해상 · 육상 기상특보가 없다. 공개 경로를 조사했다(2026-10-09): API허브 `wrn_now_data.php`(지금 발효 중, 구역 코드 단위) ·
  `wrn_reg.php`(구역 목록 · 유효 기간) · 공공데이터포털 기상특보 조회서비스(통보문 글자). **구역 경계 도형은 공개 자료가 없다** — 선박 위치와 구역을 이을 수 없다.
- 실제 응답(같은 날 — 예비 풍랑 3건): EUC-KR · 머리 주석 + 한 특보 한 줄(쉼표, 끝 `=`) · 시각 KST · 예비특보의 발효 시각은 시각이 아니라 때(시간대)를 뜻하는
  부호(`hh:59` · `hh:58` — 머리 주석의 표). 특보가 없으면 주석만 온다. `disp=1` 은 JSON 이지만 빈 목록의 모양을 보지 못해 확인한 `disp=0` 을 쓴다.

## 결정
1. **수집**: 수집기 작업 `kma_warning`(SIGMET 작업과 같은 파일 — 같은 호출 · 예산 · 실패 기록 도우미)이 300 s 마다 한 번 부른다. 하루 예산 400(엄격 — 예산
   저장소가 안 되면 부르지 않음), API허브 호스트 버킷(0.5 req/s · burst 1)은 레이더 합성과 나눈다. 키가 없으면 · 운영자가 끄면 부르지 않고 heartbeat
   `kma_warning_state`(no_key · disabled · ok)로 알린다. fixture 모드는 실제 응답을 재생한다(시각만 지금으로).
2. **해석은 규칙 모듈**(`kma_warning_rules`): UTF-8 먼저 · 아니면 EUC-KR, 머리 주석이 없으면 응답 전체를 거절(인증 실패 글 · 504 HTML), 모양이 틀린 줄은 그 줄만
   버리고 센다(품질 기록). 시각은 UTC 로, 원문 줄은 그대로(raw). **예비특보에는 발효 시각을 만들지 않는다** — 때(effective_from/to · effective_text)만,
   표에 없는 부호면 때도 모름.
3. **전달**: 새 스트림 `wakeline:wxwarn`(kind `wx_warnings` · scope `-` · 목록 전체 · MAXLEN 200). JSON Schema(`wx_warnings_payload`, 예비면 effective_at 금지 ·
   정규면 필수)를 api 가 검증한다(다른 스트림의 wx_warnings 는 거절). Redis ACL: 수집기는 이 스트림에 쓰고, ais 는 못 쓴다.
4. **api**: 실시간 목록은 메모리(`WarningStore` — 더 새 목록만), 이력은 스트림 순서대로 DB(V20 `wx_warning` — 자연키 이어 쓰기, 목록에서 빠지면 그 목록의
   수신 시각으로 끝, 다시 나타나면 다시 엶 · 영수증으로 저장 뒤 ACK · 끝난 행 90일 보존). REST `GET /api/v1/warnings`(ETag · 30 s) ·
   `/warnings/history`(≤ 30일 · 구역 거르기). **WS 메시지는 더하지 않는다**(결정 D6 — 몇 분 단위로 바뀌는 자료).
5. **화면**: 오른쪽 패널 'wx' 탭(탭을 열 때 받는 조각 — 60 s ETag 조회): 해상을 상위 구역별로 먼저, 육상은 접음, 수신 전 · 0건 · 오래됨(15분) · 조회 실패를
   구분. 선박 카드 한 줄 "해상특보: 지금 발효 중 N건 — 이 선박의 구역은 판정하지 않음(구역 경계 자료 없음)" — 구역을 짐작해 붙이지 않는다.

## 버린 대안
- **`disp=1`(JSON)**: 읽기 쉽지만 특보가 없을 때의 모양을 보지 못했다.
- **WS 로 방송**: 계약 · 웹 검사기 · 첫 화면 JS 가 는다 — 5분 자료에 실시간 통로가 필요 없다.
- **`wrn_reg` 로 구역 목록 받기**: 지금 화면에 필요한 이름 · 상위 구역은 특보 줄에 함께 온다. 구역 경계가 생길 때(SPEC F9) 쓴다.
- **선박 위치를 구역 이름에서 짐작**: 제품 규칙(받쳐지지 않는 값을 짐작하지 않는다)에 어긋난다.

## 결과
- 시험: collector `test_kma_warning_rules.py`(실제 응답 · 빈 목록 · 예비 13 부호 · 틀린 줄 · 거절 · 인코딩 · 상한) · `test_kma_warning_job.py`(스키마 그대로 발행 ·
  실패 시 발행 안 함 · 키 없음 · 운영자 끔 · 품질 · 파라미터 · 키 가림 · 재생) · `contract_check`(실제 fixture + 틀린 표본 둘) · api `StreamConsumerWarningsTest` ·
  `WarningControllerTest` · `WarningPersistDbTest` · `RestSamplesIT`(warnings · history) · `RolePrivilegesDbTest`(V20) · Redis ACL 시험 · web `warnings.test.ts` ·
  e2e `warnings.spec.ts`.
- 남은 한계: 구역 경계가 없어 선박 · 항공기 위치와 잇지 못한다(F9). 특보 해제의 까닭은 목록에서 빠진 것으로만 안다(통보문 글자는 받지 않는다). 공항경보는
  실시간 공개 API 가 없어 다루지 않는다.
