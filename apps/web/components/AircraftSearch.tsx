"use client";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { ApiError, apiGet } from "@/lib/api";
import { useServerNow } from "@/lib/clock";
import { fmtTimeKstLabel } from "@/lib/format";
import { saveLayers } from "@/lib/prefs";
import {
  isTypingTarget, moveActive, normalizeQuery, normalizeShipQuery, parseSearchResponse, parseShipSearchResponse, SHIP_SEARCH_DB_NOTE, SHIP_SEARCH_LIMIT, shipChoice, shipRowFromHit,
  shipSearchDbUnavailable,
  type SearchHit, type ShipHit,
} from "@/lib/search";
import { sortShipRows, type ShipSort, type ShipSortKey } from "@/lib/ships";
import { aircraftStates, shipStates } from "@/lib/store";
import { useUi } from "@/lib/ui-store";
import type { AircraftState } from "@/lib/types";
import { ShipTable } from "./ShipTable";
import { AltStack } from "./UnitStack";
import { RequestIdOf } from "./logs/ErrorNote";

const DEBOUNCE_MS = 250;

type GroupState = "idle" | "loading" | "done" | "error";
/** note = 결과와 함께 보일 알림(예: 선박 DB 사용 불가 — 결과가 실시간 목록뿐). error = 실패의 오류 그대로(ApiError 면 요청 id 를 문구에 — 계약 v5 §G5) */
export interface SearchGroup<T> { hits: T[]; state: GroupState; msg: string; note?: string; error?: unknown }
const IDLE = { hits: [], state: "idle" as const, msg: "" };

/** 검색 실패 문구(묶음마다) — 404 는 서버가 아직 그 검색을 지원하지 않는 경우(구 api) */
function failText(what: string, e: unknown): string {
  if (e instanceof ApiError && e.status === 429) return "요청이 많아 잠시 제한됨 — 잠시 후 다시";
  if (e instanceof ApiError && e.status === 404) return `${what} 검색을 쓸 수 없음(HTTP 404 — 서버가 지원하지 않음)`;
  if (e instanceof ApiError && e.status === 400) return `${what} 검색어 형식이 맞지 않음(HTTP 400)`;
  return `${what} 검색 실패 (${(e as Error).message})`;
}

/** 선박 검색 결과의 표시 순서: 정렬을 고르기 전에는 서버 순서(실시간 먼저), 고르면 표 규칙(lib/ships sortShipRows) */
function shipRows(hits: ShipHit[], sort: ShipSort | null, now: number) {
  const rows = hits.map((h) => shipRowFromHit(h, shipStates.get(h.mmsi)));
  return sort ? sortShipRows(rows, sort, now) : rows;
}

/**
 * 상단 통합 검색(GAP-12 · 계약 v5 §B3): 항공기(호출부호·hex·등록번호 접두사 2–10자)와 선박(선명·호출부호 앞부분 · MMSI · IMO, 2–40자)을 함께 찾는다.
 * "/" 로 초점, ↑↓ 이동(항공기 → 선박), Enter 선택, Esc 닫기. 결과는 두 묶음(묶음 제목·출처) — 한 묶음이 실패해도 다른 묶음은 그대로.
 * 항공기: 카드를 열고 위치(검색 결과 → 지도 스냅샷 사본 → REST 상세)로 지도를 옮긴다.
 * 선박: 선박 레이어를 켜고(꺼져 있으면) 카드 + 항적. 실시간이고 위치를 알면 지도를 옮기고, 실시간이 아니면 "실시간 아님 · 마지막 수신 hh:mm · 마지막 저장 hh:mm" 과 함께 카드만
 * — 위치를 지어내지 않는다.
 */
