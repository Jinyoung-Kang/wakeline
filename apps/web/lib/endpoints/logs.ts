/**
 * 시스템 로그 REST(web-review §3.1 · 계약 v5 §C4 · §C7) — 시스템 로그 화면(/logs)만 부른다(첫 화면 밖). 경로는 lib/logs 의 경로 함수(형식이 틀린 요청 id ·
 * 지문 · 커서는 보내지 않는다 · 항목 id 는 인코딩), 본문은 lib/logs 의 파서로 읽는다(모양이 틀린 항목은 버리고, 모르는 값은 null). { signal } 은 그대로 넘긴다.
 */
import { apiGet } from "@/lib/api";
import {
  aisGapRows, logGroupsUrl, logItemUrl, logsUrl, parseLogGroups, parseLogItemResponse, parseLogPage, type LogEntry, type LogFilter, type LogStreamName,
} from "@/lib/logs";

type Opts = { signal?: AbortSignal };

/** 목록 한 쪽(at = 기간의 기준 시각 — 다음 쪽도 같은 at) */
export function logsPage(f: LogFilter, at: number, page?: { cursor?: string | null; limit?: number }, o?: Opts): Promise<ReturnType<typeof parseLogPage>> {
  return apiGet<unknown>(logsUrl(f, at, page), o).then((v) => parseLogPage(v));
}
/** 지문 묶음(§C4) */
export function logGroups(f: Parameters<typeof logGroupsUrl>[0], at: number, o?: Opts): Promise<ReturnType<typeof parseLogGroups>> {
  return apiGet<unknown>(logGroupsUrl(f, at), o).then((v) => parseLogGroups(v));
}
/** 항목 하나(§C4) — 스키마와 맞지 않으면 null(부른 쪽이 '형식이 맞지 않음'을 보인다) */
export function logItem(id: string, stream: LogStreamName | null, o?: Opts): Promise<LogEntry | null> {
  return apiGet<unknown>(logItemUrl(id, stream), o).then((v) => parseLogItemResponse(v));
}
/** AIS 수신 공백(공개 GET /api/v1/ais/gaps — §C7 탭). fromIso = 기간의 시작(UTC ISO) */
export function aisGaps(fromIso: string, o?: Opts): Promise<ReturnType<typeof aisGapRows>> {
  return apiGet<unknown>(`/api/v1/ais/gaps?${new URLSearchParams({ from: fromIso })}`, o).then((v) => aisGapRows(v));
}
