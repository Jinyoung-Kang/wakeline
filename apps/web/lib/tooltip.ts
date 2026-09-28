/**
 * 지도 호버 툴팁 내용(GAP-26) — 순수 함수. 항공기(호출부호·고도·속도·수신 경과), SIGMET(유형·고도대·유효), 공항(ICAO·카테고리·METAR 경과).
 * 값은 받은 데이터 그대로, 없으면 "—". DOM 은 textContent 로만 만든다(원문·호출부호 등 외부 문자열을 HTML 로 해석하지 않는다).
 * 고도·속도는 두 단위(계약 v5 §A — ft·kt 와 m·km/h, 정의된 상수로 바꾼 계산값).
 */
import { band, catSourceLabel, ceilingLabel, fmtAltGndDual, fmtDuration, fmtGsDual, fmtNum, fmtSogDual, fmtTime, fmtVrateDual, isMetarStale, metarAgeS } from "./format";
import { seenAtMs, thresholds } from "./interpolate";
import { isExpired, isPending, sigmetBandSource } from "./sigmet";
import { fmtCourse, navStatusLabel, positionBadge, ROT_LABEL, SHIP_CATEGORY_LABEL, SHIP_STALE_S, shipAgeS, shipCategory, shipRotation, SHIPS_RULE, type ShipLite } from "./ships";
import type { AircraftState, SigmetProps } from "./types";

export type Tone = "warn" | "bad" | "est" | "ok" | "muted";
export interface Tip {
  title: string;
  subtitle?: string;
  rows: [string, string][];
  flags: { text: string; tone: Tone }[];
}

/**
 * 지도에 그려진 항공기(렌더 속성) + 메인 스레드의 원본 상태(있으면). 고도·속도는 관측값을 보여 준다.
 * 원본 상태가 없어 렌더 속성의 고도를 쓸 때, 렌더가 dead reckoning(estimated)이면 그 고도는 수직속도로 외삽했을 수 있어 "(추정)"을 붙인다.
 * nowMs 는 서버 기준 시각(serverNowMs) — 워커의 stale 판정과 같은 기준(WS-3).
 */
export function aircraftTip(
  render: { hex: string; callsign?: string | null; alt_ft?: number | null; stale?: boolean; estimated?: boolean; emergency?: boolean; age_unknown?: boolean; on_ground?: boolean | null; track_deg?: number | null },
  state: AircraftState | null | undefined,
  nowMs: number,
): Tip {
  const seen = seenAtMs(state?.seen_at);
  const age = seen == null || !nowMs ? null : Math.max(0, (nowMs - seen) / 1000);
  const provider = state?.provider ?? null;
  const flags: Tip["flags"] = [];
  if (render.emergency) flags.push({ text: `EMERGENCY ${state?.squawk ?? ""}`.trim(), tone: "bad" });
  if (render.stale) flags.push({ text: age != null && age > thresholds(provider).staleAfterS ? "STALE · 수신 지연" : "STALE · 위치 추정 상한", tone: "warn" });
  else if (render.estimated) flags.push({ text: "위치 추정(dead reckoning)", tone: "est" });
  if (age == null) flags.push({ text: "수신 경과 모름", tone: "muted" });
  const track = state ? state.track_deg : render.track_deg;
  if (track == null) flags.push({ text: "방위 모름 · 방향 없는 기호", tone: "muted" });
  return {
    title: state?.callsign ?? render.callsign ?? "—",
    subtitle: render.hex,
    rows: [
      ["ALT", state ? fmtAltGndDual(state.alt_ft, state.on_ground) : renderAlt(render)],
      ["GS", fmtGsDual(state?.gs_kt)],
      ["VS", fmtVrateDual(state?.vrate_fpm)],
      ["TRK", fmtNum(state?.track_deg, "°")],
      ["AGE", age == null ? "—" : fmtDuration(age)],
      ["SRC", provider ?? "—"],
    ],
    flags,
  };
}

/** 렌더 속성의 고도(원본 상태가 없을 때): 외삽 위치(estimated)면 추정 표기 */
function renderAlt(r: { alt_ft?: number | null; on_ground?: boolean | null; estimated?: boolean }): string {
  const v = fmtAltGndDual(r.alt_ft, r.on_ground);
  return r.estimated && r.alt_ft != null && r.on_ground !== true ? `${v} (추정)` : v;
}

