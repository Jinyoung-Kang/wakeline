"use client";
import { useEffect, useRef, useState } from "react";
import { apiGet } from "@/lib/api";
import { useServerNow } from "@/lib/clock";
import { ageS, fmtDuration, fmtIso, fmtSogDual, fmtTime } from "@/lib/format";
import {
  fmtDraught, fmtShipEta, LAST_SEEN_TITLE, notLiveText, fmtShipSize, fmtShipType, GAP_BREAK_MIN_MS, gapDurationS, gapSummary, imoField, isMmsi, navStatusLabel,
  parseDestinationInfo, parseShipState, parseShipStatic, pickDestinationInfo, positionBadge, positionSourceLabel, ROT_LABEL, SHIP_CATEGORY_CODES,
  SHIP_CATEGORIES, SHIP_SORT_DEFAULT, SHIP_STALE_S, SHIP_TRACK_HOURS, SHIP_TRACK_WINDOW_MS, shipAgeS, shipCategory, shipDestinationLines, shipList, shipOriginText, shipRotation, shipRowFromLite, shipsChip, SHIPS_RULE_TEXT, sortShipRows,
  type DestinationInfo, type ShipCategory, type ShipSort, type ShipSortKey, type ShipState, type ShipStatic,
} from "@/lib/ships";
import { shipStates, useServerData } from "@/lib/store";
import { saveLayers } from "@/lib/prefs";
import { panIfOutside, shipPos } from "@/lib/focus";
import { useUi } from "@/lib/ui-store";
import { ShipTable } from "./ShipTable";

/**
 * REST /ships/{mmsi} 상세. first_recorded_at = 이 서비스가 이 MMSI 를 처음 기록한 시각, last_position_at = DB 에 저장된 마지막 위치 시각
 * (보존 72 h 안 — 없으면 null), last_seen_at = 실시간이 아닐 때의 마지막 수신 기록(계약 v5 §G4 — 없으면 null). 계약 v5 §B3 카드 행.
 */
export interface ShipDetail {
  mmsi: string; state: ShipState | null; static: ShipStatic | null; destination_info: DestinationInfo | null; db_unavailable: boolean;
  first_recorded_at: string | null; last_position_at: string | null; last_seen_at: string | null;
}

const isoOrNull = (v: unknown) => (typeof v === "string" && v.length <= 40 && !Number.isNaN(Date.parse(v)) ? v : null);

/** REST /ships/{mmsi} 응답 검증(모양이 다르면 null — 모르는 값을 채우지 않는다) */
export function parseShipDetail(mmsi: string, r: unknown): ShipDetail {
  const o = typeof r === "object" && r !== null ? (r as Record<string, unknown>) : {};
  const st = parseShipState(typeof o.state === "object" && o.state !== null ? { mmsi, ...(o.state as object) } : null);
  const sx = parseShipStatic(typeof o.static === "object" && o.static !== null ? { mmsi, ...(o.static as object) } : null);
  const meta = typeof o.meta === "object" && o.meta !== null ? (o.meta as Record<string, unknown>) : {};
  return {
    mmsi, state: st?.mmsi === mmsi ? st : null, static: sx?.mmsi === mmsi ? sx : null,
    destination_info: parseDestinationInfo(o.destination_info), db_unavailable: meta.db_unavailable === true,
    first_recorded_at: isoOrNull(o.first_recorded_at), last_position_at: isoOrNull(o.last_position_at), last_seen_at: isoOrNull(o.last_seen_at),
  };
}

/** 관측 시각이 더 새로운 상태(같거나 비교할 수 없으면 앞의 것) */
function newer(a: ShipState | null, b: ShipState | null): ShipState | null {
  if (!a || !b) return a ?? b;
  const ta = a.seen_at ? Date.parse(a.seen_at) : NaN, tb = b.seen_at ? Date.parse(b.seen_at) : NaN;
  return !Number.isNaN(tb) && (Number.isNaN(ta) || tb > ta) ? b : a;
}

