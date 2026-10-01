# ADR-017 리뷰 v1 에서 승인한 계약 변경(공개 API · DB · 인증 · 인프라)

**상태** 채택(초안 → 사용자 지시에 따라 확인 없이 진행, 최종 보고에서 알림) · 2026-09-28 · 근거 `docs/review/REVIEW-v1.md`

각 항목: 변경 · 이유 · 대안 · 영향 · 되돌리기.

## 1. 공개 API
| ID | 변경 | 이유 | 대안(버린 이유) | 영향 · 되돌리기 |
|---|---|---|---|---|
| R-16 | bbox 의 NaN·Infinity·지수 표기 → 400 `BAD_BBOX`(WS 와 같은 규칙) | NaN 이 범위·면적 검사를 통과해 재생 면적 상한이 우회됨 | 계산 뒤 걸러내기(검사 우회는 그대로) | 잘못된 요청만 거절 · 커밋 되돌리기 |
| R-71 | 기간 한도를 절삭 없이 정확히 비교(초과면 400) | 한도보다 긴 요청이 통과, 선박 항적과 동작이 다름 | 없음 | 한도 초과 요청만 거절 |
| R-45 | 통계 응답 `day` = `"YYYY-MM-DD"`(UTC 날짜 — 2026-09-30 부터 KST 날짜 · `day_zone`, 계약 v5 §G20), 집계 전 날짜는 `aggregated:false` | 자정 시각 문자열이 JVM 시간대에 따라 달라지고, 집계 전과 자료 없음을 구분 못 함 | 필드 이름 바꾸기(웹·계약 변경이 더 큼) | 웹 통계 화면을 함께 고침 · REST 계약 검사 갱신 |
| R-74 | 커서 페이지의 `next_cursor` 는 다음이 없으면 `null`(빈 문자열 금지) | 엔드포인트마다 달라 클라이언트가 분기해야 함 | 없음 | /ops/audit 만 바뀜 |
| R-72 | `/status` 의 `radar_kr` 는 검증한 필드만(원본 해시 통째로 내보내지 않음), `/radar/kr` 는 잘못된 값에 500 대신 unavailable | 공개 응답에 내부 필드 노출, 파싱 예외 | 없음 | 필드 목록은 계약 검사로 고정 |
| R-70 | `/replay` 캐시 `max-age=60` | 1시간 캐시가 2시간만 유효한 레이더 타일을 가리킴 | 레이더를 응답에서 빼기(기능 축소) | 캐시 적중만 줄어듦 |
| R-89 | 공개 OpenAPI 문서에서 `/api/v1/ops/**` 제외 | "비인가는 404 로 존재 비공개" 설계와 모순 | 문서 전체 비공개(개발자 편의 손실) | 운영 문서는 로그인 뒤 경로로만 |
| R-26 | `/replay` 의 SIGMET 을 요청 bbox 와 겹치는 것만 | 응답의 72 % 가 무관한 전세계 SIGMET | 없음 | 재생 화면 동작 같음 |
| R-52 | `/aircraft/{hex}/track` 점 수 상한(초과 시 `truncated:true`), 좌표 중복 제거 | 상한 없는 응답 | 없음 | 웹 항적은 상한 안 |

## 2. DB(Flyway V9 — 되돌리기 SQL 은 마이그레이션 머리 주석)
| ID | 변경 | 이유 | 되돌리기 |
|---|---|---|---|
| R-15 | `alert_event (hex, id DESC)` 인덱스 | 알림 이력 hex 필터가 표 전체를 역순으로 훑음(idx_scan 0) | `DROP INDEX` |
| R-51 | 항공기 검색용 `upper(hex) text_pattern_ops` · `upper(registration) text_pattern_ops` 인덱스(앞부분 일치) | 검색이 aircraft 표를 순차 스캔 | `DROP INDEX` |
| R-27 | 일 통계 집계 쿼리를 파티션 한정·인덱스 사용으로(필요 시 인덱스) | 하루 파티션 전체 순차 스캔 + 디스크 정렬 | 쿼리 되돌리기 |
| R-88 | `ALTER DEFAULT PRIVILEGES` 로 새 표에 api DML 자동 부여 중단(명시 GRANT 만), track_point 파티션 직접 쓰기 회수 | 새 표가 생길 때마다 권한이 열림(fail-open) | `ALTER DEFAULT PRIVILEGES … GRANT` 복원 |
| R-06 | 보존: 항적·선박 위치 파티션을 72 h 경계에서 정확히 지우고, `alert_event` 는 30일 보존(끝난 알림만) | 99–123 h 남고 알림이 하루 약 50 MB 씩 영구 누적(NFR-09 10 GB 초과 경로) | 보존 값은 설정, 삭제 작업 끄기 |
| R-62 | api 연결에 `statement_timeout`(공개 조회 3 s · 쓰기 30 s)과 `lock_timeout` 5 s | DB 가 느려지면 공개 조회가 풀을 다 잡아 쓰기까지 막힘 | 연결 설정 되돌리기 |

