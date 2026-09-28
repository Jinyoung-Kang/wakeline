"use client";
import { fmtDuration, fmtIso } from "@/lib/format";
import {
  fmtSavedAt, LAST_SEEN_TITLE, navStatusLabel, navStatusShort, SHIP_CATEGORY_CODES, SHIP_CATEGORY_COLOR, SHIP_CATEGORY_LABEL, shipRowAgeS, type ShipRow, type ShipSort,
  type ShipSortKey,
} from "@/lib/ships";
import { SogStack } from "./UnitStack";

const COLS: { key: ShipSortKey; label: string; title: string; className?: string }[] = [
  { key: "cat", label: "선종", title: "선종(색) — AIS 선종 코드의 분류(USCG AIS Guide), 색은 지도와 같다. 이름은 칸에 마우스를 올리면" },
  { key: "name", label: "선명", title: "선박이 보고한 이름(검증하지 않은 보고값)" },
  { key: "mmsi", label: "MMSI", title: "해상 이동 업무 식별 번호(9자리)" },
  { key: "sog", label: "속력", title: "대지속력(SOG) kn · km/h(1 kn = 1.852 km/h) — 선박 보고값", className: "text-right" },
  { key: "nav", label: "항해 상태", title: "항해 상태 코드(USCG NAVCEN 0–15) — 선박 보고값" },
  { key: "age", label: "경과", title: "실시간: 마지막 관측부터 · 실시간 아님: 마지막 수신 기록부터(모르면 마지막 저장 위치부터, 서버 기준 시각)", className: "text-right" },
];

/** 검색 결과(상단 통합 검색 콤보박스의 팝업)로 쓸 때 — tbody 가 listbox, 줄이 option(머리글 정렬 단추는 listbox 밖) */
export interface ShipTableListbox {
  /** listbox id(콤보박스 aria-controls) */
  id: string;
  /** 묶음 제목 요소 id(listbox 이름) */
  labelledBy: string;
  /** 키보드 활성 줄(aria-selected · 콤보박스 aria-activedescendant) */
  activeMmsi: string | null;
  optionId: (mmsi: string) => string;
  onHover: (mmsi: string) => void;
}

/**
 * 선박 표(계약 v5 §B3) — 화면 안 선박 목록과 검색 결과가 같은 표를 쓴다. 머리글을 누르면 정렬(한 번 더 누르면 방향 반대), 모르는 값은 "—" 이고 정렬에서 끝.
 * 줄을 누르면(또는 선명 단추에서 Enter) onPick. 실시간이 아닌 선박은 경과 칸에 "실시간 아님"과 마지막 수신 기록(§G4) · 마지막 저장 시각을 적는다.
 * listbox(검색 결과): 표 역할 대신 tbody = role=listbox · 줄 = role=option — 입력(콤보박스)이 ↑↓ 로 aria-activedescendant 를 옮기고 Enter 로 고른다.
 * option 안에는 조작 요소를 두지 않고(선명은 글자), 정렬 상태는 머리글 단추 이름에 적는다(aria-sort 는 표 역할이 있을 때만).
 * 넓은 표(검색 결과)는 폭이 모자라면(전화기) 선명 칸을 줄이지 않고 드롭다운 안에서 옆으로 넘긴다.
 * 선명 등은 외부 문자열 — React 텍스트로만 넣는다.
 */
