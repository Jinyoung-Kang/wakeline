"use client";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { serverNowMs, useServerData, type WsInvalid } from "@/lib/store";
import { useNow } from "@/lib/clock";
import {
  type Chip, connChip, detailRows, type DetailRow, fitChips, type Health, HEALTH_MARK, HEALTH_WORD, openGapWarning, statusChips, statusInput, type StatusInput,
} from "@/lib/statusbar";
import { WsInvalidBadge } from "./WsInvalidBadge";

const NONE: ReadonlySet<string> = new Set();

/**
 * 상단 상태 바(FR-11 — 사용자 요청 2026-09-30 "[WS open] 줄에 정보가 너무 많아 잘리고 옆으로 끌어야 보인다"로 다시 짰다).
 * - 줄(가로 스크롤 없음): 연결 → 경고(WS 형식 오류 · FIXTURE · 열린 AIS 공백 — R-31 앞쪽) → 피드마다 칩 하나(이름 + 상태 모양 ■ ▲ ✕ □ 과 색 +
 *   핵심 수 하나, 정상이 아니면 낱말) → 오른쪽 끝 '상세' 단추. 표시 모델은 lib/statusbar(순수 함수 — 기준은 모두 기존 값).
 * - 폭이 모자라면 정상 · 모름 칩만 뒤에서부터 상세 표로 옮기고 단추에 '+N'(무엇을 옮겼는지 title) — 잘리지 않는다. 주의 · 경고 칩은 빼지 않는다.
 *   그래도 넘치면(좁은 화면의 경고들) 줄이 다음 줄로 넘어간다(flex-wrap) — 잘리지 않는다.
 * - 줄 폭은 칩 모음이 바뀔 때(그리기 전 — layout effect)와 ResizeObserver 가 크기 변화를 알릴 때만 잰다(1 s 시계 틱마다 재지 않는다). 둘 다 그리기
 *   전에 반영한다 — 자료가 칩을 더할 때 줄이 두 줄로 먼저 그려졌다가 줄어드는 일이 없다(검토 하네스: 전에는 약 260 ms 동안 두 줄). 옮긴 칩은 보이지
 *   않게 겹쳐 두어(invisible · absolute) 계속 잴 수 있고 화면 읽기 프로그램에서는 숨긴다(값은 상세 표에 있다).
 * - 상세: 단추(aria-expanded · aria-controls) — 누름 · Enter · Space 로 열고 닫고, Esc(초점이 상세 안 · 단추에 있거나 아무 데도 없을 때 — 단추로 초점을
 *   돌린다) · 바깥 누르기 · 초점이 밖으로 나감(초점은 그대로)으로 닫힌다. 다른 입력의 Esc 는 그 입력의 것. 열려 있을 때만 그린다.
 * - 스토어는 보이는 값만 골라 구독한다(전체 스토어가 아니라) — 항공기 diff 마다 모든 값을 다시 계산하지 않는다.
 * - 출처 표기는 모든 화면 하단의 고정 줄(AttributionFooter — FR-20).
 * - WS 형식 오류 배지(계약 v5 §E2)는 단추 — 상세는 popover(최상위 층)라 이 줄에 잘리지 않는다(WsInvalidBadge).
 */
export function StatusBar() {
  const conn = useServerData((x) => x.conn);
  const reconnectAttempt = useServerData((x) => x.reconnectAttempt);
  const lastRxAt = useServerData((x) => x.lastRxAt);
  const feeds = useServerData((x) => x.feeds);
  const aircraftCount = useServerData((x) => x.aircraftCount);
  const status = useServerData((x) => x.status);
  const sigmetsProvider = useServerData((x) => x.sigmetsProvider);
  const sigmetsFetchedAt = useServerData((x) => x.sigmetsFetchedAt);
  const radar = useServerData((x) => x.radar);
  const radarKr = useServerData((x) => x.radarKr);
  const ais = useServerData((x) => x.ais);
  const snapshotVersion = useServerData((x) => x.snapshotVersion);
  const inv = useServerData((x) => x.wsInvalid);
  const now = useNow(1000);
  const input = useMemo(() => statusInput(
    { conn, reconnectAttempt, lastRxAt, feeds, aircraftCount, status, sigmetsProvider, sigmetsFetchedAt, radar, radarKr, ais, snapshotVersion }, now, now ? serverNowMs(now) : 0,
  ), [conn, reconnectAttempt, lastRxAt, now, feeds, aircraftCount, status, sigmetsProvider, sigmetsFetchedAt, radar, radarKr, ais, snapshotVersion]);
  return <StatusBarView input={input} inv={inv} />;
}