## 3. 인증·세션
| ID | 변경 | 이유 | 영향 |
|---|---|---|---|
| R-54 | 운영 세션 절대 수명 8 h(유휴 연장과 별개) | 폴링이 세션을 무기한 연장 | 8 h 마다 다시 로그인 |
| R-95 | 비밀번호를 바꾸면(ops-user) 그 사용자의 기존 세션 모두 폐기. 3단계 검증 뒤 보강: 세션을 로그인 때 확인한 비밀번호 해시의 표식(SHA-256 앞 16바이트)에 묶고 운영 요청마다 지금 값과 비교 — 로그인과 교체가 겹쳐 목록 삭제를 피한 세션도 끝난다(DB 를 못 읽으면 503, 세션 유지) | 탈취된 세션이 비밀번호 교체 뒤에도 유효 | 배포 직후 기존 운영 세션(표식 없음)은 한 번 다시 로그인 · 운영 요청마다 PK 조회 1회 |
| R-55 | 로그인 실패 감사에 **존재하는 계정만** 이름을 남기고, 없는 계정은 "unknown account"(원문 미저장) | 아이디 칸에 잘못 친 비밀번호가 지울 수 없는 감사 로그에 남음 | 없는 계정 이름은 감사에서 보이지 않음 |
| R-90 | 쿠키 `Secure` 를 설정값으로(기본 false — 로컬 http) | HTTPS 배포 시 코드 수정이 필요 | 로컬 동작 같음 |
| R-97 | 세션 쿠키 `Path=/api`(CSRF 쿠키는 화면 JS 가 읽어야 해서 `/` 유지) | 같은 localhost 의 다른 포트·Next 서버로 세션 쿠키 전송 | 포트 간 전송 자체는 브라우저 규칙이라 완전히 막을 수 없음 — 별도 호스트명(`wakeline.localhost`)은 사용자 결정 |

