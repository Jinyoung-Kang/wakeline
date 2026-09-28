"use client";
import { useNow, useServerNow } from "@/lib/clock";
import { mapDemandChip, type Chip } from "@/lib/demand";
import { countShipsIn, filterGridCells, SHIP_CATEGORIES, shipsChip, shipsGapSuffix, type ShipCategory, type ShipsChipFilter } from "@/lib/ships";
import { shipStates, useServerData } from "@/lib/store";
import { useUi } from "@/lib/ui-store";
import { isRxFresh } from "@/lib/ws-protocol";

const TONE_CLASS: Record<Chip["tone"], string> = { ok: "ok", warn: "warn", bad: "bad", est: "est", muted: "" };

/** 서버가 보고한 수요 상태 칩 — 카드와 지도가 같은 모양을 쓴다 */
export function DemandBadge({ chip, testId }: { chip: Chip; testId: string }) {
  return <span className={`badge ${TONE_CLASS[chip.tone]} normal-case!`} title={chip.title} data-testid={testId} data-kind={chip.kind}>{chip.text}</span>;
}

/**
 * 지도 왼쪽 위 상태 칩(계약 v2 §A3/§B4):
 * - 수요: 선택 항공기가 있으면 집중 추적 상태, 없으면 핫 리전 상태 — 서버가 보고한 상태·주기 그대로(연결이 실시간일 때만).
 * - 선박: 지금 지도가 무엇을 그리는지(개별 선박 N척 / 격자 N칸·M척과 그 이유 / 수신 대기 / 0척의 이유) — 격자로 묶었다는 사실을 숨기지 않는다(계약 v4 §C).
 */
export function MapChips() {
  const hex = useUi((s) => s.selectedHex);
  const shipsOn = useUi((s) => s.layers.ships);
  const shipCats = useUi((s) => s.shipCats);
  return <MapChipsView hex={hex} shipsOn={shipsOn} shipCats={shipCats} />;
}

/** 선종 필터 칩 입력(계약 v5 §B3): 점 모드는 화면 안 선박 중 켜진 선종 수, 격자는 선종별 수로 다시 센 합. 모두 켜져 있으면 null */
function chipFilter(ships: { mode: string; grid: Parameters<typeof filterGridCells>[0] }, cats: readonly ShipCategory[]): ShipsChipFilter | null {
  if (cats.length >= SHIP_CATEGORIES.length) return null;
  const on = new Set(cats);
  if (ships.mode === "grid") {
    const g = filterGridCells(ships.grid, on);
    return { on: cats.length, of: SHIP_CATEGORIES.length, shown: g.total, shownCells: g.cells.length, unfilteredCells: g.unfilteredCells };
  }
  return { on: cats.length, of: SHIP_CATEGORIES.length, shown: countShipsIn(shipStates.values(), on) };
}

/** 표시 부분(선택 hex·선박 레이어·선종 필터를 인자로 — 서버 렌더 시험용) */
export function MapChipsView({ hex, shipsOn, shipCats = SHIP_CATEGORIES }: { hex: string | null; shipsOn: boolean; shipCats?: readonly ShipCategory[] }) {
  const demand = useServerData((d) => d.demand);
  const conn = useServerData((d) => d.conn);
  const lastRxAt = useServerData((d) => d.lastRxAt);
  const ships = useServerData((d) => d.ships);
  const ais = useServerData((d) => d.ais);
  const viewport = useServerData((d) => d.viewport);
  const now = useServerNow(1000);
  const wall = useNow(1000);
  // 끊김·일시정지·수신 없음이면 서버 임대가 곧 만료된다 — 마지막 상태를 "진행 중"처럼 보이지 않는다
  const chip = isRxFresh(conn, lastRxAt, wall) ? mapDemandChip(demand, hex, now) : null;
  // 레이어를 켰는데 아직 서버에 알리기 전(mode off)이면 수신 대기로 본다
  const ship = shipsOn
    ? shipsChip(ships.mode === "off" ? { ...ships, mode: "waiting" } : ships, { zoom: viewport?.zoom ?? null, bbox: viewport?.bbox ?? null, ais, filter: chipFilter(ships, shipCats) })
    : null;
  if (!chip && !ship) return null;
  return (
    <div className="pointer-events-none absolute top-3 left-12 z-10 flex max-w-[60%] flex-col items-start gap-1" aria-live="polite">
      {chip ? <div className="pointer-events-auto bg-bg-1/90"><DemandBadge chip={chip} testId="demand-map-chip" /></div> : null}
      {ship ? (
        <div className="pointer-events-auto bg-bg-1/90">
          <span className={`badge normal-case! ${ship.warn ? "warn" : ""}`} data-testid="ships-chip" data-mode={ships.mode} title={ship.title}>
            {ship.text}{shipsGapSuffix(ais)}
          </span>
        </div>
      ) : null}
    </div>
  );
}