export function AircraftSearch() {
  const uid = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [aircraft, setAircraft] = useState<SearchGroup<SearchHit>>(IDLE);
  const [ships, setShips] = useState<SearchGroup<ShipHit>>(IDLE);
  const [active, setActive] = useState(-1);
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState("");
  const [shipSort, setShipSort] = useState<ShipSort | null>(null);
  const select = useUi((s) => s.select);
  const selectShip = useUi((s) => s.selectShip);
  const requestFlyTo = useUi((s) => s.requestFlyTo);
  const now = useServerNow(1000);
  const qa = normalizeQuery(text);
  const qs = normalizeShipQuery(text);

  // "/" 단축키 — 입력 중이 아닐 때만
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e.target)) return;
      e.preventDefault();
      inputRef.current?.focus();
      inputRef.current?.select();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // 디바운스 + 이전 요청 취소(늦게 온 응답이 새 결과를 덮지 않게). 검색어가 그 묶음 규칙에 맞지 않으면 요청하지 않는다(idle)
  useEffect(() => {
    if (!qa && !qs) return;
    const ctl = new AbortController();
    const t = setTimeout(() => {
      setActive(-1);
      if (qa) {
        setAircraft((g) => ({ ...g, state: "loading" }));
        apiGet<unknown>(`/api/v1/aircraft/search?q=${encodeURIComponent(qa)}`, { signal: ctl.signal })
          .then((body) => { const h = parseSearchResponse(body); setAircraft({ hits: h, state: "done", msg: h.length ? `${h.length}건` : "일치하는 항공기 없음" }); })
          .catch((e: unknown) => { if (!ctl.signal.aborted) setAircraft({ hits: [], state: "error", msg: failText("항공기", e), error: e }); });
      } else setAircraft(IDLE);
      if (qs) {
        setShips((g) => ({ ...g, state: "loading" }));
        apiGet<unknown>(`/api/v1/ships/search?q=${encodeURIComponent(qs)}&limit=${SHIP_SEARCH_LIMIT}`, { signal: ctl.signal })
          .then((body) => {
            const h = parseShipSearchResponse(body);
            setShips({ hits: h, state: "done", msg: h.length ? `${h.length}건` : "일치하는 선박 없음", note: shipSearchDbUnavailable(body) ? SHIP_SEARCH_DB_NOTE : undefined });
          })
          .catch((e: unknown) => { if (!ctl.signal.aborted) setShips({ hits: [], state: "error", msg: failText("선박", e), error: e }); });
      } else setShips(IDLE);
    }, DEBOUNCE_MS);
    return () => { clearTimeout(t); ctl.abort(); };
  }, [qa, qs]);

  const chooseAircraft = useCallback(async (h: SearchHit) => {
    setOpen(false);
    select(h.hex);
    let pos: [number, number] | null = h.live && h.lon != null && h.lat != null ? [h.lon, h.lat] : null;
    if (!pos) { const s = aircraftStates.get(h.hex); if (s) pos = [s.lon, s.lat]; }
    if (!pos) {
      try {
        const d = await apiGet<{ state: AircraftState | null }>(`/api/v1/aircraft/${encodeURIComponent(h.hex)}`);
        if (d.state && Number.isFinite(d.state.lat) && Number.isFinite(d.state.lon)) pos = [d.state.lon, d.state.lat];
      } catch { /* 위치 모름 */ }
    }
    const name = h.callsign ?? h.hex;
    if (pos) { requestFlyTo(pos[0], pos[1], 8); setMsg(`${name} 선택 — 지도 이동`); }
    else setMsg(`${name} 선택 — 현재 위치 없음(DB 기록만${h.last_seen ? `, 마지막 ${fmtTimeKstLabel(h.last_seen)}` : ""})`);
  }, [select, requestFlyTo]);

  const chooseShip = useCallback((h: ShipHit) => {
    setOpen(false);
    // 선박 레이어가 꺼져 있으면 켠다 — 선택 표시·항적은 선박 레이어에 그린다(설정은 이 브라우저에 저장)
    const ui = useUi.getState();
    if (!ui.layers.ships) { ui.toggleLayer("ships"); saveLayers(useUi.getState().layers); }
    selectShip(h.mmsi);
    const listed = shipStates.get(h.mmsi);
    const c = shipChoice(h, listed ? { lat: listed.lat, lon: listed.lon } : null, now);
    // 줌 9: 줌 7 이상이면 서버가 개별 선박을 보낸다(화면 안 5,000척 이하 — 계약 v4 §C)
    if (c.fly) requestFlyTo(c.fly[0], c.fly[1], 9);
    setMsg(c.message);
  }, [selectShip, requestFlyTo, now]);

  const rows = shipRows(ships.hits, shipSort, now);
  const total = aircraft.hits.length + rows.length;
  const pick = (i: number) => {
    if (i < 0) return;
    if (i < aircraft.hits.length) { if (aircraft.state === "done") void chooseAircraft(aircraft.hits[i]); return; }
    const r = rows[i - aircraft.hits.length];
    const h = r ? ships.hits.find((x) => x.mmsi === r.mmsi) : undefined;
    if (h && ships.state === "done") chooseShip(h);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setOpen(true);
      setActive((a) => moveActive(a, e.key === "ArrowDown" ? 1 : -1, total));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (total) pick(active >= 0 ? active : 0);
    } else if (e.key === "Escape") {
      if (open) { setOpen(false); } else { setText(""); inputRef.current?.blur(); }
    }
  };

  const onShipSort = (k: ShipSortKey) => setShipSort((cur) => (cur?.key === k ? { key: k, dir: cur.dir === "asc" ? "desc" : "asc" } : { key: k, dir: k === "age" || k === "sog" ? "desc" : "asc" }));
  const showList = open && (qa != null || qs != null);
  const activeId = showList && active >= 0 && active < total ? optionId(uid, active < aircraft.hits.length ? `a-${aircraft.hits[active].hex}` : `s-${rows[active - aircraft.hits.length].mmsi}`) : undefined;
  // 팝업 = 두 listbox(항공기 · 선박 — 묶음 제목이 이름). 선박 listbox 는 결과가 있을 때만 그린다(없는 id 를 가리키지 않게)
  const lists = searchListIds(uid);
  const controls = rows.length ? `${lists.aircraft} ${lists.ships}` : lists.aircraft;
  const hint = text.trim().length > 0 && !qa && !qs ? "영문·숫자 2자 이상(선박은 공백 . - / 포함 40자까지)" : "";
  return (
    // 초점이 검색 영역(입력 · 결과의 정렬 단추) 밖으로 나갈 때만 닫는다 — Tab 으로 선박 표 머리글(정렬)에 갈 수 있게
    <div className="relative" data-testid="aircraft-search" onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false); }}>
      <label htmlFor={`${uid}-input`} className="sr-only">통합 검색 — 항공기(호출부호·hex·등록번호) · 선박(선명·MMSI·IMO·호출부호)</label>
      <div className="flex items-center">
        <input
          ref={inputRef}
          id={`${uid}-input`}
          type="text"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={showList}
          aria-controls={controls}
          aria-activedescendant={activeId}
          aria-describedby={`${uid}-status`}
          autoComplete="off"
          spellCheck={false}
          maxLength={40}
          value={text}
          placeholder="항공기 호출부호·hex · 선박 선명·MMSI·IMO"
          className="mono h-[26px] w-64 text-[12px] uppercase placeholder:normal-case placeholder:text-fg-3"
          onChange={(e) => {
            setText(e.target.value); setOpen(true); setActive(-1);
            if (!normalizeQuery(e.target.value)) setAircraft(IDLE);
            if (!normalizeShipQuery(e.target.value)) setShips(IDLE);
            if (!normalizeQuery(e.target.value) && !normalizeShipQuery(e.target.value)) setMsg("");
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          data-testid="aircraft-search-input"
        />
        <kbd className="mono -ml-6 w-5 border border-line-2 text-center text-[10px] text-fg-3" aria-hidden>/</kbd>
      </div>
      <div id={`${uid}-status`} className="sr-only" aria-live="polite">{hint || msg || [aircraft.msg && `항공기 ${aircraft.msg}`, ships.msg && `선박 ${ships.msg}`].filter(Boolean).join(" · ")}</div>
      {showList ? (
        // 마우스로 목록 안을 눌러도 초점은 입력에 둔다(정렬 머리글·줄). Esc(정렬 단추에서) = 닫고 입력으로
        <div className="panel absolute right-0 top-[calc(100%+6px)] z-50 w-[580px] max-w-[calc(100vw-1.5rem)] text-[12px]" data-testid="aircraft-search-results"
          onMouseDown={(e) => e.preventDefault()} onKeyDown={(e) => { if (e.key === "Escape") { inputRef.current?.focus(); setOpen(false); } }}>
          <SearchResultsView uid={uid} aircraft={aircraft} ships={ships} active={active} now={now} shipSort={shipSort} onShipSort={onShipSort}
            onChooseAircraft={(h) => void chooseAircraft(h)} onChooseShip={chooseShip} onHover={setActive} />
          <div className="border-t border-line px-2 py-1 text-[10px] text-fg-3">↑↓ 이동 · Enter 선택 · Esc 닫기 · live = 실시간 · db = 과거 기록(위치 없음) · 선박 머리글을 누르면 정렬(키보드: Tab)</div>
        </div>
      ) : null}
    </div>
  );
}

