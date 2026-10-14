# 버전 · 지원 종료 · 알려진 취약점(versions) — AWS 공개 데모 QA(2026-10-14)

- 대상: 브랜치 `qa/aws-2026-10`(main `29d39e38` + QA 도구) — 제품 코드는 고치지 않았다(찾기 단계). 결함 번호 범위 QA-1130–1139 중 **1130–1131** 을 썼다.
- 환경: QA 이미지 `wakeline-*:qa`(스택 A 컨테이너 안에서 읽기만 — `docker exec … --version`), 버리는 컨테이너(`--network none`), aws-deploy 는 읽기만
  (Caddy 는 compose 에 고정된 다이제스트 그대로 · gate 는 그 Dockerfile 로 만든 `portfolio-gate:local`). AWS 에는 접속하지 않았다 — AWS 판은 같은 Dockerfile 고정 다이제스트로 추정한다.
- 방법: ① 이미지 안 실제 판 ② endoflife.date API(원본 JSON 보관)와 공식 문서(Next.js 지원 정책 · Python 3.13.16 changelog · OpenSSL · Tomcat · pgjdbc 공지)
  ③ `SECURITY_OWN_IMAGES="wakeline-api:qa … wakeline-edge:qa" bash tools/security_gate.sh` + 게이트보다 넓은 trivy(MEDIUM 이상 · 고칠 수 없는 것 포함) +
  Caddy · gate 이미지 trivy + `npm audit`(전 심각도) + GitHub Advisory DB 질의 ④ 찾은 것을 실제로 재현.
- 실행: 보안 게이트 1회(**PASS** — gitleaks 1,403 커밋 · trivy 자체 5 + redis · npm audit · pip-audit, k6 는 보고만) · trivy 8 이미지 × 2 기준 ·
  새 재현 시험 pytest 3건(2 실패 · 1 대조 통과) · 재현 스크립트 2개(둘 다 결함 확인) · h2c 탐침 1. 출력은 [evidence/versions/](../evidence/versions/README.md).

| 번호 | 심각도 | 결함 | 재현 |
|---|---|---|---|
| QA-1130 | 낮음 | 수집기 이미지의 파이썬 3.13.15 가 CVE-2026-15310(3.13.16 에서 고침)을 품어, 공역 가져오기의 '풀린 크기 20 MiB 상한'이 bzip2 · LZMA KMZ 에서 메모리를 지키지 못한다 — 917 B 파일 하나로 `airspace_import` 가 512m 에서 OOM(종료 137) | `apps/collector/tests/qa/test_qa_1130_airspace_kmz_bzip2_lzma_bomb.py` · `tools/qa/qa_1130_collector_python_zip_bomb.sh` |
| QA-1131 | 낮음 | AWS 앞단 Caddy 2.11.7(고정 다이제스트)의 실행 파일이 Go 1.26.8 · x/net 0.59.0 — 고칠 수 있는 HIGH 3(CVE-2026-78667 · 78669 · 97031) · MEDIUM 5. wakeline 게이트 기준이면 막힐 이미지이고, 평문 리스너가 HTTP/2(h2c)를 받아 HTTP/2 서버 CVE 가 리스너에 닿는 누구에게나 열린다 | `tools/qa/qa_1131_caddy_go_cves.sh` |

