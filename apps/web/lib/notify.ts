/**
 * 브라우저 알림(SPEC F4-3 · ADR-037) — Notification 감싸기. 허락 요청은 사용자가 단추를 누를 때만(브라우저도 사용자 동작 없는 요청을 막는다).
 * 서비스 워커 · 푸시 구독은 쓰지 않는다 — 탭이 열려 있을 때만 온다. 지원하지 않거나 거절되면 화면 안 배너만.
 */
export type NotifyPermission = "granted" | "denied" | "default" | "unsupported";

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

/** 허락됐을 때만 띄운다(tag 가 같으면 브라우저가 앞의 것을 바꾼다). 누르면 창을 앞으로 · onClick. 띄웠으면 true */
export function showNotification(title: string, body: string, tag: string, onClick?: () => void, n: NotificationApi | null = api()): boolean {
  if (!n || n.permission !== "granted") return false;
  try {
    const note = new n(title, { body, tag });
    note.onclick = () => { try { window.focus(); } catch { /* 창을 앞으로 못 가져와도 이동은 한다 */ } onClick?.(); note.close(); };
    return true;
  } catch {
    return false; // 안드로이드 크롬 등은 생성자를 막는다(서비스 워커 전용) — 배너만
  }
}
