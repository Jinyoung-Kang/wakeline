/**
 * 상단 상태 바의 표시 모델(순수 함수 — components/StatusBar 가 그린다). 사용자 요청 2026-09-30: "[WS open] 줄에 정보가 너무 많아 한 화면에서
 * 잘리고 옆으로 끌어야 보인다" — 1,427 px 창에서 줄의 내용이 2,063 px 였다.
 * - 줄: 연결 · 경고(FIXTURE · 열린 AIS 공백) · 피드마다 칩 하나 = 이름 + 상태(색과 모양 ■ ▲ ✕ □ · 정상이 아니면 낱말) + 핵심 수 하나(지연 또는 경과).
 *   정상이 아닌 칩(주의 · 경고)은 줄에서 빼지 않는다(pinned). 폭이 모자라면 정상 · 모름 칩만 뒤에서부터 '상세 +N' 으로 옮긴다(fitChips) — 잘리지 않는다.
 * - 상세 표(detailRows): 출처 · 수집 시각 · 속도 · 기상청 프레임 · 합성 지점 · 엔진 · 판 · AIS 공백 기록 · 기준 — 줄에서 뺀 것도 모두 여기에 있다.
 * - 기상청 내려받기 '파일 없음' 연속(운영 로그 2026-09-30 — api radar/kr missing): KMA 칩에 "파일 없음"(주의 — 까닭 문장은 title) · 상세에 행 하나.
 *   마지막 확인이 15분(수집기 선택값)을 넘으면 "파일 없음 · 확인 멈춤" — 지금도 그런지 모른다.
 *   보관 프레임이 모두 만료돼 '사용 불가'여도 연속을 알면 KMA 칩을 남긴다(나이 STALE 만으로는 까닭을 모른다).
 * - 기준은 모두 이미 있는 값: 지역 60 s · 전세계 300 s(ws-protocol · api StatusService), AIS 120 s(ships), 기상청 900 s(format — api meta),
 *   SIGMET 900 s · 레이더 600 s(api StatusService 의 status.*.stale — SIGMET_STALE_S · RADAR_STALE_S 는 그 값을 옮겨 적은 것, 시험이 서버 코드와 견준다).
 *   새로 지은 수는 없다(칩 순서 · 폭 계산은 표시 규칙).
 * - 시각은 KST 만(사용자 결정 2026-09-30 — 계약 v5 §G20). 날짜가 오늘(KST)과 다르면 날짜도 붙인다. 글자는 lib/time 의 공유 형식기(fmtKst · fmtKstRange ·
 *   fmtTimeTitle)가 만든다 — 여기서 시각 글자를 직접 짓지 않는다.
 * - AIS 공백 모델(aisGapInfo)도 여기에 있다(ships.ts 의 옛 상태 바 배지 aisGapBadge 를 대신한다 — 합친 뒤 지웠다).
 */
import { isKrRadarStale, KR_RADAR_STALE_S, fmtAgeS, ageS, fmtDuration } from "./format";
import { KR_MISSING_CHECK_STALE_MIN, KR_MISSING_RECHECK_MIN, krComposite, krMissing } from "./kr-radar";
import { aisBadge, AIS_GAP_SHOW_MS, AIS_LAG_WARN_S, fmtShardScope, openGapShards, shardConnText, type AisStatus } from "./ships";
import type { ConnState, ServerData } from "./store";
import { fmtKst, fmtKstRange, fmtTimeTitle, kstWallMs, timeParts, type TimeIn } from "./time";
import type { FeedInfo, KrRadar, PublicStatus, RadarFrames } from "./types";
import { connTone, feedLag, GLOBAL_STALE_S, isRxFresh, lagTone, REGION_STALE_S, RX_DEAD_MS, RX_FRESH_MS } from "./ws-protocol";

/** SIGMET 목록이 이보다 오래되면 오래됨 — api StatusService(status.sigmet.stale: lag > 900 s)와 같은 값(옮겨 적음) */
export const SIGMET_STALE_S = 900;
/** RainViewer 레이더 목록이 이보다 오래되면 오래됨 — api StatusService(status.radar.stale: lag > 600 s)와 같은 값(옮겨 적음) */
export const RADAR_STALE_S = 600;

export type Health = "ok" | "warn" | "bad" | "unknown";
/** 상태 모양(색만으로 말하지 않는다 — WCAG 1.4.1): 정상 ■ · 주의 ▲ · 경고 ✕ · 모름 □ */
export const HEALTH_MARK: Record<Health, string> = { ok: "■", warn: "▲", bad: "✕", unknown: "□" };
/** 화면 읽기 프로그램용 상태 낱말(보이는 낱말이 없는 정상 · 모름에도) */
export const HEALTH_WORD: Record<Health, string> = { ok: "정상", warn: "주의", bad: "경고", unknown: "모름" };

