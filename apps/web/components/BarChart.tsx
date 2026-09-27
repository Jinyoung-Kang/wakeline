/** 의존성 없는 SVG 막대 차트 — 통계 화면 전용. */
export function BarChart({ rows, height = 160, color = "#4c90f0", unit = "" }: { rows: { label: string; value: number }[]; height?: number; color?: string; unit?: string }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  const w = Math.max(320, rows.length * 28);
  return (
    <svg viewBox={`0 0 ${w} ${height + 28}`} className="w-full" role="img">
      {rows.map((r, i) => {
        const h = (r.value / max) * height;
        const x = i * (w / rows.length);
        const bw = Math.max(4, w / rows.length - 6);
        return (
          <g key={r.label}>
            <rect x={x + 3} y={height - h} width={bw} height={h} fill={color} opacity={0.85} />
            <text x={x + 3 + bw / 2} y={height + 12} fontSize={9} fill="#6b737e" textAnchor="middle">{r.label}</text>
            <text x={x + 3 + bw / 2} y={Math.max(10, height - h - 3)} fontSize={9} fill="#a3aab4" textAnchor="middle">{r.value}{unit}</text>
          </g>
        );
      })}
    </svg>
  );
}
