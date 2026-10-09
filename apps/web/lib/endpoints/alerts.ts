/** 알림 한 건 — 근거 공유(계약 v5 §G51). 본문이 화면이 읽는 모양이 아니면 null */
import { apiGet } from "@/lib/api";
import { parseAlertDetail, type AlertDetail } from "@/lib/alert-detail";
import { pathSegment } from "./path";

export async function alertDetail(id: string, o?: { signal?: AbortSignal }): Promise<AlertDetail | null> {
  return apiGet<unknown>(`/api/v1/alerts/${pathSegment(id)}`, o).then((b) => parseAlertDetail(b));
}
