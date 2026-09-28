"use client";
import { useMemo, useState } from "react";
import { serverNowMs, useServerData, type ServerData } from "@/lib/store";
import { useNow, useRxFresh, useServerNow } from "@/lib/clock";
import type { Alert } from "@/lib/types";
import { useUi } from "@/lib/ui-store";
import { EvidenceCard } from "./EvidenceCard";
import { fmtClock, fmtEta, fmtTime, hazardColor } from "@/lib/format";
import { alertListState, EVENT_LABEL, etaRemainingS, eventBannerVisible, type AlertListState } from "@/lib/alerts";
import { aircraftPos, panIfOutside } from "@/lib/focus";
import { AltStack } from "./UnitStack";

/**
 * 알림 패널(FR-10): 관측(경보 안)·예측(추정)을 구분해 목록으로. 행을 누르면 목록 안에서 근거 카드를 펼치고(선택하지 않음),
 * 펼친 영역의 "항공기 카드·지도" 버튼이 항공기를 선택하고 알려진 위치가 화면 밖이면 지도를 옮긴다(R-08).
 * 예측 ETA 는 eta_at 에서 1 s 마다 줄어든다(추정). 배너는 진입·이탈·신호 끊김·진입 예상만(예측 갱신/해제는 목록에만 반영).
 * 목록을 아직 받지 못했으면 "없음"이라고 하지 않고 "수신 대기", 연결이 끊겼으면 마지막 목록임을 밝히고 ETA 를 멈춘다(DH-9).
 * 예측 행의 고도는 진입 시 고도 추정값 — 보라 점선 밑줄(추정 표기)로 관측 고도와 구분한다(DH-15). 고도 칸 둘째 줄은 m(계약 v5 §A2).
 */