## 설치된 판 · 지원 기간(2026-10-14, 출처: endoflife.date — [eol-table.txt](../evidence/versions/eol-table.txt))
| 구성 | 쓰는 판(이미지 안) | 최신 | 지원 끝(활성 / 보안) | 판단 |
|---|---|---|---|---|
| Node.js(web) | 24.21.0 · 내장 OpenSSL 3.5.8 | 24.21.0 | 2026-10-20 / 2028-04-30 | 보안 수정 계속 — 앞선 QA 와 같음(참고) |
| Next.js | 16.3.8 | 16.4.0(2026-10-06) | 16 = Active LTS(날짜 없음) | 지원 중 — 공식 정책은 16 줄의 어느 부 버전에 보안 수정을 내는지 적지 않는다(nextjs.org/support-policy) |
| React | 19.3.0 | 19.3.0 | — | 지원 중 |
| Spring Boot · Framework | 4.1.1 · 7.0.9 | 4.1.1 · 7.0.9 | — / 2027-07-31(OSS) | 지원 중 |
| Java(Temurin, api) | 25.0.4.1+1 LTS · Ubuntu 26.04.1 | 25.0.4.1+1 | 2031-09-30 | 지원 중 |
| Tomcat(내장) | 11.0.26(제약으로 올림) | 11.0.27(2026-10-06) | — | 11.0.26 까지의 공지는 모두 고쳐짐(tomcat.apache.org/security-11 — 11.0.27 공지 없음) |
| Python(collector · ais) | **3.13.15** · Debian 13.7 | **3.13.16**(2026-09-30) | 2026-10-01 / 2029-10-31 | **QA-1130** — 상류 `python:3.13-slim` 은 이미 3.13.16(`sha256:70729b46…`), Dockerfile 은 3.13.15(`sha256:7c61056e…`, 2026-09-28 R-85 뒤 그대로) |
| Python(aws-deploy gate) | 3.14.8 | 3.14.8 | 2027-10-01 / 2030-10-31 | 지원 중(아래 개선 제안 5 — 이미지 안 pip) |
| PostgreSQL(로컬 db · AWS RDS) | 18.6 · RDS 18.6 | 18.6 | 2030-11-14 | 지원 중 |
| PostGIS | 3.6.4 | 3.6 줄(3.7 은 RC2) | 공식 EOL 날짜를 찾지 못함 | 미확인 |
| Redis | 8.10.2 · Alpine 3.23.6 | 8.10.2 | 날짜 없음(현재 줄) | 지원 중 |
| nginx(edge) | 1.30.5 · Alpine 3.24.2 · OpenSSL 3.5.9 | 1.30.5 | 현재 stable | 지원 중 |
| Caddy(aws-deploy) | 2.11.7(Go 1.26.8) | 2.11.7(2026-10-03 — 그 뒤 판 없음, GitHub releases) | 2 줄 지원 중 | **QA-1131** |
| OS | Alpine 3.24 · 3.23 / Debian 13 / Ubuntu 26.04 · EC2 Ubuntu 24.04(aws-deploy README) | — | 2028-06 · 2027-11 / 2030-06 / 2031-05 · 2029-05 | 지원 중 |
| 라이브러리 | asyncpg 0.31.0 · httpx 0.28.1 · websockets 17.1 · json-schema-validator 3.0.8 · MapLibre 6.11.2 · pgjdbc 42.7.13 | 0.32.0 · 0.28.1 · 17.2 · 3.0.8 · 6.14.0 · 42.7.14 | — | 새 판의 변경에 보안 수정은 pgjdbc 42.7.14 뿐(wakeline 이 쓰지 않는 API — 개선 제안 4) |

90일 안(2027-01-12 까지)에 지원이 끝나는 쓰는 줄: Node 24 의 **활성** 지원(2026-10-20)뿐이고 보안 수정은 2028-04 까지라 결함 아님(앞선 QA 와 같음).
이미 끝난 것: Python 3.13 버그 수정(2026-10-01, 보안은 2029-10) · ESLint 9(2026-08-06, 개발 도구) — 둘 다 앞선 리뷰에서 수용(아래 '앞선 QA 와 같음').

## 취약점 점검 결과
- **보안 게이트 PASS**([원문](../evidence/versions/security-gate-qa-images.txt)): trivy 자체 5 이미지 고칠 수 있는 HIGH·CRITICAL 0 · redis 0 · npm audit High 0(기한부 예외 braces 1 — 2026-11-02) ·
  pip-audit 0 · gitleaks 0. trivy DB 2026-10-13T13:06Z · java DB 2026-10-13T01:09Z.
- **넓게**([요약](../evidence/versions/trivy-wide-summary.txt)): 자체 이미지의 고칠 수 있는 MEDIUM 은 db 의 libpng16 1건(CVE-2026-46675 — db 는 로컬 전용, 다시 빌드하면 받는다)뿐.
  고칠 수 없는(affected) HIGH·CRITICAL 은 Debian 기반(collector 44 · db 106 — 대부분 util-linux · ncurses · mariadb 라이브러리)에 남는다 — 게이트 정책(ignore-unfixed)대로 결함 아님.
- `npm audit --omit=dev`(웹 이미지에 들어가는 것): 0건(전 심각도). GitHub Advisory DB 질의: next 16.3.8 · maplibre-gl 6.11.2 · websockets 17.1 · httpx 0.28.1 · asyncpg 0.31.0 ·
  tomcat-embed-core 11.0.26 · netty 4.2.17 · spring-web 7.0.9 · json-schema-validator 3.0.8 모두 0건.