## 4. 인프라
| ID | 변경 | 이유 | 되돌리기 |
|---|---|---|---|
| R-64 · R-77 | 네트워크 분리: `public`(edge, 게시 포트) · `internal`(`internal: true` — web · api · db · redis) · `egress`(collector · ais 만 인터넷). edge·collector·ais 는 필요한 망에 함께. **한계(3단계 검증)**: `public` 은 일반 bridge 라 edge 는 망 차원에서 인터넷에 나갈 수 있다(Docker Desktop 은 masquerade 끄기도 무시 — 실측) — edge 는 설정(upstream api·web 뿐 · resolver 없음, 정책 시험)으로 막는다. 망 구성이 바뀌는 배포는 `make down` → `make up`(부분 재생성은 고정 IP 를 잃는다) | 모든 컨테이너가 서로의 모든 포트와 인터넷에 닿음 — "외부 호출은 collector/ais 만" 을 망이 강제하지 않음 | compose 네트워크 정의 되돌리기 |
| R-24 | PostgreSQL: `checkpoint_timeout 15min` · `max_wal_size 2GB` · `wal_compression on` · `shared_buffers 256MB` | WAL 의 86 % 가 전체 페이지 이미지(하루 약 16 GB) | 설정 삭제 |
| R-25 | api JVM 힙 비율 60 % → 40 %(컨테이너 1 GiB 에서 최대 약 410 MiB), 측정 후 확정 | 프로세스 약 700 MiB 로 NFR-03(≤ 512 MB) 초과, GC 뒤 살아 있는 데이터 약 75 MiB | 값 되돌리기 |
| R-29 · R-85 | 실행 이미지에서 npm·corepack·pip 제거, 기반 이미지·uv 를 다이제스트로 고정 | 쓰지 않는 패키지 관리자가 HIGH 취약점을 전부 만듦 | Dockerfile 되돌리기 |
| R-37 | Tomcat 11.0.25 이상(Spring Boot 패치 또는 버전 속성) | CRITICAL 3건 | 버전 되돌리기 |
| R-63 | db 이미지 다이제스트 갱신(같은 18.x · 3.6) → 2026-09-30 직접 빌드로 해결(ADR-004 개정) | 고칠 수 있는 CVE CRITICAL 9 · HIGH 76 → 0 | 이전 이미지 · 권한으로(ADR-004 개정) |
| R-86 | Redis ACL: collector·ais 에서 `DEL`·`UNLINK`·`RENAME` 등 키 삭제·이름 변경 계열 거부(쓰는 키에 필요한 것만 허용) | 스트림을 지워 api 소비자 그룹을 없앨 수 있음 | start.sh 되돌리기 |
| R-14 · R-18 | 스트림 보존을 시간 기준으로 넉넉히(항공기·선박 2 h 이상), api 가 끊긴 뒤 이어 읽을 때 잘려 나간 구간을 감지해 손실로 기록·표시 · 드롭·트림·저장 실패 지표를 운영 화면(`GET /api/v1/ops/pipeline`)에 — **공개 `/status` 에는 싣지 않는다**(아래 결정) | api 가 창보다 오래 멈추면 조용히 손실 | 값 되돌리기 |
| R-13 | `make backup`(pg_dump 사용자 지정 형식, 권한 600) · `make restore`(격리 확인 뒤) + 절차 문서 | 백업·복원 절차 없음 | — |

## 5. 3단계 중 결정(검증 결과 반영)
- **R-18 의 `/status` 부분 — 싣지 않기로 결정.** 손실 수(드롭·거절·트림)는 프로세스별 기동 뒤 누계라 공개 사용자에게는 해석할 기준이 없고, 내부 구성(큐·리스너·스트림 이름)을 드러낸다.
  공개 응답은 검증한 필드만 싣는다는 R-72 · 운영 경로를 숨기는 R-89 와 같은 원칙이다. 공개 쪽 신호는 이미 있는 `/healthz` 의 `status: degraded` + `reasons`(예: `unread_trimmed`)로 충분하다.
  운영자는 `/ops` 의 pipeline 탭에서 본다(영구 손실 — DB 거절 행·처리 오류·리스너 오류 — 포함).
- **R-98(3단계 추가)** — 경로 판단을 인가 규칙과 같은 매처(`ApiPaths`)로. 공개 계약 변화 없음(인코딩한 경로가 원래 규칙을 받게 될 뿐).

## 6. 개정 — CTO 리뷰 2026-10(2026-10-01)
근거: [PLAN](../review/cto-2026-10/PLAN.md) · [security-review](../review/cto-2026-10/security-review.md). 모두 실패하는 시험으로 먼저 재현했다. 화면(웹)은 이미 헤더로 토큰을 보내고 같은 출처에서만 쓰므로 화면 동작은 그대로다.

