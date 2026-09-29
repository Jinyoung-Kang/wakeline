# ADR-022 선박의 한국 항만 입출항: 선택한 선박의 호출부호로만 해양수산부 PORT-MIS 에 묻는다

**상태** 채택 · 2026-09-29

## 맥락
AIS 에는 "어느 항구에 언제 들어왔고 나갔는가" 가 없다. 목적지 칸은 선원이 입력한 자유 문자열이다(ADR-014 · 계약 v4 §B).
사용자가 공공데이터포털(data.go.kr)에서 해양 API 4개를 활용신청했다. 2026-09-29 사용자 키로 직접 불러 무엇을 주는지 확인했다
(docs/review/evidence/public-data-apis-2026-09-29.txt — 키는 기록하지 않음):

| 데이터셋 | 개별 선박 위치 | 쓸 수 있는 것 |
|---|---|---|
| 해양수산부_선박운항정보 (1192000/VsslEtrynd5) | 없음 | 입출항 신고 — 항만청 · 입출항 일시 · 선명 · 국적 · 선종 · 목적 · 전출항지 · 차항지 · 목적지 |
| 인천항만공사_인천항여객터미널 국내외 선박정보 | 없음(데이터셋 설명) | 이 ADR 에서 쓰지 않는다 |
| 한국해양교통안전공단_실시간 교통정보 (B554035/realtime) | 없음 — 격자별 척수·밀집도 | 이 ADR 에서 쓰지 않는다 |
| 한국해양교통안전공단_운항항로 정보 (oprt-rt-info-v3) | 없음(데이터셋 설명) | 이 ADR 에서 쓰지 않는다 |

네 개 모두 지도에 점으로 찍을 개별 선박 위치를 주지 않는다 — 지도 위 선박은 지금처럼 aisstream.io(ADR-014)만 그린다.
이 ADR 은 첫 번째 데이터셋으로 **선택한 선박 카드에 한국 항만 입출항 기록**을 붙이는 것만 정한다.

## 확인한 사실(2026-09-29, Swagger 와 실제 응답)
- `GET https://apis.data.go.kr/1192000/VsslEtrynd5/Info5` — 필수 `serviceKey` · `prtAgCd`(항만청 코드) · `sde` · `ede`(YYYYMMDD),
  선택 `pageNo` · `numOfRows`(최대 50) · `deGb`(I = 입항일 기준, 기본 · O = 출항일 기준) · `clsgn`(호출부호).
- JSON 을 요청해도 **XML** 이 온다: `response/header/resultCode`("00" = 정상) · `resultMsg`, `body/items/item[]`, `body/totalCount`.
- item 필드: prtAgCd · prtAgNm · etryptYear · etryptCo · clsgn · vsslNm · vsslNltyCd · vsslNltyNm · vsslKndCd · vsslKndNm · etryptPurpsCd ·
  etryptPurpsNm · frstDpmprtNatPrtCd · frstDpmprtPrtNm · prvsDpmprtNatPrtCd · prvsDpmprtPrtNm · nxlnptNatPrtCd · nxlnptPrtNm · dstnNatPrtCd ·
  dstnPrtNm · details/detail[](reqstSeNm · etryndNm = 입항/출항 · etryptDt = +09:00 ISO · ibobprtNm …).
- 실제 예(부산, 2026-09-29): prtAgCd 020 · prtAgNm 부산 · vsslNm 부광9호 · clsgn 230025 · vsslKndNm 석유제품 운반선 · etryptPurpsNm 양하 ·
  전출항지/차항지/목적지 여천항(KRYOC) · detail 최초 · 입항 · 2026-09-29T00:00:00+09:00. 저장소 fixture `fixtures/portmis_info5_busan_230025.xml` 은
  **값을 확인한 필드만** 담는다(etryptYear · etryptCo · 국적 · 코드 필드 · 최초출항지 · ibobprtNm · resultMsg 는 뺐다 — 파서는 없는 필드를 null 로 읽는다).
- **항만청 코드**: 국가물류통합정보센터(nlic.go.kr) 항만청코드 표 — 표에는 11건이라 적혀 있으나 10건만 보인다. 10개 모두 API 로 불러 돌려준 prtAgNm 을
  확인했다: 020 부산 · 030 인천 · 200 동해 · 300 대산 · 500 군산 · 610 목포 · 620 여수 · 700 포항 · 810 마산 · 820 울산.
  **보이지 않는 1건은 모른다** — 추측한 코드로 묻지 않는다. 그 항만청의 입출항은 빠질 수 있다(화면 한계에 적는다).
- 개발 계정 트래픽 한도: API 하나당 하루 10,000회(작업 지시에 적힌 값 — 위 증거 파일에는 기록되지 않았다. 운영 계정으로 바꾸면 다시 확인한다).