/** 칩 하나: 이름 · 모양(화면 읽기 프로그램에는 낱말) · 값 · 상태 낱말. hidden = 줄에서 상세로 옮김(보이지 않게 겹쳐 두고 계속 잰다) */
function ChipView({ chip, hidden }: { chip: Chip; hidden: boolean }) {
  return (
    <span className={`chip ${chip.plain ? "plain" : chip.health}${hidden ? " pointer-events-none invisible absolute top-0 left-0" : ""}`}
      data-chip={chip.key} data-pinned={chip.pinned ? "true" : undefined} data-overflow={hidden ? "true" : undefined} data-health={chip.plain ? undefined : chip.health}
      data-testid={chip.testId} title={chip.title} aria-hidden={hidden ? "true" : undefined}>
      <span className="chip-k">{chip.label}</span>
      {chip.plain ? null : <span className="chip-m" aria-hidden="true">{HEALTH_MARK[chip.health]}</span>}
      <span className="chip-v">{chip.value}</span>
      {chip.words.map((w) => <span key={w.text} className="chip-s" data-testid={w.testId} title={w.title}>{w.text}</span>)}
      {!chip.plain && chip.words.length === 0 ? <span className="sr-only">{HEALTH_WORD[chip.health]}</span> : null}
    </span>
  );
}

/**
 * 줄의 내용 폭(패딩 제외) · 칩 사이 간격 · 고정 항목(연결 · 경고 · 상세 단추) 폭을 읽어 옮길 칩을 고른다 — 칩 모음이 바뀐 커밋(layout effect)과
 * ResizeObserver 콜백에서만 부른다. 배치 전 · 숨김(폭 0 — 레이아웃 없음)이면 null: 재지 않는다(모두 옮기면 '+N' 이 틀린다 — 크기가 생기면 다시 알린다).
 */
function measure(row: HTMLElement): Set<string> | null {
  const width = row.clientWidth;
  if (!(width > 0)) return null;
  const cs = getComputedStyle(row);
  const gap = parseFloat(cs.columnGap) || 0;
  const inner = width - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
  let reserved = 0;
  for (const el of row.querySelectorAll<HTMLElement>("[data-pin]")) reserved += el.offsetWidth + gap;
  const boxes = [...row.querySelectorAll<HTMLElement>("[data-chip]")].map((el) => ({ key: el.getAttribute("data-chip") ?? "", width: el.offsetWidth, pinned: el.getAttribute("data-pinned") === "true" }));
  return fitChips(boxes, inner, reserved, gap);
}

const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>) => a.size === b.size && [...b].every((k) => a.has(k));

/**
 * 줄에서 옮길 칩. layoutKey(어떤 칩이 있고 무엇이 pinned 인지)가 바뀌면 그 커밋 안에서(useLayoutEffect — 그리기 전) 한 번 재고 다시 관찰한다.
 * 그 밖에는 ResizeObserver 가 줄 · 칩 · 고정 항목의 크기 변화(창 폭 · 값 글자 폭)를 알릴 때만 잰다 — 콜백은 레이아웃 뒤 · 그리기 전에 오므로
 * flushSync 로 그 자리에서 반영한다(다음 작업으로 미루면 한 프레임은 두 줄로 그려진다). 결과가 같으면 다시 그리지 않는다.
 * ResizeObserver 가 없으면(옛 브라우저) 칩 모음이 바뀔 때만 잰다 — 그래도 넘치면 줄이 넘어간다(flex-wrap). 서버 렌더에서는 재지 않는다.
 */
function useOverflow(rowRef: React.RefObject<HTMLDivElement | null>, layoutKey: string): { hidden: ReadonlySet<string>; measured: boolean } {
  const [hidden, setHidden] = useState<ReadonlySet<string>>(NONE);
  const [measured, setMeasured] = useState(false);
  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    const apply = (next: Set<string> | null) => {
      if (!next) return;
      setHidden((prev) => (sameSet(prev, next) ? prev : next));
      setMeasured(true);
    };
    apply(measure(row));
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      const next = measure(row);
      if (next) flushSync(() => apply(next));
    });
    ro.observe(row);
    for (const el of row.querySelectorAll("[data-chip], [data-pin]")) ro.observe(el);
    return () => ro.disconnect();
  }, [rowRef, layoutKey]);
  return { hidden, measured };
}