/**
 * 선박 상세(계약 v2 §B4 · v4 §B): 선박명·MMSI·호출부호·IMO·선종(코드+분류)·크기(A+B × C+D, 보고값)·흘수·출발지(보고)·목적지(보고, 원문 + UN/LOCODE 풀이)·ETA(선원 입력값, 연도 없음)·
 * 속력(kn · km/h, 계약 v5 §A)/침로/선수방위·항해 상태·위치 출처·관측 시각(경과). 값이 없으면 "—". 정적 정보는 선원이 입력한 보고값이다(검증하지 않은 값).
 * 상태: WS ship_selected(바뀔 때마다) → 없으면 REST 상세 → 없으면 지도 목록 사본 중 관측이 가장 새로운 것. 경과는 서버 기준 시각.
 */
export function ShipCard({ mmsi }: { mmsi: string }) {
  const [detail, setDetail] = useState<ShipDetail | null>(null);
  const [error, setError] = useState<{ mmsi: string; msg: string } | null>(null);
  const loaded = useRef<ShipDetail | null>(null);
  const now = useServerNow(1000);
  // WS 가 "실시간 목록에 없음(state null)"이라고 하면 상세를 다시 받는다 — 카드를 연 뒤 목록에서 빠진 선박의 '마지막 저장 위치'가
  // 연 때의 값에 머물지 않게(계약 v5 §B3). 이미 받은 상세도 실시간이 아니라고 했으면 같은 사실이라 다시 받지 않는다
  const gone = useServerData((x) => x.shipSelected != null && x.shipSelected.mmsi === mmsi && x.shipSelected.state == null);
  useEffect(() => {
    const have = loaded.current;
    if (gone && have?.mmsi === mmsi && have.state == null) return;
    let alive = true;
    apiGet<unknown>(`/api/v1/ships/${encodeURIComponent(mmsi)}`)
      .then((r) => { if (alive) { const p = parseShipDetail(mmsi, r); loaded.current = p; setDetail(p); setError(null); } })
      .catch((e: Error) => { if (alive) setError({ mmsi, msg: String(e.message) }); });
    return () => { alive = false; };
  }, [mmsi, gone]);
  const d = detail && detail.mmsi === mmsi ? detail : null;
  const err = error && error.mmsi === mmsi ? error.msg : null;
  return <ShipCardView mmsi={mmsi} detail={d} error={err} now={now} />;
}

