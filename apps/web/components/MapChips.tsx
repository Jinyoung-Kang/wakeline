"use client";
import { useNow, useServerNow } from "@/lib/clock";
import { mapDemandChip, type Chip } from "@/lib/demand";
import { fmtCount } from "@/lib/ships";
import { useServerData } from "@/lib/store";
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
 * - 선박: 지금 지도가 무엇을 그리는지(개별 선박 N척 / 격자 N칸·M척 / 수신 대기) — 격자로 묶었다는 사실을 숨기지 않는다.
 */
export function MapChips() {
  const hex = useUi((s) => s.selectedHex);
  const shipsOn = useUi((s) => s.layers.ships);
  return <MapChipsView hex={hex} shipsOn={shipsOn} />;
}

/** 표시 부분(선택 hex·선박 레이어를 인자로 — 서버 렌더 시험용) */
export function MapChipsView({ hex, shipsOn }: { hex: string | null; shipsOn: boolean }) {
  const demand = useServerData((d) => d.demand);
  const conn = useServerData((d) => d.conn);
  const lastRxAt = useServerData((d) => d.lastRxAt);
  const ships = useServerData((d) => d.ships);
  const gapOpen = useServerData((d) => d.ais?.gap_open_since ?? null);
  const aisOff = useServerData((d) => d.ais?.state === "disabled");
  const now = useServerNow(1000);
  const wall = useNow(1000);
  // 끊김·일시정지·수신 없음이면 서버 임대가 곧 만료된다 — 마지막 상태를 "진행 중"처럼 보이지 않는다
  const chip = isRxFresh(conn, lastRxAt, wall) ? mapDemandChip(demand, hex, now) : null;
  const shipText = !shipsOn ? null
    : ships.mode === "points" ? `선박 ${ships.count.toLocaleString("en-US")}척 · 화면 안 · AIS`
    : ships.mode === "grid" ? `선박 ${fmtCount(ships.total)}척 · ${ships.cell_deg ?? "—"}° 격자 ${ships.count}칸으로 묶음${ships.capped ? " · 전송 상한 초과" : " · 줌 7 이상에서 개별 표시"}`
    : aisOff ? "선박 없음 · AIS 꺼짐(키 없음)" : "선박 수신 대기";
  if (!chip && !shipText) return null;
  return (
    <div className="pointer-events-none absolute top-3 left-12 z-10 flex max-w-[60%] flex-col items-start gap-1" aria-live="polite">
      {chip ? <div className="pointer-events-auto bg-bg-1/90"><DemandBadge chip={chip} testId="demand-map-chip" /></div> : null}
      {shipText ? (
        <div className="pointer-events-auto bg-bg-1/90">
          <span className={`badge normal-case! ${ships.capped ? "warn" : ""}`} data-testid="ships-chip" data-mode={ships.mode}
            title={ships.mode === "grid" ? "선박이 많아 서버가 격자별 선박 수만 보냅니다(원 크기 = 수, 색 = 가장 많은 선종). 원을 누르면 확대합니다." : "AIS 로 받은 선박 위치(보간 없음)"}>
            {shipText}{gapOpen ? " · AIS 공백 중(위치 멈춤)" : ""}
          </span>
        </div>
      ) : null}
    </div>
  );
}
