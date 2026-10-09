# ADR-034 공역 자료 — 국토교통부 AIP 공역 KMZ 를 운영자가 표준 입력으로 가져오고, 저장소에는 합성 자료만 둔다

**상태** 채택 · 2026-10-09 · 사용자 승인("권장안대로" — [계획](../plans/features-2026-10/PLAN.md) §9 결정 D1) · [SPEC](../plans/features-2026-10/SPEC.md) F1 ·
계약 [v5 §G47](../audit/change-contract-v5.md) · 함께 보는 기록: [ADR-035](ADR-035-zone-judgement.md)(공역 판정) · [ADR-026](ADR-026-first-screen-js-budget.md)(첫 화면 JS) ·
[VERIFICATION](../VERIFICATION.md) #118

## 맥락
- 공역(비행금지 · 제한 · 위험 · 원전 임시비행금지 등)을 지도에 그리고 판정하려면 공식 도형이 필요하다. 공개된 것은 국토교통부 '공역정보 지도자료'(AIP 차수 기준
  KMZ — Google Earth 용)다. 2026-10-09 파일(AIP 25년 5차 기준)을 직접 세어 봤다: `doc.kml` 3.8 MB · 장소표 697(다각형 383 · 항로 선 314) · 점 65,649 ·
  장소표 하나 최대 7,628점. 종류는 폴더 이름에만 있다(`Type_Code` 는 128개가 'Other'), 속성은 description 의 HTML 표, 문서 요소에 `xmlns:xsi` 선언이 빠져
  그대로는 XML 이 아니다(unbound prefix). 고도 한계는 같은 뜻을 여러 글자로 적는다(Feet/FT · Flight Level/FL · Height/HEI · Surface/SFC · Unlimited/UNLTD).
- 이용 조건(eAIP GEN 0.1 §5): 국토교통부 저작물 — 이익을 얻는 이용은 사전 허가 · 협의, 무단 변경 금지, 출처 표시. 이 저장소는 **공개**다 — 커밋은 재배포다.

## 결정
1. **저장소에는 원본도 원본에서 만든 좌표도 넣지 않는다.** 운영자가 받은 파일을 `make airspace-import f=… edition=…` 로 가져온다 — 파일은 collector 컨테이너의
   표준 입력으로만 들어간다(읽기 전용 루트 · 볼륨을 더 열지 않음). `.gitignore` 의 `*.kmz` 와 인프라 정책 시험(`test_airspace_policy`)이 합성 자료 밖의
   `.kml` · `.kmz` 를 막는다.
2. **해석은 수집기 규칙(`airspace.py`)**: zip 안 `.kml` 하나만 메모리에서 읽으며 크기를 센다(머리말의 크기를 믿지 않음) · 강화 XML 입구(`xml_intake` — 크기 ·
   엄격 UTF-8 · DOCTYPE/ENTITY 거절, 해양격자와 같은 입구로 옮겼다) · 빠진 `xmlns:xsi` 를 더함 · 종류는 폴더 경로(모르는 폴더는 'other' + 폴더 이름 — 짐작하지
   않는다) · 고도 한계는 ft + 기준(MSL · FL · AGL · SFC · UNL · UNKNOWN)과 원문. 장소표 하나의 문제는 그것만 건너뛰고 까닭을 센다.
3. **저장은 한 트랜잭션(V18)**: 차수 행 → 도형(유효하지 않을 때만 `ST_MakeValid`, 고쳐도 비면 빼고 셈, 표시용 사본은 0.0005° 단순화) → 옛 차수 끄고 새 차수 켬.
   같은 원본(SHA-256)을 다시 가져오면 바꾸지 않거나(켜져 있음) 그 차수를 다시 켠다(되돌리기). 도형이 0개면 켜지 않는다. **옛 차수는 지우지 않는다**(옛 공역
   알림이 가리킨다 — V19). collector 가 쓰고 api 는 읽기만, 아무도 지우지 않는다.
4. **api 는 메모리 스냅숏**(`AirspaceRefresher` 60 s — 켜진 차수가 바뀔 때만 다시 읽음, 실패하면 이전 값)에서 `GET /api/v1/airspace` 로 답한다(차수 · 출처 ·
   `currency_checked: false`, 자료가 없으면 빈 목록 + edition null).
5. **화면**: 레이어 '공역'(기본 끔, 켤 때 받는 조각) · 종류 단추(기본 금지 · 원전 · 안보 · 제한 · 위험) · 툴팁(고도 범위와 기준 · 원문 · 차수 · 출처 · "AIRAC
   최신 여부 확인 안 함") · `/about` 의 출처와 조건. README · 설명서 · 포트폴리오 그림은 합성 공역(격리 스택)으로만 찍는다.

## 버린 대안
- **KMZ(또는 GeoJSON 변환본)를 저장소에 넣기**: 가장 쉽지만 공개 저장소라 재배포다.
- **api 의 운영 화면에 파일 올리기**: 업로드 경로 · 크기 · 형식 공격면이 공개 서비스에 생긴다. 1회성 운영 작업이라 명령으로 충분하다.
- **차수를 지우고 덮어쓰기**: 옛 알림의 구역을 잃는다(근거가 가리킬 행이 없어진다).
- **shapely 등 새 의존성으로 도형 검사**: PostGIS 가 이미 있다(`ST_IsValid` · `ST_MakeValid`).

## 결과
- 시험: collector `test_airspace.py`(합성 KML — 종류 · 고도 표 · 구멍 · 선 · zip 상한 · DTD · 인코딩 · 개수 상한 · 명령의 종료 코드) ·
  `test_db_pg_integration.py`(실제 PostgreSQL — 한 트랜잭션 · 다시 켜기 · 고친 도형 · 빈 차수 안 켬 · 지우기 권한 없음) · api `AirspaceRefresherDbTest` ·
  `AirspaceControllerTest` · `RolePrivilegesDbTest`(V18) · REST 계약(airspace) · web `airspace.test.ts` · e2e `airspace.spec.ts` · infra `test_airspace_policy.py`.
- 실제 파일(로컬, 커밋 안 함)로 잰 값: 697 들어감 · 건너뜀 0 · 고친 도형 0 · 해석 0.43 s + 가져오기 0.47 s(버리는 DB) · 표시용 점 65,649 → 14,322 ·
  전체 GeoJSON 약 388 KB(압축 전).
- 남은 한계: 차수가 낡는다(AIRAC 28일 주기) — 화면이 '최신 여부 확인 안 함'을 적고, 새 차수는 운영자가 같은 명령으로 가져온다. 국토교통부에 이용을 문의하지는
  않았다(로컬 비상업 표시 · 출처 표기로 조건 안이라고 본 것은 법률 판단이 아니다).
