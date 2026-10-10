# ADR-039 AWS 데모 배포 — RDS · 앞단 Caddy(접근 코드) 뒤 edge · DB 로 나가는 망

**상태** 채택 · 2026-10-10 · 사용자 승인("권장 방안대로") · [VERIFICATION](../VERIFICATION.md) #130 · 덧붙임 2026-10-11(#136 — 공개 화면의 운영자 메뉴 · 링크)

## 맥락

포트폴리오 공개용으로 Macro · BuildRisk 와 함께 AWS 서울 리전에 올린다. 구성은 다음과 같다.

- 서버: EC2 한 대(앱 컨테이너 + Redis)
- DB: RDS PostgreSQL 18.6 + PostGIS 3.6 한 대(db.t4g.micro, 1 GB). 세 프로젝트가 DB를 하나씩 나눠 쓴다.
- 운영 시간: 평일 09–18시
- 접속 경로: 도메인 없이 CloudFront 기본 도메인(HTTPS) → EC2 Caddy → 접근 코드 잠금화면 → edge

로컬 compose를 그대로 올리면 다음이 맞지 않았다.

- **DB 접근**: api · migrate는 `internal: true` 망(wakeline)에만 있어 밖의 RDS에 닿지 않는다. `DB_HOST: db`도 고정이다.
- **edge Host 검사**: Host 허용 목록(localhost · 127.0.0.1 · [::1], SEC-7 DNS rebinding 방어)이 공개 주소를 421로 거절한다. api의 Origin 허용 목록도 localhost뿐이다.
- **클라이언트 IP**: edge가 `X-Forwarded-For`를 직접 접속 주소로 덮어쓴다(위조 차단). 그래서 Caddy 뒤에서는 모든 방문자가 한 주소가 되고, IP당 요청 · WS 제한이 방문자 전체에 걸린다.
- **역할 초기화**: `01-roles.sh`는 initdb 때 superuser로 돈다. RDS 마스터는 superuser가 아니다.
- **DB 크기**: 1 GB DB에 전세계 OpenSky와 근전세계 AIS를 받으면 하루 1.5 GB 이상 쌓인다(REVIEW-v1 실측).

## 결정

1. **덧붙임 파일 `infra/compose.aws.yml`**: `compose.yml`과 정책 시험은 그대로 둔다.
   - db는 profile로 뺀다. migrate · api · collector는 `DB_HOST=RDS_HOST`로 붙는다.
   - api는 `SPRING_DATASOURCE_URL`에 `sslmode=require`를 붙인다. 선택 조회 풀도 같은 URL을 쓴다. collector는 `PGSSLMODE=require`다.
   - migrate는 URL을 직접 조립해 `sslmode=prefer`가 된다. RDS가 TLS를 강제(`rds.force_ssl`)하므로 연결은 TLS로 맺어진다.
2. **DB로 나가는 망 `rds`(일반 bridge)를 api · migrate에만 더한다.** 이렇게 하면 두 서비스가 밖으로 나갈 길이 생겨 격리가 약해진다. 다만 api는 요청 처리 중에 외부를 부르지 않는다(ADR-001 · 006). EC2 보안 그룹의 송신 범위와 앞단 잠금이 바깥 경계를 맡는다. collector는 이미 egress로 나간다.
3. **Host와 Origin**
   - 앞단 Caddy가 edge로 보낼 때 Host를 `localhost`로 바꾼다. edge의 Host 허용 목록은 그대로다.
   - 웹은 상대 경로와 `location.host`로 REST · WS 주소를 만든다. CSP도 `connect-src 'self'`라 Host를 쓰지 않는다.
   - api의 `WAKELINE_ALLOWED_ORIGINS`에는 공개 주소(`PUBLIC_ORIGIN`)를 더하고, 관리자 터널용 localhost 주소를 남긴다.
4. **edge realip**: `nginx.conf`에 `include /etc/nginx/edge.d/*.conf;`를 둔다(로컬에서는 비어 있어 아무 일도 하지 않는다).
   - AWS에서는 `edge/realip.aws.conf`를 마운트한다. 사설 대역(도커 브리지 게이트웨이)에서 온 `X-Forwarded-For`를 믿는다.
   - realip이 `$remote_addr` 자체를 바꾸므로 `proxy_headers.conf`의 덮어쓰기와 api의 `WAKELINE_TRUSTED_PROXY`는 그대로다.
5. **공개 범위**: Caddy가 `/ops*` · `/logs*` · `/api/v1/ops/*`를 404로 닫는다. 운영자는 SSM 포트 포워딩으로 `http://localhost:8700`에 직접 붙는다.
   화면에서 그리로 가는 메뉴 · 링크는 감춘다(아래 덧붙임).
