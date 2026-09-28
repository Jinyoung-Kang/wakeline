# ADR-019 공급자 스위치의 원본은 DB · 수집 실행 기록은 멱등

**상태** 채택 · 2026-09-29 · 계약 v5 §D · 리뷰 R-94 · R-91

## R-94 공급자 스위치
- 원본: `provider_switch` 표(V11 — api 는 SELECT · INSERT · UPDATE 만, collector 는 권한 없음). 운영자 토글은 감사 행과 한 트랜잭션(`ProviderSwitchService.set`),
  커밋 뒤 Redis `wakeline:provider:{name}.disabled` 로 미러. 값의 뜻은 collector 와 같다 — `"1"` 이면 꺼짐, 그 밖(필드 없음 포함)은 켜짐.
- 응답: `POST /api/v1/ops/providers/{name}/{action}` → 200 `{provider, disabled, version, updated_at, mirrored}`(이전 204).
  Redis 장애는 더 이상 변경을 막지 않는다(이전 503) — 원본과 감사는 커밋되고 `mirrored:false`, 주기 미러가 맞춘다.
- 60 s 마다(StartupMirror, 설정 미러와 같은 주기) DB → Redis 다시 미러. collector 는 그 해시에 쓸 수 있으므로(상태 필드) 스위치 값을 바꿔도 1분 안에 되돌아온다.
  미러는 값이 다를 때만 쓰고, 켜진 스위치는 필드가 없으면 쓰지 않는다(없음 = 켜짐 — 호출한 적 없는 공급자의 해시를 만들지 않아 운영 목록이 그대로다).
  되돌린 공급자는 경고 로그로 남는다(collector 가 바꿨거나 Redis 를 잃었다).
- 이관: 표에 행이 없는 공급자는 지금 Redis 값을 한 번 옮겨 담는다(기동 시, 실패하면 60 s 마다 다시). 모든 공급자에 행을 만들므로 한 번뿐이다 —
  이관 뒤 collector 가 쓴 값은 원본이 되지 않는다. Redis 를 읽지 못하면 행을 만들지 않는다. 이관마다 시스템 감사 행 `PROVIDER_SWITCH_IMPORT`
  (before `{redis_disabled: 원문 ≤ 32자 | null}`). 이관 전에 운영자가 토글하면 그 행이 원본이고 이관은 건너뛴다.
- 되돌리기: V11 머리 주석의 SQL(`DROP TABLE provider_switch; DELETE FROM flyway_schema_history WHERE version='11'`) + 코드 되돌리기 — Redis 값은 그대로 남아 이전처럼 동작.
  V12 가 적용돼 있으면 V12 부터 되돌린다.

## R-91 실행 기록
- `ingest_run.run_key uuid UNIQUE`(V12, 옛 행은 NULL — 새 열은 표 권한을 따르므로 추가 GRANT 없음). collector 가 실행마다 uuid4 를 만들고(재시도는 같은 키)
  `INSERT … ON CONFLICT (run_key) DO NOTHING RETURNING id`.
- 커밋은 됐지만 응답이 시간 초과로 끊겨 다시 보내도 행은 하나다. quality_event 는 같은 트랜잭션에서 돌려받은 run id 에 붙는다.
  행이 돌아오지 않으면 앞선 시도가 품질 사례·규칙별 건수와 함께 이미 커밋된 것이므로 아무것도 다시 넣지 않고(건수 두 배 방지),
  기존 run id 를 run_key 로 되찾아 로그에 남긴다.
- 되돌리기: V12 머리 주석(`ALTER TABLE ingest_run DROP COLUMN run_key; DELETE FROM flyway_schema_history WHERE version='12'`) + collector 코드 되돌리기.
