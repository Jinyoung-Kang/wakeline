# QA 2026-10 AWS — 성능(계획 §3.5, AWS 값)

- 영역키 `performance` · 결함 번호 QA-1500–QA-1529 · 브랜치 `qa/aws-2026-10`(HEAD `fe1dbb3a` = QA 고친 뒤, 측정 도구는 커밋하지 않음) · 2026-10-14 KST 16:15–19:14
  (UTC 07:15–10:14). 수치는 모두 이 세션에서 잰 값이다. 계산한 값은 '추정', 실측 근거가 없는 전제는 '가정'이라고 적었다.
- 측정만 했다 — 제품 코드는 바꾸지 않았다. 점검 스크립트만 더하거나 인자를 더했다(§11). 기본값은 옛 동작 그대로이고 옛 증거 경로를 덮지 않는다.
- 증거: `docs/qa/2026-10-aws/evidence/performance/`(k6 요약 JSON · 로그 · 자원 표본 CSV · 단계 경계 · pg_stat_statements · EXPLAIN · 느린 문장 · 큰 응답 · Lighthouse 보고서 · 첫 화면 JS).

## 0. 판단(먼저)
- **api 층 목표는 두 규모 모두 통과**: 공개 32경로(35개 이름) 경로마다 p95 ≤ 300 ms · 실패 0 % · **503 0 %**(공개 조회 허가 3 — 격벽 거절 0건, 몰림 400 rps 포함) ·
  WS 200 연결 지연 p95 46 ms(AWS 규모) · 281 ms(상한 규모, 3번 중 1번 560 ms) · api 컨테이너 최대 428 · 582 MiB(목표 768) · OOM · 재시작 0.
- **앞선 측정(PERF §14.2 p40 — 같은 순서 · 상한 규모)보다 나빠진 것 없음**. 메모리는 같은 꼴(REST 100 rps 최대 526 MiB — 앞 524), 몰림 뒤 평탄은 579 MiB(앞 679).
  지연은 이번이 훨씬 낮은데(전체 p95 12.9 ms — 앞 37.5), VM 의 다른 부하가 적었다(§1). 그래서 지연 개선을 코드 효과로 읽지 않는다.
- **QA 고침 뒤 따라잡기 비용**: 정상 상태에서 늘어난 몫은 QA-1202(최근 6 h 다시 요약)뿐이다. 따라잡기마다 DB 시간이 AWS 규모 +0.5 s, 상한 규모 +1.6 s 늘고,
  외부 정렬 임시 파일이 15–22 MB 생긴다. QA-1201(지정 보존 창 70 h → 365일)은 같은 자료에서 비용이 같다(12.6–13.4 s 대 12.7–13.2 s).
  QA-1200 · 1203 · 1240 은 질의마다 평균 2 ms 아래다(EXPLAIN 최대 7 ms). 따라잡기 한 번의 DB 시간은 AWS 규모 1.5 s, 상한 규모 12.4 s다(§5).
- **화면**: 데스크톱 8화면은 모두 good(실제 GPU · 배경지도 열림). 모바일에서 새로 넘은 것은 둘이다.
  `/stats` CLS 0.156은 자료가 실제 규모가 되면서 나빠졌다(**QA-1500** — 앞선 측정 0.050). `/guide` LCP 2,910 ms는 새 화면이다(**QA-1501**).
  나머지 모바일 LCP 2.4–2.6 s · 지도 화면 TBT 421–458 ms는 주인이 2026-10-02 에 받아들인 꼴과 같은 값이다(PERF §15.6).
- **첫 화면 JS 549,840 B / 550,000 B** — 예산 안이지만 여유가 160 B뿐이다(출시 QA 2차 548,678 B → +1,162 B).

## 1. 조건

| 항목 | 값 |
|---|---|
| 기계 | Apple M1 · 16 GB · Docker Desktop VM 4 CPU · 7.75 GiB. **이번에는 이 스택만 떠 있었다**(로컬 운영 스택 8700 · 스택 B · 다른 프로젝트 컨테이너 모두 정지). 측정 끝 무렵 호스트 부하 평균(1분 · 15분) 1.5 · 3.1 |
| 스택 | **A1**(`tools/qa/wlqa.sh A1` — compose `wlqa-a` · `http://localhost:8701` · 망 10.78.0 · api `10.78.0.30:8000`) = 격리 표준 + `compose.aws-sim.yml`(공개 데모 · 공유 풀 6 · 공개 조회 허가 3 · 선택 조회 풀 2 · OpenSky 끔). fixture 모드(서버의 외부 호출 0) · 시험 env(사용자 `.env` 읽지 않음) |
| 이미지 | `:qa` 를 이 세션에서 다시 빌드(api `13d2614bef22` · collector `aa24e23132db` · web `a1b6bf0a40c6`) + edge `4c042b930c91` · db `a1b67035920c`(PostgreSQL 18.6). `:local` · `:mainsafe` 는 건드리지 않음 |
| JVM · 한도 | 이미지 그대로 `-XX:+UseG1GC -XX:MaxRAMPercentage=40 -XX:+ExitOnOutOfMemoryError` · `MALLOC_ARENA_MAX=2` · 힙 상한 410 MiB · api 1 GiB · db 1 GiB(shared_buffers 256 MB) |
| 요청 제한 | REST · WS 측정 동안만 `perf_api_up.sh lifted`(공개 분당 1,000,000 · WS IP 당 / 전체 1,000). **실행마다 api 를 새 컨테이너(새 JVM)로**(`--force-recreate`). 측정 뒤 기본값(분당 120 · WS 5/200)으로 되돌림 — 따라잡기 · 큰 응답 · Lighthouse 는 기본값 |
| DB 계측 | 측정 전용(시험 볼륨): `shared_preload_libraries = pg_stat_statements` · `log_min_duration_statement = 100ms`(ALTER SYSTEM + db 재시작 — 볼륨과 함께 지움) |
| 부하 | k6 2.3.0(같은 VM · `wlqa-a_wakeline` 망 · api 직접). `perf/qa/rest-routes.js` — **OpenAPI 공개 32경로 전부**(앞선 22개 이름 그대로 + 13경로 추가 = 35개 이름, 무게 39). 자원 표본 `perf_sample.py` 5 s |
| 순서(실행마다) | `tools/qa/perf_aws_run.sh`: W 데움 ≥ 180 s(실시간 상태가 찰 때까지) → AWS 규모 `R20`(20 rps 3분) → `R100`(100 rps 3분) → `S`(WS 200 · 선박 레이어, 1분 램프 + 3분) → `I` 쉼 120 s / 상한 규모 `R100` → `S` → `B`(몰림 300 → 400 rps 각 60 s) → `I` 300 s. 3번씩 |
| 화면 | Lighthouse 12.8.2(npx) · Chrome for Testing 153.0.8010.12 · **실제 GPU**(`--headless=new --use-angle=metal --enable-gpu` → WebGL "ANGLE Metal Renderer: Apple M1", `cwv-webgl-renderer.txt`) · 기본 throttling · 배경지도(OpenFreeMap)만 열고 다른 바깥은 막음(`perf_cwv.sh … ofm`) · 화면 8 × 2 프리셋 × 3번. 소프트웨어 GL 은 재지 않았다 |

