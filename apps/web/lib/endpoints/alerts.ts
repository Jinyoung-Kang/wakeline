/** 알림 한 건 — 근거 공유(계약 v5 §G51) · 열린 알림 목록(모바일 화면 /m — 지도 · WS 없이). 본문이 화면이 읽는 모양이 아니면 null */
import { apiGet } from "@/lib/api";
import { parseAlertDetail, type AlertDetail } from "@/lib/alert-detail";
import type { Alert } from "@/lib/types";
import { pathSegment } from "./path";

/** 지금 열린 알림(관측 + 예측 — 계약 §2 GET /api/v1/alerts). 원소마다 최소 모양만 본다(틀린 원소는 버린다) */
export async function openAlerts(o?: { signal?: AbortSignal }): Promise<Alert[] | null> {
  const b = await apiGet<unknown>("/api/v1/alerts", o);
  const items = (b as { items?: unknown })?.items;
  if (!Array.isArray(items)) return null;
  return items.filter((a): a is Alert => typeof a === "object" && a !== null && typeof (a as Alert).id === "number" && typeof (a as Alert).hex === "string"
    && ((a as Alert).kind === "OBSERVED" || (a as Alert).kind === "PREDICTED") && typeof (a as Alert).entered_at === "string");
}

export async function alertDetail(id: string, o?: { signal?: AbortSignal }): Promise<AlertDetail | null> {
  return apiGet<unknown>(`/api/v1/alerts/${pathSegment(id)}`, o).then((b) => parseAlertDetail(b));
}
