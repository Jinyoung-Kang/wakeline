"use client";
import { useEffect, useState } from "react";
import { apiGet } from "@/lib/api";
import { useServerNow } from "@/lib/clock";
import { fmtDuration, fmtIso, fmtTime } from "@/lib/format";
import {
  fmtDraught, fmtMotion, fmtShipEta, fmtShipSize, fmtShipType, GAP_BREAK_MIN_MS, gapDurationS, gapSummary, imoField, isMmsi, navStatusLabel,
  parseDestinationInfo, parseShipState, parseShipStatic, pickDestinationInfo, positionBadge, positionSourceLabel, ROT_LABEL, SHIP_CATEGORY_CODES,
  SHIP_STALE_S, shipAgeS, shipCategory, shipDestinationLines, shipList, shipOriginText, shipRotation, shipsChip, SHIPS_RULE_TEXT,
  type DestinationInfo, type ShipState, type ShipStatic,
} from "@/lib/ships";
import { shipStates, useServerData } from "@/lib/store";
import { saveLayers } from "@/lib/prefs";
import { panIfOutside, shipPos } from "@/lib/focus";
import { useUi } from "@/lib/ui-store";

interface Detail { mmsi: string; state: ShipState | null; static: ShipStatic | null; destination_info: DestinationInfo | null; db_unavailable: boolean }