/** nowMs 는 서버 기준 시각. 발효 전(DH-8)이면 "발효 전 · 시각"과 발효까지 남은 시간을 보여 준다(판정 대상 아님). */
export function sigmetTip(p: SigmetProps, nowMs: number): Tip {
  const flags: Tip["flags"] = [];
  const expired = nowMs ? isExpired(p, nowMs) : false;
  const pending = nowMs ? isPending(p, nowMs) : p.pending === true;
  if (expired) flags.push({ text: "만료됨", tone: "warn" });
  else if (pending) flags.push({ text: `발효 전 · ${fmtTime(p.valid_from)}부터 · 판정 전`, tone: "muted" });
  else if (p.expiring_soon) flags.push({ text: "30분 내 만료", tone: "warn" });
  if (p.inside && !pending) flags.push({ text: "안에 항공기(관측)", tone: "bad" });
  if (p.excluded_reason) flags.push({ text: `판정 제외: ${p.excluded_reason}`, tone: "muted" });
  const left = nowMs ? (Date.parse(p.valid_to) - nowMs) / 1000 : NaN;
  const starts = nowMs ? (Date.parse(p.valid_from) - nowMs) / 1000 : NaN;
  const rows: [string, string][] = [
    ["BAND", band(p.base_ft, p.top_ft, sigmetBandSource(p))],
    ["VALID", `${fmtTime(p.valid_from)} – ${fmtTime(p.valid_to)}`],
  ];
  if (pending) rows.push(["STARTS", Number.isFinite(starts) && starts > 0 ? `${fmtDuration(starts)} 뒤` : "—"]);
  rows.push(["LEFT", Number.isFinite(left) && left > 0 ? fmtDuration(left) : "—"]);
  return {
    title: `${p.hazard}${p.qualifier ? ` ${p.qualifier}` : ""}`,
    subtitle: `${p.fir_id ?? "—"} ${p.series_id ?? ""}`.trim(),
    rows,
    flags,
  };
}

export interface AirportProps {
  icao: string;
  name?: string | null;
  flight_cat?: string | null;
  flight_cat_source?: string | null;
  obs_time?: string | null;
  obs_age_s?: number | null;
  stale?: boolean | null;
  ceiling_state?: string | null;
  ceiling_ft?: number | null;
}

export function airportTip(p: AirportProps, nowMs: number): Tip {
  const age = metarAgeS(p, nowMs);
  const hasMetar = p.obs_time != null || age != null;
  const stale = hasMetar && isMetarStale(p, nowMs);
  const flags: Tip["flags"] = [];
  if (!hasMetar) flags.push({ text: "METAR 없음", tone: "muted" });
  else if (stale) flags.push({ text: "오래됨 · 2시간 초과", tone: "warn" });
  return {
    title: p.icao,
    subtitle: p.name ?? undefined,
    rows: [
      ["CAT", `${p.flight_cat ?? "—"}${p.flight_cat ? ` · ${catSourceLabel(p.flight_cat_source, p.flight_cat).replace("카테고리: ", "")}` : ""}`],
      ["METAR", hasMetar ? `${fmtTime(p.obs_time)} · ${age == null ? "—" : `${fmtDuration(age)} 전`}` : "—"],
      ["CEIL", hasMetar ? ceilingLabel(p.ceiling_state, p.ceiling_ft) : "—"],
    ],
    flags,
  };
}

/**
 * 선박 툴팁(계약 v2 §B4). 지도 렌더 속성(방향 방식·STALE) + 원본(ShipLite). 이름·MMSI 는 외부 문자열 — renderTip 이 텍스트 노드로만 넣는다.
 * nowMs = 서버 기준 시각.
 */
export function shipTip(s: ShipLite, nowMs: number): Tip {
  const age = shipAgeS(s.seen_at, nowMs);
  const rot = shipRotation(s);
  const flags: Tip["flags"] = [];
  if (age != null && age > SHIP_STALE_S) flags.push({ text: `STALE · ${fmtDuration(age)} 전 위치`, tone: "warn" });
  if (age == null) flags.push({ text: "관측 시각 모름", tone: "muted" });
  const pb = positionBadge(s.position_source);
  if (pb) flags.push(pb);
  if (rot.mode !== "heading") flags.push({ text: ROT_LABEL[rot.mode], tone: "muted" });
  const cat = shipCategory(s.ship_type);
  return {
    title: s.name ?? "—",
    subtitle: `MMSI ${s.mmsi}`,
    rows: [
      ["TYPE", s.ship_type == null ? `— · ${SHIP_CATEGORY_LABEL[cat]}` : `${s.ship_type} · ${SHIP_CATEGORY_LABEL[cat]}`],
      ["SOG", fmtSogDual(s.sog_kn)],
      ["COG/HDG", fmtCourse(s)],
      ["STATUS", navStatusLabel(s.nav_status)],
      ["AGE", age == null ? "—" : fmtDuration(age)],
    ],
    flags,
  };
}