**자료 두 규모**

| | AWS 규모(`seed_perf_aws.sql` + fixture 실시간) | 상한 규모(`seed_perf.sql` + `seed_perf_r2.sql` — 앞선 QA 와 같은 식) |
|---|---|---|
| DB | **451 MB**(AWS 실측 219 MB — VERIFICATION #144) | **8.58 GB**(앞선 QA 8.8–9.06 GB) |
| 원해상도 항적 | 관심 지역 130대 / 10 s × 평일 운영 시간(00–09 UTC)만 · 최근 3일 → 117만 행 | 관심 지역 200대 / 10 s + 전세계 1만 대 / 120 s · 56 h → 2,085만 행 |
| 선박 위치 · 정적 | 3,000척(가정 — 동아시아 구독) 분당 약 330행 → 50만 행 · 정적 6,000 | 12,000척 분당 약 2,300행 → 775만 행 · 정적 4만 |
| 1분 요약 · 알림 · SIGMET | 75만 · 4,077(관심 지역만) · 11,200(14일) | 853만 · 118만(30일) · 20만(250일) |
| 특보 · 지정 보존 | 5,000 · 8.6만(대상 20) | 11.2만 · 346만(대상 20) |
| 실시간(`perf_feed.py`) | 전세계 0(OpenSky 끔) · 관심 지역 127(fixture) · 선박 3,375(합성 3,000 — 5 s 마다 30척 = 초당 6건, PERF §3 동아시아 5.3 msg/s) · SIGMET 132 | 전세계 10,000 · 관심 지역 127 · 선박 15,375 · SIGMET 132(앞선 QA 와 같다) |
| 운영 설정 | `retain_targets` = 지정 상한 20개(항공기 10 · 선박 10 — 따라잡기의 365일 복사가 실제로 일하게) | 같음 |

- 상한 규모를 줄이지 않았다. 넣는 데 seed 15분 + r2 0.5분 + VACUUM 0.8분이 걸렸다.
  `seed_perf.sql` 은 알림 끝 시각을 지금으로 옮기자 마지막 SIGMET 뒤를 가리켜 FK 오류로 멈췄다(`seed-max-run.log`). 도구를 고친 뒤 알림부터 이어서 넣었다(§11).
- **앞선 측정과 다른 점**: 풀 6/3/2(앞 12/6/4) · 경로 35개 이름(앞 §14.2 는 16개) · VM 의 다른 CPU(REST 단계 가운데 38–44 % — 앞 60–71 %) · 새 JVM 을 매번(앞과 같다) ·
  앞선 측정의 몰림은 2분(각 60 s)이라 이번에도 같게 했다(3분이 아님).
- **AWS 와 다른 점(로컬로 재지 못함)**: DB 가 RDS db.t4g.micro(2 vCPU 버스트 · 1 GB · shared_buffers 179 MB · 망 너머 TLS)가 아니라 같은 VM 의 컨테이너다.
  api 는 EC2 m7i-flex.large(2 vCPU)가 아니라 VM 4 CPU 를 다른 컨테이너 · k6 와 나눠 쓴다. CloudFront · Caddy · gate 를 거치지 않는다(api 직접).

## 2. 목표 대비(3번의 가운데 [최소–최대])

| 항목 | 목표 | AWS 규모 | 상한 규모 | 판정 |
|---|---|---|---|---|
| REST 20 rps — 전체 p95 · 가장 느린 경로 p95 | 경로마다 ≤ 300 ms | 10.4 [10.1–10.5] · `replay_72h` 16.9 [16.7–19.1] | — | 통과 |
| REST 100 rps — 전체 p95 · 가장 느린 경로 p95 | 경로마다 ≤ 300 ms | 6.1 [6.0–6.2] · `replay_72h` 14.2 [13.6–14.3] | 12.9 [12.4–21.3] · `replay_72h` 36.9 [31.8–84.8] | 통과(넘은 경로 0 · 9번 모두) |
| 실패율 · **503 비율** | < 1 % · ≤ 1 % | 0 % · 0 %(격벽 거절 0) | 0 % · 0 %(격벽 거절 0) | 통과 |
| 몰림 300 → 400 rps(기록만) | — | — | 400 rps p95 19.6 [17.7–70.0] · 실패 0 % · 503 0 % · 가장 느린 `replay_72h` 66 [53–167] | (기록) |
| WS 200 연결 — 항공기 지연 p95 | ≤ 500 ms | 46 [45–56] · 오류 0 | 281 [200–**560**] · 오류 0 | 통과(가운데) — 상한 1/3 넘음(§4) |
| api 메모리 최대(컨테이너 · RSS) | ≤ 768 MiB | 402 [386–428] · 419 [404–448] | 579 [558–582] · 600 [579–603] | 통과 |
| GC 일시정지 합(R100 3분 · 몰림 2분) | 기록 | 0.41 s [0.33–0.49] · 115회 | 0.67 [0.64–0.89] · 110회 / 몰림 1.00 [0.98–1.45] · 196회 · 최대 0.085 s | (기록) |
| 첫 화면 JS | ≤ 550,000 B | 549,840 B(여유 160 B) | — | 통과(경계) |
| 화면 CWV(가운데) | LCP ≤ 2,500 · TBT ≤ 200 · CLS ≤ 0.1 | 데스크톱 8/8 good · 모바일 §7 | — | QA-1500 · QA-1501 |

## 3. REST(k6 · api 직접)
요약 표 전체(단계 · 경로별 · 실행마다): `evidence/performance/summary-aws.md` · `summary-max.md`(`tools/qa/perf_aws_summary.py --routes --runs`).

**AWS 규모** — 경로별 p95 가 모두 20 ms 아래다(20 rps 에서 가장 느린 `replay_72h` 16.9 ms, 100 rps 에서 14.2 ms). 20 rps 가 100 rps 보다 조금 느린 것은 순서 탓이다.
새 JVM 의 첫 3분이라 JIT 데움이 들어 있다. db CPU 는 가운데 1–6 %, 히카리 대기 0, 격벽 거절 0이었다.
100 rps 3분 동안 pg_stat_statements 상위 7개 문장의 합은 약 3.3 s 다(`replay.track_point` 874–943회 · 합 1.5–1.6 s · 평균 1.6–1.8 ms가 가장 크다).

**상한 규모** — 100 rps 경로별 p95 상위: `replay_72h` 36.9 [31.8–84.8] · `replay_1m` 20.3 · `ships_region` 18.5 · `ships_coverage` 17.4 · `aircraft_wide` 15.5 ms. 나머지는 15 ms 아래다.
몰림(2분, 41,752건): 300 rps p95 16.5 · 400 rps 19.6 ms이고 실패 · 503 · 놓친 반복이 모두 0이다. 가장 느린 경로는 `replay_72h` p95 66 ms[53–167] · p99 144 ms.
api CPU 가운데 82 %(최대 315 %) · db 33 %(최대 96 %) · VM 전체 가운데 170–219 %였다.
- 3번째 실행이 모든 단계에서 느렸다(R100 p95 21.3 · 몰림 57.5 ms · WS 560 ms). 그 실행의 api CPU 최대는 315 %, GC 최대 일시정지는 85 ms였다. 같은 설정 안의 흔들림으로 본다(§4).
- 상한 규모의 DB 상위 문장(`pgss-max-r*-R100.txt` · `-B.txt`): `replay.track_point` 평균 6.3 ms(몰림 7.0) · `replay.sigmet` 4.9 ms(몰림 5.3, 최대 185 ms) ·
  `replay.track_point_1m` 2.8 ms · `ship.track` 2.2 ms. 느린 문장 로그(≥ 100 ms, 57분, `slowlog-max-summary.md`): 공개 조회는 `replay.track_point` 32건(가운데 121 · 최대 228 ms) ·
  `replay.sigmet` 4건 · `replay.track_point_1m` 2건 · `aircraft.search` 1건이다. 나머지는 기록기(전세계 1만 대 항적 배치 44건 · 가운데 163 ms)와 따라잡기(§5)다.
- 추가한 13경로(상한 100 rps p95): `aircraft_detail` 5.0 · `ship_detail` 6.4 · `airports` 4.8 · `ais_gaps` 7.4 · `alerts_active` 6.6 · `sigmet_one` 3.1 · `radar_frames` 2.6 · `radar_kr` 3.1 ·
  `radar_kr_png` 4.1(fixture 라 프레임이 없어 404 경로) · `ships_coverage` 17.4 · `traffic_grid` 3.4(fixture 라 available:false) · `client_errors` 4.4(자체 제한 IP 당 분당 10 → 429 가 정상) · `healthz` 2.0 ms.

## 4. WS · 메모리 · GC

| 단계(MiB · 3번 가운데 [최소–최대]) | AWS 규모 컨테이너 · RSS · 힙 커밋 | 상한 규모 컨테이너 · RSS · 힙 커밋 |
|---|---|---|
| 기동 뒤 쉼(W 마지막 60 s) | 336 [331–388] · 356 · 115 | 485 [430–490] · 506 · 239 |
| REST 100 rps 최대 | 377 [366–420] · 398 · 118 | 526 [472–534] · 547 · 253 |
| WS 200 최대 | 402 [383–427] · 419 · 132 | 561 [523–569] · 582 · 284 |
| 몰림 최대 | — | 564 [531–578] · 583 · 284 |
| 부하 뒤 쉼(I 마지막 60 s) | 398 [383–428] · 419 · 132 | **579 [558–582]** · 600 · 297 |

- WS 200(선박 레이어 켬): AWS 규모 메시지 19,297 · 오류 0 · 항공기 지연 p50 19 · p95 46 · p99 72 ms. 상한 규모 메시지 22,094 · 오류 0 · p50 22 · p95 281 [200–560] · p99 694 · 최대 1,078 [847–2,911] ms.
  선박 지연 p95 150 ms. 상한 3번째 실행 하나가 500 ms 를 넘었다(560). PERF §14.2 가 적었듯 이 지연 표본에는 스냅샷의 `ts`(전세계는 120 s 마다)가 섞여 같은 설정에서도 크게 흔들린다(앞 117–1,123 ms).
  가운데 값으로 통과라 결함으로 올리지 않았다.
- 메모리는 목표 768 MiB 의 75 %(상한 규모 최대 582 MiB)다. 몰림 뒤 평탄 579 MiB는 앞선 측정(679)보다 100 MiB 낮다. 이번 몰림은 실패가 0이고 힙 커밋이 297 MiB에 그쳤다(앞 377).
- 재시작 · OOM 0(6번 모두 `inspect restarts=0 oom_killed=false` · `oom_lines 0`). WARN 은 상한 규모에서만 1–2건 났고 모두 `ShipCoverage memory cap reached (cells 16000 / 16000)`였다.
  선박 1.5만 척 전세계 격자가 설계한 상한에 닿은 것이다(관찰 — AWS 동아시아 구독에서는 나지 않았다).

## 5. 느린 쿼리 · 따라잡기 비용(QA 고침이 바꾼 경로)

**실제 따라잡기 한 번**(`tools/qa/perf_catchup.sh` — '아침 기동' 흉내: 어제 KST 의 일 통계 완료 표식을 지우고 pg_stat_statements 를 비운 뒤 api 를 새로 만들어 150 s 기다림, `catchup-{aws,max}.txt`)

| 문장(호출) | AWS 규모 ms · 읽은 블록 · 임시 | 상한 규모 ms · 읽은 블록 · 임시 |
|---|---|---|
| 교통량 하루 집계(어제 — 아침마다, work_mem 64MB) | 550 · 896 · 0 | 4,685 · 146,564 · 4,281 |
| 지정 보존 복사 항공기 10(창 365일 — QA-1201) | 232 · 1,335 · 1,094 | 4,131 · 108,866 · 2,452 |
| 지정 보존 복사 선박 10 | 95 · 4,830 · 0 | 1,587 · 30,481 · 393 |
| 최근 6 h 다시 요약 × 6(QA-1202) | 525(87/회) · 0 · 1,900 | 1,597(266/회, 최대 526) · 32,235 · 2,743 |
| 옛 시간 확인 EXISTS × 50–52(QA-1200 — 남은 파티션 전체) | 67 | 15 |
| 알림 · SIGMET 하루 집계 · 옛 날 채우기 시작 날 · 표식 · 파티션 목록 | 8 | 426 |
| **합(DB 시간)** · 걸린 시간(로그) | **1,477 ms** | **12,441 ms** · 약 19 s(기동 60 s 뒤 → 10:02:36Z) |

- 임시 블록은 8 KB 단위다. 다시 요약 · 보존 복사는 정렬을 기본 work_mem(4 MB)에서 하므로 디스크로 넘친다. AWS 규모에서도 따라잡기마다 약 23 MB(추정 — 블록 × 8 KB)다.
  VERIFICATION #144 의 RDS '임시 파일 0'은 QA-1202 를 배포하면 따라잡기마다 바뀔 것이다(관찰 — 다시 볼 신호로 적어 둔다).
- **고치기 전과 비교**(같은 자료 · 같은 문장, `explain-max-scale-retained-window.txt` · `explain-*-scale-aws.txt`):
  - QA-1201 지정 보존 창: 고치기 전 70 h 와 고친 뒤 365일을 번갈아 두 번씩 쟀다. 12,610 · 13,386 ms 대 12,723 · 13,179 ms이고 읽은 블록은 둘 다 117 천이었다 — **같다**.
    정상 상태에서는 남은 파티션(이번 56–58 h)이 70 h 안이라 읽는 행이 같다. 긴 정지 뒤에는 남은 파티션만큼 늘어난다(그것이 고침의 목적이다).
  - QA-1202 다시 요약: **늘어난 몫**이다. 따라잡기마다(기동 + 3 h 마다) AWS 규모 +0.5 s, 상한 규모 +1.6–1.7 s가 늘고, 임시 파일 15–22 MB가 생긴다.
    EXPLAIN 으로 잰 요약 부분 전체(창 56–58 h)는 AWS 0.58 s · 상한 1.76 s이고, 이 가운데 확인 50–52번이 0.02–0.05 s다.
  - QA-1200(창 = 가장 오래된 파티션)의 확인은 한 번에 0.3–7 ms, 파티션 목록 읽기는 0.14 ms다. QA-1240(파티션 보장 1분마다)은 호출마다 0.3–1.5 ms다.
  - QA-1203(특보 목록마다): 열린 행 읽기 0.04 · 1.4 ms(부분 색인 `wx_warning_open`) + 빠진 행마다 기본 키 UPDATE 0.6 ms.
    처음 잰 32.9 ms 는 측정 문장의 `min(id)` 하위 질의 몫이라 도구를 고쳐 다시 쟀다.
- **상한 규모의 보존 복사가 무겁다**(개선 제안 — 결함 아님): 따라잡기마다(기동 + 3 h 마다) 이미 옮긴 점까지 다시 읽는다.
  한 문장에 4.1–13.4 s가 걸리고 0.9 GB를 읽는다(블록 108–117 천). 공유 풀 연결 하나를 그동안 쥔다. 고치기 전(70 h)에도 같았다.
  AWS 규모는 OpenSky 를 꺼서 0.3 s 다. 줄이려면 대상마다 마지막으로 옮긴 분부터 읽는 길이 있다(잰 값 없음).
- **특보 이력 · /watch · /alerts/{id}**(EXPLAIN, AWS / 상한): 특보 이력 기본 24 h 0.20 / 0.17 ms · 30일 × 500(상한) 0.49 / 0.62 ms · 구역 하나 30일 0.08 / 1.18 ms ·
  /watch 공항 20 0.09 / 0.48 ms · 알림 한 건 0.17 / 1.02 ms · 그 SIGMET 사본 0.01 ms. 모두 색인을 탄다.
  QA-401 의 알림 이력 새 문장(25일 전 1 h) 0.02 / 1.1 ms · 일반 계획 0.27 ms다(앞선 QA 고친 뒤 0.25–2.24 ms와 같다).
- 그 밖의 공개 조회 EXPLAIN(상한, `explain-max-scale-explain.txt`): `replay.track_point` 넓은 bbox 2,500 sq° · 40 h 전 57 ms, `replay.sigmet` 넓은 bbox · 25일 전 141 ms(캐시가 찬 부하 중 평균은 4.9–5.3 ms),
  `aircraft.track` 24 h 398 ms(차가운 캐시, 5,001점 상한)다. 옛 형태의 알림 이력 문장(6.1 s)은 QA-401 뒤 쓰이지 않는다(비교용).

## 6. 큰 응답(edge 경유 · gzip · 3번 — `perf_large_responses.py 3 --json`)
- 상한 규모(`large-responses-max.txt`): 1 MiB 넘는 원본은 둘이고 앞선 QA 와 같다. `aircraft track 24h` 1,067,358 B(전송 215 KB · 84 ms — 점 상한 5,000) ·
  `ships wide` 1,511,930 B(전송 244 KB · 41 ms). 나머지는 1 MiB 아래이고 JSON 은 모두 gzip 이다.
  `/aircraft` bbox 2,500 sq°: full 633 KB(전송 92 KB · 52 ms) · lite 536 KB(88 KB · 37 ms). `/replay` 같은 bbox: 최근 395 KB(66 KB · 64 ms) · 10일 전(1분 요약) 45 KB(10 KB · 31 ms).
- AWS 규모(`large-responses-aws.txt`): 걸린 것 0. `ships wide` 1,005,153 B(선박 3,375척 — 1 MiB 바로 아래, 전송 165 KB) · `aircraft track 24h` 582 KB ·
  `/aircraft` 넓은 bbox full 56 KB · `/replay` 넓은 bbox 최근 110 KB.

## 7. 화면 — Lighthouse 12.8.2 · 실제 GPU · 배경지도 열림 · AWS 규모 · 3번 가운데 [최소–최대](`cwv-aws-summary.txt` · 보고서 `cwv/aws/gpu-ofm/`)

| 화면 | 프리셋 | 점수 | LCP ms | TBT ms | CLS | FCP ms | 판정 |
|---|---|---|---|---|---|---|---|
| `/` | desktop | 100 | 578 [550–591] | 6 [0–10] | 0.005 | 232 | good |
| `/` | mobile | 85 [84–87] | 2,524 [2,523–2,670] | 458 [412–526] | 0.004 | 779 | LCP · TBT 넘음(받아들인 꼴) |
| `/m` | desktop | 99 | 540 | 0 | 0.073 | 218 | good |
| `/m` | mobile | 95 [93–96] | 2,588 [2,563–2,639] | 115 [96–140] | 0.062 [0.062–0.104] | 773 | LCP 넘음(같은 꼴) |
| `/alerts/[id]` | desktop | 100 | 564 | 0 | 0.000 | 229 | good |
| `/alerts/[id]` | mobile | 97 [96–99] | 2,425 [1,733–2,562] | 82 | 0.000 | 792 | good |
| `/replay` | desktop | 100 [99–100] | 405 [324–479] | 26 [12–60] | 0.004 | 284 | good |
| `/replay` | mobile | 87 [83–87] | 2,528 [2,453–2,573] | 421 [420–541] | 0.002 | 790 | LCP · TBT 넘음(받아들인 꼴) |
| `/stats` | desktop | 100 | 537 [526–540] | 0 | 0.051 [0.033–0.051] | 229 | good |
| `/stats` | mobile | 91 [91–95] | 2,388 [2,381–2,389] | 62 | **0.156 [0.113–0.159]** | 777 | **CLS 넘음 — QA-1500** |
| `/guide` | desktop | 100 | 657 [657–684] | 0 | 0.000 | 328 | good |
| `/guide` | mobile | 95 | **2,910 [2,842–2,955]** | 42 [24–55] | 0.000 | 1,192 [1,077–1,209] | **LCP 넘음 — QA-1501** |
| `/about` | desktop | 100 | 574 | 0 | 0.000 | 269 | good |
| `/about` | mobile | 97 | 2,543 [2,540–2,546] | 62 [62–103] | 0.000 | 935 | LCP 넘음(받아들인 꼴) |
| `/airports/RKSI` | desktop | 100 | 561 | 0 | 0.000 | 227 | good |
| `/airports/RKSI` | mobile | 97 [96–97] | 2,589 [2,438–2,612] | 76 | 0.000 | 776 | LCP 넘음(같은 꼴) |

- benchmarkIndex 2,684–2,852. 배경지도 요청은 실행마다 12–14건이었다(합 48번 중 지도 화면 12번).
- 모바일 LCP 2.4–2.6 s(`/` · `/replay` · `/about` · `/m` · `/airports`): LCP 요소는 서버가 그린 글자(출처 줄 · 안내 줄 · 표 칸 · 빈 상태 문구 · TAF 원문)다. 시뮬레이션 값은 첫 그리기 전에 받은 스크립트를 느린 4G 로 다시 센 값이다.
  PERF §15.2-5 · §15.4 의 '갈림'과 같은 원인이고, 주인이 2026-10-02 에 받아들였다(§15.6 — `/` · `/replay` · `/about` · `/stats`).
  `/m` · `/airports/[icao]` · `/alerts/[id]` 는 그 결정 뒤에 생긴 화면이다. 같은 꼴이라 결함으로 세지 않고 주인 확인 거리로 둔다.
- 지도 화면 모바일 TBT(`/` 458 · `/replay` 421 ms, 배경지도 열림)는 §15.4 의 같은 조건(474 · 442 ms)과 같다 — 받아들인 값.
- 첫 화면 JS(`cd apps/web && npm run build && npm run check:first-js -- --in-image`, 웹 이미지 Node 24.21.0 · zlib 1.3.2.1-motley): **549,840 B**(maplibre 304,573 · entry 12개 215,815 ·
  dynamic 25,944 · public 3,508). 예산 550,000 B 안이고 여유는 160 B다. 흐름은 547,116(§15.7) → 548,679(§20) → 548,678(출시 QA 2차) → 549,840 B다.
  QA 고침이 예산을 넘겨 `0c4f72cb`(perf: bring the first-screen JS back under the ADR-026 budget)가 되돌린 결과다. 다음 변경 하나로 넘을 수 있다(관찰).

## 8. 앞선 측정과 비교(같은 순서 · 상한 규모 — PERF §14.2 의 `p40` 열 = 지금 설정)

| 항목 | §14.2 p40(2026-10-02 · 풀 12/6/4 · 16경로) | 이번 상한 규모(풀 6/3/2 · 35경로) |
|---|---|---|
| REST 100 rps: 컨테이너 · RSS 최대 MiB | 524 [512–527] · 531 [512–537] | 526 [472–534] · 547 [492–554] |
| REST 100 rps: 힙 커밋 최대 · GC 합 s · 횟수 | 250 · 1.15 [0.86–1.49] · 149 | 253 · 0.67 [0.64–0.89] · 110 |
| REST 100 rps: 전체 p95 · 가장 느린 경로 p95 ms | 37.5 · 116.5 [90.5–252.3] | 12.9 · 36.9 [31.8–84.8] |
| 임계값(경로마다 p95 < 300 · 실패 < 1 %) 넘은 실행 | 0/3 | 0/3 |
| WS 200: 컨테이너 · RSS 최대 · 지연 p95 ms(500 넘은 실행) | 551 · 562 · 324 [235–389](0) | 561 · 582 · 281 [200–560](1) |
| 몰림: GC 합 s · 400 rps 실패 % · p95 ms | 2.86 · 0.28 [0–1.41] · 886 | 1.00 · 0.00 · 19.6 |
| 몰림 뒤 쉼: 컨테이너 · RSS · 힙 커밋 MiB | 679 · 664 · 377 | 579 · 600 · 297 |
| 다시 시작 · OOM | 0 | 0 |
| VM 의 다른 CPU(REST 단계 가운데) | 60–71 % | 38–44 % |

- **나빠진 것 없음.** 메모리 꼴(부하 중 약 530–580 MiB, 힙 밖 RSS 약 290 MiB)은 같다. 몰림 뒤 평탄은 오히려 낮다.
  지연이 크게 낮은 것은 VM 경합이 줄고(운영 스택 · 스택 B 정지) 경로 섞음이 가벼운 경로 쪽으로 넓어진 몫이 섞여 있다. 코드 효과로 읽지 않는다.
- 공개 조회 허가가 6 → 3으로 줄었는데도 몰림 400 rps 에서 격벽 거절이 0이다. 공개 조회 문장이 평균 2–7 ms 라 허가 3개가 모자라지 않았다.
- 출시 QA 2차(2026-10-10, 21경로 · 100 rps) 전체 p95 30.5–83.1 ms · 가장 느린 `replay_72h` 83–271 ms. 이번 상한 12.4–21.3 · 32–85 ms다. 조건(다른 스택 · 첫 실행 데움)이 달라 견주기만 한다.
- 화면(§15.4 와 같은 실제 GPU): `/` · `/replay` 의 데스크톱 · 모바일은 같은 범위다. `/stats` 는 CLS 가 0.004/0.050 → 0.051/0.156으로 나빠졌다(QA-1500).
  `/about` · `/stats` 모바일 LCP 는 §15.4 에서 '갈림'의 낮은 쪽(2,100 · 1,143)이 가운데였다. 이번에는 높은 쪽(2,543 · 2,388)이 가운데다 — 같은 성질이라 변경의 효과로 읽지 않는다.

## 9. 결함 후보

| 번호 | 심각도 | 한 줄 | 재현 |
|---|---|---|---|
| QA-1500 | 보통 | 실제 규모 자료에서 `/stats` 모바일 CLS 0.156 [0.113–0.159]가 목표 0.1 을 넘는다. AWS 규모 3/3, 상한 규모 3/3(0.159). 앞선 측정 0.050은 fixture 자료뿐이었다 | 아래 |
| QA-1501 | 보통(기준표 '성능 목표 초과' — 주인 판단 필요) | 새 화면 `/guide` 모바일 LCP 2,910 [2,842–2,955] ms가 3/3 목표 2,500 을 넘는다. FCP 도 1.08–1.21 s로 다른 화면(0.77–0.94 s)보다 늦다 | 아래 |

### QA-1500 · 보통 · 화면 성능(CLS)
- **환경**: 스택 A1(§1) · `seed_perf_aws.sql`(최근 7일 SIGMET 약 5,600건 · FIR 40곳) · Lighthouse 12.8.2 모바일 프리셋 · 실제 GPU.
- **재현 절차**:
  ```bash
  WLQA_ENV=<시험 env> tools/qa/wlqa.sh A1 up -d --no-build --wait
  docker exec -i wlqa-a-db-1 psql -X -U postgres -d wakeline -v ON_ERROR_STOP=1 < tools/qa/seed_perf_aws.sql
  PERF_CWV_OUT=<폴더> tools/qa/perf_cwv.sh stats gpu ofm 3 /stats && python3 tools/qa/perf_cwv_summary.py <폴더>/stats/gpu-ofm
  ```
- **기대**: CLS ≤ 0.1(가운데).
- **실제**: 모바일 0.113 · 0.159 · 0.156(AWS 규모), 0.159 × 3(상한 규모 — `cwv-max-stats-summary.txt`). 데스크톱은 0.033–0.072로 목표 안이다.
  Lighthouse `layout-shifts` 가 고른 요소는 `main#main > div.h-full > div.grid > section.panel` 이다.
  밀린 패널은 'SIGMET BY HAZARD (7D)'(0.156–0.159)와 'DISTINCT AIRCRAFT BY HOUR (KST)'(0.093 + 0.019)다.
- **의심 원인(확인하지 않음 — 고치지 않았다)**: `apps/web/app/stats/page.tsx` 의 받는 중 자리(`PanelLoading`)는 글자 한 줄과 막대 · 자리 표시 세 줄뿐이다.
  받은 뒤의 FIR 막대(`BarChart` 상위 24줄)는 그보다 훨씬 높다. 모바일 한 단 배치에서 위 패널이 커지면 아래 패널을 민다.
  fixture 자료만 있으면 FIR 이 적어 덜 민다(§15.4 의 0.050). 실제 AWS 는 AWC 전세계 SIGMET 이라 FIR 상위 24줄이 찬다(추정).
- **증거**: `cwv/aws/gpu-ofm/stats-mobile-{1,2,3}.json.gz` · `cwv/max-stats/gpu-ofm/` · `cwv-aws-summary.txt`.

### QA-1501 · 보통(주인 판단) · 화면 성능(LCP)
- **환경 · 재현**: QA-1500 과 같다. 화면만 `/guide` 다(`perf_cwv.sh guide gpu ofm 3 /guide`).
- **기대**: LCP ≤ 2,500 ms(가운데).
- **실제**: 2,910 · 2,842 · 2,955 ms. LCP 요소는 `article.g-doc > section#overview > p.g-p`(서버가 그린 첫 문단)이고 단계는 TTFB 463 · Render Delay 2,446 ms다.
  문서 전송 68.9 KB(원본 329 KB — 다른 화면 5–17 KB) · 이미지 297 KB · DOM 1,709개다. 주 스레드 Style & Layout 이 338 ms(다른 화면 110–148)이고 FCP 는 1,077–1,209 ms다.
- **판단 근거**: 다른 화면의 모바일 LCP 2.4–2.6 s는 받아들인 '갈림'(§7)이다. `/guide` 는 3번 모두 2.84 s 넘게 고르게 높고, 첫 그리기부터 늦다.
  긴 문서 하나를 한 번에 그리는 몫으로 보인다(추정). 데스크톱은 657 ms 로 good 이다.
  안내 화면이라 핵심 작업을 막지 않으므로 주인이 §15.6 처럼 받아들일 수 있다 — 그때는 결함에서 뺀다.
- **증거**: `cwv/aws/gpu-ofm/guide-mobile-{1,2,3}.json.gz`.

### 고친 뒤(고치기 단계 · 2026-10-14 KST 19:30–20:40 · 같은 조건 — A1 · AWS 규모 시드 · Lighthouse 12.8.2 · 실제 GPU · 배경지도 열림)
증거: `evidence/performance/after-fix/`(보고서 `cwv/{qa-1500,qa-1501,ref-same-session,final}/gpu-ofm/` · 요약 `cwv-*-summary.txt` · QA 시험 출력 · 표준 e2e) · 재현 `repro-qa-1500/` · `repro-qa-1501/`.

| 결함 | 원인(확인) | 고침 | 전 → 뒤(가운데 [최소–최대]) |
|---|---|---|---|
| QA-1500 `2800351c` | 패널마다 받는 중(87 px) · 빈(55–72) · 오류(107–160) 자리가 그림 높이(FIR 24줄 412 px 에서 121 · 위험 유형 238)와 달라, 응답이 오면 아래 패널이 밀렸다. 재현 시험 CLS 0.162 | 본문 칸에 받은 뒤 모양의 보이지 않는 자리(ghost — FIR 은 24칸 고정 `minSlots` 로 너비 비율 상자, 위험 유형 238 px, 교통량은 같은 글 · 24칸 그림 상자) + 바닥 9.75rem(휴대폰 오류 안내). 알림 표(마지막)는 그대로 | 모바일 CLS 0.156 [0.113–0.159] → **0.000** [0.000–0.000](3회 · 최종 3회 · 앞선 빌드 6회도 0) · 점수 91 → 97–98 · 데스크톱 CLS 0.051 → 0.000. LCP 2,388 → 2,388 [1,938–2,454] · 최종 2,439(같은 요소 — 하단 출처 줄, 두 갈래 §7) |
| QA-1501 `6e5b6242`(일부) | 첫 화면 밖 그림 2장(297 KB — 412×823 에서 위 1,653 · 2,677 px)이 lazy 거리 안이라 관측 첫 그리기(232 ms) 전 176 ms 에 요청되어 LCP 비관 그래프에 들어갔다. 재현 시험 실패(요청 2건) | 그림 src 를 비워 두고(data-guide-src) 스크롤 영역 보이는 곳의 절반 높이 안으로 오면 넣는다(GuideImageLoader · `lib/guide-image-loading`). 스크립트 없으면 noscript 같은 그림 | 모바일 LCP 2,910 [2,842–2,955] → 2,657 [2,541–2,793](6회) · 최종 2,677 [2,664–2,684]. LCP 전에 받은 바이트 559 → 263 KB. 데스크톱 657 → 628–641. 같은 때 `/about` 모바일 2,515 [1,985–2,519] |

- **QA-1501 남은 것(주인 결정)**: 고친 뒤에도 6/6 · 3/3 이 2.5 s 위다. 남은 몫은 문서 크기다 — 69.5 KB gzip(원본 337 KB, `/about` 17 KB). 설명서 내용이 HTML 과 RSC 페이로드로 두 번 실린다(HTML 141 KB · RSC 174 KB 원본).
  Lantern 은 파서가 시작한 요청을 문서 요청 뒤에 매달고(PageDependencyGraph) 앞 노드가 끝나야 시작하므로(Simulator — lighthouse 12.8.2 의 trace_engine 소스로 확인)
  문서 크기가 스크립트 190 KB 앞에 그대로 더해진다. 클래스 줄이기(gzip −0.6 KB) · noscript 빼기(−0.2 KB)는 효과가 없고,
  절을 content-visibility: auto 로 그리기를 미루는 것도 재 보았지만 LCP 가 그대로였다(2,670–2,761 — 버림, 스타일 · 레이아웃만 줄었다).
  내용을 줄이지 않고 더 줄이려면 첫 절 뒤를 클라이언트에서 그리거나 설명서를 나누는 구조 변경이 필요하다(스크립트 없을 때 · 깊은 링크 동작이 바뀜) — 고치지 않고 묻는다.
- 검증: eslint · tsc 깨끗 · vitest 166 파일 1,860 통과(3 건너뜀) · `npm run build` · 첫 화면 JS **549,840 B**(그대로 — `/` 모듈 늘지 않음) ·
  표준 e2e(A1) 50 통과 · QA 시험 qa-1500(4) · qa-1501 · qa-1461(설명서 · 통계) 7 통과 · 공개 데모 스윕(axe) 4 통과 — `/stats` · `/guide` axe 0.

**결함으로 올리지 않은 것(관찰 · 개선 제안)**
- WS 200 상한 규모 3번째 실행의 p95 560 ms — 가운데 281 ms 로 통과했다. 지연 표본에 스냅샷 `ts` 가 섞이는 측정 성질이 있다(PERF §14.2).
- 따라잡기의 지정 보존 복사가 상한 규모에서 4–13 s · 0.9 GB 다(§5). 고치기 전과 같고, 목표가 없는 배치다 — 개선 제안.
- QA-1202 로 따라잡기마다 임시 파일 15–22 MB 가 생긴다(RDS 에서 '임시 파일 0'이 바뀜) — 관찰.
- 첫 화면 JS 여유 160 B — 관찰.
- 상한 규모의 `ShipCoverage memory cap reached` WARN — 설계한 상한이다.
- 모바일 LCP 2.4–2.6 s(`/m` · `/airports/[icao]` 포함)와 지도 화면 모바일 TBT — 받아들인 꼴과 같다(§7).

## 10. 못 잰 것 · 한계
- **AWS 실물**: RDS db.t4g.micro(버스트 CPU · gp 스토리지 IOPS · 망 너머 TLS verify-full · shared_buffers 179 MB · 세 프로젝트 공유 연결)와
  EC2 m7i-flex.large 2 vCPU 위의 값은 재지 못했다. 이번 값은 같은 VM 의 컨테이너 DB(1 GiB) · 4 CPU 다.
  AWS 에서는 DB 문장이 더 느리고, 따라잡기의 읽기량(AWS 규모 수천 블록)이 IOPS 에 걸릴 수 있다(추정). 그래서 503 0 %는 로컬 값이다.
- **앞단 포함(R — Caddy · gate · CloudFront)** 지연 · gate CPU · 메모리는 이 과제에서 재지 않았다(계획 §3.5 둘째 줄 — 리허설 스택 몫).
- **AWS 규모의 실측 근거**: 선박 3,000척 · 알림 하루 500건 · 특보 5,000행 · 평일 운영 9 h 는 가정이다(AWS 공개 주소는 잠금이고, 승인 범위 밖이라 `/status` 를 읽지 않았다).
  DB 는 451 MB 로 AWS 실측 219 MB 의 약 2배다.
- **fixture 모드의 경로**: `radar_kr_png` 는 404 경로, `traffic_grid` 는 available:false 경로, `client_errors` 는 대부분 429 경로만 쟀다(실제 PNG · 격자 · 기록 경로는 아님).
- **소프트웨어 GL** Lighthouse 는 재지 않았다(실제 GPU 만 — 섞지 않음). GPU 가 없는 환경의 값은 PERF §15.4(소프트웨어 GL)를 본다.
- 몰림은 앞선 측정과 같게 2분이다(3분 × 3 이 아님). 긴 정지 뒤(파티션이 4–5일 남은) 따라잡기 비용은 정상 상태만 쟀다.
- `perf/results/ws-summary.json`(git 무시 — 앞선 실행의 산출물)은 k6 WS 실행이 덮어썼다. 이번 사본은 증거 폴더의 `k6-*-S.json` 이다.

## 11. 재현 · 도구
```bash
E=<시험 env — tools/qa/make_qa_env.py>; EV=docs/qa/2026-10-aws/evidence/performance
WLQA_ENV=$E tools/qa/wlqa.sh A1 build api collector web && WLQA_ENV=$E tools/qa/wlqa.sh A1 up -d --no-build --wait
docker exec wlqa-a-db-1 psql -X -U postgres -d wakeline -c "ALTER SYSTEM SET shared_preload_libraries = 'pg_stat_statements'" -c "ALTER SYSTEM SET log_min_duration_statement = '100ms'"
docker restart wlqa-a-db-1 && docker exec wlqa-a-db-1 psql -X -U postgres -d wakeline -c "CREATE EXTENSION pg_stat_statements"
# AWS 규모
docker exec -i wlqa-a-db-1 psql -X -U postgres -d wakeline -v ON_ERROR_STOP=1 < tools/qa/seed_perf_aws.sql
PERF_PROJECT=wlqa-a PERF_GLOBAL_N=0 PERF_SHIPS_N=3000 PERF_SHIP_BATCH=30 python3 tools/qa/perf_feed.py 14400 &
for n in 1 2 3; do WLQA_ENV=$E PERF_PROJECT=wlqa-a PERF_EV=$EV PHASES="R20 R100 S I" WARM_SHIPS=3000 SHIP_N=3000 IDLE_S=120 tools/qa/perf_aws_run.sh aws $n; done
# 상한 규모(새 볼륨) — alerts_end = 스택을 띄운 시각
docker exec -i wlqa-a-db-1 psql -X -U postgres -d wakeline -v ON_ERROR_STOP=1 -v alerts_end='2026-10-14 08:44:00+00' < tools/qa/seed_perf.sql
docker exec -i wlqa-a-db-1 psql -X -U postgres -d wakeline -v ON_ERROR_STOP=1 < tools/qa/seed_perf_r2.sql   # + retain_targets 20개(seed-max-run.log)
PERF_PROJECT=wlqa-a python3 tools/qa/perf_feed.py 14400 &
for n in 1 2 3; do WLQA_ENV=$E PERF_PROJECT=wlqa-a PERF_EV=$EV PHASES="R100 S B I" WARM_GLOBAL=9900 WARM_SHIPS=14900 SHIP_N=12000 IDLE_S=300 tools/qa/perf_aws_run.sh max $n; done
PERF_EV=$EV python3 tools/qa/perf_aws_summary.py --routes --runs aws max
# 따라잡기 · EXPLAIN · 느린 문장 · 큰 응답 · 화면
WLQA_ENV=$E PERF_PROJECT=wlqa-a tools/qa/perf_catchup.sh $EV/catchup-max.txt default
docker exec -i wlqa-a-db-1 psql -X -U postgres -d wakeline < tools/qa/perf_explain_aws.sql      # + perf_explain.sql · perf_explain_qa401.sql · perf_explain_r2.sql · perf_explain_retained_window.sql
PERF_PROJECT=wlqa-a python3 tools/qa/perf_slowlog.py <since> <until> --raw $EV/slowlog-max-raw.log
python3 tools/qa/perf_large_responses.py 3 --json $EV/large-responses-max.json
PERF_CWV_OUT=$EV/cwv tools/qa/perf_cwv.sh aws gpu ofm 3 / /m /alerts/<id> /replay /stats /guide /about /airports/RKSI
(cd apps/web && npm run build && npm run check:first-js -- --in-image)
WLQA_ENV=$E tools/qa/wlqa.sh A down -v --remove-orphans
```

| 도구 | 바꾼 것(기본값은 옛 동작) |
|---|---|
| `perf/qa/rest-routes.js` | 공개 32경로 전부 — 13경로 추가(앞 이름 · 무게 그대로), 경로마다 정상 상태(404 · 429), 503 비율 지표 `status_503`(경로 · 단계), `SHIP_N` |
| `tools/qa/perf_aws_run.sh`(새) | 한 번의 측정 — 새 JVM · 단계 목록 `PHASES` · 데움 기준 · 단계마다 격벽 거절 · pg_stat_statements |
| `tools/qa/perf_aws_summary.py`(새) | 단계 · 경로별 · WS · 메모리 · 몰림 단계 표(가운데 [최소–최대]) |
| `tools/qa/perf_catchup.sh`(새) | 기동 뒤 첫 따라잡기의 문장별 DB 시간('아침 기동' 흉내) |
| `tools/qa/perf_explain_aws.sql` · `perf_explain_retained_window.sql`(새) | 따라잡기(QA-1200 · 1201 · 1202) · 특보 끝내기(QA-1203) · 특보 이력 · /watch · /alerts/{id} · 보존 창 70 h 대 365일 |
| `tools/qa/seed_perf_aws.sql`(새) | AWS 규모 합성 자료(§1) |
| `tools/qa/seed_perf.sql` | `-v alerts_end=` (기본 앞선 값 2026-10-01 17:00) · 알림의 SIGMET 번호를 마지막 SIGMET 로 묶음(`least(199999, …)` — 알림 끝이 지금에 가까우면 FK 오류) |
| `tools/qa/perf_api_up.sh` | `WLQA_ENV` 면 `wlqa.sh`(스택 A1 · `:qa`)로, `PERF_FORCE_RECREATE=1` 이면 새 컨테이너, 풀 설정도 출력 |
| `perf_k6.sh` · `perf_sample.py` · `perf_feed.py` · `perf_slowlog.py` · `perf_cwv.sh` | `PERF_PROJECT` · `PERF_API` · `PERF_GLOBAL_N` · `PERF_SHIPS_N` · `PERF_SHIP_BATCH` · `PERF_FEED_STOP` · `PERF_CWV_OUT` · `PERF_BASE`. `perf_sample.py` 끝에 열 `pub_rejected`(격벽 거절 누계) |

- 정리: 스택 A 를 `down -v --remove-orphans` 로 내렸다(시드 볼륨 · DB 설정 함께 삭제). `wlqa-*` 컨테이너 · 볼륨 · 망은 0이다. `perf/results` 에 이번에 남긴 k6 사본을 지웠다.
  `:qa` 이미지는 그대로 두었다(QA 의 다른 단계가 쓴다).
