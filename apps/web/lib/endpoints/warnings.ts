/**
 * 기상특보 REST(계약 v5 §G49 · ADR-036) — 선박 카드(나중에 받는 조각)가 '지금 발효 중인 해상특보 수'를 적으려고 부른다. 첫 화면 밖이다. 특보 탭의 주기 조회는
 * 조건부 요청(304)이라 lib/warnings 의 ETag 조회기가 따로 맡는다.
 */
import { apiGet } from "@/lib/api";
import { parseWarnings, type Warnings } from "@/lib/warnings";

/** 지금 발효 중인 특보. 본문이 화면이 읽는 모양이 아니면 null */
export async function warningsNow(o?: { signal?: AbortSignal }): Promise<Warnings | null> {
  return apiGet<unknown>("/api/v1/warnings", o).then((b) => parseWarnings(b));
}
