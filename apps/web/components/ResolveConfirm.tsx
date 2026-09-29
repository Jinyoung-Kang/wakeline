"use client";
import { useCallback, useEffect, useId, useRef, useState } from "react";
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
 * 확인 패널 자리(한 화면에 하나): 열 때마다 번호(n)를 새로 매긴다 — 부모는 n 을 패널의 key 로 준다.
 * 같은 자리를 다시 열어도(예: 일부 실패 뒤 목록이 바뀐 다음 "보이는 묶음 모두" 다시) 패널이 새로 시작해 지난 시도의 남은 요청 · 오류를 쓰지 않는다.
 * close = 지금 열린 패널을 닫는다(취소 · Esc — 패널이 화면에 있다). closeIf(n) = 그 번호의 패널이 아직 열려 있을 때만 닫는다(쓰기 결과 —
 * 보내는 동안 운영자가 다른 대상의 확인을 열었으면 그것을 닫지 않는다).
 */
export function useResolveSlot() {
  const [open, setOpen] = useState<{ at: string; target: ResolveTarget; n: number } | null>(null);
  const seq = useRef(0);
  /** 패널을 연 요소(키보드로 누른 단추) — 닫힌 뒤 초점을 되돌릴 곳 */
  const opener = useRef<HTMLElement | null>(null);
  const base = useId();
  const show = useCallback((at: string, target: ResolveTarget) => {
    opener.current = typeof document !== "undefined" ? (document.activeElement as HTMLElement | null) : null;
    setOpen({ at, target, n: ++seq.current });
  }, []);
  const close = useCallback(() => setOpen(null), []);
  const closeIf = useCallback((n: number) => setOpen((o) => (o?.n === n ? null : o)), []);
  // 닫힌 뒤(취소 · Esc · 완료) 초점이 사라진 패널과 함께 갈 곳을 잃었으면 연 단추로 되돌린다 — 긴 표에서 키보드 사용자가 자리를 잃지 않게.
  // 초점이 이미 다른 곳(운영자가 누른 다른 단추)에 있으면 건드리지 않는다. 연 단추가 사라졌으면(행이 목록에서 빠짐) 되돌리지 않는다
  useEffect(() => {
    if (open) return;
    const el = opener.current;
    opener.current = null;
    if (el?.isConnected && focusLost()) el.focus?.();
  }, [open]);
  /** 그 자리 패널의 DOM id(aria-controls 가 가리킨다) */
  const panelId = useCallback((at: string) => `${base}resolve-${at}`, [base]);
  /** 패널을 여는 단추의 속성 — 열려 있는지(aria-expanded)와 열린 패널(aria-controls) */
  const openerProps = useCallback((at: string) => ({ "aria-expanded": open?.at === at, "aria-controls": open?.at === at ? panelId(at) : undefined }), [open, panelId]);
  return { open, show, close, closeIf, panelId, openerProps };
}

/** 초점이 갈 곳을 잃었는가(문서 본문 · 없음 · 문서에서 떨어진 요소) */
function focusLost(): boolean {
  if (typeof document === "undefined") return false;
  const a = document.activeElement as HTMLElement | null;
  return a == null || a === document.body || !a.isConnected;
}

/**
 * 해결 처리 · 되돌리기 확인 패널(ADR-024) — 보내기 전에 대상 · 범위(upto) · 결과를 글로 말하고, 운영자가 확인해야 보낸다.
 * - 쓰기는 lib/api apiSend(CSRF 헤더). 401/404 는 onAuthMiss 로 세션을 확인해 만료면 부모가 로그인으로 보낸다(패널은 사라진다).
 * - 보내는 동안 단추를 막고("처리 중…", aria-busy) 두 번 보내지 않는다. 화면(해결됨 표시)은 부모가 201/204 를 받은 뒤에만 바꾼다.
 * - 보내는 동안 패널이 사라져도(상세 닫기 · 보기 · 탭 전환 · 다른 대상의 확인) 받은 결과는 부모에게 알린다 — 서버는 이미 바뀌었다(목록을 다시 읽어야 한다).
 *   패널 자신의 상태(남은 요청 · 오류 · 요약)만 사라진 패널에는 쓰지 않는다.
 * - 실패는 한국어 첫 문구 + (HTTP · code) + 요청 id(복사 · 로그로 거르기). 일괄의 일부 실패는 결과 수를 말하고 "남은 N개 다시 시도"로 실패 · 보내지 않은 것만 다시 보낸다.
 * - Esc = 취소(보내는 중이 아닐 때). 메모는 선택, 앞뒤 공백을 떼어 200자 이하 한 줄(서버가 다시 검사한다).
 */