/** 표시 부분(입력을 인자로 — 시험용). 스토어와 시계는 StatusBar 가 준다 */
export function StatusBarView({ input, inv }: { input: StatusInput; inv: WsInvalid }) {
  const c = connChip(input);
  const chips = statusChips(input);
  const gapOpen = openGapWarning(input);
  const fixture = input.status?.fixture_mode === true;
  const invAny = inv.elements + inv.messages + inv.errors > 0;
  const rowRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const layoutKey = `${chips.map((x) => `${x.key}${x.pinned ? "!" : ""}`).join(",")}|${invAny ? "i" : ""}${fixture ? "f" : ""}${gapOpen ? "g" : ""}`;
  const { hidden: hiddenAll, measured } = useOverflow(rowRef, layoutKey);
  // 옮김은 정상 · 모름 칩만(주의 · 경고는 늘 줄에) — 마지막 측정 뒤 pinned 가 된 칩은 다음 측정 전에도 보인다
  const hidden = chips.filter((x) => hiddenAll.has(x.key) && !x.pinned);
  useEffect(() => {
    if (!open) return;
    const inside = (n: Node | null) => n != null && (panelRef.current?.contains(n) === true || btnRef.current?.contains(n) === true);
    // 상세를 품은 조상(문서 본문 · <main tabindex=-1> 등): 상세 안의 글자처럼 초점을 받지 않는 곳을 누르면 브라우저가 초점을 여기로 옮긴다 — '초점 없음'과 같다
    const around = (n: Node | null) => n == null || n === document.body || n === document.documentElement || (panelRef.current != null && n.contains(panelRef.current));
    // Esc 는 초점이 있는 곳의 것이다: 초점이 상세(표 · 단추)에 있거나 아무 데도 없을 때만 닫고 초점을 단추로 돌린다.
    // 다른 입력(검색 등)의 Esc · 이미 처리된 Esc(defaultPrevented)는 건드리지 않는다 — e.target 은 누를 때 초점이 있던 요소(처리기가 초점을 옮겨도 그대로)
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const t = e.target as Node | null;
      if (!inside(t) && !around(t)) return;
      setOpen(false);
      btnRef.current?.focus();
    };
    const onDown = (e: PointerEvent) => {
      if (inside(e.target as Node | null)) return; // 단추는 onClick 이 여닫는다
      setOpen(false);
    };
    // 초점이 다른 요소로 나가면(예: '/' 로 검색) 닫는다 — 초점은 옮겨 간 곳에 그대로 둔다. 조상으로 간 초점(위)은 나간 것이 아니다(바깥 누르기는 onDown 이 닫는다)
    const onFocusIn = (e: FocusEvent) => { const t = e.target as Node | null; if (!inside(t) && !around(t)) setOpen(false); };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("focusin", onFocusIn);
    };
  }, [open]);
  const hiddenNames = hidden.map((x) => x.label).join(" · ");
  return (
    <div className="relative shrink-0 border-b border-line bg-bg-1" data-testid="statusbar" role="group" aria-label="수집·연결 상태">
      {/* 처음 잴 때까지(서버 HTML · 하이드레이션 전)는 한 줄로 자른다(flex-nowrap · overflow-hidden) — 좁은 창에서 두세 줄로 그렸다가 줄어드는 일이 없다.
          잰 뒤에는 줄바꿈을 허용한다(주의 · 경고만으로 넘칠 때 — 잘리지 않게) */}
      <div ref={rowRef} className={`relative flex min-h-8 items-center gap-x-2 gap-y-1 px-3 py-[3px] text-[11px] ${measured ? "flex-wrap" : "flex-nowrap overflow-hidden"}`}
        data-testid="statusbar-row" data-measured={measured ? "true" : undefined}>
        <span className={`badge ${c.tone} shrink-0 whitespace-nowrap`} data-testid="conn" title={c.title} data-pin="">{c.text}</span>
        {invAny ? <span className="flex shrink-0" data-pin=""><WsInvalidBadge inv={inv} /></span> : null}
        {fixture ? <span className="badge warn shrink-0 whitespace-nowrap" data-testid="fixture-badge" data-pin="" title="api 가 fixture 모드 — 외부 공급자를 부르지 않고 기록된 자료를 재생합니다">FIXTURE MODE · 외부 호출 없음</span> : null}
        {gapOpen ? (
          <span className={`chip ${gapOpen.partial ? "warn" : "bad"}`} data-testid="ais-gap-badge" data-pin="" data-partial={gapOpen.partial ? "true" : undefined} title={gapOpen.title}>
            <span className="chip-k">AIS 공백</span><span className="chip-m" aria-hidden="true">{HEALTH_MARK[gapOpen.partial ? "warn" : "bad"]}</span>
            <span className="chip-v">{gapOpen.value}</span>
          </span>
        ) : null}
        {chips.map((x) => <ChipView key={x.key} chip={x} hidden={hidden.includes(x)} />)}
        <button ref={btnRef} type="button" className="btn ml-auto min-w-[84px] shrink-0 px-2! py-0.5! normal-case!" data-pin="" data-testid="statusbar-details-toggle"
          aria-expanded={open} aria-controls={open ? panelId : undefined} onClick={() => setOpen((v) => !v)}
          title={hidden.length ? `줄에 다 넣지 못한 항목 ${hidden.length}개(${hiddenNames}) — 상세 표에 있습니다` : "피드별 출처 · 수집 시각(KST) · 속도 · 기준 · 엔진 · 판"}>
          상세{hidden.length ? <span className="mono text-warn"> +{hidden.length}</span> : null} <span aria-hidden="true">{open ? "▴" : "▾"}</span>
        </button>
      </div>
      {open ? <StatusDetails id={panelId} panelRef={panelRef} rows={detailRows(input)} hiddenNames={hiddenNames} onClose={() => { setOpen(false); btnRef.current?.focus(); }} /> : null}
    </div>
  );
}