export function ShipTable({ rows, now, sort, onSort, onPick, testId, wide, listbox }: {
  rows: readonly ShipRow[]; now: number; sort: ShipSort | null; onSort: (k: ShipSortKey) => void; onPick: (r: ShipRow) => void; testId: string;
  /** 넓은 표(검색 결과): 경과 칸에 "실시간 아님 · 마지막 수신 · 저장 시각"이 한 줄씩 들어갈 폭 */
  wide?: boolean;
  listbox?: ShipTableListbox;
}) {
  const lb = listbox ?? null;
  const cell = lb ? "none" : undefined;
  const table = (
    <table className={wide ? "table-fixed min-w-[472px] text-[11px]" : "table-fixed text-[11px]"} role={lb ? "presentation" : undefined} data-testid={`${testId}-table`}>
      {/* 선종은 색 칸만(이름은 title) — 380 px 패널에서 선명 칸이 가장 넓게. 넓은 표: 고정 칸 368 px + 선명 ≥ 104 px(경과 칸 150 px = "마지막 수신 MM-DD hh:mm UTC") */}
      <colgroup>
        <col className="w-[28px]" /><col /><col className="w-[68px]" /><col className="w-[62px]" /><col className="w-[60px]" /><col className={wide ? "w-[150px]" : "w-[50px]"} />
      </colgroup>
      <thead>
        <tr>
          {COLS.map((c) => {
            const on = sort?.key === c.key;
            const dir = on ? (sort!.dir === "asc" ? "오름차순" : "내림차순") : null;
            return (
              <th key={c.key} scope={lb ? undefined : "col"} aria-sort={lb ? undefined : on ? (sort!.dir === "asc" ? "ascending" : "descending") : "none"} className={`px-1! py-1! ${c.className ?? ""}`} title={c.title}>
                <button type="button" className={`label w-full cursor-pointer text-[9px] tracking-normal! whitespace-nowrap ${c.className ?? "text-left"} ${on ? "text-fg!" : ""}`} onClick={() => onSort(c.key)}
                  aria-label={lb ? `${c.label} 기준 정렬${dir ? ` — 지금 ${dir}` : ""}` : undefined} data-testid={`${testId}-sort-${c.key}`}>
                  {c.label}{on ? (sort!.dir === "asc" ? " ▲" : " ▼") : ""}
                </button>
              </th>
            );
          })}
        </tr>
      </thead>
      <tbody role={lb ? "listbox" : undefined} id={lb?.id} aria-labelledby={lb?.labelledBy}>
        {rows.map((r) => {
          const age = shipRowAgeS(r, now);
          const active = lb?.activeMmsi === r.mmsi;
          return (
            <tr key={r.mmsi} id={lb?.optionId(r.mmsi)} role={lb ? "option" : undefined} aria-selected={lb ? active : undefined}
              className={`cursor-pointer ${active ? "bg-[#1c2a3f]" : "hover:bg-bg-2"}`}
              onClick={() => onPick(r)} onMouseEnter={lb ? () => lb.onHover(r.mmsi) : undefined} data-testid={`${testId}-item`} data-mmsi={r.mmsi}>
              <td role={cell} className="px-1! py-0.5!" title={`${SHIP_CATEGORY_LABEL[r.category]} · 코드 ${SHIP_CATEGORY_CODES[r.category]}`}>
                <span className="inline-block h-2.5 w-2.5 align-middle" style={{ background: SHIP_CATEGORY_COLOR[r.category] }} aria-hidden />
                <span className="sr-only">{SHIP_CATEGORY_LABEL[r.category]}</span>
              </td>
              <td role={cell} className="truncate px-1! py-0.5!">
                {lb ? <span className="block truncate" title={r.name ?? `이름 모름 · MMSI ${r.mmsi}`}>{r.name ?? "—"}</span>
                  : <button type="button" className="w-full truncate text-left" title={r.name ?? `이름 모름 · MMSI ${r.mmsi}`}>{r.name ?? "—"}</button>}
              </td>
              <td role={cell} className="mono px-1! py-0.5! text-fg-2">{r.mmsi}</td>
              <td role={cell} className="px-0.5! py-0.5! text-right"><SogStack kn={r.sog_kn} nowrap /></td>
              <td role={cell} className="truncate px-1! py-0.5! text-[10px]" title={navStatusLabel(r.nav_status)}>{navStatusShort(r.nav_status)}</td>
              <td role={cell} className="mono px-1! py-0.5! text-right"
                title={r.live ? fmtIso(r.seen_at) : `마지막 수신 ${fmtIso(r.last_seen_at)} · 마지막 저장 위치 ${fmtIso(r.last_position_at)} — ${LAST_SEEN_TITLE}`}>
                {r.live ? (age == null ? "—" : fmtDuration(age)) : (
                  <span className="flex flex-col items-end leading-tight whitespace-nowrap">
                    <span className="text-[10px] text-warn">실시간 아님</span>
                    <span className="text-[10px] text-fg-2">마지막 수신 {fmtSavedAt(r.last_seen_at, now)}</span>
                    <span className="text-[10px] text-fg-3">저장 {fmtSavedAt(r.last_position_at, now)}</span>
                  </span>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
  return wide ? <div className="overflow-x-auto">{table}</div> : table;
}