### 6.1 인증 · 세션(§3 에 더함)
| ID | 변경 | 이유 | 영향 · 되돌리기 |
|---|---|---|---|
| S1 | 운영 변경 요청의 CSRF 토큰을 `X-CSRF-Token` 헤더에서만 읽는다. `_csrf` 요청 파라미터(쿼리 · 폼 본문)는 받지 않는다(`SecurityConfig.HeaderOnlyCsrfTokenRequestHandler`) | 쿠키는 포트를 가리지 않는다. 다른 localhost 포트의 페이지가 CSRF 쿠키 값을 `_csrf` 로 실은 단순 POST(사전 요청 없음)로 운영 변경을 실행할 수 있었다(재현: 200) | `_csrf` 로 보내던 클라이언트는 403. 저장소 안에는 없다. 되돌리기: `csrf.spa()` |
| S1b | `/api/v1/ops/**` 의 GET · HEAD · OPTIONS · TRACE 가 아닌 요청(로그인 포함)은 출처를 본다(`OpsOriginFilter`, CsrfFilter 앞). `Origin` 이 허용 목록에 없거나 `Sec-Fetch-Site` 가 `same-origin` 이 아니면 **403 `ORIGIN_NOT_ALLOWED`**(RFC 9457). 둘 다 없으면 통과하고 CSRF 검사가 뒤따른다 | S1 과 같은 공격 면을 브라우저가 붙이는 헤더로 한 겹 더 막는다. 같은 호스트의 다른 포트는 same-site 라 SameSite 쿠키로는 못 막는다 | 새 오류 코드 하나. 허용 목록은 WS 핸드셰이크와 같다(`wakeline.allowed-origins`). 단 이 검사는 **정확한 origin 만** 쓴다 — `*` 가 든 Spring origin 패턴(`http://localhost:[*]` · `**` 등)은 WS 에만 쓰고 여기서는 빼며 WARN 을 남긴다(최종 리뷰: 패턴 하나가 다른 포트를 모두 열었다). 되돌리기: 필터 빼기 |
| S1c | 허용 목록 뒤에 개발용 출처를 더하는 opt-in `EXTRA_ALLOWED_ORIGINS`(→ `wakeline.extra-allowed-origins`). 기본은 빈 값. 격리 스택(`make e2e` · `ISO_ENV`)은 늘 빈 값으로 덮는다 | `next dev`(다른 포트)로 화면을 띄우면 S1b 때문에 운영 쓰기가 막힌다 | 비우면 영향 없음. 운영 배포에서는 비워 둔다 |
| S14 | 로그인에 성공하면 세션 ID 와 함께 CSRF 토큰도 새로 만든다 | 로그인 전에 다른 포트의 페이지가 심어 둔 토큰 쿠키를 로그인 뒤에도 쓸 수 있었다 | 로그인 응답이 새 CSRF 쿠키를 준다. 화면은 요청마다 쿠키를 다시 읽는다. **한계**(최종 리뷰): 같은 이름 · 더 좁은 경로로 심은 쿠키(`Path=/api/v1/ops`)는 다른 쿠키라 남고, 브라우저가 그것을 먼저 보내 서버가 그 값을 쓴다 — 화면은 그 쿠키를 읽지 못해 운영 쓰기가 403 이 된다(서비스 거부, 이 브랜치 전부터). 그 값으로 다른 출처가 쓰기를 하는 것은 S1 · S1b 가 막는다 |
| S3 | 로그아웃(`DELETE /api/v1/ops/session`)은 비밀번호 표식 비교(R-95)를 건너뛴다. 절대 수명 검사는 그대로다 | DB 장애 중에 로그아웃이 503 으로 막혀 세션이 최대 8 h 살아 있었다. 권한을 줄이는 요청에 실패-닫힘 규칙을 적용한 것이 원인이었다 | 다른 운영 요청은 여전히 503 |
| S8 | `--create-ops-user` 는 `--password-stdin` 으로만 비밀번호를 받는다. 환경 변수 `WAKELINE_OPS_PASSWORD` 경로는 없앴다(사용자 결정 5) | 계약 §7(stdin 만)과 어긋났다. `docker exec -e` 로 넘긴 값은 argv · 프로세스 환경에 보인다 | 없이 실행하면 종료 코드 2 와 안내. `make ops-user` 는 원래 stdin 을 쓴다 |