export type ChipKey = "aircraft" | "region" | "world" | "ais" | "ais-gap" | "sigmet" | "radar" | "kma";
/** 상태 낱말 하나(정상이 아닐 때) — 기상청처럼 낱말마다 따로 설명(title · 시험 id)이 있을 수 있다 */
export interface ChipWord { text: string; testId?: string; title?: string }
export interface Chip {
  key: ChipKey;
  /** 이름(대문자 라벨) */
  label: string;
  /** 핵심 수 하나(지연 · 경과 · 수) — 모르면 "—" 또는 NO DATA */
  value: string;
  /** 정상이 아닐 때의 낱말(STALE · 끊김 · 일부 합성 …) — 정상이면 빈 목록 */
  words: ChipWord[];
  health: Health;
  /** 상태 판정이 없는 수(항공기 수) — 모양 · 상태 낱말을 붙이지 않는다 */
  plain?: boolean;
  title: string;
  /** 줄에서 빼지 않는다(주의 · 경고) */
  pinned: boolean;
  testId: string;
}
const word = (text: string | null | undefined): ChipWord[] => (text ? [{ text }] : []);
/** 칩의 상태 낱말(없으면 상태 이름) — 상세 표 */
export const chipState = (c: Chip): string => (c.words.length ? c.words.map((w) => w.text).join(" · ") : HEALTH_WORD[c.health]);

export interface ConnChip { text: string; tone: "ok" | "warn" | "bad"; title: string; live: boolean }

export interface StatusInput {
  conn: ConnState;
  reconnectAttempt: number;
  lastRxAt: number | null;
  /** 브라우저 시각(ms) — 0 = 아직 모름(첫 렌더) */
  nowMs: number;
  /** 서버 기준 시각(ms) — 0 = 아직 모름 */
  srvNowMs: number;
  feeds: { region: FeedInfo | null; global: FeedInfo | null };
  aircraftCount: number | null;
  status: PublicStatus | null;
  sigmetsProvider: string;
  sigmetsFetchedAt: string | null;
  radar: RadarFrames | null;
  radarKr: KrRadar | null;
  ais: AisStatus | null;
  snapshotVersion: number;
}

/** 상태 바가 보는 스토어 값 */
export type StatusSource = Pick<ServerData, "conn" | "reconnectAttempt" | "lastRxAt" | "feeds" | "aircraftCount" | "status" | "sigmetsProvider" | "sigmetsFetchedAt" | "radar" | "radarKr" | "ais" | "snapshotVersion">;
/** 스토어 값 + 시계 → 입력(nowMs = 브라우저 시각, srvNowMs = 서버 기준 시각 — 모르면 0) */
export function statusInput(d: StatusSource, nowMs: number, srvNowMs: number): StatusInput {
  return {
    conn: d.conn, reconnectAttempt: d.reconnectAttempt, lastRxAt: d.lastRxAt, nowMs, srvNowMs, feeds: d.feeds, aircraftCount: d.aircraftCount, status: d.status,
    sigmetsProvider: d.sigmetsProvider, sigmetsFetchedAt: d.sigmetsFetchedAt, radar: d.radar, radarKr: d.radarKr, ais: d.ais, snapshotVersion: d.snapshotVersion,
  };
}

/** KST 날짜 "YYYY-MM-DD". 모르면 null */
const kstDay = (v: TimeIn): string | null => timeParts(v)?.wall.ymd ?? null;

/** KST 벽시계 — 날짜가 오늘(KST)과 다르거나 오늘을 모르면 날짜도. 모르면 "—" */
export function kstAt(v: TimeIn, nowMs: number, o: { seconds?: boolean } = {}): string {
  const day = kstDay(v);
  const sameDay = day != null && nowMs > 0 && day === kstDay(nowMs);
  return fmtKst(v, { date: !sameDay, seconds: o.seconds !== false });
}

/** 마우스를 올렸을 때의 같은 순간 전체 "2026-09-30 02:43:23.000 KST"(연도 · ms — 보인 시각 title 과 같은 모양, lib/time fmtTimeTitle). 모르면 undefined */
const kstFull = (v: TimeIn): string | undefined => fmtTimeTitle(v);
/** "앞말 + 전체 순간" title — 모르면 undefined(title 없음) */
const fullTitle = (lead: string, v: TimeIn): string | undefined => { const f = kstFull(v); return f ? `${lead} ${f}` : undefined; };

