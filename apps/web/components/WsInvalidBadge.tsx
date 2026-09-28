"use client";
import { useId, useState } from "react";
import { copyText } from "@/lib/copy";
import { fmtClock } from "@/lib/format";
import type { WsInvalid } from "@/lib/store";

/**
 * 상세 문구(복사하는 글자 그대로) — 단위별 수 · 실제로 일어나는 다시 받기(lib/ws.ts recoverFrom) · 마지막 사유와 시각.
 * 다시 받기를 부풀려 말하지 않는다: 알림 · SIGMET · 레이더는 목록 재요청, status 는 heartbeat, 선택 · 수요는 바뀔 때만 다시 온다.
 */
export function wsInvalidText(inv: WsInvalid): string {
  return [
    "WS 수신 형식 오류(schemas/ws/server.v1.json 과 맞지 않음 — 페이지를 연 뒤 누적, 재접속해도 유지)",
    `버린 원소·값 ${inv.elements} — 틀린 항공기 · 선박 · 알림 · SIGMET · 격자 칸 같은 원소나 참고 값만 버렸다(모름으로). 메시지의 나머지는 적용했다.`,
    `버린 메시지 ${inv.messages} — 적용할 수 없는 메시지를 통째로 버렸다.`,
    `처리 예외 ${inv.errors} — 적용하다 예외가 났다(반쯤 적용됐을 수 있다).`,
    "다시 받기: 항공기 · 선박은 스냅샷 재동기(resync). 알림 · SIGMET · 레이더는 그 목록 전체를 다시 요청한다(알림 수는 전체 목록을 받을 때까지 \"—\"). "
      + "status 는 30 s 안의 다음 heartbeat, 선택한 항공기 · 선박과 수요 표시는 그 값이 바뀔 때 다시 온다.",
    "버린 메시지와 처리 예외는 브라우저 오류로 보고한다(같은 문구 60 s 에 1번 · 분당 5번 이하 — 운영 로그 메뉴).",
    `마지막: ${inv.last ?? "—"}${inv.at != null ? ` · ${fmtClock(inv.at)}(브라우저 시계)` : ""}`,
  ].join("\n");
}

/**
 * WS 형식 오류 배지(계약 v5 §E2 · 2차 리뷰): 단위가 다른 수를 더하지 않고 이름을 붙여 보인다("원소 3 · 메시지 1" — 0 인 단위는 뺀다).
 * 단추라서 키보드(Tab · Enter)와 터치로 연다 — 상세는 popover(최상위 층: 가로 스크롤되는 상태 바에 잘리지 않는다, Esc · 바깥 누르기로 닫힘)에
 * 단위별 설명 · 다시 받기 · 마지막 사유를 보이고 그 글자를 복사할 수 있다.
 */
export function WsInvalidBadge({ inv }: { inv: WsInvalid }) {
  const id = useId();
  const [copied, setCopied] = useState<"idle" | "ok" | "fail">("idle");
  const parts = ([["원소", inv.elements], ["메시지", inv.messages], ["예외", inv.errors]] as const).filter(([, n]) => n > 0);
  const text = wsInvalidText(inv);
  return (
    <>
      <button type="button" className="badge warn cursor-pointer" data-testid="ws-invalid" popoverTarget={id}
        aria-label={`WS 수신 형식 오류 — ${parts.map(([k, n]) => `${k} ${n}`).join(", ")}. 눌러서 상세 보기`}>
        WS 형식 오류{parts.map(([k, n]) => ` · ${k} ${n}`).join("")}
      </button>
      <div id={id} popover="auto" role="dialog" aria-label="WS 수신 형식 오류 상세" data-testid="ws-invalid-detail"
        className="panel inset-auto top-10 left-3 m-0 w-[min(560px,calc(100vw-24px))] p-3 text-[11px] leading-[1.5] whitespace-normal text-fg">
        <div className="mb-2 flex items-center justify-between gap-2">
          <span className="label">WS 수신 형식 오류</span>
          <span className="flex items-center gap-1">
            <button type="button" className="btn px-1.5! py-0! normal-case!" onClick={async () => setCopied((await copyText(text)) ? "ok" : "fail")}>
              {copied === "ok" ? "복사됨" : copied === "fail" ? "복사 실패" : "복사"}
            </button>
            <button type="button" className="btn px-1.5! py-0! normal-case!" popoverTarget={id} popoverTargetAction="hide">닫기</button>
          </span>
        </div>
        <pre className="mono m-0 whitespace-pre-wrap text-fg-2 select-all">{text}</pre>
        <span role="status" className="sr-only">{copied === "ok" ? "상세 문구 복사됨" : copied === "fail" ? "복사 실패 — 글자를 직접 선택해 복사하세요" : ""}</span>
      </div>
    </>
  );
}