### 6.2 공개 API(§1 에 더함)
| ID | 변경 | 이유 | 영향 |
|---|---|---|---|
| S13 | `/api/v1/status` 와 WS `status` 의 `active_providers` 는 정해 둔 필드만 싣는다: `{job}` · `{job}_since` · `{job}_reason` · `{job}_none_since` · `{job}_none_reason` · `{job}_none_next` · `{job}_none_retry`(job ∈ region · global) | 수집기 해시 `wakeline:active` 를 통째로 내보내서, 수집기가 나중에 쓰는 필드가 저절로 공개될 수 있었다 | 지금 쓰는 필드는 같다. WS 계약 샘플에서 시험용 `hot` 항목만 빠졌다 |
| A3 | `GET /api/v1/radar/kr/{tm}.png`: Redis 장애는 **503 + `Retry-After`**, 값이 없으면 404, base64 가 아닌 값은 404 와 함께 `wakeline_radar_kr_parse_errors_total{field="frame_png"}` 를 센다(사용자 결정 6) | 장애가 '그림 없음'(404)으로 보였고, 깨진 값은 500 이 되었다(R-72 위반) | 프레임 목록(`/radar/kr`)은 Redis 오류를 '프레임 없음'으로 보는 동작 그대로 |
| QA-207 | (QA 2026-10) 공개 · 운영의 시각 · 날짜 쿼리 파라미터는 1970-01-01T00:00:00Z ~ 9999-12-31T23:59:59.999999999Z(날짜 1970-01-01 ~ 9999-12-31)만 받는다 — 밖이면 400 `BAD_REQUEST`, 저장소에 닿지 않는다(api 요청 바인더 한 곳, 계약 v5 §G32) | 기원전 4713 년 앞의 날짜가 PostgreSQL 에 `-infinity` 로 가서 익명 `/stats/*` 하나가 3 s 동안 DB CPU 를 다 쓰고 임시 파일 0.5–0.8 GB 를 썼다(6개면 공개 조회 격벽이 찬다). PostgreSQL · Instant 범위 밖 값은 500 + ERROR 스택, 재집계는 `day = -infinity` 행을 썼다 | 범위 안 값의 결과는 같다. 1970 앞의 행은 있을 수 없어 잃는 답이 없다. 웹은 범위 밖 값을 보내지 않는다 |
| QA-206 | (QA 2026-10) `GET /api/v1/aircraft/search` 의 실시간 항목에 실시간 상태의 `registration` · `type_code` 를 싣는다(아는 것만, 계약 v5 §G33) | 등록번호로 찾은 실시간 항목에 등록번호가 없어 웹 검색 목록이 '—' 로 그렸다 | 필드만 더한다. 웹은 이미 읽는다 |
| S4 | WS `subscribe` 의 `zoom` 을 실수로 읽고 0–24 로 자른다 | int 범위 밖 숫자(`1e10` 등) 하나로 익명 클라이언트가 ERROR 스택 로그와 1011 종료를 반복해서 만들 수 있었다 | 범위 안 값의 결과는 같다. double 범위를 넘는 정수(309자리 이상)도 ±∞ 로 읽어 `zoom` 은 끝(0 · 24)으로 자르고 `bbox` 원소는 `BAD_BBOX`(연결 유지)다 — 최종 리뷰 때는 Jackson 3 의 `asDouble()` 이 그 수에서 던져 그 연결만 1002 로 닫히는 것을 알려진 한계로 두었고, QA 2026-10(QA-203)이 `bbox` 원소도 같은 길임을 찾아 둘 다 고쳤다. 1,000자리를 넘는 숫자는 JSON 해석 상한(Jackson)에 걸려 `BAD_JSON`(1002) |

### 6.3 인프라(§4 에 더함)
| ID | 변경 | 이유 | 되돌리기 |
|---|---|---|---|
| S7 | Redis 서비스 비밀번호를 `redis-server` 명령행으로 넘기지 않는다. `infra/redis/start.sh` 가 SHA-256 해시 규칙(`#<64자>`)만 적은 소유자 전용(0600) ACL 파일을 tmpfs(`/tmp`, 1 MiB)에 만들고 `--aclfile` 경로만 넘긴다. 평문은 셸 변수에서 `sha256sum` 의 stdin 으로만 간다. R-86 의 명령 제한은 그대로다 | 기동 직후 `ps` 로 비밀번호가 보이는 틈이 있었다(프로젝트 규칙: 비밀값은 argv 금지) | start.sh 되돌리기. 배포 때 redis 컨테이너를 다시 만들어야 한다(`docker compose up -d redis`) |