/** 초까지의 KST 구간 "09-29 10:00:00 – 09-29 10:00:42 KST"(날짜는 늘 — 상세 표 · 툴팁). 한쪽이라도 모르면 "—" */
function kstSpan(a: TimeIn, b: TimeIn): string {
  return timeParts(a) && timeParts(b) ? fmtKstRange(a, b) : "—";
}

// ---- AIS 수신 공백 ----

/** AIS 공백 하나(줄의 칩 · 앞쪽 경고 · 상세 표). 모든 시각은 KST 만 */
export interface AisGapInfo {
  /** 한 줄 요약(칩 글자와 같다): "AIS 공백 진행 중 4m 12s" · "AIS 공백 1/2 구역 진행 중 1m 00s" · "AIS 공백 42s · 02:22 KST 끝남" */
  text: string;
  /** 칩의 값 · 상태 낱말(text 를 나눈 것) */
  value: string;
  state: string | null;
  open: boolean;
  partial?: boolean;
  /** 일부 구역만 공백일 때: 공백 구역 수 / 전체 구역 수 */
  zones?: { open: number; total: number };
  /** 상태 바 줄에 보일지: 열린 공백, 또는 끝난 지 AIS_GAP_SHOW_MS(30분, 계약 v2 §B4) 안 */
  recent: boolean;
  /** 길이(초): 열림 = 서버 기준 지금 − 시작(지금을 모르면 null) · 끝남 = 끝 − 시작 */
  durationS: number | null;
  startedAt: string | null;
  endedAt: string | null;
  reason: string | null;
  /** 시작 – 끝(KST, 초까지) — 상세 표 */
  span: string;
  title: string;
}

/**
 * AIS 수신 공백(계약 v2 §B4 · v4 §D). 길이를 먼저 적는다(1분 미만은 초 — fmtDuration): 전에는 분까지의 시작–끝("02:22–02:22 KST")을 적어
 * 1분이 안 되는 공백(재시작)이 같은 두 시각으로 보였다(사용자 보고 2026-09-30).
 * - 열린 공백 → "AIS 공백 진행 중 4m 12s"(지금 = 서버 기준 — 모르면 길이 없이).
 * - 구역이 여럿이고 일부만 공백이면 "AIS 공백 n/m 구역 진행 중 1m 00s"(길이는 가장 이른 구역부터) — 툴팁에 공백 구역 · 시작 시각, 나머지 구역은 보고된 연결 상태 그대로
 *   (연결 · 끊김 · 연결 모름 — 공백이 없다고 "수신 중"이라고 말하지 않는다).
 * - 끝난 공백 → "AIS 공백 42s · 02:22 KST 끝남". 끝난 공백은 상태에 구역이 없다 — 구역이 여럿이면 그렇다고 적는다.
 * 모르면(상태 없음 · 공백 기록 없음 · 끝을 모르는 지난 공백) null. 줄에 보일지는 recent(상세 표는 늘 보인다).
 */
