# QA 2026-10 AWS — 영역 config(배포 설정 · 정책) 결함 상세

대상: `main` 29d39e38 + QA 도구(브랜치 `qa/aws-2026-10`). AWS 판 = `infra/compose.yml` + `infra/compose.aws.yml` + aws-deploy 앞단(CloudFront → Caddy → gate → edge).
번호 범위 QA-1600–QA-1619. aws-deploy(`/Users/jinyoung/Projects/aws-deploy`)는 읽기만 했다(파일을 쓰지 않음, *.env 열지 않음). 재현 시험은 wakeline 쪽에 둔다.
환경 표기: 정적 = compose/스크립트 정적 분석 · Docker = 버리는 컨테이너.

## QA-1600 (보통↔낮음 경계) — AWS 공개 HTTPS 판 api 의 세션·CSRF 쿠키 Secure 가 꺼진 채 배포된다
- 환경: 정적(`docker compose … config` 렌더) + AWS 읽기 점검(evidence/aws-readonly/describe-*.md — 실행 중 api 컨테이너 값 false 확인). aws-deploy README 3단계 배포 절차.
- 재현 절차:
  1. `infra/tests/test_qa_1600_aws_cookie_secure.py` — 임시 폴더에 `tools/init_env.py`(= `make init`)로 `.env.example` 을 복사해 .env 를 만들고 README 대로 `RDS_HOST`·`PUBLIC_ORIGIN` 더미를 더한다(실제 .env 는 읽지 않음).
  2. `docker compose -f infra/compose.yml -f infra/compose.aws.yml --env-file <임시> config` 로 api 환경을 렌더해 `WAKELINE_COOKIE_SECURE` 를 본다.
  - 명령: `cd /Users/jinyoung/Projects/wakeline && python3 -B -m unittest discover -s infra/tests -p 'test_qa_1600*' -v`
- 기대: 공개 HTTPS(CloudFront) 뒤 배포이므로 `WAKELINE_COOKIE_SECURE=true`(compose.aws.yml:51 의 `${COOKIE_SECURE:-true}` 가 의도한 기본값).
- 실제: `false`. 실패 글 `AssertionError: 'false' != 'true'`. 대조 시험(`.env` 에 COOKIE_SECURE 줄이 없으면 true)은 통과 → 원인이 `.env.example` 의 줄임을 보인다.
  AWS 읽기 점검에서도 실행 중 api 컨테이너 `WAKELINE_COOKIE_SECURE=false`.
- 원인 사슬: `.env.example:41` 의 로컬용 `COOKIE_SECURE=false` → `tools/init_env.py` 가 `.env.example` 을 .env 로 복사(init_env.py: EXAMPLE=.env.example) → `infra/compose.aws.yml:51` 의 `${COOKIE_SECURE:-true}` 에서 .env 값(false)이 기본값(true)을 이긴다.
  `.env.aws.example` 에는 COOKIE_SECURE 줄이 없지만 init 은 그 파일을 읽지 않으므로 거기에 넣어도 바뀌지 않는다. 적용: `apps/api/src/main/resources/application.yml:79` → `SecurityConfig.cookieSerializer`/`csrfTokenRepository`(secure=false).
