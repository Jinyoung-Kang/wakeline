/** 운영 화면 보조(순수 함수·주입 가능한 호출). 비인가 ops 호출은 404 로 숨겨지므로(SecurityConfig) 401 과 함께 "세션 없음 후보"로 본다. */
import { ApiError } from "./api";

export const OPS_SESSION_PATH = "/api/v1/ops/session";

/** 401/404 — 세션이 없을 때 ops 엔드포인트가 돌려주는 상태 */
export function isAuthMiss(e: unknown): boolean {
  return e instanceof ApiError && (e.status === 401 || e.status === 404);
}

/**
 * ops 호출 오류가 세션 만료인지 가린다(R-12). 401/404 를 받으면 세션 확인(GET /ops/session)을 한 번 더 해서
 * 그것도 401/404 일 때만 "expired". 세션이 살아 있거나 확인할 수 없으면(네트워크) "error" — 한 엔드포인트의 404 로 로그아웃시키지 않는다.
 */
export async function classifyOpsError(e: unknown, probeSession: () => Promise<unknown>): Promise<"expired" | "error"> {
  if (!isAuthMiss(e)) return "error";
  try {
    await probeSession();
    return "error";
  } catch (p) {
    return isAuthMiss(p) ? "expired" : "error";
  }
}

/**
 * 로그아웃: 서버 호출이 실패해도 화면은 항상 로그인으로 돌아간다(done 을 반드시 부른다 — R-12).
 * 이미 만료(401/404)면 서버에 남은 세션이 없다. 그 밖의 실패는 서버 세션이 남아 있을 수 있음을 알린다(숨기지 않는다).
 */
export async function signOut(send: () => Promise<unknown>, done: (note: string | null) => void): Promise<{ ok: boolean; note: string | null }> {
  let ok = true, note: string | null = null;
  try {
    await send();
  } catch (e) {
    if (!isAuthMiss(e)) { ok = false; note = "로그아웃 요청 실패 — 서버 세션이 남아 있을 수 있습니다(최대 8 h 뒤 만료). 다시 로그인한 뒤 로그아웃하세요."; }
  } finally {
    done(note);
  }
  return { ok, note };
}

export const SESSION_EXPIRED_NOTE = "세션이 만료되었습니다 — 다시 로그인하세요.";
