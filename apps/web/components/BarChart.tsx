import { chartSummary, type ChartRow } from "@/lib/chart";

const SLOT = 28; // 막대 한 칸(px) — 항목 수와 무관하게 글자 크기가 일정하도록 확대하지 않는다
const TOP = 14; // 최댓값 라벨 자리
const MAX_LABEL = 12; // 이보다 긴 라벨만 줄인다(전체는 툴팁·스크린리더 표)
const LABEL_H = { rotated: 64, flat: 18 }; // 막대 이름 줄의 높이 — 45° 기울인 이름 · 바로 쓴 이름
const DEFAULT_H = 160; // 막대 영역 높이(기본)
const PAD_L = 44; // 기울인 이름이 왼쪽으로 넘는 몫

/**
 * 그림의 크기 규칙(받기 전 자리를 잡는 화면 — app/stats · QA-1500): 그림은 제 크기(너비 barChartWidth · 높이 barChartMaxHeight)로 그리고, 칸이 좁으면
 * 너비에 맞춰 같은 비율로 줄 뿐 커지지 않는다(svg max-width 100% · height auto) — 높이 = barChartMaxHeight × min(1, 칸 너비 / barChartWidth).
 * rotated = 이름을 기울이는가(3자를 넘는 이름이 있는가) · slots = 칸 수(minSlots 를 주면 막대가 적어도 그만큼).
 */
export function barChartMaxHeight({ height = DEFAULT_H, rotated }: { height?: number; rotated: boolean }): number {
  return TOP + height + (rotated ? LABEL_H.rotated : LABEL_H.flat);
}
export function barChartWidth({ slots, rotated }: { slots: number; rotated: boolean }): number {
  return (rotated ? PAD_L : 0) + Math.max(slots, 2) * SLOT;
}

/**
 * 의존성 없는 SVG 막대 차트 — 통계 화면 전용. value=null 은 "자료 없음"(0 막대로 그리지 않고 점선 + "—").
 * 스크린리더: svg 에 제목·요약(aria-labelledby), 같은 값을 시각적으로 숨긴 표로도 제공(GAP-25).
 * 라벨이 3자를 넘으면(FIR·위험 유형) 45° 기울여 칸을 넘지 않게 하고, 줄인 라벨도 전체를 툴팁(<title>)으로 보인다(R-32).
 * 행에 full(전체 이름 — 예: 시간대 막대의 "09-29 07시 KST")이 있으면 툴팁 · 스크린리더 표는 그것을 쓴다.
 * minSlots: 막대가 적어도 그 칸 수만큼 너비를 잡는다(빈 칸은 오른쪽) — 상위 N 그림의 높이가 막대 수와 상관없이 칸 너비로만 정해지게(QA-1500).
 */
export function BarChart({ id, title, rows, height = DEFAULT_H, color = "#4c90f0", unit = "", minSlots = 0 }: { id: string; title: string; rows: ChartRow[]; height?: number; color?: string; unit?: string; minSlots?: number }) {
  const max = Math.max(1, ...rows.map((r) => r.value ?? 0));
  const rotate = rows.some((r) => r.label.length > 3);
  const padL = rotate ? PAD_L : 0;
  const w = barChartWidth({ slots: Math.max(rows.length, minSlots), rotated: rotate });
  const H = barChartMaxHeight({ height, rotated: rotate });
  const summary = chartSummary(rows, unit);
  return (
    <figure className="m-0 overflow-x-auto">
      <svg width={w} height={H} viewBox={`0 0 ${w} ${H}`} className="block max-w-full" style={{ height: "auto" }} role="img" aria-labelledby={`${id}-t ${id}-d`}>
        <title id={`${id}-t`}>{title}</title>
        <desc id={`${id}-d`}>{summary}</desc>
        <line x1={padL} x2={w} y1={TOP + height + 0.5} y2={TOP + height + 0.5} stroke="#333a43" />
        {rows.map((r, i) => {
          const h = r.value == null ? 0 : (r.value / max) * height;
          const x = padL + i * SLOT;
          const bw = SLOT - 6;
          const cx = x + 3 + bw / 2;
          const ly = TOP + height + 12;
          const cut = r.label.length > MAX_LABEL ? `${r.label.slice(0, MAX_LABEL - 1)}…` : r.label;
          return (
            <g key={r.label}>
              {r.value == null
                ? <line x1={x + 3} x2={x + 3 + bw} y1={TOP + height - 2.5} y2={TOP + height - 2.5} stroke="#8a929d" strokeDasharray="2 2" />
                : <rect x={x + 3} y={TOP + height - h} width={bw} height={h} fill={color} opacity={0.85} />}
              <text x={cx} y={ly} fontSize={10} fill="#8a929d" textAnchor={rotate ? "end" : "middle"} transform={rotate ? `rotate(-45 ${cx} ${ly - 4})` : undefined}>
                <title>{r.full ?? r.label}</title>{cut}
              </text>
              <text x={cx} y={TOP + height - h - 3} fontSize={9} fill={r.value == null ? "#8a929d" : "#a3aab4"} textAnchor="middle">{r.value == null ? "—" : `${r.value}${unit}`}</text>
            </g>
          );
        })}
      </svg>
      <table className="sr-only">
        <caption>{title}</caption>
        <thead><tr><th scope="col">항목</th><th scope="col">값</th></tr></thead>
        <tbody>{rows.map((r) => <tr key={r.label}><td>{r.full ?? r.label}</td><td>{r.value == null ? "자료 없음" : `${r.value}${unit}`}</td></tr>)}</tbody>
      </table>
    </figure>
  );
}