export function ResolveConfirm({ id, target, onClose, onChanged, onAuthMiss, onFilterRid, testId = "resolve-confirm" }: {
  /** 패널의 DOM id — 여는 단추의 aria-controls(useResolveSlot panelId) */
  id?: string;
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
  /** 보내는 중 — 상태(sending)는 다음 그리기에야 단추를 막으므로 같은 프레임의 두 번째 누름은 이것이 막는다 */
  const busy = useRef(false);
  const noteId = useId();
  const subjectId = useId(), effectId = useId(), excludedId = useId();
  /** 무엇을 · 무엇이 일어나는지 — 초점이 메모 · 확인 단추에 오면 화면 읽기 프로그램이 함께 읽는다 */
  const describedBy = [subjectId, effectId, target.op === "resolve" && target.excluded ? excludedId : null].filter(Boolean).join(" ");
  useEffect(() => {
    live.current = true;
    first.current?.focus?.(); // 열리면 첫 입력(메모 · 되돌리기 확인)으로 — 키보드로 바로 확인 · Esc
    return () => { live.current = false; };
  }, []);
  const noteErr = target.op === "resolve" ? noteError(note) : null;

  /** 실패 처리: 세션 확인(401/404) — 만료면 부모가 로그인으로 보내므로 여기서 멈춘다 */
  const expired = async (e: unknown) => (isAuthMiss(e) ? (await onAuthMiss(e)) === "expired" : false);

  const run = async () => {
    if (busy.current || noteErr || (target.op === "resolve" && !remaining.length)) return;
    busy.current = true;
    setSending(true);
    setError(null);
    try {
      if (target.op === "revoke") {
        try {
          await apiSend<void>("DELETE", resolutionPath(target.ref.id));
          onChanged({ op: "revoke", id: target.ref.id, complete: true });
        } catch (e) {
          if (await expired(e)) return;
          if (live.current) setError(e);
          // 404(세션은 살아 있음) = 이미 되돌렸거나 없는 해결 — 보이는 목록이 틀렸으니 다시 불러온다(패널이 사라졌어도)
          if (e instanceof ApiError && e.status === 404) onChanged({ op: "revoke", id: target.ref.id, complete: false });
        }
        return;
      }
      const drafts = remaining;
      const out = await resolveAll(drafts, async (d) => parseResolution(await apiSend<unknown>("POST", RESOLUTIONS_PATH, resolutionBody(d, note))));
      const err = out.stopped ?? out.failed[0]?.error ?? null;
      if (err != null && await expired(err)) return;
      // 남은 것 = 실패 + 멈춘 뒤 보내지 않은 것(뒤쪽) — 다시 시도는 이것만 보낸다(이미 저장한 해결을 두 번 만들지 않는다)
      const left = [...out.failed.map((f) => f.draft), ...drafts.slice(drafts.length - out.notTried)];
      if (live.current) {
        setRemaining(left);
        setError(err);
        if (total > 1) {
          setSummary(`${out.done.length}개 해결됨 · ${out.failed.length}개 실패${out.notTried ? ` · ${out.notTried}개 보내지 않음(나머지도 같은 이유로 실패 — 멈춤)` : ""}`);
        }
        if (out.done.length) setSavedSome(true);
      }
      // 저장된 해결은 패널이 사라졌어도 알린다 — 부모가 목록을 다시 읽고 상태 줄에 남긴다
      if (out.done.length) {
        onChanged({ op: "resolve", created: out.done.flatMap((x) => (x.res ? [x.res] : [])), saved: out.done.length, complete: left.length === 0 });
      }
    } finally {
      busy.current = false;
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
      id={id} role="group" aria-label={heading} data-testid={testId} className="my-1 border border-accent/60 bg-bg p-2 text-[11px] whitespace-normal"
      onSubmit={(e) => { e.preventDefault(); void run(); }}
      onKeyDown={(e) => { if (e.key === "Escape" && !sending) { e.preventDefault(); onClose(); } }}
    >
      <div className="label mb-1">{heading}</div>
      <div id={subjectId} className="mb-1 text-fg" data-testid="resolve-subject">{target.subject}</div>
      <p id={effectId} className="mb-1 text-fg-3" data-testid="resolve-effect">{target.effect}</p>
      {target.op === "resolve" && target.excluded ? <p id={excludedId} className="mb-1 text-fg-3" data-testid="resolve-excluded">{target.excluded}</p> : null}
      {target.op === "resolve" ? (
        <label className="mb-1 flex flex-wrap items-center gap-1">
          <span className="label">메모</span>
          <input
            ref={first} aria-label="해결 메모" className="mono w-80 max-w-full" value={note} disabled={sending}
            placeholder={`선택 · ${NOTE_MAX}자 이하 한 줄 · 감사 기록에 남음`} onChange={(e) => setNote(e.target.value)}
            aria-invalid={noteErr ? true : undefined} aria-describedby={noteErr ? `${describedBy} ${noteId}` : describedBy}
          />
        </label>
      ) : null}
      {noteErr ? <div id={noteId} className="mb-1 text-bad" role="alert" data-testid="resolve-note-error">{noteErr}</div> : null}
      <div className="flex flex-wrap items-center gap-1">
        <button
          ref={target.op === "revoke" ? first : undefined} type="button" className="btn border-accent! text-accent!" onClick={() => void run()}
          disabled={sending || !!noteErr || (target.op === "resolve" && !remaining.length)} aria-busy={sending} aria-describedby={describedBy}
        >{confirmLabel}</button>
        <button type="button" className="btn" onClick={() => onClose()} disabled={sending}>{savedSome ? "닫기" : "취소"}</button>
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
