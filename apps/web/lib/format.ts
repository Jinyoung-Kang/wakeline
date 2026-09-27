export const HAZARD_COLORS: Record<string, string> = {
  TS: "#f59e0b", TURB: "#a855f7", ICE: "#38bdf8", MTW: "#64748b", VA: "#a16207", TC: "#ef4444",
  CONVECTIVE: "#f59e0b", IFR: "#ef4444", MTN: "#64748b", "MT OBSC": "#64748b", LLWS: "#22c55e",
};
export const hazardColor = (h: string) => HAZARD_COLORS[h] ?? "#94a3b8";

export const CAT_COLORS: Record<string, string> = { VFR: "#22c55e", MVFR: "#3b82f6", IFR: "#ef4444", LIFR: "#d946ef" };

export function fmtAlt(ft: number | null | undefined) {
  return ft == null ? "—" : ft >= 18000 ? `FL${Math.round(ft / 100)}` : `${ft.toLocaleString()} ft`;
}
export function fmtNum(v: number | null | undefined, unit = "", digits = 0) {
  return v == null ? "—" : `${v.toFixed(digits)}${unit}`;
}
export function fmtTime(iso: string | null | undefined) {
  if (!iso) return "—";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "—" : d.toISOString().slice(11, 19) + "Z";
}
export function fmtAgo(iso: string | null | undefined, nowMs = Date.now()) {
  if (!iso) return "—";
  const s = Math.max(0, Math.round((nowMs - Date.parse(iso)) / 1000));
  return s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`;
}
export function fmtEta(s: number | null | undefined) {
  if (s == null) return "—";
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}
export function band(base: number, top: number | null | undefined) {
  return `${base === 0 ? "SFC" : fmtAlt(base)} – ${top == null ? "∞" : fmtAlt(top)}`;
}