6. **수집 범위**: OpenSky는 끈다(ADR-009 공개 배포 기본값). 항공기 공급자는 `adsb_fi,adsb_lol`이다. AIS는 출처를 표시하고 켠다(초대받은 사람만 보는 비공개 데모).
7. **DB 연결 수 줄이기**: 공유 풀 12 → 6(공개 조회 허가 6 → 3), 선택 조회 풀 4 → 2.
8. **역할 초기화**: aws-deploy `rds/bootstrap.sql`에서 마스터가 실행한다.
   - `01-roles.sh`와 같은 역할 3개를 만든다.
   - DB를 만들기 전에 `GRANT wakeline_migrator TO CURRENT_USER`(PG16+ 규칙)를 둔다.
   - PostGIS를 설치한다.
   - `SET ROLE wakeline_migrator`로 public 스키마 권한을 정리한다.
9. **데이터는 새로 시작한다.** 로컬 DB를 옮기지 않는다. 계정 표(`ops_user`)는 읽지 않는다는 규칙이 있다. 72 h 항적은 어차피 운영 시간 안에 다시 쌓이고, 격자 · 입출항 색인도 수집기가 다시 채운다.

## 버린 대안

- **edge `server_name`에 공개 주소 더하기**: CloudFront 주소를 저장소에 박거나 설정을 생성해야 한다. Caddy에서 Host를 바꾸면 edge의 방어 규칙을 그대로 둘 수 있다.
- **api · migrate를 egress 망에 붙이기**: 의미가 다르다(외부 공급자 호출). DB 전용 망 이름이 의도를 드러낸다.
- **로컬 DB 덤프 복원**: 위 9.

## 결과

**로컬 리허설**(2026-10-10). 리허설 환경은 다음과 같다.
- DB: RDS 흉내(PostgreSQL 18.6 + PostGIS 3.6, superuser 아닌 마스터, TLS 강제, `max_connections=80`)
- 앞단: Caddy + 잠금
- 운영 스택과 겹치지 않게: 프로젝트 `wakeline_aws_rehearsal`, 포트 18710, 망 10.78.0 — 이 대역은 격리 E2E 스택(`make e2e` · `make demo`)과 같아 그 스택을 막았다. 다음 리허설은 10.79.0을 쓴다(VERIFICATION #134)

확인한 것:
- migrate(V1–V21)가 superuser가 아닌 migrator로 통과했다.
- TLS 연결 7개(api 6 · collector 1)였다. api 연결 수가 6이고 공개 조회 허가 3이 기동 검사를 통과해, 덧붙임 값이 실제로 적용된 것을 확인했다.
- 공개 경로: 화면 200 · `/api/v1/status` 200. `/ops` · `/logs` · `/api/v1/ops/*`는 404였다.
- WS: 허용 Origin은 101, 다른 Origin은 403이었다.
- edge 접근 로그에 Caddy가 넘긴 주소(203.0.113.88)가 찍혔다.
- 멈춤 → 시작 2회: 41초 · 76초 만에 healthy가 됐다.
- 메모리(기동 직후): api 307 MiB, 나머지는 합계 약 165 MiB였다.

## 덧붙임(2026-10-11) — 공개 화면에서 운영자 메뉴 · 링크를 감춘다

[VERIFICATION](../VERIFICATION.md) #136. 결정 5로 앞단이 운영자 경로를 닫았지만 화면에는 그리로 가는 길이 남아 있었다. 공개 주소에서 누르면 화면 대신 404 JSON이 나왔다.
사용자 결정(2026-10-11): AWS 배포에서만 감추고, 로컬은 지금과 같게 둔다.

- **감추는 것**: 상단 메뉴의 [운영] · [로그], 오류 문구에서 요청 id 옆의 '로그 보기'(`/logs#rid=…`), 오류 화면(`app/error.tsx`)의 `/logs` 안내 글자.
  요청 id와 복사 단추는 남긴다(운영자에게 전할 값이다).
- **방법**: web 컨테이너의 실행 시 환경 변수 `WAKELINE_PUBLIC_DEMO=1`을 `compose.aws.yml`의 web에만 둔다.
  루트 레이아웃이 요청 때 읽어(이미 `connection()`으로 요청마다 렌더한다) boolean 하나를 클라이언트 context로 넘긴다.
  이미지는 로컬과 같다. 값이 없거나 `"1"`이 아니면 지금과 같다.
- **운영자**: 터널로 붙어도 같은 web 컨테이너라 메뉴는 감춰진다. `/ops` · `/logs`는 주소를 직접 입력해 연다.
  운영자 화면 안(`app/ops` · `app/logs` 레이아웃)은 공개 데모가 아닐 때처럼 '로그 보기' 링크를 둔다.
- **버린 대안**
  - `NEXT_PUBLIC_` 빌드 시 값: 배포마다 이미지를 따로 빌드해야 하고, `next.config.ts`가 `NEXT_PUBLIC_` 변수를 금지한다.
  - 요청 Host로 판단: Caddy가 Host를 `localhost`로 바꾸므로(결정 3) 공개 요청과 터널 요청이 구별되지 않는다.
- **남는 것**: `app/global-error.tsx`(루트 레이아웃까지 실패했을 때)는 context 밖이라 로컬 문구와 링크를 쓴다.
  설명서의 운영 · 로그 절과 스크린샷(로컬에서 찍음)은 그대로 두고, 공개 데모에서는 메뉴에 없다는 한 줄만 더했다.