- 영향·악용성(정직하게): 공개 CSRF 쿠키(`WAKELINE_CSRF`, Path=/, HttpOnly 없음, SameSite=Strict)가 모든 공개 응답에 Secure 없이 나간다(evidence/config/qa-1600-public-set-cookie.txt). 운영 세션 쿠키(`WAKELINE_SESSION`, Path=/api)도 Secure 가 없다.
  실제 악용성은 제한적: CloudFront 는 HTTP→HTTPS 리디렉트 + HSTS(max-age 1년, describe 확인)라 downgrade 는 첫 방문 TOFU 틈만 남고, 운영 경로(/ops)는 Caddy 가 공개 주소에서 404 로 닫아 세션 쿠키는 SSM 터널(http://localhost:8700 평문)에서만 쓰인다. → 보통↔낮음 경계.
- 고치기 주의(멈춤 조건): 단순히 true 로 바꾸면 SSM 터널(평문 http)로 붙는 운영자 로그인이 깨진다(브라우저가 Secure 쿠키를 평문에서 버림 — application.yml:79·SecurityConfig.java:156 주석의 R-90). 올바른 수정은 공개 경로/HTTPS 와 터널 경로를 가르거나 터널도 TLS 로 바꾸는 설계 판단이 필요 → 제품 동작 변경이라 고치기 전 사용자에게 묻는다.
- 의심 원인 파일:줄 — `.env.example:41` · `tools/init_env.py`(EXAMPLE 복사) · `infra/compose.aws.yml:51`.

## QA-1603 (보통) — (배포 뒤) AWS 운영자 로그인이 Safari 에서 곧바로 '세션이 만료되었습니다'로 끝난다 · QA-1600 고침의 회귀
- 환경: AWS 운영(2026-10-14 14:54Z, `1cf0f8e1` 배포 뒤) · Safari 27 · SSM 포트 포워딩 터널 `http://localhost:8700/ops`. 사용자가 겪었고 edge 접근 기록으로 확인.
- 재현: 운영자 계정으로 로그인 → `POST /api/v1/ops/session` 200 → 바로 뒤 `GET /api/v1/ops/{session,providers,runs,…}` 가 모두 404(api 는 세션 없는 운영 요청에 404).
  화면은 '세션이 만료되었습니다 — 다시 로그인하세요.' 시험: `infra/tests/test_qa_1603_aws_tunnel_cookie.py`(compose 해석 — 문서대로 만든 .env 에서
  `WAKELINE_COOKIE_SECURE` 기대 false · 실제 true, `AssertionError: 'true' != 'false'`).
- 원인: QA-1600 고침(`49104246`)이 `AWS_COOKIE_SECURE` 기본값을 true 로 두어 세션 · CSRF 쿠키가 Secure 가 됐다. Safari 는 평문 `http://localhost` 에서 Secure
  쿠키를 저장하지 않는다(Chrome · Firefox 는 localhost 를 안전한 곳으로 보아 받는 것으로 알려져 있으나 확인하지 않았다). 위 QA-1600 절의 '고치기 주의'가 바로 이것을
  경고했는데 고침이 그대로 true 로 했고, 보고서는 'Safari 확인 못함'으로만 남겼다 — 내 잘못.
- 고침(`c850eee5` · 사용자 결정 2026-10-14 — 세 선택지 중 '기본 false'): `compose.aws.yml` 기본값 false. 근거: 운영 세션 쿠키가 실리는 길은 평문 터널뿐(운영 경로는
  공개 주소에서 Caddy 가 닫음), 공개 쪽 CSRF 쿠키는 세션 없이는 값이 없음, CloudFront 가 HTTPS 리디렉트 · HSTS. QA-1600 의 분리(로컬 COOKIE_SECURE 가 AWS 값을
  정하지 않음)는 그대로 시험한다. 고르지 않은 것: 요청마다 나누기(공개 HTTPS 는 Secure · 터널은 아님 — 공용 Caddy · edge · api 세 곳 변경), 터널을 TLS 로.

## QA-1601 (보통) — 앞단 잠금(gate) 시도 제한이 동시 요청에 지켜지지 않는다(check-then-act 경쟁) · aws-deploy(공유)
- 환경: Docker 없이 gate.py 를 메모리로 불러 127.0.0.1 임의 포트에 띄워 시험(aws-deploy 읽기만 · __pycache__ 쓰지 않음). aws-deploy gate 는 Macro·BuildRisk·Wakeline 공유.
- 재현 절차:
  - `infra/tests/test_qa_1601_gate_limiter_race.py` — 한 IP(또는 서로 다른 IP 여러 개)가 `threading.Barrier` 로 같은 순간 틀린 코드를 POST /__gate/unlock 로 보낸다.
  - 명령: `cd /Users/jinyoung/Projects/wakeline && python3 -B -m unittest discover -s infra/tests -p 'test_qa_1601*' -v`
- 기대: 한 IP 는 15분 5회까지만 코드를 확인(401), 나머지 429(gate.py `IP_MAX_FAILS=5`). 전체는 1시간 30회(`GLOBAL_MAX_FAILS=30`)가 차면 그 뒤 잠김.
- 실제: 한 IP 가 동시에 보낸 20회가 모두 401(코드 확인됨) — `AssertionError: 20 not less than or equal to 5 … {401: 20}`. 서로 다른 IP 40개 동시 → 40회 모두 401(`40 not less than or equal to 30`, 한 번 {401:39,429:1}). 3회 반복 안정.
- 원인: `gate/gate.py` `do_POST` 가 `limiter.blocked_for()`(확인) → `check_code()`(scrypt) → `limiter.record_failure()`(기록) 순서인데 확인과 기록이 한 잠금 안에 있지 않다(check-then-act). `ThreadingHTTPServer`(`make_server`, `daemon_threads=True`)는 연결마다 스레드를 만들고 동시 수 상한이 없어, 한 번에 들어온 요청이 모두 확인을 통과한 뒤 각자 scrypt 를 돈다. Caddyfile 에 /__gate 요청 제한이 없다(정적 확인).
- 영향: 문서화된 무차별 대입 제한(IP 5 · 전체 30)이 동시성으로 우회된다. scrypt(n=2^14·r=8, 수십 ms) + 긴 무작위 코드라 실전 전수 대입은 여전히 느리지만, QA-1602(동시 scrypt OOM·재시작으로 시도 기록 초기화)와 겹치면 제한이 사실상 리셋된다.
- 의심 원인 파일:줄 — aws-deploy `gate/gate.py` `Limiter`(record/blocked 분리) · `do_POST`(≈448–484) · `make_server`(ThreadingHTTPServer).

## QA-1602 (높음) — 익명 동시 잠금 해제 요청이 공유 gate(96 MiB)를 메모리 고갈로 죽이고 시도 제한을 초기화한다 · aws-deploy(공유)
- 환경: Docker(버리는 컨테이너) — 운영과 같은 이미지 `portfolio-gate:local`·메모리 상한 96m·`restart: unless-stopped`·read-only, 저장소의 지금 gate.py 를 읽기 전용 마운트. 127.0.0.1 포트만. 시험 비밀값은 실행 중 생성(출력·기록 안 함). aws-deploy gate 는 세 프로젝트 공유.
- 재현 절차:
  - `tools/qa/qa_1601_gate_burst.py` — gate 를 띄우고 ① 한 IP 순차 6회(정상 동작 확인) ② 서로 다른 IP 가 한꺼번에(--burst) 틀린 코드 POST ③ 뒤에 ①의 IP 재시도.
  - 명령: `cd /Users/jinyoung/Projects/wakeline && python3 -B tools/qa/qa_1601_gate_burst.py --burst 8`(그리고 --burst 30). 증거: evidence/config/qa-1601-gate-burst-96m.txt.
- 기대: 동시 시도가 많아도 gate 는 살아 있고(다른 방문자가 잠금화면을 계속 받음) 시도 제한이 유지된다.
- 실제:
  - burst=4: 살아남음(memory.peak ≈ 97 MB, 상한 턱 밑). burst=8: `docker events` 에 `die exitCode=137`(OOM SIGKILL) — gate 가 죽음.
  - burst=30: `oom` 이벤트 + `RestartCount 1`, 응답 `{401:3, RemoteDisconnected:27}`(연결 끊김 = 컨테이너 죽음). ③ 재시도 결과 `401`(잠금화면 열림) — ①에서 건 IP 잠금이 재시작으로 사라졌다. gate 'start' 사건 2회(재기동).
- 원인: scrypt(n=2^14·r=8)는 호출마다 ≈16 MiB. gate 컨테이너 상한은 96 MiB(aws-deploy `compose.yml` gate.mem_limit)인데 `ThreadingHTTPServer` 가 동시 요청 수를 제한하지 않아 ~6개만 겹쳐도 상한을 넘겨 OOM-kill. gate 가 죽으면 Caddy forward_auth 상류가 끊겨 502 → CloudFront 가 502/504 를 S3 오프라인 503 으로(10 s 캐시) → 세 프로젝트(Macro·BuildRisk·Wakeline) 방문자가 모두 "운영 시간 외"를 본다. 재시작 시 `Limiter` 의 메모리 상태(IP·전체 실패 기록)가 사라져 무차별 대입 잠금이 초기화된다.
- 도달성: /__gate/unlock 은 접근 코드 없이도 공개 인터넷에서 CloudFront 를 거쳐 닿는다(CloudFront 가 X-Origin-Verify 를 붙여 Caddy origin_guard 통과, CachingDisabled·AllViewer 로 POST 전달, WAF 없음 — describe 확인). gate 자체가 코드를 검사하는 관문이라 그 앞에는 인증이 없다. → 익명 요청으로 공유 자원 고갈·다른 방문자 차단 = 높음.
- 의심 원인 파일:줄 — aws-deploy `gate/gate.py` `make_server`(ThreadingHTTPServer — 동시 상한 없음) · `do_POST` scrypt(동시 scrypt 격벽 없음) · aws-deploy `compose.yml` gate.mem_limit 96m. (수정 방향 제안: 동시 unlock 처리 세마포어 또는 gate 앞 요청 제한 — 고치기는 aws-deploy 공유라 사용자에게 묻는다.)

## 개선 제안(결함 아님 — 설계상 수용 또는 구조)
- migrate 컨테이너에 메모리 상한이 없다(`infra/compose.yml` migrate 블록 91–109 — deploy 없음). 공유 8 GB EC2 에서 배포 중 JVM 3 + Next 3 과 겹치면 압박. 하지만 일회성이고 실측 harm 을 만들지 못함 → 제안.
- api·migrate 의 `rds` 망은 일반 bridge(인터넷 egress 경로)다(`infra/compose.aws.yml` networks.rds). ADR-039 결정 2 가 명시적으로 수용(요청 처리 중 외부 호출 안 함 · 보안그룹·앞단이 경계). → 설계 수용 위험으로 기록.
- `realip.aws.conf` 가 사설 대역 전체(10/8·172.16/12·192.168/16)의 XFF 를 믿는다. edge 게시 포트는 127.0.0.1 전용이고 Caddy 는 host 네트워크로 그 루프백에 붙어, 다른 compose 프로젝트 컨테이너는 127.0.0.1 게시 포트에 닿지 못한다(리눅스) → 다른 컨테이너의 XFF 위조는 현 토폴로지에서 자명하지 않음. 실제 검증은 R 리허설 담당. → 미확인/설계 수용.
- `EDGE_CONFIG_SHA`(Makefile:15–16)가 `realip.aws.conf` 를 포함하지 않는다. 다만 Makefile 은 compose.aws.yml 을 쓰지 않고(로컬 전용), AWS 는 start-stack.sh 가 compose 를 직접 불러 해시 라벨이 늘 `unset`(ADR-039 덧붙임 2) — 실질 영향 거의 없음. → 낮음/제안.

## 확인 사항(notes)
- EventBridge 일정 4개(rds/ec2 start·stop, MON-FRI)가 모두 DISABLED인데 README·ADR 은 평일 자동 운영이라 적는다. describe 의 CloudTrail 은 사용자 계정이 수동 start/stop. 결함 아님 — 운영 방식이 수동으로 바뀐 것인지 사용자 확인 필요.
