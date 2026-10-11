"use client";
import { useRouter } from "next/navigation";
import { ScrollRegion } from "./ScrollRegion";
import { KstTime } from "./KstTime";
import { RequestIdOf } from "./logs/ErrorNote";
import { statusOf } from "./WatchPanel";
import { WatchRunner } from "./watch/WatchRunner";
import { openAlerts } from "@/lib/endpoints/alerts";
import { alertZone } from "@/lib/alerts";
import { errorLine } from "@/lib/api";
import { enableNotify } from "@/lib/notify";
import { fmtKstClock } from "@/lib/time";
import { useApiResource } from "@/lib/use-api-resource";
import { label, type WatchEvent } from "@/lib/watch";
import { useWatch } from "@/lib/watch-store";
import type { Alert } from "@/lib/types";

export const MOBILE_REFRESH_MS = 15_000;

/** 모바일 화면 본문(app/m) — 시험이 서버 렌더로도 그린다 */
export function MobileAlerts() {
  const res = useApiResource("m-alerts", (signal) => openAlerts({ signal }), { refreshMs: MOBILE_REFRESH_MS });
  const targets = useWatch((s) => s.targets);
  const state = useWatch((s) => s.state);
  const permission = useWatch((s) => s.permission);
  const setPermission = useWatch((s) => s.setPermission);
  const items = res.data ?? [];
  const router = useRouter();
  // 관심 대상 사건을 누르면: 알림 사건은 그 근거 화면, 그 밖은 이 화면에 남는다(지도 카드가 없다)
  const openOnMobile = (e: WatchEvent) => { if (e.alertId != null) router.push(`/alerts/${e.alertId}`); };
  // 단추 이름은 하는 일(QA-803): 알림 사건은 '근거 보기', 그 밖은 열 것이 없어 '닫기'만
  const openName = (e: WatchEvent) => (e.alertId != null ? "근거 보기" : null);
  return (
    <ScrollRegion label="모바일 알림" main className="h-full overflow-y-auto overflow-x-hidden p-3 text-[13px]" data-testid="mobile">
      <h1 className="label mb-1" lang="en">Alerts · mobile</h1>
      <div className="mb-2 text-[11px] text-fg-3" role="status" aria-live="polite" data-testid="mobile-status">
        {res.status === "failed" ? <span className="text-bad">조회 실패 — {errorLine(res.error)}<RequestIdOf error={res.error} /></span>
          : res.data ? `열린 알림 ${items.length}건 · 15초마다(보이는 동안) · 지도 · 실시간 연결 없음`
          : res.status === "loaded" ? <span className="text-warn">응답의 모양이 틀려 그리지 않음</span> : "알림 불러오는 중…"}
      </div>
      <ul className="mb-4 border-t border-line" data-testid="mobile-alerts">
        {res.data && !items.length ? <li className="py-3 text-fg-3">지금 열린 알림이 없습니다.</li> : null}
        {items.map((a) => <MobileRow key={a.id} a={a} />)}
      </ul>
      <section aria-labelledby="m-watch" data-testid="mobile-watch">
        <h2 id="m-watch" className="label mb-1">관심 대상 · 이 브라우저</h2>
        {permission === "default" ? <button className="btn mb-2" onClick={() => void enableNotify().then(setPermission)}>브라우저 알림 켜기</button> : null}
        {permission === "blocked" ? <div className="mb-2 text-[12px] text-fg-3" data-testid="mobile-notify">이 브라우저는 페이지 알림을 막음(안드로이드 크롬 등) — 이 화면의 배너만</div> : null}
        {!targets.length ? <div className="text-[12px] text-fg-3">관심 대상이 없습니다 — 상황판의 항공기 · 선박 · 공항 카드에서 더합니다(같은 브라우저).</div> : (
          <ul className="border-t border-line">
            {targets.map((t) => (
              <li key={`${t.kind}:${t.id}`} className="flex flex-wrap justify-between gap-x-2 border-b border-line py-2" data-testid="mobile-watch-item">
                <span className="min-w-0 break-all">{label(t)}</span><span className="text-fg-3">{statusOf(t, state)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <WatchRunner open={openOnMobile} openName={openName} />
    </ScrollRegion>
  );
}

function MobileRow({ a }: { a: Alert }) {
  const z = alertZone(a);
  const pred = a.kind === "PREDICTED";
  return (
    <li className="border-b border-line">
      <a href={`/alerts/${a.id}`} className="block py-2 hover:bg-bg-2" data-testid="mobile-alert">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className={`badge ${pred ? "est" : "warn"}`}>{pred ? "예측 진입" : "진입"}</span>
          <span className="font-semibold">{a.callsign?.trim() || "호출부호 —"}</span>
          <span className="mono text-[11px] text-fg-3">{a.hex}</span>
        </div>
        <div className="mt-0.5 break-words">{z.kind} · {z.label} · {z.sub}</div>
        <div className="text-[11px] text-fg-3">진입 <KstTime v={a.entered_at} />{pred && a.eta_at ? <> · 예상 {fmtKstClock(a.eta_at)}(추정)</> : null}</div>
      </a>
    </li>
  );
}
