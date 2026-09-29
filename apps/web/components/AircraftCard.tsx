"use client";
import { useEffect, useMemo, useState } from "react";
import { apiGet } from "@/lib/api";
import { aircraftStates, useServerData } from "@/lib/store";
import { useUi } from "@/lib/ui-store";
import { useElapsedSince, useNow, useServerNow } from "@/lib/clock";
import { focusChip } from "@/lib/demand";
import { isRxFresh } from "@/lib/ws-protocol";
import { predict, seenAtMs } from "@/lib/interpolate";
import type { AircraftState, Alert, PredictionReason } from "@/lib/types";
import { fmtAltGndDual, fmtBool, fmtDuration, fmtGsDual, fmtNum, fmtVrateDual } from "@/lib/format";
import {
  EARTH_RADIUS_KM, fmtAirline, fmtAirportCodes, fmtAirportPlace, fmtRouteKm, parseRoute, ROUTE_ATTRIBUTION_TAIL, ROUTE_CAVEAT, ROUTE_SOURCE_URL,
  ROUTE_PENDING_TITLE, ROUTE_SLOW_TEXT, ROUTE_STATUS_TEXT, ROUTE_TITLE, routeCallsignMismatch, routeDistanceKm, routePendingPhase, type RouteAirport, type RouteInfo,
} from "@/lib/route";
import { EvidenceCard } from "./EvidenceCard";
import { DemandBadge } from "./MapChips";
import { RequestIdOf } from "./logs/ErrorNote";
import { KstTime } from "./KstTime";

interface Detail {
  hex: string;
  state: AircraftState | null;
  static: { registration?: string | null; type_code?: string | null; category?: string | null; first_seen?: string | null; last_seen?: string | null } | null;
  active_alerts?: Alert[];
  inside_sigmets?: string[];
  emergency?: boolean;
  meta?: { provider?: string | null; fetched_at?: string | null; lag_s?: number | null; stale?: boolean; db_unavailable?: boolean };
  /** 계약 v4 §A — 검증 전 값(parseRoute) */
  route?: unknown;
}

/** 등록 정보(static)·SIGMET 포함 여부 등 REST 상세 갱신 주기. 위치·속도는 WS selected 스트림이 실시간으로 준다. */
const DETAIL_REFRESH_MS = 30_000;
const EMERGENCY_SQUAWKS: ReadonlySet<string> = new Set(["7500", "7600", "7700"]);
const REASON_LABEL: Record<PredictionReason, string> = {
  turning: "선회 중(최근 트랙 변화 > 15°)", slow: "저속", on_ground: "지상", no_track: "속도/방위 없음", stale: "수신 지연",
};

/** 관측 시각(seen_at)이 더 새로운 상태. 같거나 비교할 수 없으면 앞의 것(REST full). */
function newerState(a: AircraftState | null, b: AircraftState | null): AircraftState | null {
  if (!a || !b) return a ?? b;
  const ta = seenAtMs(a.seen_at), tb = seenAtMs(b.seen_at);
  return tb != null && (ta == null || tb > ta) ? b : a;
}

function qualityLabel(q: number | null | undefined) {
  if (q == null) return "—";
  if (q === 0) return "0 · 통과";
  if (q === 1) return "1 · 경고(속도/방위 없음 → 보간 안 함)";
  return String(q);
}

function AirportLine({ a }: { a: RouteAirport }) {
  return (
    <span className="flex flex-col items-end">
      <span className="mono">{fmtAirportCodes(a)}</span>
      <span className="text-[11px] text-fg-2">{fmtAirportPlace(a)}</span>
    </span>
  );
}