const optionId = (uid: string, key: string) => `${uid}-opt-${key}`;
/** 검색 팝업의 두 listbox id(콤보박스 aria-controls) */
export const searchListIds = (uid: string) => ({ aircraft: `${uid}-list-aircraft`, ships: `${uid}-list-ships` });
const headId = (uid: string, group: "aircraft" | "ships") => `${uid}-head-${group}`;

function GroupHead({ id, title, count, source, testId }: { id: string; title: string; count: string; source: string; testId: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2 border-b border-line bg-bg-2 px-2 py-1" data-testid={testId}>
      <span className="label text-fg-2" id={id}>{title} {count}</span>
      <span className="text-[10px] text-fg-3">{source}</span>
    </div>
  );
}

/**
 * 검색 결과 표시 부분(서버 렌더 시험용): 항공기 묶음(목록) → 선박 묶음(정렬 가능한 선박 표 — 화면 안 선박 목록과 같은 표).
 * active = 키보드 활성 위치(항공기 먼저, 이어서 선박 표의 보이는 순서). 묶음마다 상태(검색 안 함·검색 중·실패·없음)를 따로 적는다.
 * 접근성: 묶음마다 listbox(이름 = 묶음 제목), 줄은 option — 입력(콤보박스)의 aria-activedescendant 가 가리킨다. 선박 정렬 단추는 listbox 밖(표 머리글).
 */