export function aisGapInfo(ais: AisStatus | null, nowMs: number): AisGapInfo | null {
  if (!ais) return null;
  const sg = openGapShards(ais);
  const since = (v: string) => { const t = Date.parse(v); return nowMs > 0 && Number.isFinite(t) ? Math.max(0, (nowMs - t) / 1000) : null; };
  const clock = (v: TimeIn, seconds: boolean) => { const t = kstAt(v, nowMs, { seconds }); return t === "—" ? null : t; };
  const out = (o: Omit<AisGapInfo, "text">): AisGapInfo => ({ ...o, text: `AIS 공백 ${o.value}${o.state ? ` · ${o.state}` : ""}` });
  const loss = "재전송이 없어 이 구간 선박 위치는 비어 있게 됩니다";
  if (sg && sg.open.length > 0 && sg.open.length < sg.total) {
    const lines = ais.shards!.map((sh, i) => `구역 ${i + 1} ${fmtShardScope(sh)} — ${
      sh.gap_open_since ? `공백 ${clock(sh.gap_open_since, true) ?? "—"} 부터` : `공백 없음 · ${shardConnText(sh)}`}`);
    const first = sg.open.map((sh) => sh.gap_open_since!).sort()[0];
    const d = since(first);
    return out({
      value: `${sg.open.length}/${sg.total} 구역 진행 중${d == null ? "" : ` ${fmtDuration(d)}`}`, state: null, open: true, partial: true,
      zones: { open: sg.open.length, total: sg.total }, recent: true, durationS: d,
      startedAt: first, endedAt: null, reason: null, span: `${clock(first, true) ?? "—"} 부터(가장 이른 구역)`,
      title: `${lines.join("\n")}\n공백 구역 안 선박 위치는 멈춰 있고, ${loss}`,
    });
  }
  if (ais.gap_open_since) {
    const all = sg && sg.open.length === sg.total ? ` · 모든 구역(${sg.total}개)` : "";
    const d = since(ais.gap_open_since);
    const from = clock(ais.gap_open_since, true) ?? "—";
    return out({
      value: `진행 중${d == null ? "" : ` ${fmtDuration(d)}`}`, state: null, open: true, recent: true, durationS: d,
      startedAt: ais.gap_open_since, endedAt: null, reason: null, span: `${from} 부터`,
      title: `AIS 수신이 ${from} 부터 끊겨 있음${all} — ${loss}`,
    });
  }
  const g = ais.last_gap;
  if (!g) return null;
  const start = Date.parse(g.started_at);
  const end = g.ended_at ? Date.parse(g.ended_at) : NaN;
  if (!g.ended_at || !Number.isFinite(end)) return null; // 끝을 모르는 지난 공백 — 열린 공백은 gap_open_since 가 말한다
  const d = Number.isFinite(start) ? Math.max(0, (end - start) / 1000) : null;
  const recent = nowMs > 0 && nowMs - end <= AIS_GAP_SHOW_MS;
  const endClock = clock(g.ended_at, false);
  const scope = sg ? ` · 어느 구역의 공백인지는 상태에 없음(구역 ${sg.total}개)` : "";
  const span = kstSpan(g.started_at, g.ended_at);
  return out({
    value: fmtDuration(d), state: endClock ? `${endClock} 끝남` : "끝남", open: false, recent, durationS: d,
    startedAt: g.started_at, endedAt: g.ended_at, reason: g.reason, span,
    title: `AIS 수신 공백 ${fmtDuration(d)} — ${span}${g.reason ? ` (${g.reason})` : ""} — 이 구간 선박 위치 없음${scope}`,
  });
}

const toneHealth = (t: "ok" | "warn" | "bad" | "muted"): Health => (t === "muted" ? "unknown" : t);

/**
 * 연결 칩. "paused" 는 탭이 숨겨져 서버에 일시정지(pause)를 보낸 상태다(components/MapView visibilitychange → lib/ws pause) — 그동안 서버는 이 탭에
 * 갱신을 보내지 않는다. 그렇게 적는다("WS paused · 탭 숨김").
 */
export function connChip(i: Pick<StatusInput, "conn" | "reconnectAttempt" | "lastRxAt" | "nowMs">): ConnChip {
  const live = isRxFresh(i.conn, i.lastRxAt, i.nowMs);
  const silent = i.conn === "open" && !live;
  const retry = i.conn !== "open" && i.reconnectAttempt > 0 ? ` · retry ${i.reconnectAttempt}` : "";
  const text = `WS ${i.conn}${silent ? " · 수신 없음" : ""}${i.conn === "paused" ? " · 탭 숨김" : ""}${retry}`;
  const title = silent ? `연결은 열려 있지만 ${RX_FRESH_MS / 1000} s 넘게 아무것도 받지 못함 — ${RX_DEAD_MS / 1000} s 가 되면 다시 연결`
    : i.conn === "paused" ? "탭이 숨겨져 서버에 일시정지(pause)를 보냈습니다 — 그동안 서버는 이 탭에 갱신을 보내지 않아 화면 값이 멈춰 있습니다. 탭이 다시 보이면 resume 으로 전체 초기 세트(스냅샷 · 알림 · SIGMET · 레이더 · status)를 다시 받습니다"
    : i.conn === "open" ? `실시간 연결(/ws/v1) — 서버 ping 은 30 s 마다, ${RX_FRESH_MS / 1000} s 넘게 아무것도 받지 못하면 '수신 없음'`
    : i.conn === "connecting" ? (i.reconnectAttempt > 0 ? `끊겨서 다시 연결하는 중 — ${i.reconnectAttempt}번째 시도(지수 백오프, 최대 30 s)` : "처음 연결하는 중")
    : i.reconnectAttempt > 0 ? `연결 끊김 — ${i.reconnectAttempt}번째 재연결을 기다리는 중(지수 백오프, 최대 30 s)` : "연결 끊김";
  return { text, tone: connTone(i.conn, silent, i.reconnectAttempt), title, live };
}

/** 서버 판정(stale) 또는 브라우저가 본 경과 > 기준이면 오래됨. 경과를 모르면 모름 */
function ageHealth(age: number | null, serverStale: boolean | undefined, limitS: number): Health {
  if (serverStale === true || (age != null && age > limitS)) return "bad";
  return age == null ? "unknown" : "ok";
}

