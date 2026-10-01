"use client";
import { useRef, useState } from "react";
import { signIn } from "@/lib/endpoints/ops";
import { loginErrorText, validateLogin } from "@/lib/ops";
import { RequestIdOf } from "./logs/ErrorNote";

/**
 * 운영자 로그인(R-56): 서버 규칙(아이디 필수 · 비밀번호 8자 이상)을 보내기 전에 검사해 한국어로 알리고, 서버 오류는 상태별 한국어 문구
 * (429 는 Retry-After 초). 오류가 나면 해당 칸(또는 오류 문구)으로 초점을 옮긴다. notice = 세션 만료 등 로그인 화면으로 돌아온 이유(R-12).
 * 서버 오류 문구 옆에는 요청 id(복사 — 계약 v5 §C8)를 둔다.
 */
export function OpsLogin({ onLogin, notice }: { onLogin: (u: { username: string }) => void; notice: string | null }) {
  const [u, setU] = useState(""); const [p, setP] = useState("");
  const [err, setErr] = useState<{ field: "user" | "pass" | null; text: string; error?: unknown } | null>(null);
  const [busy, setBusy] = useState(false);
  const userRef = useRef<HTMLInputElement>(null), passRef = useRef<HTMLInputElement>(null), errRef = useRef<HTMLDivElement>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const bad = validateLogin(u, p);
    if (bad) { setErr(bad); (bad.field === "user" ? userRef : passRef).current?.focus(); return; }
    setErr(null); setBusy(true);
    try { onLogin(await signIn(u, p)); }
    catch (x) { setErr({ field: null, text: loginErrorText(x), error: x }); setTimeout(() => errRef.current?.focus(), 0); }
    finally { setBusy(false); }
  };
  const invalid = (f: "user" | "pass") => (err?.field === f ? true : undefined);
  return (
    <div className="grid-bg flex h-full items-center justify-center">
      <form onSubmit={submit} noValidate className="panel w-80 max-w-[calc(100vw-1.5rem)] p-4" data-testid="ops-login">
        <div className="label mb-3">Operator sign-in</div>
        {notice ? <div className="mb-2 text-[11px] text-warn" role="status" data-testid="ops-login-notice">{notice}</div> : null}
        <label className="label block" htmlFor="ops-user">username</label>
        <input id="ops-user" ref={userRef} className="mb-2 w-full" value={u} onChange={(e) => setU(e.target.value)} autoComplete="username" required
          aria-invalid={invalid("user")} aria-describedby={err ? "ops-login-err" : undefined} />
        <label className="label block" htmlFor="ops-pass">password <span className="normal-case text-fg-3">(8자 이상)</span></label>
        <input id="ops-pass" ref={passRef} className="mb-3 w-full" type="password" value={p} onChange={(e) => setP(e.target.value)} autoComplete="current-password" required minLength={8}
          aria-invalid={invalid("pass")} aria-describedby={err ? "ops-login-err" : undefined} />
        {err ? <div id="ops-login-err" ref={errRef} tabIndex={-1} className="mb-2 text-[11px] text-bad" role="alert" data-testid="ops-login-error">{err.text}<RequestIdOf error={err.error} /></div> : null}
        <button className="btn w-full" type="submit" disabled={busy}>{busy ? "…" : "Sign in"}</button>
        <div className="mt-3 text-[10px] text-fg-3">계정은 `make ops-user` 로만 만듭니다. 세션 8 h · HttpOnly · SameSite=Strict · CSRF 이중 제출.</div>
      </form>
    </div>
  );
}