/** 표시 부분(REST 상세·오류·서버 기준 시각을 인자로 — 서버 렌더 시험용) */
export function ShipCardView({ mmsi, detail: d, error: err, now }: { mmsi: string; detail: ShipDetail | null; error: string | null; now: number }) {
  const selectShip = useUi((s) => s.selectShip);
  const live = useServerData((x) => (x.shipSelected && x.shipSelected.mmsi === mmsi ? x.shipSelected : null));
  const track = useServerData((x) => (x.shipTrack && x.shipTrack.mmsi === mmsi ? x.shipTrack : null));
  useServerData((x) => x.ships.version); // 지도 목록 사본이 바뀌면 다시 그린다
  const trackHours = useUi((s) => s.shipTrackHours);
  const setTrackHours = useUi((s) => s.setShipTrackHours);
  const lite = shipStates.get(mmsi) ?? null;
  // WS 가 "목록에 없음(state null)"이라고 했으면 그것이 가장 최신 판단
  const gone = live != null && live.state == null;
  const full = newer(live?.state ?? null, d?.state ?? null);
  const pos = newer(full, lite ? { ...lite, rot: null, provider: null, msg_type: null, class: null } : null);
  // 위치·속도는 가장 새 관측, 등급·출처는 full 상태에서(지도 목록 사본 ShipLite 에는 없다)
  const s: ShipState | null = gone || !pos ? null : { ...pos, class: pos.class ?? full?.class ?? null, provider: pos.provider ?? full?.provider ?? null };
  const st: ShipStatic | null = live?.static ?? d?.static ?? null;
  const age = shipAgeS(s?.seen_at, now);
  const stale = age != null && age > SHIP_STALE_S;
  const pb = positionBadge(s?.position_source);
  const rot = s ? shipRotation(s) : null;
  // 공백 요약: 기록 조회에 성공했거나(0회도 근거 있음) 선택 뒤 받은 공백이 있을 때만
  const gaps = track && ((track.loaded && !track.error) || track.gaps.length) ? gapSummary(track.gaps, track.fromMs ?? -Infinity, now > 0 ? now : Infinity) : null;
  // 문구의 기간은 받은 항적의 창(선택 버튼은 다음에 받을 창)
  const hours = track?.hours ?? SHIP_TRACK_WINDOW_MS / 3600_000;
  const savedAge = ageS(d?.last_position_at, now);
  const heardAge = ageS(d?.last_seen_at, now);
  // 실시간 상태가 없고 상세(REST)도 실시간이 아니라고 했으면 "실시간 아님 · 마지막 수신 hh:mm · 마지막 저장 hh:mm"(계약 v5 §B3 · §G4) — 위치를 지어내지 않는다.
  // 검색에서 실시간이 아닌 선박을 고르면 서버가 곧바로 ship_selected{state:null} 로 답하므로 gone 이어도 같은 문구.
  // 상세가 아직 없거나 상세를 받은 뒤 목록에서 빠졌으면(상세의 저장 시각이 옛 값일 수 있다 — ShipCard 가 다시 받는다) gone 배지만
  const notLive = s == null && d != null && d.state == null;
  const code = st?.ship_type ?? s?.ship_type ?? null;
  const name = st?.name ?? s?.name ?? null;
  const imo = imoField(st?.imo);
  // 목적지 풀이(api 결정적 규칙): 보이는 원문과 같은 원문을 풀이한 것만(WS → REST 순)
  const destInfo = pickDestinationInfo(st?.destination, live?.destination_info, d?.destination_info);
  const dest = shipDestinationLines(destInfo, st?.destination);
  // [표시 이름, 값, 설명(title), 시험용 필드 이름(없으면 표시 이름)]
  const rows: [string, React.ReactNode, string?, string?][] = [
    ["선박명", name ?? "—"],
    ["MMSI", <span key="m" className="mono">{mmsi}</span>],
    ["호출부호", <span key="cs" className="mono">{st?.call_sign ?? "—"}</span>],
    [imo.label, <span key="imo" className="mono">{imo.value}</span>, "AIS 정적 보고의 IMO 칸: 1,000,000–9,999,999 = IMO 번호, 10,000,000 이상 = 기국 공식 번호(USCG NAVCEN)", "IMO"],
    ["선종", fmtShipType(code), `분류 코드 ${SHIP_CATEGORY_CODES[shipCategory(code)]} (USCG AIS Guide)`],
    ["크기", fmtShipSize(st), "길이 A+B × 폭 C+D — 안테나 기준 보고값"],
    ["흘수", fmtDraught(st?.draught_m)],
    ["출발지(보고)", shipOriginText(destInfo, st?.destination), "AIS 에는 출발지 항목이 없습니다. 선원이 목적지 칸에 'A>B' 로 적었을 때만 A 를 보고된 출발지로 읽습니다(api 결정적 규칙 — 추정하지 않음)"],
    ["목적지(보고)", dest.raw == null ? "—" : (
      <span key="dest" className="flex flex-col items-end" data-testid="ship-dest">
        <span className="mono">“{dest.raw}”</span>
        {dest.lines.map((l, i) => <span key={i} className="text-[11px] text-fg-2">{l}</span>)}
      </span>
    ), "선원이 입력한 목적지 원문(검증하지 않은 보고값)과 UN/LOCODE 풀이 — 항구(1)·내륙항(8) 항목만, 규칙으로만 읽고 추정하지 않음"],
    ["ETA", fmtShipEta(st)],
    ["속력/침로/선수방위", (
      <span key="mo" className="flex flex-col items-end">
        <span className="mono" data-testid="ship-sog">{fmtSogDual(s?.sog_kn)}</span>
        <span className="mono text-[11px] text-fg-2">침로 {s?.cog_deg == null ? "—" : `${s.cog_deg.toFixed(1)}°`} · 선수방위 {s?.heading_deg == null ? "—" : `${s.heading_deg.toFixed(0)}°`}</span>
      </span>
    ), "대지속력(SOG, kn · km/h) / 대지침로(COG) / 선수방위(HDG) — 선박 보고값. km/h 는 1 kn = 1.852 km/h 로 바꾼 값"],
    ["항해 상태", navStatusLabel(s?.nav_status)],
    ["위치 출처", positionSourceLabel(s?.position_source), "보고의 Timestamp 필드 — 0–59 전자 위치 장치(종류는 모름) · 61 수동 · 62 추측항법 · 63 장치 비작동 · 60(값 없음)은 —"],
    ["AIS 등급", s?.class ? `Class ${s.class}` : "—"],
    ["관측 시각", <span key="seen" className="mono" title={fmtIso(s?.seen_at)}>{fmtTime(s?.seen_at)}{age != null ? ` (${fmtDuration(age)} 전)` : ""}</span>],
    ["처음 기록", <span key="first" className="mono" title={fmtIso(d?.first_recorded_at)}>{fmtTime(d?.first_recorded_at)}</span>,
      "이 서비스(Wakeline)가 이 MMSI 를 처음 기록한 시각 — 선박의 건조·취항 시각이 아님"],
    ["마지막 저장 위치", <span key="last" className="mono" title={fmtIso(d?.last_position_at)}>{fmtTime(d?.last_position_at)}{savedAge != null ? ` (${fmtDuration(savedAge)} 전)` : ""}</span>,
      "DB 에 저장된 마지막 위치의 시각(60 s 에 1점, 보존 72 h — 그보다 오래됐거나 없으면 —). 카드를 열 때(실시간 목록에서 빠지면 그때 다시) 받은 값 — 실시간 선박은 그 뒤에도 계속 저장됩니다"],
    // 계약 v5 §G4: 실시간 상태가 없을 때만 — 실시간이면 '관측 시각'이 마지막 수신이다
    ...(s == null ? [["마지막 수신", <span key="heard" className="mono" title={fmtIso(d?.last_seen_at)}>{fmtTime(d?.last_seen_at)}{heardAge != null ? ` (${fmtDuration(heardAge)} 전)` : ""}</span>,
      `${LAST_SEEN_TITLE}. 위치 보존(72 h)이 지나도 남습니다`] as [string, React.ReactNode, string]] : []),
    ["출처", s?.provider ?? st?.provider ?? "—"],
  ];
  return (
    <div className="flex h-full flex-col" data-testid="ship-card">
      <div className="row">
        <span className="label">Ship</span>
        <div className="flex flex-wrap items-center justify-end gap-1">
          {gone && !notLive ? <span className="badge warn" data-testid="ship-gone">실시간 목록에 없음 · 30분 넘게 수신 없음</span> : null}
          {notLive ? <span className="badge warn normal-case!" data-testid="ship-not-live" title={`실시간 선박 목록(AIS)에 없습니다 — 지도에 위치를 그리지 않습니다. 마지막 수신 기록 ${fmtIso(d?.last_seen_at)} · 마지막 저장 위치 시각 ${fmtIso(d?.last_position_at)}`}>
            {notLiveText({ lastSeenAt: d?.last_seen_at, lastPositionAt: d?.last_position_at }, now)}</span> : null}
          {stale ? <span className="badge warn" data-testid="ship-stale">STALE · 15분 넘게 위치 없음</span> : null}
          {pb ? <span className={`badge ${pb.tone === "est" ? "est" : "warn"}`} data-testid="ship-pos-badge">{pb.text}</span> : null}
          {rot && rot.mode !== "heading" ? <span className="badge">{ROT_LABEL[rot.mode]}</span> : null}
          <button className="btn" onClick={() => selectShip(null)}>닫기</button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-1 text-[12px]">
        {err ? <div className="text-[11px] text-bad" data-testid="ship-detail-error">상세(REST) 조회 실패 — 실시간으로 받은 값만 표시 ({err})</div> : null}
        {d?.db_unavailable ? <div className="text-[11px] text-warn">선박 정보 DB 일시 사용 불가 — 정적 정보는 “—”일 수 있음</div> : null}
        {rows.map(([k, val, title, field]) => (
          <div key={field ?? k} className="flex justify-between gap-2 border-b border-line py-1" data-testid="ship-row" data-field={field ?? k}>
            <span className="shrink-0 text-fg-3" title={title}>{k}</span><span className="text-right">{val}</span>
          </div>
        ))}
        <div className="mt-2" data-testid="ship-track-info">
          <div className="mb-0.5 flex items-center justify-between gap-2">
            <span className="label normal-case!">항적 · 최근 {hours} h</span>
            {/* 기간(계약 v5 §B3): 바꾸면 지도가 그 창으로 다시 받는다(REST ≤ 24 h) */}
            <span className="flex gap-1" role="group" aria-label="항적 기간">
              {SHIP_TRACK_HOURS.map((h) => (
                <button key={h} type="button" className="btn px-1.5 py-0 text-[10px] normal-case!" aria-pressed={trackHours === h} onClick={() => setTrackHours(h)} data-testid={`ship-track-hours-${h}`}>{h} h</button>
              ))}
            </span>
          </div>
          {track == null || !track.loaded ? <div className="text-[11px] text-fg-3">항적 불러오는 중…</div>
            : track.error ? <div className="text-[11px] text-warn">기록 조회 실패 — 선택한 뒤 받은 관측만 이어 그립니다 ({track.error})</div>
            : <div className="text-[11px] text-fg-2">기록 구간 {track.segments}개 · 60 s 에 1점(저장 기준) + 실시간 관측</div>}
          <div className="text-[10px] text-fg-3">항적 점에 마우스를 올리면 시각(UTC)·속력·침로·항해 상태(보고값, 없으면 —)</div>
          {gaps ? (
            <div className="mt-1 text-[11px]" data-testid="ship-gap-summary">
              <div className={gaps.count ? "text-warn" : "text-fg-2"}>
                {track?.error ? "선택 뒤 받은 수신 공백" : `최근 ${hours} h 수신 공백`} {gaps.count}회{track?.gapsTruncated ? " 이상(최신 목록만)" : ""} · 합계 {gaps.closedS} s
                {track?.error ? ` (기록 조회 실패 — ${hours} h 전체가 아님)` : ""}
                {gaps.openSinceMs != null ? ` · 진행 중 1회(지금까지 ${now ? fmtDuration((now - gaps.openSinceMs) / 1000) : "—"})` : ""}
              </div>
              <div className="text-fg-3">{GAP_BREAK_MIN_MS / 1000} s 이상 공백에서만 선을 끊습니다(저장 간격 60 s)</div>
            </div>
          ) : null}
          {track?.gaps.length ? (
            <ul className="mt-1 space-y-0.5 text-[11px] text-warn" data-testid="ship-gaps">
              {track.gaps.slice(-5).map((g) => {
                const dur = gapDurationS(g);
                return (
                  <li key={`${g.started_at}-${g.ended_at ?? "open"}`} className="mono">
                    수신 공백 {fmtTime(g.started_at)} – {g.ended_at ? fmtTime(g.ended_at) : "진행 중"}{dur != null ? ` · ${dur} s` : ""}{g.reason ? ` · ${g.reason}` : ""}
                  </li>
                );
              })}
            </ul>
          ) : null}
        </div>
        <div className="mt-2 text-[10px] text-fg-3">
          선박명·호출부호·크기·흘수·목적지·ETA 는 선박이 AIS 로 보낸 보고값(선원 입력)이며 검증하지 않았습니다. ETA 에는 연도가 없습니다.
          출발지(보고)는 선원이 목적지 칸에 “A&gt;B” 로 적은 경우의 A 이고, 항구 이름·국가는 UN/LOCODE 코드 모양일 때만 풀이합니다.
          아이콘은 선수방위, 없으면 침로(점선 외곽), 둘 다 없으면 방향 없는 원입니다. 지도 위 선은 기록된 위치를 이은 것이고, 회색 점선은 그 사이 위치를 모르는 공백입니다.
        </div>
      </div>
    </div>
  );
}