- **게이트가 보지 못하는 곳**: trivy 는 이미지 안 런타임 실행 파일(python · node · java · redis-server · postgres)의 판을 보지 않는다 — 게이트가 PASS 인데 수집기 파이썬은
  CVE 8건이 고쳐진 판보다 하나 뒤다(QA-1130). Node 24.21.0 의 내장 OpenSSL 3.5.8 은 3.5.9(2026-09-29, High 1 = DTLS · 나머지 Low — QUIC · DTLS · CMP · SM2)보다 뒤지만
  웹 서버는 TLS 를 쓰지 않고 상류 Node 24 의 새 판도 아직 없다(참고).

---

## QA-1130 낮음 — 수집기 파이썬 3.13.15 의 CVE-2026-15310: 공역 KMZ 의 '풀린 크기 상한'이 bzip2 · LZMA 멤버에서 메모리를 지키지 못함
- **환경**: `wakeline-collector:qa`(`sha256:8220ce59…`, PYTHON_VERSION=3.13.15) · 버리는 컨테이너(`--network none --cap-drop ALL`) · 호스트 uv 파이썬 3.13.13.
  운영 경로는 `make airspace-import`(Makefile:59–62) = `docker compose exec -T collector python -m wakeline_collector.tools.airspace_import < 파일` — 실행 중인 수집기 컨테이너
  (한도 512m, infra/compose.yml:212 — AWS 판도 같은 한도, 평소 RSS 약 169 MiB — VERIFICATION #143) 안에서 돈다. AWS 에서도 2026-10-11 에 이 명령으로 공역을 넣었다(#144).
- **배경**: Python 3.13.16 changelog(2026-09-30) gh-156002 — "Bound the amount of data zipfile decompresses per read for members compressed with bzip2, LZMA, or
  Zstandard … A small archive member could previously expand into an unbounded allocation even when read in small chunks"(CVE-2026-15310). 같은 판이 tarfile · ssl ·
  urllib.request · stringprep 의 CVE 7건도 고쳤다(CVE-2026-82049 · 19672 · 87910 · 19445 · 19553 · 15806 · 17084) — 수집기는 tarfile · urllib.request · 서버 쪽 ssl 을 쓰지 않고(호스트 이름은 ASCII),
  `wrap_bio`/`start_tls` 에는 늘 server_hostname 을 넘긴다(asyncpg connect_utils.py:985 · httpx · websockets) → 닿는 것은 zipfile 하나로 봤다.
- **재현 절차**:
  1. `cd apps/collector && uv run --offline pytest tests/qa/test_qa_1130_airspace_kmz_bzip2_lzma_bomb.py -q` — 공백 128 MiB 를 담은 멤버 하나짜리 KMZ(bzip2 247 B · LZMA 19 KB ·
     대조 deflate)를 `airspace.kml_bytes` 로 읽는 동안 최고 메모리(tracemalloc)가 상한의 세 배(60 MiB) 안인지 본다.
  2. `bash tools/qa/qa_1130_collector_python_zip_bomb.sh` — 이미지의 파이썬으로 1 GiB 공백 bzip2 멤버 KMZ(917 B)를 만들고, 수집기와 같은 `--memory 512m` 에서
     `airspace_import --dry-run` 에 표준 입력으로 준다(DB 에 닿지 않는다).
  3. 대조: 같은 `airspace.py`(작업 트리 읽기 전용 마운트) · 같은 512m 을 파이썬 3.14.8(gh-156002 를 고친 판 — `portfolio-gate:local`)에서 돌린다.
- **기대**: airspace.py 머리말 · QA-711 의 규칙대로 "풀린 크기 20 MiB 초과(머리말의 크기를 믿지 않고 읽으며 센다)" — 최고 메모리 ≈ 20 MiB, `거절: KML larger than 20971520 bytes
  when unpacked`(종료 1).
- **실제**: 읽기를 64 KiB 씩 해도 첫 읽기에서 압축 조각 전체를 한꺼번에 푼다 — 멤버 크기에 비례해 메모리를 잡는다. 512m 에서는 거절 글 없이 **OOM 으로 죽는다(종료 137)**.
  3.14.8 에서는 같은 코드가 22.6 MiB 로 거절한다.
- **증거**([qa-1130-pytest.txt](../evidence/versions/qa-1130-pytest.txt) · [qa-1130-repro.txt](../evidence/versions/qa-1130-repro.txt)):
  ```
  E       AssertionError: 247 B KMZ 의 128 MiB 멤버를 읽는 동안 최고 269.4 MiB (> 60 MiB) — 한 번 읽을 때 푸는 양이 묶이지 않았다(CVE-2026-15310)
  E       AssertionError: 19,150 B KMZ 의 128 MiB 멤버를 읽는 동안 최고 277.4 MiB (> 60 MiB) — 한 번 읽을 때 푸는 양이 묶이지 않았다(CVE-2026-15310)
  FAILED …::test_qa_1130_kmz_unpack_limit_bounds_memory[bzip2]
  FAILED …::test_qa_1130_kmz_unpack_limit_bounds_memory[lzma]
  2 failed, 1 passed in 4.29s                       (deflate 대조 통과 — 22.7 MiB)

  python 3.13.15 · wakeline_collector.airspace · limit 20 MiB · member 256 MiB unpacked      (wakeline-collector:qa)
  bzip2    kmz=     343 B  peak=   557.4 MiB   1.02s  -> AirspaceTooLarge: KML larger than 20971520 bytes when unpacked
  lzma     kmz=  38,082 B  peak=   565.5 MiB   0.70s  -> AirspaceTooLarge: …
  python 3.14.8 · copy of kml_bytes …                                                         (portfolio-gate:local)
  bzip2    kmz=     343 B  peak=    22.6 MiB   0.13s  -> Err: KML larger than limit when unpacked

  airspace_import --dry-run (512m): exit 137                                                 (기대: 1 + '거절: …')
  FAIL  기대: 종료 1 + '거절: KML larger than … when unpacked' — 실제: 종료 137 (137 = OOM 으로 죽음)
  ```
- **의심 원인**: `apps/collector/Dockerfile:4,14` — `python:3.13-slim@sha256:7c61056e…`(3.13.15) 고정이 그대로다(상류 같은 태그는 `sha256:70729b46…` = 3.13.16).
  코드 쪽 노출 지점은 `apps/collector/wakeline_collector/airspace.py:298-301`(`z.open(…).read(1 << 16)` — 압축 방식을 가리지 않는다; KMZ 는 deflate 를 쓴다).
  보안 게이트(trivy)는 인터프리터 판을 보지 않아 PASS 였고, Dependabot docker PR 도 열리지 않았다(2026-10-12 PR 3건 — uv · npm · actions 뿐).
- **심각도 근거**: 입력은 운영자가 표준 입력으로 주는 파일(국토교통부 KMZ)이라 조건이 드물다(낮음). 결과는 운영 명령의 비정상 종료이고, `exec` 는 수집기와 같은 cgroup 을 나눠 쓴다
  (수집기 본 프로세스가 함께 죽는지는 확인하지 않았다 — 아래 미확인).
- **참고**: 호스트(3.13.13)에서는 pytest 가 실패하지만, CI 의 uv 가 3.13.16 이상을 고르면 pytest 는 통과하고 이미지는 그대로일 수 있다 — 이미지 단위 확인은 스크립트가 한다.
  고치는 길(고치기 단계): 기반 이미지 다이제스트를 3.13.16 이상으로(이미지) · 그리고/또는 KMZ 멤버를 stored · deflate 로만 받기(어느 런타임에서나 pytest 통과).

## QA-1131 낮음 — AWS 앞단 Caddy 2.11.7 의 Go 1.26.8: 고칠 수 있는 HIGH 3 · 평문 리스너가 h2c 를 받음
- **환경**: aws-deploy `compose.yml:30` 의 `caddy:2.11.7-alpine@sha256:d8542f48…`(로컬에 있던 같은 다이제스트, arm64 — 새 태그를 만들지 않음) · 망 없는 컨테이너.
  운영(EC2 x86_64)은 같은 다이제스트(인덱스)라 같은 릴리스 바이너리로 추정한다.
- **재현 절차**: `bash tools/qa/qa_1131_caddy_go_cves.sh`(aws-deploy 는 읽기만) — ① `caddy build-info` ② `tools/scan_lib.sh` 의 trivy(게이트와 같은 기준 HIGH·CRITICAL ·
  고칠 수 있는 것, 캐시 DB) ③ 운영 Caddyfile 과 같이 `auto_https off` · `protocols` 미지정인 평문 리스너에 `curl --http2-prior-knowledge`.
- **기대**: 인터넷을 마주한 앞단(세 프로젝트 공유)에 고칠 수 있는 HIGH 가 없다(wakeline `tools/security_gate.sh` 기준), 또는 닿지 않는다는 근거가 있다.
- **실제**: `go1.26.8` · `golang.org/x/net v0.59.0`. trivy HIGH 4행(고유 CVE 3) — CVE-2026-78669(HTTP/2 SETTINGS 프레임 CPU 고갈, stdlib · x/net) ·
  CVE-2026-78667(Range 헤더 CPU — FileServer · ServeContent) · CVE-2026-97031(crypto/tls ECH 메모리) — 모두 Go 1.26.9 · 1.27.2 / x/net 0.60.0 에서 고침(공개 2026-10-08).
  MEDIUM 5(고유 — 그 밖에 Alpine zlib CVE-2026-85091 1, caddy 는 Go 정적 바이너리라 쓰지 않음): HTTP/2 HPACK 동시 수정으로 서버 크래시(97032) · HTTP/2 흐름 제어 우회(78663) · CONNECT 요청 밀반입(94439) · CONNECT 응답 오염(56866) · html/template XSS(94448).
  평문 리스너가 **HTTP/2(h2c)를 받는다**(`2 200`) — HTTP/2 서버 CVE 는 리스너에 TCP 로 닿는 누구에게나 열린다.
- **증거**([qa-1131-caddy.txt](../evidence/versions/qa-1131-caddy.txt) · [trivy/caddy_*.compact.json](../evidence/versions/trivy/)):
  ```
  go	go1.26.8
  dep	golang.org/x/net	v0.59.0
  usr/bin/caddy (gobinary)  Total: 4 (HIGH: 4, CRITICAL: 0)
  FAIL  trivy: 고칠 수 있는 HIGH·CRITICAL 있음(rc 1)
  h2c(사전 지식) 응답 HTTP 판: 2
  ```
- **닿는 경로(확인한 것과 추정 구분)**: 확인 — Caddyfile 은 `file_server` 를 쓰지 않고(78667 의 대상 함수 없음), TLS 를 끈 평문 리스너라(`auto_https off`) ECH(97031)는 닿지 않는다.
  HTTP/2 계열(78669 · 97032 · 78663)은 h2c 로 닿는다. 추정 — 리스너 8101–8103 은 보안 그룹이 CloudFront 원본 대역만 들인다(Caddyfile 머리말의 설명, 이 QA 에서 확인 안 함),
  CloudFront 는 원본에 HTTP/1.1 로 붙는다(확인 안 함). 둘 다 맞으면 지금은 바깥에서 닿지 않는다 → 낮음. 보안 그룹이 넓으면 익명 요청으로 세 프로젝트의 앞단을 멈출 수 있다(높음).
- **의심 원인**: aws-deploy `compose.yml:30`(Caddy 2.11.7 이 최신 — 상류에 Go 1.26.9 로 빌드한 판이 아직 없다) · aws-deploy 에는 trivy 같은 이미지 검사가 없다(`.github` 없음).
  완화(제안): 공개 리스너에 `servers { protocols h1 }`(원본 구간은 HTTP/1.1 이면 충분 — 추정) · Caddy 2.11.8 이 나오면 다이제스트 갱신 · 또는 xcaddy 로 Go ≥ 1.26.9 빌드.
  aws-deploy 는 공유 저장소라 고치기 전에 사용자에게 묻는다(QA-PLAN §0 · §6).

## 미확인
- **QA-1130 의 운영 영향 범위**: `docker compose exec` 로 돈 가져오기 프로세스가 수집기 cgroup(512m)에서 OOM 이 날 때 수집기 본 프로세스도 함께 죽는지. B 스택(장애 주입 전용)을
  다른 에이전트가 함께 쓰고 있어 흔들지 않았다 — 같은 이미지 · 같은 한도의 버리는 컨테이너로만 재현했다.
- **QA-1131 의 바깥 도달성**: EC2 보안 그룹(8101–8103 의 출처 대역)과 CloudFront → 원본 프로토콜. AWS 에 접속하지 않았다.
- **AWS 에서 실제 도는 이미지의 판**: 같은 Dockerfile 고정 다이제스트(004f26dc = 29d39e38 의 제품 코드)라 같다고 봤다. 빌드 때 `apt-get upgrade` 로 받은 OS 패키지는 빌드 날짜에 따라 다를 수 있다.
  EC2 의 Docker Engine · containerd 판도 보지 않았다.
- **gate 기반 이미지 자체**(`python:3.14.8-slim-trixie@sha256:a2b82f3c…`): Docker Hub 가 429(요청 한도)로 받지 못해, 그 Dockerfile(이력 1커밋)로 만든 `portfolio-gate:local` 을 스캔했다.
- **PostGIS 3.6 의 지원 끝 날짜**: endoflife.date 에 없고(404), postgis.net 뉴스 · 판 목록에도 날짜가 없다. 3.6 은 현재 안정 줄(3.7 은 RC2, 2026-09-08)이다.
- **Dependabot 이 python:3.13-slim 새 다이제스트 PR 을 열지 않은 까닭**: 설정(`.github/dependabot.yml` docker · cooldown 7일)은 대상을 포함한다. 공식 이미지가 7일보다 자주 다시 빌드돼
  cooldown 이 끝나지 않는 것으로 추정하지만 확인하지 않았다.

## 개선 제안(결함 수에 넣지 않음)
1. **보안 게이트의 사각 — 런타임 판**: trivy 는 python · node · java · redis-server · postgres 실행 파일의 판을 보지 않는다. TomcatVersionTest · JacksonVersionTest 처럼
   이미지 ENV(`PYTHON_VERSION` · `NODE_VERSION` · `JAVA_VERSION` · `REDIS_VERSION` · `PG_VERSION` · `NGINX_VERSION`)의 하한을 시험으로 두거나, 바이너리 분류가 있는 스캐너
   (syft/grype 등 — 새 도구라 들이기 전에 이유를 적는다)를 함께 돌린다.
2. **시험 파이썬 = 이미지 파이썬**: 호스트 uv 3.13.13 · 이미지 3.13.15 · CI 는 uv 가 고르는 3.13.x — `.python-version` 을 이미지와 같은 패치로 묶거나 수집기 시험 일부를 이미지 안에서도 돌린다.
3. **KMZ 압축 방식**: 공역 KMZ 는 deflate 다 — `kml_bytes` 가 stored · deflate 멤버만 받으면 런타임 판과 상관없이 상한이 지켜진다(QA-1130 의 코드 쪽 방어).
4. **pgjdbc 42.7.14**(2026-10-07): GHSA-f64h-wr5q-3qf3(CVSS 5.3 — `setObject(ByteStreamWriter)` · CopyIn · LargeObject · `Blob.setBytes` 의 길이 불일치 때 앞선 트래픽이 값에 섞임)
   · GHSA-rhp9-mr79-r74h(5.9 — 모든 방식을 뺀 `requireAuth`). wakeline api 는 이 API 들과 `requireAuth` 를 쓰지 않아(grep 0) 닿지 않는다. 전역 Advisory DB · trivy 에 아직 없다 —
   Tomcat 처럼 제약으로 올려 두면 다음 Boot 패치를 기다리지 않는다.
5. **aws-deploy gate 이미지의 pip**: 기반 이미지의 pip 26.2.1 이 품은 urllib3 2.7.0(CVE-2026-97687 · 97689 HIGH) · msgpack 1.1.2(GHSA-6v7p-g79w-8964 HIGH) ·
   setuptools 70.3.0(CVE-2025-47273 HIGH) — 고칠 수 있는 HIGH 4 · MEDIUM 2. gate 는 `python -I gate.py` 만 실행해 닿지 않는다. wakeline 이 R-29 에서 한 것처럼 pip 를 지우고
   빌드 때 `apt-get upgrade` 를 더하면 게이트 기준을 맞춘다. aws-deploy 에 이미지 검사(trivy)를 더하는 것도 함께(공유 저장소 — 사용자 결정).
6. **httpx 0.28.1**: 2024-12-06 뒤로 새 판이 없고(22개월), 저장소는 이슈 · PR 을 협력자만 열 수 있다 — 지원 종료 공지는 찾지 못했다(관찰).
7. **Next.js 16.4**: 공식 정책은 16 줄 안 어느 부 버전에 보안 수정을 내는지 적지 않는다 — 16.3 에 머물면 다음 보안 공지가 16.4.x 로만 나올 수 있다(추정, 앞선 QA 의 참고와 같다).
