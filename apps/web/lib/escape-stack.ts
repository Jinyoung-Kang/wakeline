/**
 * Esc 로 닫기(QA 2026-10 화면 개선 제안 1) — 겹쳐 뜨는 패널(지도 범례 · 항공기 · 선박 · SIGMET · 공항 카드 · 기상청 레이더 패널 · 운영 실행 목록 ·
 * 로그 상세 · 상태 상세 · 재생 상세)을 같은 규칙으로 닫는다. 예전에는 상태 상세와 검색만 Esc 로 닫혔다.
 * 규칙(상태 상세의 것을 일반화 — components/StatusBar):
 * - Esc 는 초점이 있는 곳의 것이다. 이미 처리된 Esc(defaultPrevented — 검색 · 확인 대화 상자) · 한글 조합 중의 Esc 는 건드리지 않는다.
 * - 위(가장 나중에 연 것)부터: 초점이 그 패널(또는 그 패널을 연 단추) 안이면 그 패널을 닫는다.
 * - 초점이 어느 패널에도 없고 '중립'이면(아무 데도 없음 · 문서 본문 · 패널을 품은 조상 · `data-escape-neutral` 영역 — 지도) 맨 위 패널을 닫는다.
 *   다른 입력 · 단추에 초점이 있으면 닫지 않는다(그 요소의 Esc 다).
 * - 한 번에 하나만 닫는다(preventDefault — 다른 Esc 처리기가 같은 키로 또 닫지 않게).
 * React 를 쓰지 않는다(ADR-029 §6) — 패널 등록 · 해제는 Hook(lib/use-escape-close)이 한다.
 */

export interface EscapeLayer {
  /** 패널 뿌리 요소(그려지지 않았으면 null) */
  panel(): Element | null;
  /** 이 패널을 연 단추 등(없으면 null) — 그 위의 Esc 도 이 패널의 것이다 */
  opener?(): Element | null;
  /** 닫는다. focusInside = 초점이 패널(또는 연 단추) 안에 있었다(부르는 쪽이 초점을 옮길지 정한다) */
  close(focusInside: boolean): void;
}

export interface EscapeKeyEvent {
  key: string;
  defaultPrevented: boolean;
  isComposing?: boolean;
  target: unknown;
  preventDefault?(): void;
}

const has = (root: Element | null | undefined, n: unknown): boolean =>
  root != null && n != null && typeof (root as Node).contains === "function" && (root as Node).contains(n as Node);

/** 초점이 어느 패널의 것도 아니고 다른 요소의 Esc 도 아닌 곳인가 */
function neutral(t: unknown, top: EscapeLayer): boolean {
  if (t == null) return true;
  const d = typeof document === "undefined" ? null : document;
  if (d && (t === d.body || t === d.documentElement)) return true;
  const panel = top.panel();
  if (panel && has(t as Element, panel)) return true; // 패널을 품은 조상(<main tabindex=-1> 등) — 글자를 누르면 브라우저가 초점을 거기로 옮긴다
  const el = t as Element;
  return typeof el.closest === "function" && el.closest("[data-escape-neutral]") != null;
}

/** 위에서부터 규칙대로 하나를 닫는다. 닫았으면 true(이벤트는 preventDefault). layers 는 연 순서(마지막 = 맨 위). */
export function handleEscape(e: EscapeKeyEvent, layers: readonly EscapeLayer[]): boolean {
  if (e.key !== "Escape" || e.defaultPrevented || e.isComposing || layers.length === 0) return false;
  const t = e.target;
  for (let i = layers.length - 1; i >= 0; i--) {
    const l = layers[i];
    if (has(l.panel(), t) || has(l.opener?.() ?? null, t)) {
      e.preventDefault?.();
      l.close(true);
      return true;
    }
  }
  const top = layers[layers.length - 1];
  if (!neutral(t, top)) return false;
  e.preventDefault?.();
  top.close(false);
  return true;
}

const stack: EscapeLayer[] = [];
/** keydown 처리기를 단 문서 — 문서가 바뀌면(시험의 새 DOM) 새 문서에 다시 단다 */
let installedOn: Document | null = null;
const onKey = (e: KeyboardEvent) => { handleEscape(e, stack); };

/** 패널을 맨 위에 올린다(문서 keydown 처리기는 열린 패널이 있는 동안만 — 문서마다 하나). 돌려주는 함수로 내린다(마지막 패널이면 처리기도 뗀다). */
export function pushEscape(layer: EscapeLayer): () => void {
  stack.push(layer);
  if (typeof document !== "undefined" && installedOn !== document) {
    installedOn?.removeEventListener("keydown", onKey);
    document.addEventListener("keydown", onKey);
    installedOn = document;
  }
  return () => {
    const i = stack.lastIndexOf(layer);
    if (i >= 0) stack.splice(i, 1);
    if (stack.length === 0 && installedOn) {
      installedOn.removeEventListener("keydown", onKey);
      installedOn = null;
    }
  };
}

/** 시험용: 지금 쌓인 패널 수 */
export const escapeDepth = (): number => stack.length;
