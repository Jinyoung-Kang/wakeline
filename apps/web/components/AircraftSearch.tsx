"use client";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { ApiError, apiGet } from "@/lib/api";
import { fmtTime } from "@/lib/format";
import { isTypingTarget, moveActive, normalizeQuery, parseSearchResponse, type SearchHit } from "@/lib/search";
import { aircraftStates } from "@/lib/store";
import { useUi } from "@/lib/ui-store";
import type { AircraftState } from "@/lib/types";
import { AltStack } from "./UnitStack";

const DEBOUNCE_MS = 250;

/**
 * 상단 바 항공기 검색(GAP-12): 호출부호·hex·등록번호 접두사(2–10자). "/" 로 초점, ↑↓ 이동, Enter 선택, Esc 닫기.
 * 선택하면 항공기 카드를 열고 지도를 그 위치로 옮긴다(위치: 검색 결과 → 지도 스냅샷 사본 → REST 상세 순).
 * 위치를 모르면(DB 기록만) 옮기지 않고 그렇게 알린다 — 위치를 지어내지 않는다.
 */
export function AircraftSearch() {
  const uid = useId();
  const listId = `${uid}-list`;
  const inputRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [active, setActive] = useState(-1);
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [msg, setMsg] = useState("");
  const select = useUi((s) => s.select);
  const requestFlyTo = useUi((s) => s.requestFlyTo);
  const q = normalizeQuery(text);

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

  // 디바운스 + 이전 요청 취소(늦게 온 응답이 새 결과를 덮지 않게)
  useEffect(() => {
    if (!q) return;
    const ctl = new AbortController();
    const t = setTimeout(() => {
      setState("loading");
      apiGet<unknown>(`/api/v1/aircraft/search?q=${encodeURIComponent(q)}`, { signal: ctl.signal })
        .then((body) => {
          const h = parseSearchResponse(body);
          setHits(h); setActive(h.length ? 0 : -1); setState("done");
          setMsg(h.length ? `${h.length}건` : "일치하는 항공기 없음");
        })
        .catch((e: unknown) => {
          if (ctl.signal.aborted) return;
          setHits([]); setActive(-1); setState("error");
          setMsg(e instanceof ApiError && e.status === 429 ? "요청이 많아 잠시 제한됨 — 잠시 후 다시" : `검색 실패 (${(e as Error).message})`);
        });
    }, DEBOUNCE_MS);
    return () => { clearTimeout(t); ctl.abort(); };
  }, [q]);

  const choose = useCallback(async (h: SearchHit) => {
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
    else setMsg(`${name} 선택 — 현재 위치 없음(DB 기록만${h.last_seen ? `, 마지막 ${fmtTime(h.last_seen)}` : ""})`);
  }, [select, requestFlyTo]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setOpen(true);
      setActive((a) => moveActive(a, e.key === "ArrowDown" ? 1 : -1, hits.length));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const h = hits[active >= 0 ? active : 0];
      if (q && h && state === "done") void choose(h);
    } else if (e.key === "Escape") {
      if (open) { setOpen(false); } else { setText(""); inputRef.current?.blur(); }
    }
  };

  const showList = open && q != null && (state !== "idle");
  const activeHit = showList && active >= 0 ? hits[active] : undefined;
  const hint = text.length > 0 && !q ? "영문·숫자 2–10자" : "";
  return (
    <div className="relative" data-testid="aircraft-search">
      <label htmlFor={`${uid}-input`} className="sr-only">항공기 검색(호출부호·hex·등록번호)</label>
      <div className="flex items-center">
        <input
          ref={inputRef}
          id={`${uid}-input`}
          type="text"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={showList}
          aria-controls={listId}
          aria-activedescendant={activeHit ? `${uid}-opt-${activeHit.hex}` : undefined}
          aria-describedby={`${uid}-status`}
          autoComplete="off"
          spellCheck={false}
          maxLength={16}
          value={text}
          placeholder="호출부호 · hex · 등록번호"
          className="mono h-[26px] w-56 text-[12px] uppercase placeholder:normal-case placeholder:text-fg-3"
          onChange={(e) => { setText(e.target.value); setOpen(true); if (!normalizeQuery(e.target.value)) { setHits([]); setActive(-1); setState("idle"); setMsg(""); } }}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={onKeyDown}
          data-testid="aircraft-search-input"
        />
        <kbd className="mono -ml-6 w-5 border border-line-2 text-center text-[10px] text-fg-3" aria-hidden>/</kbd>
      </div>
      <div id={`${uid}-status`} className="sr-only" aria-live="polite">{hint || msg}</div>
      {showList ? (
        <div className="panel absolute right-0 top-[calc(100%+6px)] z-50 w-[400px] max-w-[calc(100vw-1.5rem)] text-[12px]" data-testid="aircraft-search-results">
          {hits.length === 0 ? <div className="px-2 py-1.5 text-fg-3">{state === "loading" ? "검색 중…" : msg || "일치하는 항공기 없음"}</div> : null}
          <ul id={listId} role="listbox" aria-label="항공기 검색 결과" className="max-h-[60vh] overflow-y-auto">
            {hits.map((h, i) => (
              <li
                key={h.hex}
                id={`${uid}-opt-${h.hex}`}
                role="option"
                aria-selected={i === active}
                className={`flex cursor-pointer items-center gap-2 border-b border-line px-2 py-1.5 ${i === active ? "bg-[#1c2a3f]" : "hover:bg-bg-2"}`}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActive(i)}
                onClick={() => void choose(h)}
                data-testid="aircraft-search-item"
              >
                <span className="mono w-[76px] shrink-0 font-semibold">{h.callsign ?? "—"}</span>
                <span className="mono w-[54px] shrink-0 text-fg-2">{h.hex}</span>
                <span className="mono w-[64px] shrink-0 text-fg-2" title="등록번호">{h.registration ?? "—"}</span>
                <span className="w-[62px] shrink-0 text-right">{h.on_ground === true ? <span className="mono">GND</span> : <AltStack ft={h.alt_ft} />}</span>
                {h.live ? <span className="badge ok ml-auto">live</span> : <span className="badge ml-auto" title={h.last_seen ? `마지막 수신 ${fmtTime(h.last_seen)}` : "마지막 수신 시각 모름"}>db</span>}
              </li>
            ))}
          </ul>
          <div className="px-2 py-1 text-[10px] text-fg-3">↑↓ 이동 · Enter 선택 · Esc 닫기 · live = 현재 스냅샷 · db = 과거 기록(위치 없음)</div>
        </div>
      ) : null}
    </div>
  );
}
