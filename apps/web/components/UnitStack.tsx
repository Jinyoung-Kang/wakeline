import { altM, fmtAlt, sogKmh } from "@/lib/format";

/**
 * 좁은 표 칸의 두 단위(계약 v5 §A2): 주 단위(ft·FL·kt·kn) 아래 작은 회색 줄로 m·km/h. 모르면 "—" 한 줄(둘째 줄을 만들지 않는다).
 * est = 추정값(예측 진입 고도 등) — 두 줄 모두 추정 표기(.est-val)를 유지한다.
 */
function Stack({ main, sub, est, align = "end", nowrap }: { main: string; sub: string | null; est?: boolean; align?: "end" | "start"; nowrap?: boolean }) {
  const cls = est ? "est-val" : "";
  if (sub == null) return <span className={`mono ${cls}`.trim()}>{main}</span>;
  return (
    <span className={`inline-flex flex-col leading-tight ${align === "end" ? "items-end" : "items-start"}${nowrap ? " whitespace-nowrap" : ""}`}>
      <span className={`mono ${cls}`.trim()}>{main}</span>
      <span className={`mono text-[10px] ${est ? "est-val" : "text-fg-3"}`}>{sub}</span>
    </span>
  );
}

/** 고도: "FL340" / "10,363 m". 지상(on_ground=true)이면 "GND" — 0 이 아닌 기압 고도를 보고했으면 둘째 줄에 보고값(DH-3) */
export function AltStack({ ft, onGround, est, align, nowrap }: { ft: number | null | undefined; onGround?: boolean | null; est?: boolean; align?: "end" | "start"; nowrap?: boolean }) {
  if (onGround === true) return <Stack main="GND" sub={ft == null || ft === 0 ? null : `${fmtAlt(ft)} · ${altM(ft)} 보고`} est={est} align={align} />;
  return <Stack main={fmtAlt(ft)} sub={ft == null || !Number.isFinite(ft) ? null : altM(ft)} est={est} align={align} nowrap={nowrap} />;
}

/** 선박 대지속력: "12.3 kn" / "22.8 km/h". nowrap = 좁은 표 칸에서 줄바꿈하지 않음 */
export function SogStack({ kn, align, nowrap }: { kn: number | null | undefined; align?: "end" | "start"; nowrap?: boolean }) {
  const ok = kn != null && Number.isFinite(kn);
  return <Stack main={ok ? `${kn.toFixed(1)} kn` : "—"} sub={ok ? sogKmh(kn) : null} align={align} nowrap={nowrap} />;
}