/**
 * 격자 칸 툴팁 — 서버가 보낸 칸 중심·수·가장 많은 선종(선종 필터가 켜져 있으면 선종별 수로 다시 센 값, 계약 v5 §B3).
 * BY TYPE = 서버가 보낸 선종별 수(B2) 그대로 — 없으면(구 서버) 없다고 적는다.
 */
export function shipGridTip(p: { count?: unknown; cat?: unknown; all?: unknown; unfiltered?: unknown; breakdown?: unknown }, cellDeg: number | null): Tip {
  const count = typeof p.count === "number" ? p.count : null;
  const all = typeof p.all === "number" ? p.all : count;
  const cat = typeof p.cat === "string" && p.cat in SHIP_CATEGORY_LABEL ? (p.cat as keyof typeof SHIP_CATEGORY_LABEL) : "unknown";
  const n = (v: number) => v.toLocaleString("en-US");
  const flags: Tip["flags"] = [{ text: `클릭하면 줌 ${SHIPS_RULE.highZoom} 이상으로 확대 — 화면 안 ${n(SHIPS_RULE.highMax)}척 이하면 개별 선박`, tone: "muted" }];
  if (p.unfiltered === true) flags.push({ text: "선종별 수 없음(구 서버) — 선종 필터를 적용하지 못한 전체 수", tone: "warn" });
  return {
    title: count == null ? "—" : `선박 ${n(count)}척${all != null && all !== count ? ` · 선종 필터 적용(칸 전체 ${n(all)}척)` : ""}`,
    subtitle: cellDeg ? `${cellDeg}° 격자` : "격자",
    rows: [["MOST", SHIP_CATEGORY_LABEL[cat]], ["BY TYPE", typeof p.breakdown === "string" && p.breakdown ? p.breakdown : "— (서버가 선종별 수를 보내지 않음)"]],
    flags,
  };
}

/**
 * 항적 점 툴팁(계약 v5 §B3): 시각(UTC) · 속력(kn · km/h) · 침로 · 항해 상태 — API points[] 값 그대로(없으면 —).
 * shipLabel = 선박 이름(모르면 MMSI) — 외부 문자열이라 renderTip 이 텍스트 노드로만 넣는다.
 */
export function shipTrackPointTip(p: { ts?: unknown; sog?: unknown; cog?: unknown; hdg?: unknown; nav?: unknown; src?: unknown }, shipLabel: string | null): Tip {
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const cog = n(p.cog);
  return {
    title: "항적 점",
    subtitle: shipLabel ?? undefined,
    rows: [
      ["TIME UTC", fmtTime(typeof p.ts === "string" ? p.ts : null)],
      ["SOG", fmtSogDual(n(p.sog))],
      ["COG", cog == null ? "—" : `${cog.toFixed(1)}°`],
      ["STATUS", navStatusLabel(n(p.nav))],
    ],
    flags: [{ text: p.src === "live" ? "실시간 관측 · 선택한 뒤 받은 값" : "저장 기록 · 60 s 창의 첫 보고", tone: "muted" }],
  };
}

/** Tip → DOM(텍스트 노드만). 브라우저에서만 호출한다. */
export function renderTip(tip: Tip, doc: Document = document): HTMLElement {
  const root = doc.createElement("div");
  root.className = "tip";
  const head = doc.createElement("div");
  head.className = "tip-head";
  const t = doc.createElement("span");
  t.className = "tip-title mono";
  t.textContent = tip.title;
  head.appendChild(t);
  if (tip.subtitle) {
    const s = doc.createElement("span");
    s.className = "tip-sub mono";
    s.textContent = tip.subtitle;
    head.appendChild(s);
  }
  root.appendChild(head);
  for (const [k, v] of tip.rows) {
    const r = doc.createElement("div");
    r.className = "tip-row";
    const kk = doc.createElement("span");
    kk.className = "label";
    kk.textContent = k;
    const vv = doc.createElement("span");
    vv.className = "mono";
    vv.textContent = v;
    r.append(kk, vv);
    root.appendChild(r);
  }
  if (tip.flags.length) {
    const f = doc.createElement("div");
    f.className = "tip-flags";
    for (const fl of tip.flags) {
      const b = doc.createElement("span");
      b.className = `badge ${fl.tone === "muted" ? "" : fl.tone}`.trim();
      b.textContent = fl.text;
      f.appendChild(b);
    }
    root.appendChild(f);
  }
  return root;
}