export function SearchResultsView({ uid, aircraft, ships, active, now, shipSort, onShipSort, onChooseAircraft, onChooseShip, onHover }: {
  uid: string; aircraft: SearchGroup<SearchHit>; ships: SearchGroup<ShipHit>; active: number; now: number;
  shipSort: ShipSort | null; onShipSort: (k: ShipSortKey) => void; onChooseAircraft: (h: SearchHit) => void; onChooseShip: (h: ShipHit) => void; onHover: (i: number) => void;
}) {
  const rows = shipRows(ships.hits, shipSort, now);
  const nA = aircraft.hits.length;
  const groupMsg = (g: SearchGroup<unknown>, idle: string, none: string) =>
    g.state === "idle" ? idle : g.state === "loading" ? "검색 중…" : g.state === "error" ? g.msg : g.hits.length === 0 ? none : null;
  const aMsg = groupMsg(aircraft, "항공기 검색 안 함 — 호출부호·hex·등록번호는 영문·숫자 2–10자", "일치하는 항공기 없음");
  const sMsg = groupMsg(ships, "선박 검색 안 함 — 선명·호출부호·MMSI·IMO 는 2–40자(영문·숫자·공백 . - /)", "일치하는 선박 없음");
  const activeShip = active >= nA ? rows[active - nA]?.mmsi ?? null : null;
  const lists = searchListIds(uid);
  return (
    <div className="max-h-[60vh] overflow-y-auto">
      <GroupHead id={headId(uid, "aircraft")} title="항공기" count={aircraft.state === "done" ? `${nA}건` : "—"} source="출처: 실시간 스냅샷(live) · DB 과거 기록(db)" testId="search-group-aircraft" />
      {aMsg ? <div className={`px-2 py-1.5 ${aircraft.state === "error" ? "text-warn" : "text-fg-3"}`} data-testid={aircraft.state === "error" ? "search-error-aircraft" : undefined}>
        {aMsg}{aircraft.state === "error" ? <RequestIdOf error={aircraft.error} /> : null}
      </div> : null}
      <ul role="listbox" id={lists.aircraft} aria-labelledby={headId(uid, "aircraft")}>
        {aircraft.hits.map((h, i) => (
          <li
            key={h.hex}
            id={optionId(uid, `a-${h.hex}`)}
            role="option"
            aria-selected={i === active}
            className={`flex cursor-pointer items-center gap-2 border-b border-line px-2 py-1.5 ${i === active ? "bg-[#1c2a3f]" : "hover:bg-bg-2"}`}
            onMouseEnter={() => onHover(i)}
            onClick={() => onChooseAircraft(h)}
            data-testid="aircraft-search-item"
          >
            <span className="mono w-[76px] shrink-0 font-semibold">{h.callsign ?? "—"}</span>
            <span className="mono w-[54px] shrink-0 text-fg-2">{h.hex}</span>
            <span className="mono w-[64px] shrink-0 text-fg-2" title="등록번호">{h.registration ?? "—"}</span>
            <span className="w-[74px] shrink-0 text-right" title="고도(ft · FL / m)">{h.on_ground === true ? <span className="mono">GND</span> : <AltStack ft={h.alt_ft} nowrap />}</span>
            {h.live ? <span className="badge ok ml-auto">live</span> : <span className="badge ml-auto" title={h.last_seen ? `마지막 수신 ${fmtTimeKstLabel(h.last_seen)}` : "마지막 수신 시각 모름"}>db</span>}
          </li>
        ))}
      </ul>
      <GroupHead id={headId(uid, "ships")} title="선박" count={ships.state === "done" ? `${rows.length}건` : "—"} source="출처: AIS 실시간 목록(live) · DB 선박 표(실시간 아님)" testId="search-group-ships" />
      {ships.note && ships.state === "done" ? <div className="px-2 py-1 text-[11px] text-warn" data-testid="ship-search-db-note">{ships.note}</div> : null}
      {sMsg ? <div className={`px-2 py-1.5 ${ships.state === "error" ? "text-warn" : "text-fg-3"}`} data-testid={ships.state === "error" ? "search-error-ships" : undefined}>
        {sMsg}{ships.state === "error" ? <RequestIdOf error={ships.error} /> : null}
      </div> : null}
      {rows.length ? (
        <ShipTable rows={rows} now={now} sort={shipSort} onSort={onShipSort} testId="ship-search" wide
          listbox={{ id: lists.ships, labelledBy: headId(uid, "ships"), activeMmsi: activeShip, optionId: (m) => optionId(uid, `s-${m}`), onHover: (m) => onHover(nA + rows.findIndex((r) => r.mmsi === m)) }}
          onPick={(r) => { const h = ships.hits.find((x) => x.mmsi === r.mmsi); if (h) onChooseShip(h); }} />
      ) : null}
      {rows.some((r) => !r.live) ? <div className="px-2 py-1 text-[10px] text-fg-3">실시간 아님 = 지금 AIS 목록에 없는 선박 — 고르면 카드만 열고 지도에 위치를 그리지 않습니다(마지막 수신·저장 시각은 KST · 마지막 수신 = 이 서비스가 그 선박의 AIS 메시지를 마지막으로 받은 기록).</div> : null}
    </div>
  );
}
