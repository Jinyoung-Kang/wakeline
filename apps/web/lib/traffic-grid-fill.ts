/**
 * 운영 화면(providers 탭) — 연안 교통량 격자 위치 채우기의 진행(ADR-023 2026-10-01 개정: 채우기가 수렴하는지 DB · 로그 없이 본다).
 * 값은 /ops/providers 응답의 collector 해시(수집기 heartbeat wakeline:collector)의 traffic_grid_* 필드 그대로다 — 웹은 수를 만들거나
 * 짐작하지 않는다(없거나 형식이 틀리면 "—"). 수집기 설정값(시간 몫 · 하루 예산 · 물러나기 단계)도 들고 있지 않다. 시각은 KST(계약 v5 §G20).
 * 수집기가 이 필드를 쓰지 않으면(키 없음 · fixture · 예전 수집기 — traffic_grid_cells_known 이 없다) 줄을 그리지 않는다.
 */
import { fmtKst } from "@/lib/time";

export type FillTone = "ok" | "warn" | "muted";
export interface FillItem { key: string; label: string; text: string; title: string; tone: FillTone }
export interface FillView { state: FillItem; items: FillItem[]; pass: FillItem }

const P = "traffic_grid_";
/** 0 이상 정수 글자만 수 — 빈 값 · 그 밖은 모름 */
const count = (v: unknown): number | null => (typeof v === "string" && /^\d{1,9}$/.test(v) ? Number(v) : null);
const num = (n: number | null): string => (n == null ? "—" : n.toLocaleString("en-US"));

export const FILL_LABEL = "연안 교통량 격자 위치";
export const FILL_TITLE =
  "해양교통안전공단 격자 번호의 위치(기하)를 해양수산부 격자 WFS 로 한 칸씩 묻는 수집기 작업(traffic_grid) — 수집기 heartbeat 값 그대로. " +
  "배가 있는 칸은 스냅샷마다 바뀌어 새 칸이 계속 나타나므로 끝나는 때는 적지 않는다(ADR-023 2026-10-01 개정)";

const STATE: Record<string, Omit<FillItem, "key" | "label">> = {
  filling: { text: "조회 중", title: "위치도 부정 캐시 결과도 없는 칸을 묻는 중", tone: "ok" },
  idle: { text: "물을 칸 없음", title: "대기열이 비었다 — 이 프로세스가 본 칸은 모두 위치를 알거나 부정 캐시(해양격자에 없음 · 격자 검사 실패 · 조회 실패)에 있다. 새 칸이 보이면 다시 묻는다", tone: "ok" },
  retry_wait: { text: "오류 뒤 다시 물을 때를 기다림", title: "남은 칸은 모두 조회 오류가 났던 칸이다 — 칸마다 물러났다가 다시 묻고, 거듭 실패하면 한동안 '위치 조회 실패'로 뺀다(수집기 설정)", tone: "muted" },
  waiting_db: { text: "위치 캐시(DB) 읽기를 기다림", title: "기동 뒤 marine_grid4 를 읽기 전에는 묻지 않는다(이미 아는 칸을 다시 묻지 않게) — 한동안 못 읽으면 DB 없이 묻는다", tone: "muted" },
  hour_window: { text: "이 시의 채우기 몫을 다 씀", title: "해양수산부 시간 창(항만 입출항 색인과 함께 센다)에서 채우기 몫을 다 써 다음 정시까지 쉰다 — 계획한 속도 제한이지 공급자 오류가 아니다", tone: "muted" },
  daily_budget: { text: "하루 예산을 다 씀", title: "mof_grid4 하루 예산(매일 09:00 KST 에 새로 센다)을 다 써 쉰다 — 계획한 한도", tone: "muted" },
  breaker: { text: "연달아 오류 — 잠시 쉼", title: "한 번에 WFS 조회 오류가 연달아 나 채우기 전체를 잠시 쉰다(키 · 서비스 장애에 예산을 쓰지 않게). 까닭은 공급자 표 mof_grid4 의 last error", tone: "warn" },
  operator_off: { text: "운영자가 끔(mof_grid4)", title: "공급자 표에서 mof_grid4 가 꺼져 있어 묻지 않는다", tone: "warn" },
};