/**
 * 노선 상태 줄(live 영역) — 상태가 무엇이든 RouteSection 이 늘 같은 role=status 요소 하나를 두고 글자만 바꾼다. 화면 읽기 프로그램은 영역이 생기는 순간
 * 함께 들어온 글자를 흔히 건너뛰므로, 영역을 "조회 중" 과 함께 새로 만들면 첫 "노선 조회 중" 이 읽히지 않을 수 있다(리뷰 2026-09-29).
 * - 경로를 모름(null): "—" · 찾음: 화면에는 없고 화면 읽기 프로그램에만 "노선 찾음"(조회 중 → 끝남을 알린다, 값은 아래 행)
 * - 조회 중(사용자 요청 2026-09-29 — 조회하고 있다는 느낌이 나게): 문구 · 콜사인. 움직이는 표시는 이 줄 아래 진행 막대(RouteLoading).
 *   aria-busy 조상 밖에 둔다(busy 안의 알림은 미뤄질 수 있다). 보통 경로 계산값(ROUTE_SLOW_AFTER_S)을 넘으면 "보통 경로 계산값(10 s)보다 오래 걸림"을
 *   덧붙인다(한 번 읽힘). 경과 초는 live 영역 밖(시각 표시만 — 매초 읽지 않게), 모르면(null) 쓰지 않는다.
 *   보이는 줄은 BUSY_APPEAR_DELAY_MS(선택값) 뒤에 나타난다(.busy-appear — 빨리 끝나는 조회가 번쩍이지 않게). live 영역은 그대로 DOM 에 있어 바로 읽힌다.
 * - 그 밖(없음 · 실패 · 꺼짐 · 콜사인 없음): 계약 v4 §A 문구 그대로.
 */
function RouteStatusLine({ route, pendingForS }: { route: RouteInfo | null; pendingForS: number | null }) {
  const pending = route?.status === "pending";
  const phase = routePendingPhase(pendingForS);
  const tone = route == null ? "text-fg-3" : pending ? (phase === "slow" ? "text-warn" : "text-fg-2") : route.status === "unavailable" ? "text-warn" : "text-fg-3";
  return (
    <div className={`flex items-center gap-1.5 text-[11px] ${route?.status === "found" ? "sr-only" : ""} ${pending ? "busy-appear" : ""}`}>
      <div role="status" className={`flex min-w-0 items-center gap-1.5 ${tone}`} data-testid="route-status" data-phase={pending ? phase : undefined} title={pending ? ROUTE_PENDING_TITLE : undefined}>
        {route == null ? "—"
          : route.status === "found" ? "노선 찾음"
          : <>
            <span>{ROUTE_STATUS_TEXT[route.status]}{pending && phase === "slow" ? ` — ${ROUTE_SLOW_TEXT}` : ""}</span>
            {route.callsign ? <span className="mono">· {route.callsign}</span> : null}
          </>}
      </div>
      {pending && pendingForS != null ? <span className="mono ml-auto shrink-0 text-fg-3" aria-hidden="true" data-testid="route-elapsed">{Math.floor(pendingForS)} s</span> : null}
    </div>
  );
}

/**
 * 조회 중(사용자 요청 2026-09-30 — 회전 사각형 대신): 상태 줄 아래 가는 진행 막대(값이 없는 indeterminate — 몇 % 라고 말하지 않는다)와
 * 찾은 뒤의 모양을 닮은 자리 표시(출발 · 도착마다 코드 줄 + 이름 줄 — AirportLine). 값이 채워질 자리만 aria-busy, 막대 · 자리 표시는 화면 읽기
 * 프로그램에서 숨긴다(공항 값을 지어 보이지 않는다). 묶음 전체가 BUSY_APPEAR_DELAY_MS 뒤에 나타난다(.busy-appear).
 */
