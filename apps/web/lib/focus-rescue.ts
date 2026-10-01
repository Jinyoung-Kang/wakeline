/**
 * 키보드 초점 되살리기(WCAG 2.4.3 초점 순서 — QA-304). 화면 일부가 바뀌어 누른 단추가 사라지거나(카드 '닫기' · 목록에서 카드 열기 · '선박 켜기' ·
 * 로그 상세 '닫기' · 로그인 · 로그아웃) 숨겨지거나(알림 패널을 숨기는 탭 전환) 비활성이 되면(설정 save) 브라우저는 초점을 <body> 로 떨어뜨린다 —
 * 화면 읽기 프로그램은 위치를 잃고 다음 Tab 은 브라우저마다 다르다. 그런 조작 뒤에 초점을 새 내용이나 연 자리로 옮긴다.
 * 규칙: **초점을 잃었을 때만** 옮긴다 — 사용자가 이미 다른 곳에 초점을 두었으면(검색 입력 · 지도 등) 건드리지 않는다(실시간 갱신이 초점을 빼앗지 않게).
 * React 를 쓰지 않는다(ADR-029 §6) — 부르는 쪽(효과)이 바뀐 뒤에 부른다.
 */

type Candidate = Element | null | undefined;

/** 문서 안에 있는가(떼어 내지 않음) */
export const isAttached = (el: Element): boolean => el.isConnected ?? el.ownerDocument?.contains(el) ?? false;
/** 그려지는가: 상자가 있다(display:none 안이면 없다). 상자를 잴 수 없는 환경(시험의 최소 DOM)은 조상의 hidden 으로 본다 */
function rendered(el: Element): boolean {
  if (typeof el.getClientRects === "function") return el.getClientRects().length > 0;
  for (let n: Node | null = el; n; n = n.parentNode) if ((n as Element).hasAttribute?.("hidden")) return false;
  return true;
}

/** el 이 지금 초점을 받을 수 있게 보이는가: 문서 안 · 그려짐 · 비활성 아님 */
export function isShown(el: Candidate): el is HTMLElement {
  if (!el || typeof (el as HTMLElement).focus !== "function" || !isAttached(el)) return false;
  if ((el as HTMLButtonElement).disabled === true || el.hasAttribute("disabled")) return false;
  return rendered(el);
}

/**
 * 지금 초점을 잃었는가: 초점 요소가 없음 · body · 문서 밖(떼어 낸 요소를 가리키는 환경) · 그려지지 않음(숨긴 패널 안 — 브라우저가 곧 body 로 옮긴다) ·
 * 비활성(누른 단추가 disabled 가 됨).
 */
export function focusLost(doc: Document = document): boolean {
  const a = doc.activeElement;
  return a == null || a === doc.body || a === doc.documentElement || !isShown(a);
}

/** 초점을 잃었으면 후보 가운데 처음 보이고 초점을 받는 것으로 옮긴다. 옮긴 요소(옮기지 않았으면 null) */
export function rescueFocus(...candidates: Candidate[]): HTMLElement | null {
  if (typeof document === "undefined" || !focusLost()) return null;
  for (const c of candidates) {
    if (!isShown(c)) continue;
    c.focus();
    if (document.activeElement === c) return c;
  }
  return null;
}
