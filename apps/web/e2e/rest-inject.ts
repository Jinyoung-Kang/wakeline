/**
 * E2E 가 격리된 fixture 스택의 REST 응답에 덧붙이거나 대신 주는 값(외부 호출 없음 — 계약 모양 그대로). tests/e2e-inject.test.ts 가 웹 해석기
 * (lib/kr-radar krMissing · lib/ops pipelineRows · providerMissing)로 이 값이 뜻대로 읽히는지 스택 없이 먼저 본다.
 * - krMissingStreak: /api/v1/radar/kr 의 missing(계약 v5 §G22) — fixture 수집기는 기상청을 부르지 않아 '파일 없음' 연속이 생기지 않는다.
 * - OPS_*: 운영 화면 응답 — fixture 스택에는 운영 계정이 없어(make ops-user 는 사람이 비밀번호를 넣는다) 운영 API 를 이 값으로 대신한다. 화면(빌드된 앱)이
 *   그 값을 그리는지만 본다 — api 의 응답 모양은 api 시험(OpsPipelineIT · StatsIT)과 계약 검사가 본다.
 */

/** ms(UTC) → 기상청 tm(KST 벽시계 "YYYYMMDDHHMM", 5분 단위로 내림) */
export function kstTm(ms: number): string {
  const d = new Date(ms + 9 * 3_600_000);
  d.setUTCMinutes(d.getUTCMinutes() - (d.getUTCMinutes() % 5), 0, 0);
  return d.toISOString().slice(0, 16).replace(/[-T:]/g, "");
}

/** 지금(nowMs) 1분 전에 마지막으로 확인한 '파일 없음' 연속: 55분 전 tm 부터 지금 tm 까지 · 확인한 tm 12개 · 파일 이름 · 목록 종류 EXT */
export function krMissingStreak(nowMs: number) {
  const last = kstTm(nowMs);
  return {
    since_tm: kstTm(nowMs - 55 * 60_000), last_tm: last, tms: 12, checked_at: new Date(nowMs - 60_000).toISOString(),
    file: `RDR_CMP_HSR_PUB_${last}.bin.gz`, listed: ["EXT"],
  };
}

/** /api/v1/ops/pipeline — ais 수신 진단의 고른 값은 운영 기본값과 일부러 다르게(웹이 숫자를 들고 있지 않고 응답에서 읽는지 화면에서 보인다) */
export function opsPipeline(nowMs: number) {
  const at = new Date(nowMs).toISOString();
  return {
    collector: { publish_dropped: 0, db_dropped: 0, db_pending: 0, stream_budget_trims: 0, stream_retention_s: 9000, stream_budget_bytes: 67108864, heartbeat_age_s: 3.2, log_sent: 4, log_dropped: 0 },
    ais: {
      dropped_total: 0, quarantined_total: 2, stream_budget_trims: 0, stream_retention_s: 9000, stream_budget_bytes: 67108864, log_sent: 1, log_dropped: 0,
      reconnects_quick_total: 3, loop_lag_max_s: 0.04, loop_stalls_total: 0, queue_wait_max_s: 0.12, ws_queue_max: 70, ws_queue_limit: 64,
      ping_rtt_max_s: 0.31, ping_timeout_s: 25, diag_window_s: 90, queue_depth_max: 12, queue_limit: 20000, reconnect_quick_window_s: 45,
      reconnect_warn_count: 4, reconnect_warn_window_s: 3600, loop_tick_s: 0.5, loop_stall_s: 1, loop_warn_s: 5, loop_warn_every_s: 60,
    },
    api: {
      track_queue_dropped: 0, ship_queue_dropped: 0, receipts_force_released: 0, dlq: 0, stream_trim_loss_events: 0, last_stream_trim_loss: null, track_rows_failed: 0,
      ship_rows_failed: 0, stream_apply_errors: 0, listener_errors: 0, log_sent: 2, log_dropped: 0, log_suppressed: 0, stream_window_s: { aircraft: 9000, ships: 9000 },
    },
    generated_at: at,
  };
}