/** REST /ships/{mmsi} 응답 검증(모양이 다르면 null — 모르는 값을 채우지 않는다) */
function parseDetail(mmsi: string, r: unknown): Detail {
  const o = typeof r === "object" && r !== null ? (r as Record<string, unknown>) : {};
  const st = parseShipState(typeof o.state === "object" && o.state !== null ? { mmsi, ...(o.state as object) } : null);
  const sx = parseShipStatic(typeof o.static === "object" && o.static !== null ? { mmsi, ...(o.static as object) } : null);
  const meta = typeof o.meta === "object" && o.meta !== null ? (o.meta as Record<string, unknown>) : {};
  return {
    mmsi, state: st?.mmsi === mmsi ? st : null, static: sx?.mmsi === mmsi ? sx : null,
    destination_info: parseDestinationInfo(o.destination_info), db_unavailable: meta.db_unavailable === true,
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
 * 속력/침로/선수방위·항해 상태·위치 출처·관측 시각(경과). 값이 없으면 "—". 정적 정보는 선원이 입력한 보고값이다(검증하지 않은 값).
 * 상태: WS ship_selected(바뀔 때마다) → 없으면 REST 상세 → 없으면 지도 목록 사본 중 관측이 가장 새로운 것. 경과는 서버 기준 시각.
 */
export function ShipCard({ mmsi }: { mmsi: string }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<{ mmsi: string; msg: string } | null>(null);
  const selectShip = useUi((s) => s.selectShip);
  const live = useServerData((x) => (x.shipSelected && x.shipSelected.mmsi === mmsi ? x.shipSelected : null));
  const track = useServerData((x) => (x.shipTrack && x.shipTrack.mmsi === mmsi ? x.shipTrack : null));
  useServerData((x) => x.ships.version); // 지도 목록 사본이 바뀌면 다시 그린다
  const now = useServerNow(1000);
  useEffect(() => {
    let alive = true;
    apiGet<unknown>(`/api/v1/ships/${encodeURIComponent(mmsi)}`)
      .then((r) => { if (alive) { setDetail(parseDetail(mmsi, r)); setError(null); } })
      .catch((e: Error) => { if (alive) setError({ mmsi, msg: String(e.message) }); });
    return () => { alive = false; };
  }, [mmsi]);
  const d = detail && detail.mmsi === mmsi ? detail : null;
  const err = error && error.mmsi === mmsi ? error.msg : null;
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
    ["속력/침로/선수방위", <span key="mo" className="mono">{fmtMotion(s)}</span>],
    ["항해 상태", navStatusLabel(s?.nav_status)],
    ["위치 출처", positionSourceLabel(s?.position_source), "보고의 Timestamp 필드 — 0–59 전자 위치 장치(종류는 모름) · 61 수동 · 62 추측항법 · 63 장치 비작동 · 60(값 없음)은 —"],
    ["AIS 등급", s?.class ? `Class ${s.class}` : "—"],
    ["관측 시각", <span key="seen" className="mono" title={fmtIso(s?.seen_at)}>{fmtTime(s?.seen_at)}{age != null ? ` (${fmtDuration(age)} 전)` : ""}</span>],
    ["출처", s?.provider ?? st?.provider ?? "—"],
  ];
  return (
    <div className="flex h-full flex-col" data-testid="ship-card">
      <div className="row">
        <span className="label">Ship</span>
        <div className="flex flex-wrap items-center justify-end gap-1">
          {gone ? <span className="badge warn" data-testid="ship-gone">실시간 목록에 없음 · 30분 넘게 수신 없음</span> : null}
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
          <div className="label mb-0.5">항적 · 최근 6 h</div>
          {track == null || !track.loaded ? <div className="text-[11px] text-fg-3">항적 불러오는 중…</div>
            : track.error ? <div className="text-[11px] text-warn">기록 조회 실패 — 선택한 뒤 받은 관측만 이어 그립니다 ({track.error})</div>
            : <div className="text-[11px] text-fg-2">기록 구간 {track.segments}개 · 60 s 에 1점(저장 기준) + 실시간 관측</div>}
          {gaps ? (
            <div className="mt-1 text-[11px]" data-testid="ship-gap-summary">
              <div className={gaps.count ? "text-warn" : "text-fg-2"}>
                {track?.error ? "선택 뒤 받은 수신 공백" : "최근 6 h 수신 공백"} {gaps.count}회{track?.gapsTruncated ? " 이상(최신 목록만)" : ""} · 합계 {gaps.closedS} s
                {track?.error ? " (기록 조회 실패 — 6 h 전체가 아님)" : ""}
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
  return <ShipPanelView selected={selected} shipsOn={shipsOn} />;
}

/** 표시 부분(선택·레이어를 인자로 — 서버 렌더 시험용) */
export function ShipPanelView({ selected, shipsOn }: { selected: string | null; shipsOn: boolean }) {
  const toggle = useUi((s) => s.toggleLayer);
  if (selected && isMmsi(selected)) return <ShipCard mmsi={selected} />;
  if (!shipsOn) {
    return (
      <div className="p-3 text-[11px] text-fg-3" data-testid="ship-panel-off">
        선박 레이어가 꺼져 있습니다. <button className="btn ml-1" onClick={() => { toggle("ships"); saveLayers(useUi.getState().layers); }}>선박 켜기</button>
      </div>
    );
  }
  return <ShipList />;
}

function ShipList() {
  const view = useServerData((x) => x.ships);
  const ais = useServerData((x) => x.ais);
  const viewport = useServerData((x) => x.viewport);
  const aisOff = ais?.state === "disabled";
  const selectShip = useUi((s) => s.selectShip);
  const [q, setQ] = useState("");
  if (view.mode !== "points") {
    return (
      <div className="p-3 text-[11px] text-fg-3" data-testid="ship-list-empty">
        {view.mode === "grid" ? <>
          지금은 격자(선박 수)로 표시 중입니다 — 확대해서 개별 표시가 되면 선박을 고를 수 있습니다.
          <div className="mt-1">{SHIPS_RULE_TEXT}</div>
        </> : aisOff ? "AIS 수집이 꺼져 있습니다(aisstream.io 키 없음 — 운영 설정). 선박 데이터가 오지 않습니다." : "선박 수신 대기 중…"}
      </div>
    );
  }
  // 화면 안 0척이면 칩과 같은 이유 문구(수신국 없는 해역 · 수신 범위 밖 · AIS 꺼짐 · 연결 안 됨 · 상태 모름)
  const zero = shipsChip(view, { zoom: viewport?.zoom ?? null, bbox: viewport?.bbox ?? null, ais });
  // 목록 계산은 렌더 중 — 화면 안 선박(서버 상한 5 000)만이라 가볍다
  const { items: shown, total } = shipList(shipStates.values(), q);
  return (
    <div className="flex h-full flex-col" data-testid="ship-list">
      <div className="row">
        <span className="label">화면 안 선박 {view.count}</span>
        <input value={q} onChange={(e) => setQ(e.target.value.slice(0, 32))} placeholder="이름·MMSI" aria-label="선박 이름 또는 MMSI 로 거르기" className="w-40" data-testid="ship-list-filter" />
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto text-[12px]">
        {shown.map((s) => (
          <li key={s.mmsi} className="border-b border-line">
            <button className="flex w-full justify-between gap-2 px-2 py-1 text-left hover:bg-bg-2" onClick={() => { selectShip(s.mmsi); panIfOutside(shipPos(s.mmsi)); }} data-testid="ship-list-item" data-mmsi={s.mmsi}>
              <span>{s.name ?? "—"}</span><span className="mono text-fg-3">{s.mmsi}</span>
            </button>
          </li>
        ))}
        {total > shown.length ? <li className="px-2 py-1 text-[11px] text-fg-3">외 {total - shown.length}척 — 이름·MMSI 로 거르세요</li> : null}
        {total === 0 ? <li className="px-2 py-1 text-[11px] text-fg-3" data-testid="ship-list-none">{shipStates.size ? "조건에 맞는 선박 없음" : zero?.text ?? "화면 안에 선박 없음"}</li> : null}
      </ul>
    </div>
  );
}