export function AlertPanel() {
  const alerts = useServerData((d) => d.alerts);
  const lastEvent = useServerData((d) => d.lastEvent);
  const conn = useServerData((d) => d.conn);
  const alertsVersion = useServerData((d) => d.alertsVersion);
  const listState = alertListState(conn, alertsVersion, useRxFresh());
  const select = useUi((s) => s.select);
  const [open, setOpen] = useState<number | null>(null);
  const [scope, setScope] = useState<"region" | "world">("region");
  const status = useServerData((d) => d.status);
  const all = useMemo(() => [...alerts.values()], [alerts]);
  // 관심 지역 설정(status.region)을 아직 받지 못했으면 범위를 모른다 — 전세계 목록을 '관심 지역'으로 보이지 않고 기다린다(R-09)
  const regionPending = scope === "region" && status == null;
  // 관심 지역 = 서버 설정의 중심·반경(설정값이 없으면 전체). 항공기 위치는 evidence.position([lat, lon]) 또는 없음 → 전세계 뷰에서만 표시
  const list = useMemo(() => {
    if (scope === "region" && status == null) return [];
    const center = status?.region.center, radius = status?.region.radius_nm;
    const inRegion = (a: (typeof all)[number]) => {
      if (!center || !radius) return true;
      const pos = (a.evidence as { position?: number[] }).position;
      if (!pos) return false;
      const dLat = (pos[0] - center[0]) * 60, dLon = (pos[1] - center[1]) * 60 * Math.cos((center[0] * Math.PI) / 180);
      return Math.hypot(dLat, dLon) <= radius;
    };
    return all.filter((a) => scope === "world" || inRegion(a))
      .sort((a, b) => (a.kind === b.kind ? b.entered_at.localeCompare(a.entered_at) : a.kind === "OBSERVED" ? -1 : 1));
  }, [all, scope, status]);
  const observed = list.filter((a) => a.kind === "OBSERVED").length;
  // 목록을 받기 전·관심 지역을 모를 때 수는 모름("—") — 0 이라고 하지 않는다(R-09)
  const countsKnown = alertsVersion != null && !regionPending;
  const regionText = "관심 지역(중심 " + (status?.region.center?.join(", ") ?? "—") + ", 반경 " + (status?.region.radius_nm ?? "—") + " NM)에서 ";
  return (
    <div className="flex h-full flex-col" data-testid="alert-panel">
      <div className="row">
        <span className="label">Alerts</span>
        <div className="flex items-center gap-2">
          <button className="btn" aria-pressed={scope === "region"} onClick={() => setScope("region")} data-testid="alerts-scope-region">관심 지역</button>
          <button className="btn" aria-pressed={scope === "world"} onClick={() => setScope("world")} data-testid="alerts-scope-world">전세계 {alertsVersion != null ? all.length : "—"}</button>
          <span className="mono text-[11px]"><span className="text-bad">{countsKnown ? observed : "—"}</span> inside · <span className="text-est">{countsKnown ? list.length - observed : "—"}</span> predicted</span>
        </div>
      </div>
      {/* 새 이벤트를 스크린리더에 알린다(영역은 항상 있어야 변경이 읽힌다). 높이를 고정해 배너가 나타나거나 사라져도 목록이 밀리지 않는다(R-09) */}
      <div role="status" aria-live="polite" aria-atomic="true" className="h-[26px] shrink-0 overflow-hidden border-b border-line">
        {lastEvent ? <EventBanner key={lastEvent.at} ev={lastEvent} /> : null}
      </div>
      {listState !== "live" && (listState !== "waiting" || list.length > 0) ? (
        <div className="border-b border-line bg-bg-2 px-2 py-1 text-[11px] text-warn" role="note" data-testid="alerts-stale" data-state={listState}>
          {listState === "waiting" ? "알림 수신 대기 — 아래는 이전 연결의 목록(갱신 안 됨 · ETA 멈춤)"
            : listState === "paused" ? "일시정지(탭 숨김) — 마지막으로 받은 목록 · 갱신 안 됨"
            : listState === "silent" ? "수신 없음(연결은 열림) — 마지막으로 받은 목록 · 갱신 안 됨 · ETA 멈춤"
            : "연결 끊김 — 마지막으로 받은 목록 · 갱신 안 됨 · ETA 멈춤"}
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {regionPending && alertsVersion != null ? (
          <div className="p-3 text-[11px] text-fg-3" data-testid="alerts-region-waiting">관심 지역 설정(중심·반경) 수신 대기 — 전세계 목록은 &lsquo;전세계&rsquo;에서 볼 수 있습니다.</div>
        ) : null}
        {list.length === 0 && alertsVersion != null && !regionPending ? (
          <div className="p-3 text-[11px] text-fg-3" data-testid="alerts-empty">
            {listState === "live" ? "" : "마지막으로 받은 목록 기준: "}{scope === "region" ? regionText : ""}현재 SIGMET 안에 있거나 10분 내 진입이 예상되는 항공기가 없습니다.
          </div>
        ) : null}
        {list.length === 0 && alertsVersion == null ? <div className="p-3 text-[11px] text-fg-3" data-testid="alerts-waiting">알림 목록 수신 대기 중 — 아직 “없음”을 뜻하지 않습니다.</div> : null}
        {list.map((a) => (
            <div key={a.id} className="border-b border-line" data-testid="alert-item" data-kind={a.kind}>
              <button className="flex w-full items-center gap-2 px-2 py-1.5 text-left hover:bg-bg-2" aria-expanded={open === a.id} aria-controls={open === a.id ? `evidence-${a.id}` : undefined}
                onClick={() => setOpen(open === a.id ? null : a.id)} data-testid="alert-toggle">
                <span className="inline-block h-2 w-2 shrink-0" style={{ background: hazardColor(a.hazard) }} />
                <span className="mono w-16 shrink-0 text-[12px]">{a.callsign ?? a.hex}</span><span className="sr-only">, </span>
                <span className="w-[72px] shrink-0 overflow-hidden text-[11px] text-ellipsis whitespace-nowrap text-fg-2" title={`${a.hazard}${a.qualifier ? ` ${a.qualifier}` : ""}`}>{a.hazard}{a.qualifier ? ` ${a.qualifier}` : ""}</span><span className="sr-only">, </span>
                <span className="mono w-12 shrink-0 text-[11px] text-fg-3">{a.fir_id}</span><span className="sr-only">, </span>
                {a.kind === "PREDICTED"
                  ? <span className="mono est-val w-14 shrink-0 text-[11px]" title="진입 시 고도 — 추정(현재 고도·수직속도로 외삽)" data-testid="alert-alt-est"><span className="sr-only">진입 시 고도 추정 </span><AltStack ft={a.alt_ft} est align="start" /></span>
                  : <span className="mono w-14 shrink-0 text-[11px]" title="관측 고도"><AltStack ft={a.alt_ft} align="start" /></span>}<span className="sr-only">, </span>
                {a.kind === "PREDICTED" ? <EtaBadge a={a} state={listState} /> : <span className="badge bad ml-auto">INSIDE<span className="sr-only"> — 경보 안</span></span>}
              </button>
              {open === a.id ? (
                <div id={`evidence-${a.id}`} className="px-2 pb-2">
                  <EvidenceCard a={a} />
                  <button className="btn mt-1" onClick={() => { select(a.hex); panIfOutside(aircraftPos(a.hex, a)); }} data-testid="alert-open-aircraft">항공기 카드 · 지도에서 보기</button>
                </div>
              ) : null}
            </div>
        ))}
        {list.some((a) => a.kind === "PREDICTED") ? <div className="px-2 py-1 text-[10px] text-fg-3">예측 행의 고도(<span className="est-val">보라 점선</span>) = 진입 시 고도 추정값 · ETA 도 추정</div> : null}
      </div>
    </div>
  );
}

/**
 * 마지막 알림 이벤트 배너(R-23): 받은 시각(서버 시계 추정)을 붙이고, EVENT_BANNER_TTL_MS(5분)가 지나면 숨긴다 — 오래된 진입이 방금 일처럼 보이지 않게.
 * 시각은 고정 문자열이라 aria-live 영역이 1 s 마다 다시 읽히지 않는다(숨길 때 한 번만 바뀐다).
 */
function EventBanner({ ev }: { ev: NonNullable<ServerData["lastEvent"]> }) {
  const now = useNow(1000);
  if (!eventBannerVisible(ev.at, now)) return null;
  return (
    <div className="flash truncate px-2 py-1 text-[11px] text-fg-2" data-testid="alert-banner" data-event={ev.type}>
      <span className="label mr-1">{ev.type}</span>
      <span className={ev.type === "LOST" ? "text-warn" : ""}>{EVENT_LABEL[ev.type] ?? ev.type}</span>
      {" · "}<span className="mono">{ev.alert.callsign ?? ev.alert.hex}</span> · {ev.alert.hazard} {ev.alert.fir_id}
      {" · "}<span className="mono text-fg-3" data-testid="alert-banner-time">수신 {fmtClock(serverNowMs(ev.at))}</span>
    </div>
  );
}

/** 멈춘 ETA 의 툴팁 — 목록 위 안내(alerts-stale)와 같은 상태 이름으로(R-58: 연결이 열린 'silent' 를 "끊김"이라고 하지 않는다) */
const ETA_FROZEN_TITLE: Record<Exclude<AlertListState, "live">, string> = {
  silent: "수신 없음(연결은 열림) — 갱신되지 않음 · 이미 해제됐을 수 있습니다",
  paused: "일시정지(탭 숨김) — 갱신되지 않음 · 이미 해제됐을 수 있습니다",
  waiting: "알림 수신 대기 — 이전 연결의 목록이라 갱신되지 않음 · 이미 해제됐을 수 있습니다",
  disconnected: "연결이 끊겨 갱신되지 않음 — 이미 해제됐을 수 있습니다",
};

/** 예측 ETA(추정) — 이 배지만 1 s 마다 다시 그린다. 목록이 갱신되지 않는 동안(live 가 아님)은 카운트다운하지 않는다. */
function EtaBadge({ a, state }: { a: Alert; state: AlertListState }) {
  const now = useServerNow(1000);
  const judged = typeof a.evidence?.judged_at === "string" ? a.evidence.judged_at : null;
  const frozen = state !== "live";
  return (
    <span className="badge est ml-auto" title={state === "live" ? `판정 ${fmtTime(judged)} · 현재 속도·방위 직선 외삽` : ETA_FROZEN_TITLE[state]} data-testid="alert-eta">
      추정 ETA {frozen ? "—" : fmtEta(now ? etaRemainingS(a, now) : a.eta_s)}
    </span>
  );
}