const HEALTH_TEXT: Record<Health, string> = { ok: "text-ok", warn: "text-warn", bad: "text-bad", unknown: "text-fg-3" };

/** 상세 표(열려 있을 때만): 줄의 모든 항목 + 줄에 없는 값(출처 · 수집 시각 KST · 속도 · 기상청 프레임 · 합성 지점 · 엔진 · 판 · AIS 공백 기록)과 기준 */
function StatusDetails({ id, panelRef, rows, hiddenNames, onClose }: { id: string; panelRef: React.RefObject<HTMLDivElement | null>; rows: DetailRow[]; hiddenNames: string; onClose: () => void }) {
  return (
    <div ref={panelRef} id={id} role="region" aria-label="수집 · 연결 상세" data-testid="statusbar-details"
      className="panel absolute top-full right-2 z-40 mt-1 max-h-[min(70vh,560px)] w-[min(900px,calc(100vw-16px))] overflow-auto text-[11px]">
      <div className="row sticky top-0 z-10 bg-bg-1">
        <span className="label">수집 · 연결 상세</span>
        <span className="min-w-0 flex-1 truncate text-fg-3">{hiddenNames ? `줄에 다 넣지 못한 항목: ${hiddenNames}` : "시각은 KST"}</span>
        <button type="button" className="btn px-2! py-0.5! normal-case!" onClick={onClose}>닫기</button>
      </div>
      <table className="text-[11px]">
        <thead><tr><th>항목</th><th>상태</th><th>값</th><th>출처 · 수집 시각</th><th>기준</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} data-row={r.key}>
              <td className="whitespace-nowrap text-fg">{r.name}</td>
              <td className="whitespace-nowrap">
                {r.health ? <span className={HEALTH_TEXT[r.health]} aria-hidden="true">{HEALTH_MARK[r.health]} </span> : null}
                <span className={r.health && r.health !== "ok" && r.health !== "unknown" ? HEALTH_TEXT[r.health] : "text-fg-2"}>{r.state}</span>
              </td>
              <td className="mono" title={r.valueTitle} data-testid={r.key === "kma" ? "kr-status-composite" : undefined}>{r.value}</td>
              <td className="text-fg-2">{r.source}</td>
              <td className="text-fg-3">{r.rule}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="border-t border-line px-2 py-1 text-[10px] text-fg-3">
        모양: {HEALTH_MARK.ok} 정상 · {HEALTH_MARK.warn} 주의 · {HEALTH_MARK.bad} 경고 · {HEALTH_MARK.unknown} 모름 — 색과 함께 모양 · 낱말로도 말합니다. lag = 서버가 보고한 피드 지연,
        age = 마지막 수집 뒤 경과(연결이 실시간이 아니면 받은 뒤 경과를 더함). 주의 · 경고인 항목은 줄에서 빼지 않습니다.
      </div>
    </div>
  );
}