/** 줄의 칩(표시 순서 = 줄에서 빼는 순서의 거꾸로). 경고성 항목(FIXTURE · 열린 AIS 공백)은 칩이 아니라 StatusBar 가 연결 뒤에 둔다 */
export function statusChips(i: StatusInput): Chip[] {
  const live = isRxFresh(i.conn, i.lastRxAt, i.nowMs);
  const chips: Chip[] = [];
  const push = (c: Omit<Chip, "pinned">) => chips.push({ ...c, pinned: c.health === "warn" || c.health === "bad" });

  chips.push({
    key: "aircraft", label: "aircraft", value: i.aircraftCount == null ? "—" : String(i.aircraftCount), words: [], health: "unknown", plain: true, pinned: false, testId: "aircraft-count",
    title: i.aircraftCount == null ? "항공기 수 모름 — 항공기 레이어가 꺼져 있거나 아직 스냅샷을 받지 않음" : "현재 지도 영역(구독 bbox) 안의 항공기 수 — 수신이 끊긴 항공기도 stale(반투명)로 남는다",
  });

  const region = feedLag(i.feeds.region, i.nowMs, live, REGION_STALE_S);
  const rTone = lagTone(region, i.conn, i.reconnectAttempt);
  push({
    key: "region", label: "region", testId: "lag-badge",
    value: region.lag == null ? "NO DATA" : `lag ${fmtAgeS(region.lag)}`,
    words: word(region.lag != null && region.stale ? "STALE" : null),
    health: rTone,
    title: `지역 피드(${i.feeds.region?.provider ?? "공급자 —"}) 지연 — 서버가 보고한 값(연결이 실시간이 아니면 받은 뒤 경과를 더함) · 경고 > ${REGION_STALE_S} s(서버 판정 포함)`,
  });

  const world = i.feeds.global ? feedLag(i.feeds.global, i.nowMs, live, GLOBAL_STALE_S) : null;
  push({
    key: "world", label: "world", testId: "global-lag-badge",
    value: world == null ? "—" : world.lag == null ? "NO DATA" : `lag ${fmtAgeS(world.lag)}`,
    words: word(world?.lag != null && world.stale ? "STALE" : null),
    health: world == null ? "unknown" : world.stale ? "bad" : "ok",
    title: world == null ? "전세계 피드 없음(또는 아직 받지 않음)" : `전세계 피드(${i.feeds.global?.provider ?? "공급자 —"}) 지연 · 경고 > ${GLOBAL_STALE_S} s(서버 판정 포함)`,
  });

  const ais = aisBadge(i.ais, i.nowMs, live);
  if (ais) {
    push({
      key: "ais", label: "AIS", testId: "ais-badge", title: ais.title, health: toneHealth(ais.tone),
      value: ais.kind === "disabled" ? "꺼짐" : ais.kind === "down" ? "끊김" : ais.kind === "partial" ? `끊김 ${ais.down}/${ais.shards} 구역` : ais.lag == null ? "lag —" : `lag ${fmtAgeS(ais.lag)}`,
      words: word(ais.kind === "disabled" ? "키 없음" : ais.kind === "live" ? (i.ais?.connected == null ? "연결 모름" : ais.lag != null && ais.lag > AIS_LAG_WARN_S ? "지연" : null) : null),
    });
  }

  // 끝난 공백만 칩(열린 공백은 StatusBar 가 연결 뒤 경고로) — 끝난 지 AIS_GAP_SHOW_MS 안에서만. 그동안의 선박 위치가 없다는 뜻이라 주의(pinned)
  const gap = aisGapInfo(i.ais, i.srvNowMs);
  if (gap && !gap.open && gap.recent) {
    push({ key: "ais-gap", label: "AIS 공백", testId: "ais-gap-badge", value: gap.value, words: word(gap.state), health: "warn", title: gap.title });
  }

  const sAge = i.srvNowMs ? ageS(i.sigmetsFetchedAt, i.srvNowMs) : null;
  const sHealth = ageHealth(sAge, i.status?.sigmet?.stale, SIGMET_STALE_S);
  push({
    key: "sigmet", label: "sigmet", testId: "sigmet-chip", value: `age ${fmtAgeS(sAge)}`, words: word(sHealth === "bad" ? "STALE" : null), health: sHealth,
    title: `SIGMET(${i.sigmetsProvider}) 마지막 수집 뒤 경과 — 오래됨 > ${SIGMET_STALE_S} s(api status 와 같은 기준)`,
  });

  const rAge = i.srvNowMs ? ageS(i.radar?.fetched_at, i.srvNowMs) : null;
  const rHealth = ageHealth(rAge, i.status?.radar?.stale, RADAR_STALE_S);
  push({
    key: "radar", label: "radar", testId: "radar-chip", value: `age ${fmtAgeS(rAge)}`, words: word(rHealth === "bad" ? "STALE" : null), health: rHealth,
    title: `RainViewer 레이더 목록 마지막 수집 뒤 경과 — 오래됨 > ${RADAR_STALE_S} s(api status 와 같은 기준)`,
  });

  const kr = i.radarKr;
  const miss = krMissing(kr?.missing, i.srvNowMs);
  if (kr && (kr.available || miss)) {
    const stale = isKrRadarStale(kr, i.srvNowMs);
    const comp = krComposite(kr.available ? kr.frames[kr.frames.length - 1] : null, i.srvNowMs);
    const age = i.srvNowMs ? ageS(kr.meta?.fetched_at, i.srvNowMs) : null;
    const staleTitle = `기상청 레이더에 ${KR_RADAR_STALE_S / 60}분 넘게 새 프레임 없음(최신 tm 첫 수집 ${kstAt(kr.meta?.fetched_at, i.srvNowMs)})`;
    const words: ChipWord[] = [];
    if (stale) words.push({ text: "STALE", testId: "kr-radar-stale", title: staleTitle });
    if (comp.warn) words.push({ text: "일부 합성", testId: "kr-status-partial", title: comp.warn });
    if (miss) words.push({ text: miss.word, testId: "kr-status-missing", title: `${miss.text}\n${miss.title}` });
    push({
      key: "kma", label: "KMA", testId: "kr-status", value: `age ${fmtAgeS(age)}`, words,
      health: stale ? "bad" : comp.warn || miss ? "warn" : age == null ? "unknown" : "ok",
      title: [kr.available ? `기상청 레이더 최신 tm 첫 수집(${kstAt(kr.meta?.fetched_at, i.srvNowMs)}) 뒤 경과 — STALE > ${KR_RADAR_STALE_S / 60}분 · ${comp.label}`
        : `기상청 레이더 사용 불가${kr.note ? ` — ${kr.note}` : ""}`, stale ? staleTitle : null, comp.warn, miss?.text].filter(Boolean).join("\n"),
    });
  }
  return chips;
}