function RouteLoading() {
  return (
    <div className="busy-appear" data-testid="route-loading">
      <span className="busy-bar mt-1" aria-hidden="true" data-testid="route-progress" />
      <div aria-busy="true" data-testid="route-skeleton">
        {["출발", "도착"].map((k) => (
          <div key={k} className="flex items-center justify-between gap-2 border-b border-line py-1" data-field={k}>
            <span className="shrink-0 text-fg-3">{k}</span>
            <span className="flex flex-col items-end gap-1 py-px" aria-hidden="true">
              <span className="skeleton h-3 w-24" />
              <span className="skeleton h-2.5 w-40" />
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * 노선(계약 v4 §A · ADR-016): 콜사인에 등록된 정기 노선 — 실제 운항 경로와 다를 수 있다고 적고, 판단 근거로 현재 위치와 노선 대권 경로 사이 거리(계산값)를 함께 보인다.
 * 상태별 문구는 계약 그대로. 노선이 맞다/틀리다를 판정해 붙이지 않는다. route 가 없으면(서버가 보내지 않음) "—".
 * pendingForS: 카드가 "조회 중"을 처음 본 때부터 지난 초(모르면 null).
 */
export function RouteSection({ route, pos, callsign, pendingForS = null }: { route: RouteInfo | null; pos: { lat: number; lon: number } | null; callsign: string | null; pendingForS?: number | null }) {
  const km = routeDistanceKm(route, pos);
  const rows: [string, React.ReactNode, string?][] = route?.status === "found" ? [
    ["출발", route.origin ? <AirportLine a={route.origin} /> : "—"],
    ...(route.midpoint ? [["경유", <AirportLine key="mid" a={route.midpoint} />] as [string, React.ReactNode]] : []),
    ["도착", route.destination ? <AirportLine a={route.destination} /> : "—"],
    ["항공사", fmtAirline(route.airline)],
    ["경로와의 거리", km == null ? "—" : <span key="km" className="mono">{fmtRouteKm(km)} · 계산값</span>,
      `마지막 관측 위치에서 출발→${route.midpoint ? "경유→" : ""}도착 대권 경로까지 가장 가까운 거리 — 구면 지구(반지름 ${EARTH_RADIUS_KM.toLocaleString("en-US")} km) 계산값입니다. 실제 비행 경로와의 거리가 아닙니다.`],
    ["조회 콜사인", <span key="cs" className="mono">{route.callsign ?? "—"}</span>],
    ["조회 시각", <KstTime key="at" v={route.fetched_at} />],
  ] : [];
  const otherSource = route?.source != null && route.source !== "adsbdb";
  return (
    <div className="mt-2" data-testid="route-section" data-status={route?.status ?? "unknown"}>
      <div className="label mb-0.5">{ROUTE_TITLE}</div>
      <RouteStatusLine route={route} pendingForS={pendingForS} />
      {route?.status === "pending" ? <RouteLoading />
        : route?.status !== "found" ? null
        : <>
          {rows.map(([k, val, title]) => (
            <div key={k} className="flex justify-between gap-2 border-b border-line py-1" data-testid="route-row" data-field={k}>
              <span className="shrink-0 text-fg-3" title={title}>{k}</span><span className="text-right" title={title}>{val}</span>
            </div>
          ))}
          {routeCallsignMismatch(route, callsign) ? (
            <div className="mt-1 text-[11px] text-warn" data-testid="route-callsign-mismatch">노선 조회 콜사인 {route.callsign} — 지금 콜사인 {callsign?.trim()} 과 다름</div>
          ) : null}
          <div className="mt-1 text-[11px] text-fg-2" data-testid="route-caveat">{ROUTE_CAVEAT}</div>
          <div className="mt-0.5 text-[10px] text-fg-3" data-testid="route-attribution">
            출처 {otherSource ? route.source : <><a href={ROUTE_SOURCE_URL} target="_blank" rel="noopener noreferrer" className="text-fg-2 hover:text-fg">adsbdb.com</a>{ROUTE_ATTRIBUTION_TAIL}</>}
          </div>
        </>}
    </div>
  );
}

/**
 * 항공기 상세(FR-05): 호출부호·등록·기종·고도·속도·수직속도·squawk·출처·수신 시각. 값이 없으면 "—"(기본값으로 채우지 않는다).
 * 고도·지상속도·수직속도는 두 단위(계약 v5 §A — ft·kt·ft/min 과 m·km/h·m/s).
 * 경과·stale·외삽은 서버 기준 시각으로 — 지도(워커)·툴팁과 같은 기준(WS-3 · DH-1). 지상이면 고도 대신 GND(DH-3).
 */
export function AircraftCard({ hex }: { hex: string }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<{ hex: string; msg: string; error?: unknown } | null>(null);
  const [refresh, setRefresh] = useState(0);
  const select = useUi((s) => s.select);
  const selected = useServerData((x) => (x.selected && x.selected.hex === hex ? x.selected : null));
  const alertsMap = useServerData((x) => x.alerts);
  const now = useServerNow(1000);
  const wall = useNow(1000);
  const demand = useServerData((x) => x.demand);
  const conn = useServerData((x) => x.conn);
  const lastRxAt = useServerData((x) => x.lastRxAt);
  useEffect(() => {
    const t = setInterval(() => setRefresh((n) => n + 1), DETAIL_REFRESH_MS);
    return () => clearInterval(t);
  }, [hex]);
  useEffect(() => {
    let live = true;
    apiGet<Detail>(`/api/v1/aircraft/${encodeURIComponent(hex)}`)
      .then((x) => { if (live) { setDetail(x); setError(null); } })
      .catch((e: Error) => { if (live) setError({ hex, msg: String(e.message), error: e }); });
    return () => { live = false; };
  }, [hex, refresh]);
  // 다른 항공기로 바뀐 직후 이전 응답을 보여주지 않는다
  const d = detail && detail.hex?.toLowerCase() === hex.toLowerCase() ? detail : null;
  const err = error && error.hex === hex ? error.msg : null;
  // 상태: WS selected(변할 때마다 오는 full 상태)가 있으면 그것. selected.state=null 이면 스냅샷에 더 이상 없다.
  // 아직 selected 가 없으면 REST 상세와 지도 스냅샷 사본 중 관측 시각이 더 새로운 것.
  const s: AircraftState | null = selected ? selected.state : newerState(d?.state ?? null, aircraftStates.get(hex) ?? null);
  const gone = selected != null && selected.state == null;
  const r = s && now ? predict(s, now) : null;
  const age = r?.age_s == null ? null : Math.round(r.age_s);
  const seen = seenAtMs(s?.seen_at);
  const emergency = s?.squawk != null ? EMERGENCY_SQUAWKS.has(s.squawk) : d?.emergency === true;
  const activeAlerts = useMemo(() => [...alertsMap.values()].filter((a) => a.hex === hex), [alertsMap, hex]);
  const pred = selected?.prediction ?? null;
  // 노선: WS selected(변할 때마다) → 없으면 REST 상세(30 s 마다)
  const restRoute = useMemo(() => parseRoute(d?.route), [d]);
  const route = selected?.route ?? restRoute;
  // "조회 중"을 이 항공기 · 콜사인으로 처음 본 때부터의 경과(브라우저 시계 — 카드 안의 경과만 잰다)
  const routePendingForS = useElapsedSince(route?.status === "pending" ? `${hex}|${route.callsign ?? ""}` : null, wall);
  // 집중 추적(ADR-013): 서버가 이 hex 에 대해 보고한 상태·주기만. 연결이 실시간이 아니면 상태를 말하지 않는다.
  const live = isRxFresh(conn, lastRxAt, wall);
  const chip = live ? focusChip(demand, hex, now) : null;
  const rows: [string, React.ReactNode][] = [
    ["Callsign", <span key="cs" className="mono">{s?.callsign ?? "—"}</span>],
    ["ICAO24", <span key="hex" className="mono">{hex}</span>],
    ["등록번호", <span key="reg" className="mono">{d?.static?.registration ?? s?.registration ?? "—"}</span>],
    ["기종 코드", <span key="type" className="mono">{d?.static?.type_code ?? s?.type_code ?? "—"}</span>],
    ["카테고리", d?.static?.category ?? s?.category ?? "—"],
    ["고도", <span key="alt" className="mono">{fmtAltGndDual(s?.alt_ft, s?.on_ground)}</span>],
    ["지상속도", <span key="gs" className="mono">{fmtGsDual(s?.gs_kt)}</span>],
    ["방위", <span key="trk" className="mono">{fmtNum(s?.track_deg, "°")}</span>],
    ["수직속도", <span key="vr" className="mono">{fmtVrateDual(s?.vrate_fpm)}</span>],
    ["Squawk", <span key="sq" className={`mono ${emergency ? "text-bad" : ""}`}>{s?.squawk ?? "—"}{emergency ? " EMERGENCY" : ""}</span>],
    ["지상", fmtBool(s?.on_ground)],
    ["출처", s?.provider ?? "—"],
    ["관측 시각", <span key="seen"><KstTime v={seen} />{age != null ? <span className="mono"> ({fmtDuration(age)} 전)</span> : null}</span>],
    ["수신 시각", <KstTime key="fetched" v={s?.fetched_at ?? d?.meta?.fetched_at} />],
    ["품질", qualityLabel(s?.quality)],
    ["10분 예측", pred == null ? "—" : pred.available ? "가능 · 지도 점선(추정)" : `안 함 · ${pred.reason ? REASON_LABEL[pred.reason] : "—"}`],
  ];
  return (
    <div className="flex h-full flex-col" data-testid="aircraft-card">
      <div className="row">
        <span className="label">Aircraft</span>
        <div className="flex items-center gap-2">
          {gone ? <span className="badge warn" data-testid="aircraft-gone">스냅샷에 없음 · 수신 중단</span> : null}
          {r?.estimated ? <span className="badge est">{r.capped ? "위치 추정 상한 도달 · STALE" : "지도 위치 추정 · dead reckoning"}</span> : null}
          {r && r.stale && !r.capped ? <span className="badge warn">STALE · 수신 지연</span> : null}
          <button className="btn" onClick={() => select(null)}>닫기</button>
        </div>
      </div>
      <div className="flex items-center gap-2 border-b border-line px-2 py-1 text-[11px]" data-testid="demand-row">
        <span className="text-fg-3">갱신</span>
        {chip ? <DemandBadge chip={chip} testId="demand-chip" />
          : <span className="text-fg-3" data-testid="demand-chip-none">{live ? "집중 추적 상태 수신 전" : "연결이 실시간이 아님 — 집중 추적 상태 모름"}</span>}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-1 text-[12px]">
        {err ? <div className="text-[11px] text-bad" data-testid="aircraft-detail-error">상세(REST) 조회 실패 — 마지막으로 받은 값만 표시 ({err}<RequestIdOf error={error?.error} />)</div> : null}
        {d?.meta?.db_unavailable ? <div className="text-[11px] text-warn">등록 정보 DB 일시 사용 불가 — 등록번호·기종은 “—”</div> : null}
        {rows.map(([k, val]) => (
          <div key={k} className="flex justify-between gap-2 border-b border-line py-1"><span className="shrink-0 text-fg-3">{k}</span><span className="text-right">{val}</span></div>
        ))}
        <RouteSection route={route} pos={s ? { lat: s.lat, lon: s.lon } : null} callsign={s?.callsign ?? null} pendingForS={routePendingForS} />
        {activeAlerts.length ? (
          <div className="mt-2 space-y-1">
            <div className="label">Active alerts</div>
            {activeAlerts.map((a) => <EvidenceCard key={a.id} a={a} />)}
          </div>
        ) : <div className="mt-2 text-[11px] text-fg-3">활성 알림 없음</div>}
        <div className="mt-2 text-[10px] text-fg-3">항적 선은 DB 기록(최근 2 h)에 실시간 관측을 이어 붙인 것입니다. 선택한 동안은 서버 수집기가 이 항공기를 따로 조회하므로(집중 추적) 위 칩에 보이는 서버 보고 주기로 점이 촘촘해집니다. 점선 궤적은 서버가 예측 가능하다고 판단할 때만 그리는 10분 dead reckoning 추정입니다.</div>
      </div>
    </div>
  );
}
