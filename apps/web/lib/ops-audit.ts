/**
 * 운영 감사(audit) 탭의 쪽 넘기기(QA-307 — 전에는 첫 쪽 50건만 그리고 next_cursor 를 버렸다: 로그인 · 로그아웃마다 2행이 쌓여 설정 변경 · 해결 기록이
 * 화면에서 밀려 사라졌고, 잘렸다는 표시도 없었다).
 * GET /api/v1/ops/audit?cursor=&limit=(api OpsController.auditLog): id 키셋 — cursor 보다 작은 id 를 최신순으로, 다음 쪽이 있으면 next_cursor = 이 쪽
 * 마지막 행의 id, 없으면 null. 감사 기록은 덧붙기만 한다(지우는 보존 작업이 없다 — 한 번 받은 행은 그대로다).
 * - 첫 쪽(머리)은 운영 화면의 15 s 주기가 다시 받는다(components/ops/useOpsTabs). '더 보기'로 받은 앞 기록은 쌓아 두고, 새 머리는 그 위에 합친다.
 * - 새 머리가 쌓은 행과 겹치지 않으면(주기 사이에 한 쪽 넘게 새 기록이 쌓임 — 그 사이를 모른다) 쌓은 것을 버리고 머리부터 다시 보인다:
 *   사이가 빈 목록을 이어진 기록처럼 보이지 않는다.
 */

/** 한 번에 받는 감사 행 수 — api 기본값(첫 쪽)과 같다(상한 200 안) */
export const AUDIT_PAGE_LIMIT = 50;

export type AuditRow = Record<string, unknown>;
/** 감사 응답 한 쪽(첫 쪽 · 다음 쪽 같은 모양) */
export interface AuditPage { items: AuditRow[]; next_cursor?: unknown }
/** '더 보기'로 쌓은 목록: rows = 받은 행 모두(머리 포함 — 최신순), next = 마지막으로 받은 쪽의 next_cursor */
export interface AuditPaged { rows: AuditRow[]; next: number | null }
/** 화면에 그릴 목록 — reset = 쌓은 것을 버리고 머리만 보인다(머리가 쌓은 행과 겹치지 않음) */
export interface AuditView { rows: AuditRow[]; next: number | null; reset: boolean }

/** next_cursor → 다음 쪽 커서. 양의 정수만(그 밖 · null · 키 없음은 '다음 쪽 없음') */
export function auditCursor(v: unknown): number | null {
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : null;
}

/** 다음 쪽 경로(cursor = 앞 쪽의 next_cursor — 숫자만 받는다) */
export function auditPagePath(cursor: number): string {
  const q = new URLSearchParams({ cursor: String(cursor), limit: String(AUDIT_PAGE_LIMIT) });
  return `/api/v1/ops/audit?${q.toString()}`;
}

const idOf = (r: AuditRow): number | null => (typeof r.id === "number" && Number.isFinite(r.id) ? r.id : null);

/** 두 목록을 id 하나에 한 행으로 합쳐 최신순(id 큰 것부터 — api 의 순서). 같은 id 는 앞 목록(a — 새로 받은 것)의 행. id 를 읽을 수 없는 행은 끝에 받은 순서대로 */
export function mergeAuditRows(a: readonly AuditRow[], b: readonly AuditRow[]): AuditRow[] {
  const byId = new Map<number, AuditRow>();
  const noId: AuditRow[] = [];
  for (const r of [...a, ...b]) {
    const id = idOf(r);
    if (id == null) noId.push(r);
    else if (!byId.has(id)) byId.set(id, r);
  }
  return [...[...byId.entries()].sort((x, y) => y[0] - x[0]).map(([, r]) => r), ...noId];
}

/**
 * 화면에 그릴 감사 목록. paged 가 없으면 머리 그대로(next = 머리의 next_cursor). 있으면 머리 + 쌓은 행(next = 쌓은 것의 next) —
 * 머리에 다음 쪽이 없으면(기록이 모두 한 쪽 안) 머리가 전부이고, 머리가 쌓은 행과 하나도 겹치지 않으면 머리만(reset — 사이를 모른다).
 */
export function auditView(head: AuditPage | null, paged: AuditPaged | null): AuditView {
  const items = Array.isArray(head?.items) ? head.items : [];
  const headNext = auditCursor(head?.next_cursor);
  if (!paged) return { rows: items, next: headNext, reset: false };
  if (headNext == null) return { rows: items, next: null, reset: true };
  const seen = new Set(paged.rows.map(idOf).filter((v): v is number => v != null));
  if (!items.some((r) => { const id = idOf(r); return id != null && seen.has(id); })) return { rows: items, next: headNext, reset: true };
  return { rows: mergeAuditRows(items, paged.rows), next: paged.next, reset: false };
}