/** /api/v1/ops/providers — kma_radar 공급자 해시에 '파일 없음' 연속(수집기 글자 그대로). checked_at 이 서버 시각(generated_at)보다 20분 앞선다 → 확인 멈춤 */
export function opsProviders(nowMs: number) {
  const s = krMissingStreak(nowMs - 19 * 60_000);
  return {
    providers: [{
      name: "kma_radar", last_success_at: new Date(nowMs - 70 * 60_000).toISOString(), last_latency_ms: "310", last_records: "1", consecutive_failures: "0",
      budget_used: "412", budget_limit: "1000", missing_since_tm: s.since_tm, missing_last_tm: s.last_tm, missing_tms: String(s.tms),
      missing_checked_at: s.checked_at, missing_file: s.file, missing_listed: "EXT", last_error_resolution: null, last_error_resolved: false,
    }],
    active: {}, collector: {}, switches: [], budget_days: [], budget_day_zone: "UTC", provider_switch: [], resolution_state: "ok",
    generated_at: new Date(nowMs).toISOString(),
  };
}

/**
 * /api/v1/ships/coverage(계약 v5 §G27) — 관측 수신 범위의 결정적 응답: api 가 방금(5분 전) 시작해 기동 전 기록을 읽는 중(0/25시간)이라 창의 일부(셈 시작부터)만
 * 셌다. 칸 셋: 인천 앞바다 · 부산 앞바다(상황판 첫 화면 안) · 대서양(화면 밖). 시각은 UTC ISO(api 형식 — 화면은 KST).
 */
export function shipCoverageBody(nowMs: number) {
  const iso = (ms: number) => new Date(ms).toISOString();
  const hour = 3_600_000;
  const started = nowMs - 5 * 60_000;
  const liveFrom = Math.floor(started / 60_000) * 60_000;
  const last = Math.floor((nowMs - 30_000) / 1000) * 1000;
  return {
    cell_deg: 0.5,
    window: { hours: 24, bucket_s: 3600, from: iso(Math.floor(nowMs / hour) * hour - 24 * hour), to: iso(nowMs) },
    since: iso(liveFrom), covered: "since_api_start", api_started_at: iso(started), live_from: iso(liveFrom),
    bootstrap: { state: "running", hours_loaded: 0, hours_total: 25, rows: 0, loaded_from: iso(liveFrom), missing: [], retry_backoff_s: [60, 120, 300, 600] },
    generated_at: iso(nowMs),
    cells: [
      [-30.0, 40.0, 0.5, 2, 3, iso(last - 60_000)],
      [129.0, 35.0, 0.5, 14, 55, iso(last - 120_000)],
      [126.0, 37.0, 0.5, 121, 900, iso(last)],
    ],
    cell_count: 3, positions: 958, truncated: false, dropped_positions: 0, limits: { max_cells: 16000, max_ship_cells: 200000 },
    sampling: "first_fix_per_60s", note: "관측 수신 — 이 서비스가 받은 AIS 위치의 칸별 집계(구독 범위 아님 · 수신국이 없는 해역은 비어 있다)",
    time_zone: "all times are UTC ISO-8601; window.from is the start of the current UTC hour minus 24 h",
    meta: { provider: "aisstream", fetched_at: iso(last), lag_s: 30, stale: false, generated_at: iso(nowMs), request_id: "e2e-coverage-0001" },
  };
}

/**
 * /api/v1/ships/coverage — 기동 때 한 시를 문장 상한에 걸려 못 읽고 다시 읽기를 기다리는 응답(계약 v5 §G27 개정 — 2026-09-30 22:49 KST 배포 직후의 경우):
 * api 가 10분 전에 시작해 24/25시간을 읽었고, 셈 시작 시의 3시간 전 시([시작 − 3 h, 시작 − 2 h))가 빠졌다 — 40초 뒤 다시 읽는다(1/4번째). since = 빈 시의 끝(partial).
 */
export function shipCoverageRetryBody(nowMs: number) {
  const iso = (ms: number) => new Date(ms).toISOString();
  const hour = 3_600_000;
  const base = shipCoverageBody(nowMs);
  const started = nowMs - 10 * 60_000;
  const liveFrom = Math.floor(started / 60_000) * 60_000;
  const h0 = Math.floor(liveFrom / hour) * hour;
  return {
    ...base,
    since: iso(h0 - 2 * hour), covered: "partial", api_started_at: iso(started), live_from: iso(liveFrom),
    bootstrap: {
      state: "running", hours_loaded: 24, hours_total: 25, rows: 4210, loaded_from: iso(h0 - 2 * hour),
      missing: [{ from: iso(h0 - 3 * hour), to: iso(h0 - 2 * hour), state: "retry", attempts: 1, error: "statement_timeout" }],
      retry_backoff_s: [60, 120, 300, 600], next_retry_at: iso(nowMs + 40_000), next_retry: 1,
    },
  };
}