/** 열린 AIS 공백 — 줄 앞쪽 경고(R-31: 경고는 앞에). 없으면 null */
export function openGapWarning(i: Pick<StatusInput, "ais" | "srvNowMs">): AisGapInfo | null {
  const g = aisGapInfo(i.ais, i.srvNowMs);
  return g && g.open ? g : null;
}

// ---- 줄 폭 맞추기 ----

export interface ChipBox { key: string; width: number; pinned: boolean }
/**
 * 줄에 넣을 수 없는 칩(뒤에서부터): 고정 폭(연결 · 경고 · 상세 단추 — reserved) + 늘 보일 칩(pinned) + 순서대로 넣은 칩이 줄 폭을 넘으면
 * 그 칩부터 끝까지(정상 · 모름 칩만) 뺀다. 순서를 건너뛰어 뒤의 작은 칩을 채우지 않는다(자리가 흔들리지 않게). gap = 칩 사이 간격.
 */
export function fitChips(boxes: readonly ChipBox[], rowWidth: number, reserved: number, gap: number): Set<string> {
  const pinnedW = boxes.filter((b) => b.pinned).reduce((s, b) => s + b.width + gap, 0);
  let room = rowWidth - reserved - pinnedW;
  const out = new Set<string>();
  let full = false;
  for (const b of boxes) {
    if (b.pinned) continue;
    if (!full && b.width + gap <= room) { room -= b.width + gap; continue; }
    full = true;
    out.add(b.key);
  }
  return out;
}

/**
 * 옮길 수 있는 칩을 모두 옮겨도(고정 폭 + 늘 보일 칩만) 줄 폭을 넘는가 — 그때만 줄을 넘긴다(flex-wrap, 잘리지 않게). 아니면 한 줄(nowrap)로 둔다:
 * 줄 높이가 칩 옮기기에 따라 바뀌지 않게(아래 지도의 ResizeObserver 가 같은 프레임에 두 번 크기 변화를 받는 되먹임 — 2026-09-30). fitChips 와 같은 셈.
 */
export function pinnedOverflow(boxes: readonly ChipBox[], rowWidth: number, reserved: number, gap: number): boolean {
  const pinnedW = boxes.filter((b) => b.pinned).reduce((s, b) => s + b.width + gap, 0);
  return rowWidth - reserved - pinnedW < 0;
}

// ---- 상세 표 ----

export interface DetailRow {
  key: string;
  name: string;
  /** null = 상태 판정이 없는 항목(엔진 · 판) */
  health: Health | null;
  state: string;
  value: string;
  valueTitle?: string;
  source: string;
  /** 출처 칸의 시각을 전체 순간(연도 · ms)으로 — 모르면 없음 */
  sourceTitle?: string;
  rule: string;
}