/** collector 해시 → 줄. 채우기 필드가 없으면 null(그리지 않는다) */
export function trafficGridFill(collector: Record<string, unknown> | null | undefined): FillView | null {
  const c = collector ?? {};
  const known = count(c[`${P}cells_known`]);
  if (known == null) return null;
  const at = (k: string) => (typeof c[k] === "string" && c[k] ? (c[k] as string) : null);
  const resume = at(`${P}fill_resume_at`);
  const s = STATE[String(c[`${P}fill_state`] ?? "")] ?? { text: "—", title: "수집기가 채우기 상태를 알리지 않았다", tone: "muted" as const };
  const state: FillItem = {
    key: "state", label: "상태",
    text: resume ? `${s.text} · 다음 ${fmtKst(resume, { seconds: false })}` : s.text,
    title: resume ? `${s.title} — 다음에 움직이는 때 ${fmtKst(resume)}` : s.title,
    tone: s.tone,
  };
  const resolved = count(c[`${P}resolved`]), unresolved = count(c[`${P}unresolved`]);
  const notQueued = count(c[`${P}not_queued`]);
  const item = (key: string, label: string, text: string, title: string, tone: FillTone = "muted"): FillItem => ({ key, label, text, title, tone });
  const items: FillItem[] = [
    item("drawn", "그려지는 칸", resolved == null || unresolved == null ? "—" : `${num(resolved)} / ${num(resolved + unresolved)}`,
      "마지막 스냅샷에서 위치를 아는 칸 / 스냅샷의 칸 — 지도에 그려지는 몫"),
    item("known", "위치 확인", num(known), "위치(기하)를 아는 칸 — marine_grid4 에서 읽었거나 이 프로세스가 찾은 칸. 다시 묻지 않는다"),
    item("pending", "조회 대기", num(count(c[`${P}pending`])), "조회 대기열의 칸 — 이 프로세스의 메모리라 재기동하면 비고, 결과가 없는 칸을 다시 넣는다"),
    item("not_queued", "대기열 가득 차 못 넣음", num(notQueued),
      "대기열 상한에 막혀 넣지 못한 칸(기동 뒤 누계) — 새 칸이 조회보다 빨리 나타난다는 뜻. 다음에 보일 때 자리가 있으면 넣는다",
      notQueued ? "warn" : "muted"),
    item("not_found", "해양격자에 없음", num(count(c[`${P}not_found`])), "WFS 가 0건으로 답한 칸 — 부정 캐시(기한이 지나 다시 보이면 다시 묻는다)"),
    item("off_grid", "격자 검사 실패", num(count(c[`${P}off_grid`])), "받은 기하가 격자 한 칸이 아니라 격리한 칸 — 부정 캐시"),
    item("failed", "위치 조회 실패", num(count(c[`${P}failed`])), "조회가 거듭 실패해 한동안 묻지 않는 칸"),
    item("calls", "오늘 조회", num(count(c[`${P}calls_wfs`])), "mof_grid4 가 이 예산 날(매일 09:00 KST 에 새로 센다)에 쓴 호출"),
  ];
  const passAt = at(`${P}fill_pass_at`);
  const n = (k: string) => num(count(c[`${P}fill_pass_${k}`]));
  const pass: FillItem = passAt
    ? {
      key: "pass", label: "마지막 채우기",
      text: `마지막 채우기 ${fmtKst(passAt)} 끝 — 조회 ${n("lookups")} → 찾음 ${n("found")} · 해양격자에 없음 ${n("not_found")} · 격자 밖 ${n("off_grid")} · 오류 ${n("errors")}`,
      title: "채우기 한 번 = 다시 시작한 때부터 멈춘 때(시간 창 · 하루 예산 · 연달아 오류 · 끔 · 물을 칸 없음)까지. 수집기 로그의 'geometry fill pass' 줄과 같은 수(로그 시각은 발행한 그대로)",
      tone: "muted",
    }
    : { key: "pass", label: "마지막 채우기", text: "마지막 채우기 — 이 수집기 프로세스에서 아직 끝난 채우기가 없다", title: "수집기가 다시 시작하면 비었다가 첫 채우기가 끝날 때 채워진다", tone: "muted" };
  return { state, items, pass };
}
