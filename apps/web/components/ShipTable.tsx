"use client";
import { fmtDuration, fmtIso } from "@/lib/format";
import {
  fmtSavedAt, navStatusLabel, navStatusShort, SHIP_CATEGORY_CODES, SHIP_CATEGORY_COLOR, SHIP_CATEGORY_LABEL, shipRowAgeS, type ShipRow, type ShipSort, type ShipSortKey,
} from "@/lib/ships";
import { SogStack } from "./UnitStack";

const COLS: { key: ShipSortKey; label: string; title: string; className?: string }[] = [
  { key: "cat", label: "선종", title: "AIS 선종 코드의 분류(USCG AIS Guide) — 색은 지도와 같다" },
  { key: "name", label: "선명", title: "선박이 보고한 이름(검증하지 않은 보고값)" },
  { key: "mmsi", label: "MMSI", title: "해상 이동 업무 식별 번호(9자리)" },
  { key: "sog", label: "속력", title: "대지속력(SOG) kn · km/h(1 kn = 1.852 km/h) — 선박 보고값", className: "text-right" },
  { key: "nav", label: "항해 상태", title: "항해 상태 코드(USCG NAVCEN 0–15) — 선박 보고값" },
  { key: "age", label: "경과", title: "실시간: 마지막 관측부터 · 실시간 아님: 마지막 저장 위치부터(서버 기준 시각)", className: "text-right" },
];

/**
 * 선박 표(계약 v5 §B3) — 화면 안 선박 목록과 검색 결과가 같은 표를 쓴다. 머리글을 누르면 정렬(한 번 더 누르면 방향 반대), 모르는 값은 "—" 이고 정렬에서 끝.
 * 줄을 누르면(또는 선명 단추에서 Enter) onPick. 실시간이 아닌 선박은 경과 칸에 "실시간 아님"과 마지막 저장 시각을 적는다.
 * 선명 등은 외부 문자열 — React 텍스트로만 넣는다.
 */
export function ShipTable({ rows, now, sort, onSort, onPick, testId, activeMmsi, rowId, onHover }: {
  rows: readonly ShipRow[]; now: number; sort: ShipSort | null; onSort: (k: ShipSortKey) => void; onPick: (r: ShipRow) => void; testId: string;
  /** 키보드 활성 줄(검색 결과) */
  activeMmsi?: string | null;
  /** 줄 id(검색 입력의 aria-activedescendant) */
  rowId?: (mmsi: string) => string;
  onHover?: (mmsi: string) => void;
}) {
  return (
    <table className="table-fixed text-[11px]" data-testid={`${testId}-table`}>
      <colgroup>
        <col className="w-[52px]" /><col /><col className="w-[74px]" /><col className="w-[62px]" /><col className="w-[70px]" /><col className="w-[58px]" />
      </colgroup>
      <thead>
        <tr>
          {COLS.map((c) => {
            const on = sort?.key === c.key;
            return (
              <th key={c.key} scope="col" aria-sort={on ? (sort!.dir === "asc" ? "ascending" : "descending") : "none"} className={`px-1! py-1! ${c.className ?? ""}`} title={c.title}>
                <button type="button" className={`label w-full cursor-pointer text-[9px] ${c.className ?? "text-left"} ${on ? "text-fg!" : ""}`} onClick={() => onSort(c.key)} data-testid={`${testId}-sort-${c.key}`}>
                  {c.label}{on ? (sort!.dir === "asc" ? " ▲" : " ▼") : ""}
                </button>
              </th>
            );
          })}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const age = shipRowAgeS(r, now);
          return (
            <tr key={r.mmsi} id={rowId?.(r.mmsi)} aria-selected={activeMmsi != null ? activeMmsi === r.mmsi : undefined}
              className={`cursor-pointer ${activeMmsi === r.mmsi ? "bg-[#1c2a3f]" : "hover:bg-bg-2"}`}
              onClick={() => onPick(r)} onMouseEnter={onHover ? () => onHover(r.mmsi) : undefined} data-testid={`${testId}-item`} data-mmsi={r.mmsi}>
              <td className="px-1! py-0.5!" title={`${SHIP_CATEGORY_LABEL[r.category]} · 코드 ${SHIP_CATEGORY_CODES[r.category]}`}>
                <span className="flex items-center gap-1">
                  <span className="inline-block h-2.5 w-2.5 shrink-0" style={{ background: SHIP_CATEGORY_COLOR[r.category] }} aria-hidden />
                  <span className="truncate text-[10px] text-fg-2">{SHIP_CATEGORY_LABEL[r.category]}</span>
                </span>
              </td>
              <td className="truncate px-1! py-0.5!">
                <button type="button" className="w-full truncate text-left" title={r.name ?? `이름 모름 · MMSI ${r.mmsi}`}>{r.name ?? "—"}</button>
              </td>
              <td className="mono px-1! py-0.5! text-fg-2">{r.mmsi}</td>
              <td className="px-1! py-0.5! text-right"><SogStack kn={r.sog_kn} /></td>
              <td className="truncate px-1! py-0.5!" title={navStatusLabel(r.nav_status)}>{navStatusShort(r.nav_status)}</td>
              <td className="mono px-1! py-0.5! text-right" title={fmtIso(r.live ? r.seen_at : r.last_position_at)}>
                {r.live ? (age == null ? "—" : fmtDuration(age)) : (
                  <span className="flex flex-col items-end leading-tight">
                    <span className="text-warn">실시간 아님</span>
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
}