/** 상세 표(줄에서 뺀 칩도 모두 여기) — 값은 스토어가 받은 것 그대로, 모르면 "—" */
export function detailRows(i: StatusInput): DetailRow[] {
  const c = connChip(i);
  const chips = new Map(statusChips(i).map((x) => [x.key, x]));
  const stateOf = (k: ChipKey) => { const x = chips.get(k); return x ? chipState(x) : "—"; };
  const healthOf = (k: ChipKey) => chips.get(k)?.health ?? "unknown";
  const rows: DetailRow[] = [];
  rows.push({
    key: "conn", name: "WS 연결", health: toneHealth(c.tone),
    state: i.conn === "paused" ? "일시정지(탭 숨김)" : c.text.replace(/^WS /, ""),
    value: i.reconnectAttempt > 0 ? `재시도 ${i.reconnectAttempt}` : "—", source: "/ws/v1",
    rule: `${RX_FRESH_MS / 1000} s 넘게 수신 없음 = 수신 없음 · ${RX_DEAD_MS / 1000} s = 다시 연결 · 일시정지 = 탭 숨김(서버가 보내지 않음)`,
  });
  rows.push({ key: "aircraft", name: "항공기 수", health: null, state: "—", value: i.aircraftCount == null ? "—" : String(i.aircraftCount), source: "지도 영역(구독 bbox) 안 · STALE 포함", rule: "—" });
  for (const [k, name, feed, limit] of [["region", "항공기 · 지역 피드", i.feeds.region, REGION_STALE_S], ["world", "항공기 · 전세계 피드", i.feeds.global, GLOBAL_STALE_S]] as const) {
    const chip = chips.get(k)!;
    rows.push({
      key: k, name, health: chip.health, state: stateOf(k), value: chip.value,
      source: feed ? `${feed.provider ?? "공급자 —"} · 수집 ${kstAt(feed.fetched_at, i.srvNowMs)}` : "—", sourceTitle: fullTitle("수집", feed?.fetched_at),
      rule: `경고 > ${limit} s(서버 판정 포함)`,
    });
  }
  const a = aisBadge(i.ais, i.nowMs, isRxFresh(i.conn, i.lastRxAt, i.nowMs));
  rows.push({
    key: "ais", name: "선박 · AIS", health: a ? healthOf("ais") : "unknown", state: a ? stateOf("ais") : "상태 없음",
    value: a ? `${a.lag == null ? "lag —" : `lag ${fmtAgeS(a.lag)}`} · ${a.rate == null ? "msg/s —" : `${a.rate.toFixed(1)} msg/s`}` : "—",
    valueTitle: a?.title,
    source: i.ais ? `aisstream.io${i.ais.shards && i.ais.shards.length > 1 ? ` · 구역 ${i.ais.shards.length}개` : ""}` : "AIS 상태를 받지 않음(수집기 없음 · 아직 받지 않음)",
    rule: `경고 > ${AIS_LAG_WARN_S} s · 끊김`,
  });
  const g = aisGapInfo(i.ais, i.srvNowMs);
  rows.push({
    // 끝난 공백은 줄의 창(AIS_GAP_SHOW_MS) 안에서만 주의 — 그보다 오래된 공백은 기록일 뿐이다(줄에서도 빠졌다)
    key: "ais-gap", name: "AIS 공백(마지막)", health: g ? (g.open ? (g.partial ? "warn" : "bad") : g.recent ? "warn" : null) : null,
    state: g ? (g.open ? `진행 중${g.zones ? ` · ${g.zones.open}/${g.zones.total} 구역` : ""}` : "끝남") : i.ais ? "기록 없음" : "—",
    value: g ? fmtDuration(g.durationS) : "—", valueTitle: g?.title,
    source: g ? `${g.span}${g.reason ? ` · ${g.reason}` : ""}` : "—",
    sourceTitle: g?.startedAt ? `${kstFull(g.startedAt) ?? "—"} – ${g.open ? "진행 중" : kstFull(g.endedAt) ?? "—"}` : undefined,
    rule: `줄에는 진행 중이거나 끝난 뒤 ${AIS_GAP_SHOW_MS / 60_000}분까지(계약 v2 §B4) · status 는 마지막 하나만 — 이력은 로그 메뉴의 AIS 수신 공백 탭`,
  });
  const sg = i.status?.sigmet;
  rows.push({
    key: "sigmet", name: "SIGMET", health: healthOf("sigmet"), state: stateOf("sigmet"),
    value: `${sg?.active == null ? "active —" : `${sg.active} active`} · ${chips.get("sigmet")!.value}`,
    source: `${i.sigmetsProvider === "-" ? "공급자 —" : i.sigmetsProvider} · 수집 ${kstAt(i.sigmetsFetchedAt, i.srvNowMs)}`, sourceTitle: fullTitle("수집", i.sigmetsFetchedAt),
    rule: `오래됨 > ${SIGMET_STALE_S} s(api status)`,
  });
  rows.push({
    key: "radar", name: "레이더 · RainViewer", health: healthOf("radar"), state: stateOf("radar"),
    value: `${i.radar ? `${i.radar.past.length} frames` : "frames —"} · ${chips.get("radar")!.value}`,
    source: `${i.radar?.provider ?? "rainviewer"} · 수집 ${kstAt(i.radar?.fetched_at, i.srvNowMs)}`, sourceTitle: fullTitle("수집", i.radar?.fetched_at),
    rule: `오래됨 > ${RADAR_STALE_S} s(api status)`,
  });
  const kr = i.radarKr;
  const miss = krMissing(kr?.missing, i.srvNowMs);
  if (kr?.available) {
    const comp = krComposite(kr.frames[kr.frames.length - 1], i.srvNowMs);
    rows.push({
      key: "kma", name: "레이더 · 기상청", health: healthOf("kma"), state: stateOf("kma"),
      value: `${kr.frames.length}f · 최신 tm ${kstAt(kstWallMs(kr.latest_tm), i.srvNowMs, { seconds: false })} · ${comp.label}`, valueTitle: comp.title,
      source: `기상청 API허브 · 최신 tm 첫 수집 ${kstAt(kr.meta?.fetched_at, i.srvNowMs)}`, sourceTitle: fullTitle("최신 tm 첫 수집", kr.meta?.fetched_at),
      rule: `STALE > ${KR_RADAR_STALE_S / 60}분 · 합성 N/M곳(ADR-021)`,
    });
  } else {
    rows.push({
      key: "kma", name: "레이더 · 기상청", health: miss ? healthOf("kma") : "unknown", state: kr ? (miss ? `사용 불가 · ${stateOf("kma")}` : "사용 불가") : "—", value: "—",
      source: kr?.note || (kr ? "기상청 API허브" : "상태 수신 전"), rule: `STALE > ${KR_RADAR_STALE_S / 60}분`,
    });
  }
  if (miss) {
    rows.push({
      key: "kma-missing", name: "기상청 내려받기 파일", health: "warn", state: miss.stale ? "없음 · 확인 멈춤" : "없음",
      value: `tm ${miss.range} · 확인한 tm ${miss.tms}개 ${miss.tms === 1 ? "" : "모두 "}없음`, valueTitle: miss.title,
      source: `기상청 답: ${miss.file ? `${miss.file} 없음` : "파일 없음(파일 이름 모름)"}${miss.listed ? ` · 목록에는 ${miss.listed}` : ""} · 마지막 확인 ${kstAt(miss.checkedAt, i.srvNowMs)}`,
      sourceTitle: fullTitle("마지막 확인", miss.checkedAt),
      rule: `목록에 있는 tm 을 내려받기가 '파일 없음'으로 답하는 동안 — 수집기가 주기마다 목록의 가장 새 tm 과 ${KR_MISSING_RECHECK_MIN}분 넘게 앞선 가장 새 tm 만 확인`
        + ` · 파일이 다시 오면 이 행은 사라짐 · 마지막 확인이 ${KR_MISSING_CHECK_STALE_MIN}분을 넘으면 확인 멈춤(수집기 선택값)`,
    });
  }
  const en = i.status?.engine;
  rows.push({
    key: "engine", name: "판정 엔진", health: null, state: "—",
    value: `${en?.index_polygons == null ? "polys —" : `${en.index_polygons} polys`} · ${en?.last_cycle_ms == null ? "cycle —" : `cycle ${en.last_cycle_ms} ms`}`,
    source: "SIGMET 폴리곤 색인 · 마지막 판정 주기", rule: "—",
  });
  rows.push({ key: "version", name: "스냅샷 판", health: null, state: "—", value: `v${i.snapshotVersion}`, source: "마지막으로 받은 스냅샷 · diff", rule: "—" });
  const fx = i.status?.fixture_mode;
  rows.push({ key: "fixture", name: "FIXTURE MODE", health: fx ? "warn" : null, state: fx == null ? "—" : fx ? "켜짐" : "꺼짐", value: fx ? "외부 호출 없음 — 기록된 자료 재생" : "—", source: "api status", rule: "—" });
  return rows;
}
