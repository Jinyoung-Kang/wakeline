"use client";
import { useEffect, useId, useRef, useState } from "react";
import { ApiError, apiSend } from "@/lib/api";
import { isAuthMiss } from "@/lib/ops";
import {
  noteError, NOTE_MAX, parseResolution, RESOLUTIONS_PATH, resolutionBody, resolutionPath, resolveAll, resolveErrorText,
  type Resolution, type ResolutionDraft, type ResolvedRef,
} from "@/lib/resolutions";
import { RequestIdOf } from "./logs/ErrorNote";

/**
 * 확인할 쓰기. resolve: 해결 하나 이상(묶음 · 항목 · 공급자 = 1건, "보이는 묶음 모두" = 묶음 수만큼) · revoke: 해결 하나 되돌리기.
 * subject = 무엇을(대상 · upto) · effect = 무엇이 일어나고 무엇이 그대로인지 · excluded = 일괄에서 뺀 것(수)
 */
export type ResolveTarget =
  | { op: "resolve"; drafts: ResolutionDraft[]; subject: React.ReactNode; effect: string; excluded?: string | null }
  | { op: "revoke"; ref: ResolvedRef; subject: React.ReactNode; effect: string };

/**
 * 서버 상태가 화면과 달라졌을 수 있을 때 부모에게 알린다 — 부모는 영향받는 목록을 다시 불러오고(201/204 뒤에만 화면을 바꾼다), complete 면 패널을 닫는다.
 * resolve: created = 201 본문(형식을 읽은 것만), saved = 201 을 받은 수. revoke: 204(complete) 또는 404(이미 되돌렸거나 없음 — 목록이 틀렸다, complete=false).
 */
export type ResolveResult =
  | { op: "resolve"; created: Resolution[]; saved: number; complete: boolean }
  | { op: "revoke"; id: number; complete: boolean };

/**
 * 해결 처리 · 되돌리기 확인 패널(ADR-022) — 보내기 전에 대상 · 범위(upto) · 결과를 글로 말하고, 운영자가 확인해야 보낸다.
 * - 쓰기는 lib/api apiSend(CSRF 헤더). 401/404 는 onAuthMiss 로 세션을 확인해 만료면 부모가 로그인으로 보낸다(패널은 사라진다).
 * - 보내는 동안 단추를 막고("처리 중…", aria-busy) 두 번 보내지 않는다. 화면(해결됨 표시)은 부모가 201/204 를 받은 뒤에만 바꾼다.
 * - 실패는 한국어 첫 문구 + (HTTP · code) + 요청 id(복사 · 로그로 거르기). 일괄의 일부 실패는 결과 수를 말하고 "남은 N개 다시 시도"로 실패 · 보내지 않은 것만 다시 보낸다.
 * - Esc = 취소(보내는 중이 아닐 때). 메모는 선택, 앞뒤 공백을 떼어 200자 이하 한 줄(서버가 다시 검사한다).
 */