/** 선박이 선택되지 않았을 때: 지도 없이 고르는 목록(키보드·스크린리더) + 상태 안내 */
export function ShipPanel() {
  const selected = useUi((s) => s.selectedShip);
  const shipsOn = useUi((s) => s.layers.ships);
  const shipCats = useUi((s) => s.shipCats);
  return <ShipPanelView selected={selected} shipsOn={shipsOn} shipCats={shipCats} />;
}

/** 표시 부분(선택·레이어·선종 필터를 인자로 — 서버 렌더 시험용) */
export function ShipPanelView({ selected, shipsOn, shipCats = SHIP_CATEGORIES }: { selected: string | null; shipsOn: boolean; shipCats?: readonly ShipCategory[] }) {
  const toggle = useUi((s) => s.toggleLayer);
  if (selected && isMmsi(selected)) return <ShipCard mmsi={selected} />;
  if (!shipsOn) {
    return (
      <div className="p-3 text-[11px] text-fg-3" data-testid="ship-panel-off">
        선박 레이어가 꺼져 있습니다. <button className="btn ml-1" onClick={() => { toggle("ships"); saveLayers(useUi.getState().layers); }}>선박 켜기</button>
      </div>
    );
  }
  return <ShipList shipCats={shipCats} />;
}

/** 화면 안 선박 표에 한 번에 보이는 줄 수 — 정렬한 뒤 앞에서부터 */
const SHIP_LIST_MAX = 50;