## 결정
1. **누가 부르나 — 수집기만**(ADR-001 · ADR-006). 공급자 `portmis`(providers/portmis.py): 호스트 `apis.data.go.kr` 을 HttpClient 허용 목록에 더하고,
   호스트 토큰 버킷 **1 req/s(burst 2)** — 수집기 전체 버킷(2 req/s)의 절반까지만 써서 조회가 이어져도 다른 작업 몫을 남긴다. 우선순위는 가장 낮다
   (`PRIORITY_PORTCALL` — 고정 관심 지역 > focus > hot > 노선 > 입출항). 하루 예산 `portmis` **3,000회**(개발 한도의 30 %)를 요청마다 보내기 전에
   예약하고, 보내지 않은 요청은 되돌린다. 운영 화면의 공급자 스위치(`portmis`)로 끌 수 있고, 스위치는 요청마다 보내기 직전에 다시 본다.
2. **언제 부르나 — 선택한 선박만**(ADR-013 과 같은 임대 방식). api 가 선박을 고른 구독 세션(일시정지 제외)의 호출부호를 ZSET
   `wakeline:demand:portcalls`(member = 호출부호, score = 만료 epoch ms, 키에도 같은 만료 · 60 s)에 쓴다 — 세션끼리 나누고 상한 20개(세션 수 많은 순 →
   먼저 요청된 순). hot·focus 임대와 따로 쓴다(한쪽 쓰기 실패가 다른 쪽을 막지 않는다). 수집기(`jobs/portcalls.py`)는 2 s 마다 읽기 전용으로 읽고,
   같은 호출부호는 30 s 에 한 번만 캐시를 확인한다.
3. **무엇을 묻나** — 조회 하나 = 항만청 10곳 × 쪽: `sde` = 오늘(KST) − 30일, `ede` = 오늘(KST), `deGb=I`, `clsgn`, `numOfRows=50`, `totalCount` 까지
   쪽을 따라간다(항만청당 6쪽 = 300건 상한 — 넘으면 `incomplete`). 한 번에 조회 하나(요청은 차례로). **한 요청이라도 실패하면 그 조회 전체를 error** 로 적고
   나머지 항만청은 묻지 않는다 — 일부만 받은 결과를 "기록 없음" 처럼 보이지 않게. 응답의 clsgn 도 같은 규칙으로 정규화해 요청한 호출부호와 다른 item 은 버린다.
4. **호출부호로만 찾는다.** 규칙은 두 언어가 같다(앞뒤 공백 제거 · ASCII 가 아니면 조회 안 함 · 대문자 · `^[A-Z0-9]{3,7}$` — 언어 간 벡터
   `schemas/vectors/call-sign-cases.v1.json`). 선명으로는 찾지 않는다(동명 선박). PORT-MIS 에 신고된 선명(`reported_name`)이 AIS 선명과 다르면 화면이
   "PORT-MIS 선명 X — AIS 선명과 다름" 으로 밝히고, 같은 선박인지 판정하지 않는다.
5. **캐시**: Redis `wakeline:portcalls:{호출부호}` 에 SET EX — ok·none **6 h**(입출항 신고는 하루 몇 번 바뀌는 자료 — 선택할 때마다 10회씩 부르지 않게),
   error **5분**, disabled **2분**(키를 넣거나 스위치를 켜면 2분 안에 묻는다). 캐시를 확인할 수 없으면 묻지 않고, 캐시에 쓰지 못하면 그 TTL 동안 이 프로세스
   안에서 다시 묻지 않는다(노선 조회와 같다). DB 에는 쓰지 않는다.
6. **값**(수집기 → api): `{v:1, status: ok|none|error|disabled, call_sign, fetched_at, window{from,to,days:30}, source, items[최대 20, 최근 신고 순],
   truncated, incomplete, error(원문 — 가린 뒤), error_kind, error_code, reason(disabled: no_key|fixture|operator)}`. 입항·출항 시각은 같은 종류의 신고
   시각이 하나로 정해질 때만(아니면 null 이고 신고 목록 `reports` 를 모두 둔다 — 고르지 않는다). 같은 입항(항만청 · 입항년도 · 입항횟수)은 쪽 경계에서
   겹쳐 와도 한 번만. 수집기가 실제 응답 fixture 로 만든 값 `fixtures/portcalls_value_230025.json` 을 수집기 시험이 고정하고 api 시험이 같은 파일을 읽는다.