export function ResolveConfirm({ target, onClose, onChanged, onAuthMiss, onFilterRid, testId = "resolve-confirm" }: {
  target: ResolveTarget; onClose: () => void; onChanged: (r: ResolveResult) => void;
  onAuthMiss: (e: unknown) => Promise<"expired" | "error">; onFilterRid?: (rid: string) => void; testId?: string;
}) {
  const total = target.op === "resolve" ? target.drafts.length : 1;
  const [note, setNote] = useState("");
  const [remaining, setRemaining] = useState<ResolutionDraft[]>(target.op === "resolve" ? target.drafts : []);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [savedSome, setSavedSome] = useState(false);
  const first = useRef<HTMLInputElement & HTMLButtonElement>(null);
  const live = useRef(true);
  const noteId = useId();
  useEffect(() => {
    live.current = true;
    first.current?.focus?.(); // 열리면 첫 입력(메모 · 되돌리기 확인)으로 — 키보드로 바로 확인 · Esc
    return () => { live.current = false; };
  }, []);
  const noteErr = target.op === "resolve" ? noteError(note) : null;

  /** 실패 처리: 세션 확인(401/404) — 만료면 부모가 로그인으로 보내므로 여기서 멈춘다 */
  const expired = async (e: unknown) => (isAuthMiss(e) ? (await onAuthMiss(e)) === "expired" : false);

  const run = async () => {
    if (sending || noteErr || (target.op === "resolve" && !remaining.length)) return;
    setSending(true);
    setError(null);
    try {
      if (target.op === "revoke") {
        try {
          await apiSend<void>("DELETE", resolutionPath(target.ref.id));
          onChanged({ op: "revoke", id: target.ref.id, complete: true });
        } catch (e) {
          if (await expired(e) || !live.current) return;
          setError(e);
          // 404(세션은 살아 있음) = 이미 되돌렸거나 없는 해결 — 보이는 목록이 틀렸으니 다시 불러온다
          if (e instanceof ApiError && e.status === 404) onChanged({ op: "revoke", id: target.ref.id, complete: false });
        }
        return;
      }
      const drafts = remaining;
      const out = await resolveAll(drafts, async (d) => parseResolution(await apiSend<unknown>("POST", RESOLUTIONS_PATH, resolutionBody(d, note))));
      const err = out.stopped ?? out.failed[0]?.error ?? null;
      if (err != null && await expired(err)) return;
      if (!live.current) return;
      // 남은 것 = 실패 + 멈춘 뒤 보내지 않은 것(뒤쪽) — 다시 시도는 이것만 보낸다(이미 저장한 해결을 두 번 만들지 않는다)
      const left = [...out.failed.map((f) => f.draft), ...drafts.slice(drafts.length - out.notTried)];
      setRemaining(left);
      setError(err);
      if (total > 1) {
        setSummary(`${out.done.length}개 해결됨 · ${out.failed.length}개 실패${out.notTried ? ` · ${out.notTried}개 보내지 않음(나머지도 같은 이유로 실패 — 멈춤)` : ""}`);
      }
      if (out.done.length) {
        setSavedSome(true);
        onChanged({ op: "resolve", created: out.done.flatMap((x) => (x.res ? [x.res] : [])), saved: out.done.length, complete: left.length === 0 });
      }
    } finally {
      if (live.current) setSending(false);
    }
  };

  const heading = target.op === "resolve" ? "해결 처리 확인" : "해결 되돌리기 확인";
  const confirmLabel = sending ? "처리 중…"
    : target.op === "revoke" ? "되돌리기 확인"
    : remaining.length < total ? `남은 ${remaining.length}개 다시 시도`
    : total > 1 ? `${total}개 해결 처리 확인` : "해결 처리 확인";
  return (
    <form
      role="group" aria-label={heading} data-testid={testId} className="my-1 border border-accent/60 bg-bg p-2 text-[11px] whitespace-normal"
      onSubmit={(e) => { e.preventDefault(); void run(); }}
      onKeyDown={(e) => { if (e.key === "Escape" && !sending) { e.preventDefault(); onClose(); } }}
    >
      <div className="label mb-1">{heading}</div>
      <div className="mb-1 text-fg" data-testid="resolve-subject">{target.subject}</div>
      <p className="mb-1 text-fg-3">{target.effect}</p>
      {target.op === "resolve" && target.excluded ? <p className="mb-1 text-fg-3" data-testid="resolve-excluded">{target.excluded}</p> : null}
      {target.op === "resolve" ? (
        <label className="mb-1 flex flex-wrap items-center gap-1">
          <span className="label">메모</span>
          <input
            ref={first} aria-label="해결 메모" className="mono w-80 max-w-full" value={note} disabled={sending}
            placeholder={`선택 · ${NOTE_MAX}자 이하 한 줄 · 감사 기록에 남음`} onChange={(e) => setNote(e.target.value)}
            aria-invalid={noteErr ? true : undefined} aria-describedby={noteErr ? noteId : undefined}
          />
        </label>
      ) : null}
      {noteErr ? <div id={noteId} className="mb-1 text-bad" role="alert" data-testid="resolve-note-error">{noteErr}</div> : null}
      <div className="flex flex-wrap items-center gap-1">
        <button
          ref={target.op === "revoke" ? first : undefined} type="button" className="btn border-accent! text-accent!" onClick={() => void run()}
          disabled={sending || !!noteErr || (target.op === "resolve" && !remaining.length)} aria-busy={sending}
        >{confirmLabel}</button>
        <button type="button" className="btn" onClick={onClose} disabled={sending}>{savedSome ? "닫기" : "취소"}</button>
      </div>
      {summary ? <div className="mt-1 text-warn" role="status" data-testid="resolve-summary">{summary}</div> : null}
      {error != null ? (
        <div className="mt-1 text-bad" role="alert" data-testid="resolve-error">
          {resolveErrorText(error, target.op)}
          {error instanceof ApiError ? <span className="mono ml-1 text-fg-3">(HTTP {error.status}{error.code ? ` · ${error.code}` : ""})</span> : null}
          <RequestIdOf error={error} onFilter={onFilterRid} />
        </div>
      ) : null}
    </form>
  );
}