/**
 * 화면 안 선박(계약 v5 §B3): 정렬 가능한 표(선종 색 · 선명 · MMSI · 속력 kn/km/h · 항해 상태 · 경과) — 검색 결과와 같은 표(ShipTable).
 * 선종 필터는 지도와 같게 적용하고 숨긴 수를 적는다.
 */
function ShipList({ shipCats }: { shipCats: readonly ShipCategory[] }) {
  const view = useServerData((x) => x.ships);
  const ais = useServerData((x) => x.ais);
  const viewport = useServerData((x) => x.viewport);
  const aisOff = ais?.state === "disabled";
  const selectShip = useUi((s) => s.selectShip);
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<ShipSort>(SHIP_SORT_DEFAULT);
  const now = useServerNow(1000);
  if (view.mode !== "points") {
    return (
      <div className="p-3 text-[11px] text-fg-3" data-testid="ship-list-empty">
        {view.mode === "grid" ? <>
          지금은 격자(선박 수)로 표시 중입니다 — 확대해서 개별 표시가 되면 선박을 고를 수 있습니다. 이름·MMSI 로 찾으려면 상단 검색(/ 키)을 쓰세요.
          <div className="mt-1">{SHIPS_RULE_TEXT}</div>
        </> : aisOff ? "AIS 수집이 꺼져 있습니다(aisstream.io 키 없음 — 운영 설정). 선박 데이터가 오지 않습니다." : "선박 수신 대기 중…"}
      </div>
    );
  }
  // 화면 안 0척이면 칩과 같은 이유 문구(수신국 없는 해역 · 수신 범위 밖 · AIS 꺼짐 · 연결 안 됨 · 상태 모름)
  const zero = shipsChip(view, { zoom: viewport?.zoom ?? null, bbox: viewport?.bbox ?? null, ais });
  // 목록 계산은 렌더 중 — 화면 안 선박(서버 상한 5 000)만이라 가볍다
  const filtered = shipCats.length < SHIP_CATEGORIES.length;
  const { items, total, hidden } = shipList(shipStates.values(), q, Infinity, filtered ? new Set(shipCats) : null);
  const rows = sortShipRows(items.map(shipRowFromLite), sort, now).slice(0, SHIP_LIST_MAX);
  const onSort = (k: ShipSortKey) => setSort((cur) => (cur.key === k ? { key: k, dir: cur.dir === "asc" ? "desc" : "asc" } : { key: k, dir: k === "age" || k === "sog" ? "desc" : "asc" }));
  return (
    <div className="flex h-full flex-col" data-testid="ship-list">
      <div className="row">
        <span className="label">화면 안 선박 {view.count}{filtered ? <span className="text-warn normal-case" data-testid="ship-list-cat-filter"> · 선종 필터 {shipCats.length}/{SHIP_CATEGORIES.length} · {hidden}척 숨김</span> : null}</span>
        <input value={q} onChange={(e) => setQ(e.target.value.slice(0, 32))} placeholder="이름·MMSI" aria-label="선박 이름 또는 MMSI 로 거르기" className="w-40" data-testid="ship-list-filter" />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {rows.length ? (
          <ShipTable rows={rows} now={now} sort={sort} onSort={onSort} testId="ship-list" onPick={(r) => { selectShip(r.mmsi); panIfOutside(shipPos(r.mmsi)); }} />
        ) : null}
        {total > rows.length ? <div className="px-2 py-1 text-[11px] text-fg-3" data-testid="ship-list-more">정렬 앞 {rows.length}척만 표시 · 외 {total - rows.length}척 — 이름·MMSI 로 거르세요</div> : null}
        {total === 0 ? <div className="px-2 py-1 text-[11px] text-fg-3" data-testid="ship-list-none">{shipStates.size ? "조건에 맞는 선박 없음" : zero?.text ?? "화면 안에 선박 없음"}</div> : null}
      </div>
    </div>
  );
}
