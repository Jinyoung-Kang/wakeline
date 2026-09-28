"use client";
import Link from "next/link";
import { useState } from "react";
import { ApiError } from "@/lib/api";
import { copyText } from "@/lib/copy";

/**
 * 오류 문구(계약 v5 §C8): 메시지 + (ApiError 면) HTTP 상태 · code · 요청 id. 요청 id 는 복사 단추와 /logs 링크(같은 요청의 서버 로그)로 이어진다.
 * 요청 id 가 없으면(서버가 주지 않음) 그 칸은 없다 — 지어내지 않는다.
 */
export function ErrorNote({ error, prefix, className }: { error: unknown; prefix?: string; className?: string }) {
  const msg = error instanceof Error ? error.message : String(error);
  const api = error instanceof ApiError ? error : null;
  return (
    <span className={className} data-testid="error-note">
      {prefix}{msg}
      {api ? <span className="mono ml-1 text-fg-3">(HTTP {api.status}{api.code ? ` · ${api.code}` : ""})</span> : null}
      {api?.requestId ? <RequestIdCopy id={api.requestId} /> : null}
    </span>
  );
}

/** 요청 id 한 개: 라벨 · mono 값(선택하기 쉽게 select-all) · 복사 단추(결과를 글자로) · /logs 에서 이 요청 id 로 거른 목록 */
export function RequestIdCopy({ id }: { id: string }) {
  const [state, setState] = useState<"idle" | "ok" | "fail">("idle");
  return (
    <span className="ml-1 inline-flex flex-wrap items-center gap-1 align-baseline" data-testid="request-id">
      <span className="label normal-case!">요청 id</span>
      <span className="mono select-all text-fg-2">{id}</span>
      <button type="button" className="btn px-1.5! py-0! normal-case!" aria-label={`요청 id ${id} 복사`} title="요청 id 복사 — 운영 화면 /logs 의 요청 id 칸에 붙여 넣는다"
        onClick={async () => setState((await copyText(id)) ? "ok" : "fail")}>
        {state === "ok" ? "복사됨" : state === "fail" ? "복사 실패" : "복사"}
      </button>
      <Link href={`/logs#rid=${encodeURIComponent(id)}`} className="text-[11px] text-accent underline" title="운영 로그인 필요 — 이 요청 id 의 서버 로그">로그 보기</Link>
    </span>
  );
}
