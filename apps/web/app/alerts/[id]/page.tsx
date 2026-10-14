"use client";
import { use } from "react";
import { ScrollRegion } from "@/components/ScrollRegion";
import { AlertSheet } from "@/components/AlertSheet";
import { RequestIdOf } from "@/components/logs/ErrorNote";
import { alertDetail } from "@/lib/endpoints/alerts";
import { ApiError } from "@/lib/api";
import { frontNotice } from "@/lib/front-answer";
import { useApiResource } from "@/lib/use-api-resource";

/**
 * 알림 근거 — 고정 링크(SPEC F5 · 계약 v5 §G51): 근거 카드 전체 · 판정 때 위치 · 구역 사본(SIGMET 원문 · 유효 시간 / 공역 고도 한계 원문 · 차수) · 닫힌 까닭.
 * JSON 내려받기(API 응답 그대로 + 내려받은 시각) · 브라우저 인쇄(흰 바탕 · 지도 없이 좌표 표 — globals.css @media print, 서버 PDF 없음) · 그 시각 재생 링크.
 * 닫힌 알림은 보존 기간(기본 30일) 안에서만 — 지나면 404 를 '보존 기간이 지나 볼 수 없음'으로. 시각은 KST, 원문은 발표된 그대로.
 */
/**
 * 받지 못한 까닭: 404 = 보존 기간이 지났거나 없는 번호. 앞단(AWS 데모)이 답한 오류(잠금 만료 · 원본에 닿지 못함)는 그 안내(QA-1301 — lib/front-answer),
 * 그 밖의 HTTP 오류는 상태 번호를, 응답이 없으면(망) 그렇다고 적는다 — "받지 못함"만 남기지 않는다.
 */
function alertPageErrorText(e: unknown): string {
  if (!(e instanceof ApiError)) return "알림 근거를 받지 못함 — 서버에 연결할 수 없음(네트워크)";
  if (e.status === 404) return "보존 기간이 지나 볼 수 없음(닫힌 알림은 30일 보존) — 또는 없는 알림 번호";
  const front = frontNotice(e);
  return `알림 근거를 받지 못함(HTTP ${e.status})${front ? ` · ${front}` : ""}`;
}

export default function AlertPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const valid = /^[0-9]{1,18}$/.test(id);
  const res = useApiResource(valid ? id : null, (signal) => alertDetail(id, { signal }));
  const d = res.data;
  const err = !valid ? "알림 번호가 아님 — 숫자만 받습니다"
    : res.status === "failed" ? alertPageErrorText(res.error)
    : res.status === "loaded" && !d ? "응답의 모양이 틀려 그리지 않음" : null;
  return (
    <ScrollRegion label={`알림 ${id} 근거`} main className="h-full overflow-y-auto p-4" data-print="sheet">
      <h1 className="label mb-2" lang="en">Alert evidence · #{id}</h1>
      {err ? <div className="text-bad" role="alert" data-testid="alert-page-error">{err}{res.status === "failed" ? <RequestIdOf error={res.error} /> : null}</div> : null}
      {!d && !err ? <div className="text-fg-3" role="status">알림 {id} 근거 불러오는 중…</div> : null}
      {d ? <AlertSheet d={d} /> : null}
    </ScrollRegion>
  );
}
