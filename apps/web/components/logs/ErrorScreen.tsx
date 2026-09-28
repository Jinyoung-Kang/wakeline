"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { ApiError } from "@/lib/api";
import { copyText } from "@/lib/copy";
import { describeThrown, reportClientError, type ReportResult } from "@/lib/errorReport";
import { logHeaderLine } from "@/lib/logs";
import { RequestIdCopy } from "./ErrorNote";

const REPORT_TEXT: Record<ReportResult, string> = {
  sent: "보냄 — 운영 화면 /logs 의 web-client 항목(수신 확인은 하지 않음)",
  duplicate: "같은 오류를 60 s 안에 이미 보냄 — 다시 보내지 않음",
  rate_limited: "이 페이지의 보고 상한(분당 5건)에 걸려 보내지 않음",
  unavailable: "보낼 수 없음(브라우저 환경 아님)",
};

/** 던져진 값에서 보일 것만 — Error 가 아니면 종류는 typeof, 스택 없음 */
function facts(error: unknown) {
  const err = error instanceof Error ? error : null;
  const digest = (error as { digest?: unknown } | null)?.digest;
  return {
    name: err ? err.name : typeof error,
    message: err ? err.message : String(error),
    stack: err && typeof err.stack === "string" ? err.stack : "",
    digest: typeof digest === "string" && digest ? digest : null,
    api: error instanceof ApiError ? error : null,
  };
}

/** 복사 텍스트 — 로그 항목과 같은 틀(첫 줄 `[시각 ERROR web-client/컴포넌트] rid=…`, 그다음 메시지 · HTTP · digest · 경로 · 스택) */
export function errorScreenText(error: unknown, component: string, atMs: number, path: string | null): string {
  const f = facts(error);
  const lines = [logHeaderLine(new Date(atMs).toISOString(), "ERROR", "web-client", component, f.api?.requestId ?? null), `${f.name}: ${f.message}`];
  if (f.api) lines.push(`HTTP ${f.api.status}${f.api.code ? ` · ${f.api.code}` : ""}`);
  if (f.digest) lines.push(`digest=${f.digest}`);
  lines.push(`path=${path ?? "—"}`);
  if (f.stack) lines.push(f.stack);
  return lines.join("\n");
}

/**
 * 오류 경계 화면(계약 v5 §C8 · app/error.tsx · app/global-error.tsx): 종류 · 메시지 · (ApiError 면) HTTP · code · 요청 id · digest · 경로 · 시각 · 스택을
 * 모두 보이고, 한 번에 복사할 수 있게 한다. 처음 보일 때 §C6 로 한 번 보고하고 결과(보냄 · 중복 · 상한)를 그대로 적는다.
 */
export function ErrorScreen({ error, retry, component }: { error: unknown; retry: () => void; component: string }) {
  const f = facts(error);
  const [seen, setSeen] = useState<{ at: number; path: string } | null>(null);
  const [report, setReport] = useState<ReportResult | null>(null);
  const [wrap, setWrap] = useState(true);
  const [copied, setCopied] = useState<boolean | null>(null);
  useEffect(() => {
    // 시각·경로는 브라우저에서만(서버 렌더와 어긋나지 않게), 보고는 이 오류에 한 번(개발 모드의 이중 실행은 live 로 거른다)
    let live = true;
    queueMicrotask(() => {
      if (!live) return;
      setSeen({ at: Date.now(), path: window.location?.pathname ?? "/" });
      const d = describeThrown(error);
      const dg = (error as { digest?: unknown } | null)?.digest;
      setReport(reportClientError({ message: d.message, stack: d.stack, component: typeof dg === "string" && dg ? `${component} · digest ${dg}` : component }));
    });
    return () => { live = false; };
  }, [error, component]);
  const copy = async () => setCopied(await copyText(errorScreenText(error, component, seen?.at ?? Date.now(), seen?.path ?? null)));
  const row = (label: string, value: React.ReactNode, testId?: string) => (
    <tr><th scope="row" className="w-40 align-top">{label}</th><td data-testid={testId}>{value}</td></tr>
  );
  return (
    <div className="h-full overflow-auto p-4" data-testid="error-screen">
      <div className="panel max-w-4xl p-4">
        <div className="label mb-1">Client error · 화면 오류</div>
        <h1 className="mb-2 text-sm font-semibold">이 화면을 그리는 중 오류가 났습니다</h1>
        <p className="mb-3 text-[12px] text-fg-2">“다시 시도”는 이 화면을 다시 불러와 그립니다. 계속되면 “오류 내용 복사”로 아래 전체를 복사해 전달하세요(운영자는 /logs 에서 같은 내용을 봅니다).</p>
        <div className="mb-3 flex flex-wrap gap-2">
          <button type="button" className="btn" onClick={() => retry()} data-testid="error-retry">다시 시도</button>
          <button type="button" className="btn" onClick={copy} data-testid="error-copy">오류 내용 복사</button>
          <Link className="btn" href="/">상황판으로</Link>
          <span role="status" className={`self-center text-[11px] ${copied === false ? "text-bad" : "text-ok"}`}>{copied == null ? "" : copied ? "복사됨" : "복사 실패 — 아래 글자를 직접 선택하세요"}</span>
        </div>
        <table className="mb-3">
          <tbody>
            {row("종류", <span className="mono">{f.name}</span>)}
            {row("메시지", <span className="mono whitespace-pre-wrap break-words">{f.message}</span>)}
            {f.api ? row("HTTP · code · 요청 id", <span><span className="mono">HTTP {f.api.status}{f.api.code ? ` · ${f.api.code}` : ""}</span>{f.api.requestId ? <RequestIdCopy id={f.api.requestId} /> : <span className="ml-2 text-fg-3">요청 id 없음</span>}</span>) : null}
            {row("digest", f.digest ? <span className="mono select-all">{f.digest}</span> : <span className="text-fg-3">—</span>)}
            {row("경로", <span className="mono">{seen?.path ?? "—"}</span>)}
            {row("시각(UTC)", <span className="mono">{seen ? new Date(seen.at).toISOString() : "—"}</span>)}
            {row("보고", <span className={report === "sent" ? "text-fg-2" : "text-warn"}>{report ? REPORT_TEXT[report] : "…"}</span>, "error-report")}
          </tbody>
        </table>
        <div className="mb-1 flex items-center gap-2">
          <span className="label">스택</span>
          <button type="button" className="btn px-1.5! py-0! normal-case!" aria-pressed={wrap} onClick={() => setWrap((w) => !w)}>줄바꿈 {wrap ? "켬" : "끔"}</button>
        </div>
        <pre className={`mono max-h-[50vh] overflow-auto border border-line bg-bg p-2 text-[11px] text-fg-2 ${wrap ? "whitespace-pre-wrap break-all" : "whitespace-pre"}`} data-testid="error-stack">{f.stack || "스택 없음(브라우저가 주지 않음)"}</pre>
        <p className="mt-2 text-[11px] text-fg-3">digest = 서버 렌더 오류 식별자(Next.js) — 서버 쪽 메시지는 브라우저로 오지 않으며 web 컨테이너 표준 출력에 같은 digest 로 남습니다.</p>
      </div>
    </div>
  );
}