7. **api → 화면**: WS `ship_selected.port_calls`(schemas/ws/server.v1.json `$defs/port_calls`) — status 에 api 가 아는 두 상태를 더한다:
   `pending`(캐시 없음 — 조회 전·조회 중), `no_call_sign`(호출부호 없음·형식 밖 — 묻지 않는다). 캐시 값은 믿지 않고 다시 검사한다(코드 모양 · 글 정리 ·
   시간대 있는 시각만 · 최대 20건 · 최근 순). 읽을 수 없는 값은 `error`(error_kind `cache`) — '기록 없음' 으로 바꾸지 않는다.
   **공개 화면에는 오류 원문을 보내지 않는다** — 종류(budget · rate_limited · http · provider · response · network · internal · cache)와 모양을 검사한 코드
   (HTTP 상태 · resultCode)만. 원문(예산 수치 등)은 운영 화면 공급자 상태·로그에만 있다. 선박이 바뀌지 않아도 조회 결과가 오도록 api 가 5 s 마다 선박을 고른
   세션의 ship_selected 를 다시 계산하고 값이 바뀌었을 때만 보낸다(호출부호별 5 s 메모리 캐시). REST `/ships/{mmsi}` 에는 싣지 않는다 — REST 는 조회 수요를
   만들지 않으므로 거기서 `pending` 은 사실이 아니게 된다.
8. **화면**: 선박 카드의 "한국 항만 입출항 (해양수산부 PORT-MIS · 최근 30일)" — 조회 중(흐르는 막대 · `role=status` · 움직임 줄이기 설정이면 멈춘 막대) ·
   "최근 30일 한국 항만 입출항 기록 없음(호출부호 기준)" · "공공데이터포털 키 없음" · 실패 종류(코드) · "호출부호 없음 — 조회 불가" · 결과 표(항만청 ·
   입항/출항 KST 와 UTC · 목적 · 전출항지 → 차항지, 차항지와 다른 목적지는 그 아래). 모르는 값은 "—" 만. 출처를 카드 · 하단 출처 줄 · `/about` 에 적는다.
9. **비밀값**: 인증키는 환경변수 `DATA_GO_KR_SERVICE_KEY` 로 **collector 컨테이너에만**(compose — 격리 스택은 빈 값). 비어 있으면 조회하지 않고 기동 로그에
   한 번 적으며, 요청된 호출부호에는 `disabled(no_key)` 를 쓴다(화면이 "조회 중" 에 머물지 않게). 공공데이터포털은 인코딩 키(%2B · %2F · %3D)와 디코딩 키를
   함께 준다 — 어느 쪽을 넣어도 되게 `%` 가 있으면 한 번 풀어 두고 httpx 가 한 번만 인코딩한다(%252B 가 되지 않게). 원문 · 푼 값 · 다시 인코딩한 값을 모두
   값-치환 가림에 올리고, 모양 규칙 `serviceKey=` 는 두 언어의 마스커(Python masking.py · Java LogMasker)가 이미 가진다 — 인코딩 · 디코딩 · JSON · 파이썬 repr
   모양의 공유 벡터를 `schemas/vectors/masking-cases.v1.json` 에 더했다. 요청 URL 은 로그 · 상태 · Redis 에 쓰지 않는다(httpx 로그는 WARNING).
10. **Redis ACL**(infra/redis/start.sh): 수집기에 `%R~wakeline:demand:portcalls`(읽기 전용) · `~wakeline:portcalls:*`(SET 은 문자열 키 셀렉터에만) —
    새 명령은 없다. ais 사용자는 둘 다 못 건드린다. 규칙 시험 · docker 동작 시험 · 수집기 실제 Redis 시험 · api 통합 시험(PortCallsIT)으로 고정했다.

## 남는 위험 · 한계
- **호출부호의 정확성**: AIS 호출부호는 선원이 입력한 값이다. 틀리면 다른 선박의 기록이 보일 수 있다 — 화면이 그 사실과 선명 차이를 밝힌다.
- **11번째 항만청**: 코드 표에 보이지 않는 1건은 묻지 않는다. 그 항만청 관할의 입출항은 빠질 수 있다.
- **시각의 정밀도**: 원천 시각은 신고 시각(+09:00)이다. 실제 예의 `00:00:00` 이 날짜만 신고한 것인지 자정인지 원천이 구분하지 않는다 — 그대로 옮기고 고르지 않는다.
- **이용 조건**: 데이터셋의 이용허락 범위(출처 표시 등)는 이 저장소에서 확인하지 않았다 — 공개 배포 전에 데이터셋 페이지에서 확인한다(소유자 결정).
- **남용**: 공개 WS 세션이 선박을 바꿔 가며 골라도 호출은 호스트 1 req/s · 하루 3,000회를 넘지 않는다. 예산이 다 되면 그날(UTC) 남은 동안 입출항은
  "하루 호출 예산 소진" 으로 보인다 — 다른 공급자 예산에는 영향이 없다.

## 결과
- 선택 뒤 결과는 조회 한 번(요청 10회 이상, 1 req/s)과 api 다시 보기 주기(5 s) 뒤에 온다 — 그동안 카드는 "조회 중" 이다.
- 같은 선박을 다시 고르면 6 h 동안 캐시에서 바로 온다.
