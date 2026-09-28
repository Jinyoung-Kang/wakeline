/**
 * 복사 · 내려받기(계약 v5 §C7 · §C8) — 브라우저 안에서만. 외부 라이브러리 · 인라인 스크립트 없음(CSP 그대로).
 * 환경(navigator · document · URL · setTimeout)은 주입할 수 있다(시험).
 */

interface ClipboardLike { writeText(text: string): Promise<void> }
interface CopyEnv { navigator?: { clipboard?: ClipboardLike } | undefined; document?: Document | undefined }

const g = globalThis as unknown as { navigator?: { clipboard?: ClipboardLike }; document?: Document };
const copyEnv = (): CopyEnv => ({ navigator: g.navigator, document: g.document });

/**
 * 글자를 클립보드로. navigator.clipboard 가 없거나(보안 문맥이 아닌 http — LAN 주소 등) 권한이 거부되면
 * 보이지 않는 textarea + execCommand("copy") 로 대신한다(초점은 원래 요소로 되돌린다). 성공 여부를 돌려준다 — 화면이 "복사됨/실패"를 말한다.
 */
export async function copyText(text: string, env: CopyEnv = copyEnv()): Promise<boolean> {
  const clip = env.navigator?.clipboard;
  if (clip && typeof clip.writeText === "function") {
    try { await clip.writeText(text); return true; } catch { /* 거부 → 대체 경로 */ }
  }
  const doc = env.document;
  if (!doc?.body) return false;
  const ta = doc.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.setAttribute("aria-hidden", "true");
  Object.assign(ta.style, { position: "fixed", top: "0", left: "-9999px", opacity: "0" });
  const prev = doc.activeElement as HTMLElement | null;
  doc.body.appendChild(ta);
  try {
    ta.select();
    return doc.execCommand("copy");
  } catch {
    return false;
  } finally {
    doc.body.removeChild(ta);
    prev?.focus?.();
  }
}

interface DownloadEnv {
  document?: Document | undefined;
  URL: { createObjectURL(b: Blob): string; revokeObjectURL(u: string): void };
  setTimeout: (f: () => void, ms: number) => unknown;
}
const downloadEnv = (): DownloadEnv => ({ document: g.document, URL, setTimeout: (f, ms) => setTimeout(f, ms) });

/** object URL 해제까지 기다리는 시간 — 클릭 직후 해제하면 일부 브라우저(Safari)가 내려받기를 시작하기 전에 URL 이 사라진다 */
const REVOKE_AFTER_MS = 1_000;

/** 글자를 파일로 내려받는다(Blob + object URL, 브라우저에서 만든다 — 서버 요청 없음). 뒤에 URL 을 해제한다. */
export function downloadText(filename: string, text: string, mime: string, env: DownloadEnv = downloadEnv()): boolean {
  const doc = env.document;
  if (!doc?.body) return false;
  const url = env.URL.createObjectURL(new Blob([text], { type: `${mime};charset=utf-8` }));
  const a = doc.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  a.style.display = "none";
  doc.body.appendChild(a);
  try {
    a.click();
  } finally {
    doc.body.removeChild(a);
    env.setTimeout(() => env.URL.revokeObjectURL(url), REVOKE_AFTER_MS);
  }
  return true;
}
