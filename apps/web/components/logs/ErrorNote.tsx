"use client";
import Link from "next/link";
import { useState } from "react";
import { ApiError } from "@/lib/api";
import { copyText } from "@/lib/copy";

/**
 * 오류 문구(계약 v5 §C8): 메시지 + (ApiError 면) HTTP 상태 · code · 요청 id. 요청 id 는 복사 단추와 /logs 링크(같은 요청의 서버 로그)로 이어진다.
 * 요청 id 가 없으면(서버가 주지 않음) 그 칸은 없다 — 지어내지 않는다.
 */
export function ErrorNote({ error, prefix, className, onFilterRid }: { error: unknown; prefix?: string; className?: string; onFilterRid?: (rid: string) => void }) {
  const msg = error instanceof Error ? error.message : String(error);
  const api = error instanceof ApiError ? error : null;
  return (
    <span className={className} data-testid="error-note">
      {prefix}{msg}
      {api ? <span className="mono ml-1 text-fg-3">(HTTP {api.status}{api.code ? ` · ${api.code}` : ""})</span> : null}
      {api?.requestId ? <RequestIdCopy id={api.requestId} onFilter={onFilterRid} /> : null}
    </span>
  );
}

/**
 * 한국어 안내 문구 옆에 붙이는 요청 id(계약 v5 §C8) — 문구는 화면이 정하고(서버 영문 detail 을 그대로 보이지 않는 곳), 여기는 id 만.
 * ApiError 이고 서버가 요청 id 를 줬을 때만 그린다(없으면 아무것도 — 지어내지 않는다).
 */
export function RequestIdOf({ error, onFilter }: { error: unknown; onFilter?: (rid: string) => void }) {
  return error instanceof ApiError && error.requestId ? <RequestIdCopy id={error.requestId} onFilter={onFilter} /> : null;
}

/**
 * 요청 id 한 개: 라벨 · mono 값(선택하기 쉽게 select-all) · 복사 단추(결과를 글자로) · /logs 에서 이 요청 id 로 거른 목록.
 * onFilter 가 있으면(/logs 화면 안) 링크 대신 필터를 바로 바꾼다 — Next 링크의 같은 경로 해시 이동은 hashchange 를 내지 않는다.
 */
export function RequestIdCopy({ id, onFilter }: { id: string; onFilter?: (rid: string) => void }) {
  const [state, setState] = useState<"idle" | "ok" | "fail">("idle");
  return (
    <span className="ml-1 inline-flex flex-wrap items-center gap-1 align-baseline" data-testid="request-id">
      <span className="label normal-case!">요청 id</span>
      <span className="mono select-all text-fg-2">{id}</span>
      <button type="button" className="btn px-1.5! py-0! normal-case!" aria-label={`요청 id ${id} 복사`} title="요청 id 복사 — 운영 화면 /logs 의 요청 id 칸에 붙여 넣는다"
        onClick={async () => setState((await copyText(id)) ? "ok" : "fail")}>
        {state === "ok" ? "복사됨" : state === "fail" ? "복사 실패" : "복사"}
      </button>
      {onFilter ? (
        <button type="button" className="btn px-1.5! py-0! normal-case!" onClick={() => onFilter(id)}>이 요청 id 로 거르기</button>
      ) : (
        <Link href={`/logs#rid=${encodeURIComponent(id)}`} className="text-[11px] text-accent! underline" title="운영 로그인 필요 — 이 요청 id 의 서버 로그">로그 보기</Link>
      )}
    </span>
  );
}
