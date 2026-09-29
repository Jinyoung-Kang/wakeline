"use client";
import { useMemo } from "react";
import { useServerNow } from "@/lib/clock";
import { panIfOutside } from "@/lib/focus";
import { fmtDual } from "@/lib/time";
import { hazardColor } from "@/lib/format";
import { sigmetListItems, type SigmetListItem } from "@/lib/sigmet";
import { useServerData } from "@/lib/store";
import { useUi } from "@/lib/ui-store";

/** SIGMET 탭(선택 없음): 지금 그려지는 SIGMET 목록 — 지도 클릭 없이 키보드로 고른다(R-40). */
export function SigmetList() {
  const sigmets = useServerData((d) => d.sigmets);
  const alerts = useServerData((d) => d.alerts);
  const alertsVersion = useServerData((d) => d.alertsVersion);
  const now = useServerNow(30_000);
  const items = useMemo(() => (now ? sigmetListItems(sigmets, alertsVersion == null ? null : alerts.values(), now) : []), [sigmets, alerts, alertsVersion, now]);
  return <SigmetListView items={items} waiting={sigmets == null} />;
}

/** 표시 부분(목록을 인자로 — 서버 렌더 시험용) */
export function SigmetListView({ items, waiting = false }: { items: SigmetListItem[]; waiting?: boolean }) {
  const selectSigmet = useUi((s) => s.selectSigmet);
  return (
    <div className="flex h-full flex-col" data-testid="sigmet-list">
      <div className="row"><span className="label">SIGMET {waiting ? "" : items.length}</span><span className="text-[10px] text-fg-3">지도에서 폴리곤을 클릭하거나 아래에서 고르세요</span></div>
      <ul className="min-h-0 flex-1 overflow-y-auto text-[12px]">
        {items.map((s) => (
          <li key={s.id} className="border-b border-line">
            <button className="flex w-full items-center gap-2 px-2 py-1 text-left hover:bg-bg-2" data-testid="sigmet-list-item" data-id={s.id}
              onClick={() => { selectSigmet(s.id); panIfOutside(s.center); }}
              aria-label={`${s.hazard}${s.qualifier ? ` ${s.qualifier}` : ""}, ${s.fir_name ?? s.fir_id}, ${s.pending ? "발효 전, " : ""}안 항공기 ${s.inside ?? "모름"}, 진입 예상 ${s.predicted ?? "모름"}, 유효 ${fmtDual(s.valid_to)} 까지`}>
              <span className="inline-block h-2 w-2 shrink-0" style={{ background: hazardColor(s.hazard) }} />
              <span className="w-[84px] shrink-0 truncate">{s.hazard}{s.qualifier ? ` ${s.qualifier}` : ""}</span>
              <span className="mono w-12 shrink-0 text-fg-3">{s.fir_id}</span>
              <span className="min-w-0 flex-1 truncate text-fg-2">{s.fir_name ?? ""}{s.pending ? " · 발효 전" : ""}</span>
              <span className="mono shrink-0 text-[11px]" title="안 항공기(관측 알림) · 진입 예상(추정)">
                <span className={s.inside ? "text-bad" : ""}>{s.inside ?? "—"}</span> / <span className="text-est">{s.predicted ?? "—"}</span>
              </span>
            </button>
          </li>
        ))}
        {!waiting && items.length === 0 ? <li className="px-2 py-2 text-[11px] text-fg-3">지금 유효한 SIGMET 이 없습니다.</li> : null}
        {waiting ? <li className="px-2 py-2 text-[11px] text-fg-3">SIGMET 수신 대기 중…</li> : null}
      </ul>
      <div className="border-t border-line px-2 py-1 text-[10px] text-fg-3">오른쪽 수 = 안 항공기(관측 알림) / 진입 예상(추정) · — = 알림 목록을 아직 받지 못함</div>
    </div>
  );
}
