/**
 * 브라우저 알림(SPEC F4-3 · ADR-037) — Notification 감싸기. 허락 요청은 사용자가 단추를 누를 때만(브라우저도 사용자 동작 없는 요청을 막는다).
 * 서비스 워커 · 푸시 구독은 쓰지 않는다 — 탭이 열려 있을 때만 온다. 지원하지 않거나 거절되면 화면 안 배너만.
 * blocked = 허락은 됐는데 페이지 알림의 생성자를 막는 브라우저(안드로이드 크롬 등 — 서비스 워커 전용). 띄워 봐야만 안다: '알림 켜기'의 확인 알림이나
 * 첫 알림에서 막히면 그때부터 blocked(화면이 '켜짐'이라고 하지 않고, 숨은 탭에서 헛되이 조회하지 않는다).
 */
export type NotifyPermission = "granted" | "denied" | "default" | "unsupported" | "blocked";
/** showNotification 의 결과: 띄움 · 허락 없음(또는 미지원) · 허락됐지만 생성자가 막힘 */
export type NotifyResult = "shown" | "off" | "blocked";
/** '알림 켜기' 확인 알림의 tag */
export const NOTIFY_ENABLED_TAG = "wakeline-watch-enabled";

export interface NotificationLike { onclick: ((this: unknown, ev: Event) => unknown) | null; close(): void }
export interface NotificationApi {
  permission: string;
  requestPermission(): Promise<string>;
  new (title: string, options?: { body?: string; tag?: string }): NotificationLike;
}

function api(): NotificationApi | null {
  return typeof window !== "undefined" && "Notification" in window ? (window.Notification as unknown as NotificationApi) : null;
}

export function notifyPermission(n: NotificationApi | null = api()): NotifyPermission {
  if (!n) return "unsupported";
  const p = n.permission;
  return p === "granted" || p === "denied" ? p : "default";
}

/** 단추에서만 부른다. 지원하지 않으면 unsupported */
export async function requestNotify(n: NotificationApi | null = api()): Promise<NotifyPermission> {
  if (!n) return "unsupported";
  try { await n.requestPermission(); } catch { /* 옛 브라우저(콜백 방식) · 거절 — 아래에서 지금 값을 읽는다 */ }
  return notifyPermission(n);
}

/** '알림 켜기' 단추: 허락을 묻고, 허락되면 확인 알림 하나를 띄워 이 브라우저가 페이지 알림을 띄울 수 있는지 본다(막히면 blocked) */
export async function enableNotify(n: NotificationApi | null = api()): Promise<NotifyPermission> {
  const p = await requestNotify(n);
  if (p !== "granted") return p;
  return showNotification("관심 대상 알림 켜짐", "관심 대상의 상태가 바뀌면 이렇게 알립니다", NOTIFY_ENABLED_TAG, undefined, n) === "blocked" ? "blocked" : "granted";
}

/** 막힘을 기억하는 브라우저 저장소 열쇠(값 "1") — 새로고침 뒤에도 '켜짐'으로 돌아가지 않게(생성자는 띄워 봐야만 막힘을 안다) */
export const NOTIFY_BLOCKED_KEY = "wakeline.notify.blocked";
export interface PermissionStorage { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }

/** 첫 상태: 브라우저 값(read)에 기억한 막힘을 얹는다 — 브라우저가 granted 가 아니면 막힘 기억을 지운다. 저장소를 못 쓰면 read 그대로 */
export function initialPermission(storage: PermissionStorage | null, read: NotifyPermission): NotifyPermission {
  try {
    if (storage?.getItem(NOTIFY_BLOCKED_KEY) !== "1") return read;
    if (read === "granted") return "blocked";
    storage.removeItem(NOTIFY_BLOCKED_KEY);
  } catch { /* 저장소를 못 쓰면 이번 접속 동안만 */ }
  return read;
}

/** 바뀐 허락 상태를 기억한다(막힘만 — 그 밖이면 기억을 지운다). 저장소 오류는 삼킨다 */
export function rememberPermission(storage: PermissionStorage | null, p: NotifyPermission): void {
  try {
    if (p === "blocked") storage?.setItem(NOTIFY_BLOCKED_KEY, "1");
    else storage?.removeItem(NOTIFY_BLOCKED_KEY);
  } catch { /* 이번 접속 동안만 */ }
}

/** 브라우저의 허락을 다시 읽은 값으로 바꾸되, 막힘 기록은 브라우저가 여전히 granted 라고 하는 동안 둔다(거두면 그 값을 따른다) */
export function keepBlocked(current: NotifyPermission, read: NotifyPermission): NotifyPermission {
  return current === "blocked" && read === "granted" ? "blocked" : read;
}

/** 허락됐을 때만 띄운다(tag 가 같으면 브라우저가 앞의 것을 바꾼다). 누르면 창을 앞으로 · onClick */
export function showNotification(title: string, body: string, tag: string, onClick?: () => void, n: NotificationApi | null = api()): NotifyResult {
  if (!n || n.permission !== "granted") return "off";
  try {
    const note = new n(title, { body, tag });
    note.onclick = () => { try { window.focus(); } catch { /* 창을 앞으로 못 가져와도 이동은 한다 */ } onClick?.(); note.close(); };
    return "shown";
  } catch {
    return "blocked"; // 안드로이드 크롬 등은 생성자를 막는다(서비스 워커 전용) — 배너만
  }
}
