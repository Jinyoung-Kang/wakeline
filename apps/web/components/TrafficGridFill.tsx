import { FILL_LABEL, FILL_TITLE, trafficGridFill, type FillTone } from "@/lib/traffic-grid-fill";

const TONE: Record<FillTone, string> = { ok: "text-fg-2", warn: "text-warn", muted: "text-fg-3" };

/**
 * 운영 화면 providers 탭의 한 줄 — 연안 교통량 격자 위치 채우기 진행(수집기 heartbeat 그대로, ADR-023 2026-10-01 개정). 값은 lib/traffic-grid-fill.
 * 수집기가 채우기 필드를 쓰지 않으면 그리지 않는다. nowMs = 서버 기준 지금(providersNowMs) — heartbeat 가 오래됐으면 수 대신 그 까닭만.
 */
export function TrafficGridFill({ collector, nowMs }: { collector: Record<string, unknown> | null | undefined; nowMs: number }) {
  const v = trafficGridFill(collector, nowMs);
  if (!v) return null;
  return (
    <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[11px]" data-testid="ops-traffic-grid-fill">
      <span className="label" title={FILL_TITLE}>{FILL_LABEL}</span>
      <span className={TONE[v.state.tone]} title={v.state.title} data-testid="ops-traffic-grid-fill-state">{v.state.text}</span>
      {v.items.map((i) => (
        <span key={i.key} className={TONE[i.tone]} title={i.title} data-testid={`ops-traffic-grid-fill-${i.key}`}>
          {i.label} <span className="mono">{i.text}</span>
        </span>
      ))}
      <span className={TONE[v.pass.tone]} title={v.pass.title} data-testid="ops-traffic-grid-fill-pass">{v.pass.text}</span>
    </div>
  );
}
