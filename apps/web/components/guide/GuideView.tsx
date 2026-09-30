import Link from "next/link";
import { KstTime } from "@/components/KstTime";
import { creditGroups } from "@/lib/attribution";
import { KR_RADAR_STALE_S, METAR_STALE_S } from "@/lib/format";
import {
  flattenToc, GUIDE_TOC, PLAN, SHORTCUTS, shotView, tocItem, type GuideManifest, type ManifestDrop,
} from "@/lib/guide";
import { EXTRAPOLATE_CAP_OPENSKY_S, EXTRAPOLATE_CAP_S, STALE_AFTER_OPENSKY_S, STALE_AFTER_S } from "@/lib/interpolate";
import {
  KR_MISSING_CHECK_STALE_MIN, KR_MISSING_SLOW_AFTER_MIN, KR_MISSING_SLOW_EVERY_MIN, KR_MISSING_STALE_PROBES, KR_REF_MIN_SUPPORT, KR_REF_WINDOW_MIN,
} from "@/lib/kr-radar";
import { LOG_LEVELS, LOG_PERIOD_LABEL, LOG_SERVICES } from "@/lib/logs";
import {
  PORT_CALL_AUTHORITIES, PORT_CALL_MAX_ITEMS, PORT_CALL_SOURCE, PORT_CALL_STALE_AFTER_S, PORT_CALL_TITLE, PORT_CALL_WINDOW_DAYS,
} from "@/lib/portcalls";
import { LEGEND_OPEN_MIN_WIDTH } from "@/lib/prefs";
import { REPLAY_FULL_RES_MS, REPLAY_MAX_AREA_SQDEG, REPLAY_STEPS, REPLAY_SUMMARY_MS } from "@/lib/replay";
import { ROUTE_CAVEAT, ROUTE_SLOW_AFTER_S, ROUTE_STATUS_TEXT, ROUTE_TITLE } from "@/lib/route";
import { BUSY_APPEAR_DELAY_MS } from "@/lib/busy";
import { HEALTH_MARK, RADAR_STALE_S, SIGMET_STALE_S } from "@/lib/statusbar";
import {
  AIS_GAP_SHOW_MS, AIS_LAG_WARN_S, SHIP_STALE_S, SHIP_TRACK_HOURS, SHIPS_OUT_OF_COVERAGE_TEXT, SHIPS_RULE_TEXT, SHIPS_ZERO_AIS_DOWN_TEXT, SHIPS_ZERO_TEXT, STORED_STATIC_LABEL, STORED_STATIC_TIME_LABEL,
} from "@/lib/ships";
import { NOTE_MAX, RESOLUTION_STATE_TEXT, RESOLVE_EFFECT } from "@/lib/resolutions";
import { STATS_FAILED_TEXT, STATS_LOADING_TEXT, STATS_RUN_KST } from "@/lib/stats";
import { fmtKstRange, fmtTimeTitle, fmtZuluToken, kstDayStartMs, kstWallMs, RAW_BULLETIN_LABEL, utcDayWindowKst } from "@/lib/time";
import { TRAFFIC_BINS, TRAFFIC_LAYER_LABEL, TRAFFIC_LEGEND_NOTE, TRAFFIC_POLL_MS } from "@/lib/traffic-grid";
import { RECEPTION_BINS, RECEPTION_LAYER_LABEL } from "@/lib/reception-meta";
import { GLOBAL_STALE_S, REGION_STALE_S, RX_DEAD_MS, RX_FRESH_MS } from "@/lib/ws-protocol";
import { GuideFigure } from "./GuideFigure";
import { GuideToc } from "./GuideToc";

/*
 * 설명서(/guide) 본문 — 서버 컴포넌트(정적 내용, 데이터 요청 없음). 클라이언트 코드는 목차(GuideToc)뿐.
 * 숫자 · 문구는 가능한 한 화면 코드가 쓰는 상수를 그대로 가져온다(lib/*) — 동작이 바뀌면 설명도 같이 바뀐다.
 * 출처 목록은 하단 출처 줄과 같은 lib/attribution 에서. 시각은 화면 전체의 공유 형식기(lib/time · components/KstTime — 계약 v5 §G20, KST 만)로만 그린다
 * (7장의 예가 화면과 글자까지 같다). 예는 정해 둔 순간(아래 상수)에서 계산한다.
 */

/** 시각 예의 기준 순간 — 2026-09-29 14:22:11 KST */
const EXAMPLE_AT = "2026-09-29T05:22:11Z";
/** METAR 원문 예의 순간(290500Z) */
const METAR_AT = "2026-09-29T05:00:00Z";
/** 기상청 tm 예(KST 벽시계 — 기상청이 준 모양) */
const KMA_TM = "202609291420";
/** 통계 날짜 예(KST 날짜 — 서버가 KST 날짜로 센다) */
const STATS_DAY = "2026-09-28";
/** 그날 KST 00:00 – 23:59 */
const STATS_DAY_START = kstDayStartMs(STATS_DAY)!;
/** 공급자 예산 날 예(수집기 예산 키의 날 — 매일 09:00 KST 에 새로 시작) */
const BUDGET_DAY = "2026-09-28";
const n0 = (n: number) => n.toLocaleString("en-US");
/** 구간 글자 "a – b" — 쪽마다 줄바꿈 없이(좁은 칸에서는 " – " 에서만 바뀐다 — components/KstTime KstRange 와 같은 모양) */
function RangeText({ text }: { text: string }) {
  const [a, b] = text.split(" – ");
  return b == null ? <span className="mono whitespace-nowrap">{a}</span> : <span className="mono"><span className="whitespace-nowrap">{a}</span> – <span className="whitespace-nowrap">{b}</span></span>;
}

/* 되풀이되는 요소의 모양은 globals.css 의 .g-* (설명서 블록) — 요소마다 긴 유틸리티 글자를 싣지 않는다(요청마다 렌더되는 화면) */
function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="g-kbd">{children}</kbd>;
}

function Note({ tone = "info", children }: { tone?: "info" | "warn"; children: React.ReactNode }) {
  return <div className={`my-3 border-l-2 bg-bg-1 px-3 py-2 text-[12px] ${tone === "warn" ? "border-warn text-fg" : "border-accent text-fg-2"}`}>{children}</div>;
}

/** 절: id · 번호 · 제목은 목차(lib/guide GUIDE_TOC)에서만 — 목차와 본문 제목이 어긋날 수 없다 */
function Sec({ id, sub = false, children }: { id: string; sub?: boolean; children: React.ReactNode }) {
  const t = tocItem(id);
  const H = sub ? "h3" : "h2";
  return (
    <section id={id} data-guide-section={id} aria-labelledby={`${id}-h`} className={sub ? "g-sub" : "g-sec"}>
      <H id={`${id}-h`} tabIndex={-1} className="g-h">
        <span className="g-n">{t.n}</span><span>{t.title}</span>
      </H>
      {children}
    </section>
  );
}

/** 표(머리글 · 줄) — 설명서의 표는 모두 이 모양 */
function Table({ head, rows, label }: { head: string[]; rows: React.ReactNode[][]; label: string }) {
  return (
    <div className="g-table">
      <table aria-label={label}>
        <thead><tr>{head.map((h) => <th key={h} scope="col">{h}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

const P = ({ children }: { children: React.ReactNode }) => <p className="g-p">{children}</p>;
const UL = ({ children }: { children: React.ReactNode }) => <ul className="g-ul">{children}</ul>;
/** 굵은 낱말 — 모양은 .g-doc b */
const B = ({ children }: { children: React.ReactNode }) => <b>{children}</b>;

/** 버린 결과의 묶음 제목 — 그림에 무슨 일이 생겼는지(효과별) */
const DROP_EFFECT: [ManifestDrop["effect"], string][] = [
  ["placeholder", "항목을 버림 — 그 그림은 자리표시로 보입니다"],
  ["partial", "일부만 버림 — 그림은 보이고 그 부분만 빠짐(캡처 조건 · 번호 위치)"],
  ["unused", "계획에 없어 무시 — 어느 그림에도 영향 없음"],
];

export function GuideView({ manifest, dropped }: { manifest: GuideManifest; dropped: readonly ManifestDrop[] }) {
  /** 그림 번호 = 계획 순서(문서 순서 — parsePlan 이 확인) */
  const fig = (id: string) => {
    const i = PLAN.shots.findIndex((s) => s.id === id);
    if (i < 0) throw new Error(`guide: 계획에 없는 스크린샷 "${id}"`);
    return <GuideFigure shot={PLAN.shots[i]} view={shotView(PLAN.shots[i], manifest)} no={i + 1} />;
  };
  /** 본문에서 그림의 번호를 가리킨다 — 없는 번호면 던진다(빌드 · 시험에서 드러남) */
  const ref = (id: string, n: number) => {
    const i = PLAN.shots.findIndex((s) => s.id === id);
    if (i < 0 || !PLAN.shots[i].callouts.some((c) => c.n === n)) throw new Error(`guide: 없는 번호 ${id}#${n}`);
    return <span className="whitespace-nowrap text-fg-3">(그림 {i + 1}-<span className="mono text-accent">{n}</span>)</span>;
  };
  const ready = PLAN.shots.filter((s) => manifest.shots[s.id]).length;
  const metarToken = fmtZuluToken(METAR_AT);
  return (
    <div className="h-full overflow-y-auto" data-testid="guide" data-guide-scroll="">
      <div className="mx-auto grid max-w-[1320px] grid-cols-1 gap-x-8 px-4 pb-16 min-[900px]:grid-cols-[236px_minmax(0,1fr)] min-[900px]:px-6">
        <GuideToc items={GUIDE_TOC} />
        {/* 글줄은 읽기 좋은 폭(860 px)까지, 그림 · 표는 더 넓게 — 스크린샷의 작은 글자가 덜 줄어들게 */}
        <article className="g-doc min-w-0 max-w-[1120px] pt-4 text-[13px] leading-relaxed">
          <header className="mb-2 pb-4">
            <div className="label mb-1">Wakeline · 설명서</div>
            <h1 className="text-[22px] font-semibold tracking-tight">서비스 설명과 사용 방법</h1>
            <p className="mt-2 max-w-[860px] text-fg-2">
              무엇을 보여 주는지, 각 화면을 어떻게 쓰는지, 화면의 값을 어떻게 읽어야 하는지를 적었습니다. 스크린샷의 번호는 아래 번호 설명과 짝입니다.
              데이터 출처 · 라이선스 · 한계의 전체 목록은 <Link href="/about" prefetch={false} className="text-accent underline underline-offset-2">출처·한계</Link> 화면에 있습니다.
            </p>
            <div className="mono mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-fg-3">
              <span>절 {GUIDE_TOC.length}개 · 소절 {flattenToc().length - GUIDE_TOC.length}개</span>
              <span className={ready < PLAN.shots.length ? "text-warn" : undefined}>스크린샷 {ready}/{PLAN.shots.length}{ready < PLAN.shots.length ? " — 나머지는 준비 중(자리표시에 그 화면의 설명)" : ""}</span>
              <span>시각 표기: 모두 KST(7장)</span>
            </div>
          </header>

          {dropped.length ? (
            <div role="alert" className="mb-6 border border-warn/60 bg-bg-1 px-3 py-2 text-[12px] text-warn">
              스크린샷 결과(lib/guide-manifest.json)에서 형식이 틀린 부분을 버렸습니다.
              {DROP_EFFECT.map(([effect, title]) => {
                const list = dropped.filter((d) => d.effect === effect);
                return list.length ? (
                  <div key={effect} className="mt-1">
                    <div>{title}:</div>
                    <ul className="mono list-disc pl-5 text-[11px]">{list.map((d, i) => <li key={i}>{d.text}</li>)}</ul>
                  </div>
                ) : null;
              })}
            </div>
          ) : null}

          {/* ---------------- 1 ---------------- */}
          <Sec id="overview">
            <P>
              Wakeline 은 <B>항공기(ADS-B)</B> · <B>선박(AIS)</B> · <B>위험기상(SIGMET · METAR · TAF)</B> · <B>기상 레이더</B>를 한 지도에 겹쳐 보여 주는 실시간 상황판입니다.
              항공기가 SIGMET 경보 구역 안에 있으면 <B>관측 알림</B>, 지금 속도 · 방위로 10분 안에 들어갈 것으로 계산되면 <B>예측 알림(추정)</B>을 판정 근거와 함께 보여 줍니다.
            </P>
            <div className="my-4 grid grid-cols-1 gap-px border border-line bg-line min-[700px]:grid-cols-2">
              {([
                ["Aircraft", "항공기", <>ADS-B 공급자 스냅샷의 위치 · 고도 · 속도. 갱신 사이의 위치는 브라우저가 <B>추정</B>(dead reckoning — 최대 {EXTRAPOLATE_CAP_S} s, OpenSky {EXTRAPOLATE_CAP_OPENSKY_S} s)해 관측과 구분해 그립니다.
                  수신이 {STALE_AFTER_S} s(OpenSky {STALE_AFTER_OPENSKY_S} s) 넘게 끊기면 반투명(STALE).</>],
                ["Ships", "선박", <>AIS 실시간 스트림의 위치와 선원이 입력한 보고값(이름 · 목적지 · ETA 등). 위치는 받은 그대로(보간 없음)이고 {SHIP_STALE_S / 60}분 넘게 새 위치가 없으면 STALE.
                  육상 수신국 기반이라 수신국이 없는 해역은 비어 있을 수 있습니다. 고른 선박의 <B>한국 항만 입출항</B>(해양수산부 PORT-MIS)과,
                  한반도 연안의 <B>격자별 선박 척수</B>(한국해양교통안전공단 5분 집계 — 개별 위치 아님) 레이어도 있습니다.</>],
                ["Hazards", "위험기상", <>SIGMET 의 폴리곤 · 고도대 · 유효시간으로 항공기 알림을 판정합니다. 폴리곤을 만들 수 없는 SIGMET 은 원문으로 남기되 판정에서 빼고 사유를 적습니다.
                  공항은 METAR 비행 카테고리 색과 METAR · TAF 원문.</>],
                ["Radar", "기상 레이더", <>RainViewer 전세계 합성(과거 2 h · 10분 간격 · 줌 7 이하, 커버리지 밖 회색)과 기상청 HSR 한반도 합성(500 m · 5분, 합성에 들어간 레이더 지점 수 표시).</>],
              ] as [string, string, React.ReactNode][]).map(([en, ko, body]) => (
                <div key={en} className="bg-bg p-3">
                  <div className="mb-1 flex items-baseline gap-2"><span className="label">{en}</span><span className="text-[13px] font-semibold">{ko}</span></div>
                  <div className="text-[12px] leading-relaxed text-fg-2">{body}</div>
                </div>
              ))}
            </div>
            <h3 className="mt-5 mb-1 text-[13px] font-semibold">데이터 출처 요약</h3>
            <P>모든 화면 맨 아래 출처 줄과 같은 목록입니다. 호출 상한 · 라이선스 · 조건은 <Link href="/about" prefetch={false} className="text-accent underline underline-offset-2">출처·한계</Link>에 있습니다.</P>
            <Table label="데이터 출처" head={["역할", "출처"]} rows={creditGroups().map((g) => [g.role, (
              <span key={g.role}>{g.items.map((c, i) => (
                <span key={c.label}>{i ? " · " : ""}<a href={c.href} target="_blank" rel="noopener noreferrer" className="text-fg underline decoration-line-2 underline-offset-2 hover:decoration-accent">{c.label}</a>
                  {c.license ? <span className="text-fg-3"> ({c.license.label})</span> : null}{c.note ? <span className="text-fg-3"> ({c.note})</span> : null}</span>
              ))}</span>
            )])} />
            <Note tone="warn">비상업 · 학습 · 포트폴리오 용도입니다. 운항 판단에 쓰면 안 됩니다.</Note>
          </Sec>

          {/* ---------------- 2 ---------------- */}
          <Sec id="dashboard">
            <P>상황판(맨 왼쪽 메뉴)은 지도 · 오른쪽 패널 · 위아래 줄로 이뤄집니다. 폭 900 px 미만에서는 패널이 지도 아래로 내려갑니다.</P>
            <Sec id="dashboard-layout" sub>
              {fig("dashboard")}
            </Sec>
            <Sec id="dashboard-map" sub>
              <UL>
                <li><B>이동</B> — 끌기. <B>확대 · 축소</B> — 휠 · 두 손가락 · 왼쪽 위 +/− 단추{ref("dashboard", 3)} · 지도에 초점이 있을 때 <Kbd>=</Kbd> <Kbd>-</Kbd>.</li>
                <li><B>고르기</B> — 항공기 · 선박 기호, 공항 원, SIGMET 면을 누르면 오른쪽 패널에 카드가 열립니다. 선박 격자 원을 누르면 그 칸으로 확대합니다.</li>
                <li><B>선택 풀기</B> — 지도 빈 곳을 누르면 항공기 · 선박 선택이 풀리고 집중 추적(2.5)도 멈춥니다.</li>
                <li><B>툴팁</B> — 기호 위에 마우스를 올리면 요약이 뜹니다(지도 조작을 막지 않음).</li>
                <li><B>위치 공유</B> — 주소 끝 <span className="mono">#줌/위도/경도</span>(예: <span className="mono">/#6.3/36.1/127.9</span>)가 지금 지도 위치입니다. 그 주소를 열면 같은 자리로 열립니다.</li>
                <li><B>키보드</B> — 지도에 초점(Tab)을 두면 <Kbd>←</Kbd><Kbd>→</Kbd><Kbd>↑</Kbd><Kbd>↓</Kbd> 이동, <Kbd>=</Kbd>/<Kbd>-</Kbd> 확대 · 축소(Shift 와 함께 2단계 — 9장).</li>
              </UL>
            </Sec>
            <Sec id="dashboard-layers" sub>
              <UL>
                <li><B>레이어 단추</B>{ref("dashboard", 5)} — 레이더 · SIGMET · 항공기 · 선박 · {RECEPTION_LAYER_LABEL} · 공항 · 항적 · 예측(추정) · {TRAFFIC_LAYER_LABEL}. 켜진 단추는 파란 테두리입니다. 선박 · 관측 수신 범위 · 연안 교통량은 처음에 꺼져 있습니다.</li>
                <li><B>선종 필터</B> — 선박을 켜면 <span className="mono">선종 필터 N/M</span> 단추가 생깁니다. 누르면 범례가 펼쳐지고, 범례의 선종 항목을 눌러 켜고 끕니다(‘모두 켜기’). 일부만 켜면 단추가 주황색이고, 지도 칩과 선박 목록이 걸러진 수를 따로 적습니다.</li>
                <li><B>저장</B> — 레이어 · 범례 열림 · 선종 필터는 이 브라우저에만 저장됩니다(다른 기기 · 브라우저와 공유되지 않음). 범례는 폭 {n0(LEGEND_OPEN_MIN_WIDTH)} px 이상 화면에서 처음부터 펼쳐집니다.</li>
              </UL>
              {fig("traffic")}
              <UL>
                <li><B>{TRAFFIC_LAYER_LABEL}</B>{ref("traffic", 1)} — 한국해양교통안전공단이 5분마다 집계한 해양격자 칸(0.025°)별 선박 척수를 색으로 칠합니다.
                  범례{ref("traffic", 3)}: “{TRAFFIC_LEGEND_NOTE}”. 칸의 수는 <B>격자별 척수이고 개별 선박 위치가 아닙니다</B> — 지도의 선박 기호(AIS)와 다른 자료입니다.
                  색 구간은 {TRAFFIC_BINS.map((b) => b.label).join(" · ")}척(표시용 선택 — 많을수록 밝은 주황), 0척은 회색.</li>
                <li><B>칸의 위치</B> — 해양수산부 해양격자 4단계에서 칸마다 한 번 받아 0.025° 격자에 맞는지 서버가 확인한 칸만 그립니다. 칸 번호의 글자로 위치를 짐작하지 않으므로,
                  칸 조회는 시간당 많아야 290칸(항만 입출항 색인과 나눠 쓰는 해양수산부 호출 상한)이라 처음 약 18시간 이상(계산)은 확인한 칸만 보이고 상태 줄{ref("traffic", 2)}이 ‘위치 확인 중 N칸’을 적습니다(거듭 실패한 칸은 ‘위치 조회 실패 N칸’, 해양격자에 없는 칸 · 격자 검사에 실패한 칸도 따로 셉니다).</li>
                <li><B>상태 줄</B> — 기준 시각(KST) · 표시한 칸 / 전체, 또는 꺼짐(이유 — 공공데이터포털 키 없음 · fixture 모드 · 운영자가 끔) · 자료 없음 · 검증 실패 · 조회 실패.
                  레이어가 켜져 있고 탭이 보일 때만 {TRAFFIC_POLL_MS / 1000} s 마다 조회합니다. 기준 시각이 15분 넘게 지나면(조회가 실패해도 이 브라우저 시계로) 칸을 지우고 ‘자료 멈춤’이라고 적습니다.</li>
                <li><B>툴팁</B> — 칸에 마우스를 올리면 격자 번호 · 척수 · 밀집도 % · 기준 시각(KST).</li>
              </UL>
            </Sec>
            <Sec id="dashboard-search" sub>
              {fig("search")}
              <UL>
                <li><B>항공기</B> — 호출부호 · hex · 등록번호 앞부분(영문 · 숫자 · - 2–10자, 공백은 빼고 찾음). <B>선박</B> — 선명 · 호출부호 앞부분, MMSI, IMO(2–40자, 영문 · 숫자 · 공백 . - /).</li>
                <li><Kbd>/</Kbd> 로 입력에 초점, <Kbd>↑</Kbd><Kbd>↓</Kbd> 이동, <Kbd>Enter</Kbd> 선택, <Kbd>Esc</Kbd> 닫기.</li>
                <li>항공기를 고르면 카드를 열고 지도를 그 위치로 옮깁니다. 지금 위치가 없으면(DB 기록만) 그렇다고 적고 옮기지 않습니다.</li>
                <li>선박을 고르면 선박 레이어를 켜고 카드 · 항적을 엽니다. 실시간 목록에 없는 선박은 카드만 열고 마지막 수신 · 저장 시각을 적습니다 — 위치를 지어내지 않습니다.</li>
                <li>한 묶음이 실패해도 다른 묶음은 그대로 보이고, 실패한 묶음에는 이유와 요청 id 를 적습니다.</li>
              </UL>
            </Sec>
            <Sec id="dashboard-aircraft" sub>
              {fig("aircraft")}
              <UL>
                <li><B>값</B> — 호출부호 · ICAO24 · 등록번호 · 기종 · 고도(ft · m) · 지상속도(kt · km/h) · 방위 · 수직속도 · squawk · 출처 · 관측/수신 시각 · 품질 · 10분 예측 여부. 모르는 값은 —. 비상 squawk(7500 · 7600 · 7700)는 빨간 EMERGENCY.</li>
                <li><B>{ROUTE_TITLE}</B> — {ROUTE_CAVEAT}. 판단 근거로 마지막 관측 위치와 노선 대권 경로 사이 거리를 <B>계산값</B>으로 함께 보입니다. 상태는 그대로 적습니다: {Object.values(ROUTE_STATUS_TEXT).map((s, i) => <span key={s}>{i ? " · " : ""}‘{s}’</span>)}.
                  ‘노선 조회 중’ 동안은 글자 아래 가는 진행 막대(몇 % 인지 말하지 않음)와 출발 · 도착 자리 표시가 보이고, 경과 초를 셉니다 — {BUSY_APPEAR_DELAY_MS / 1000} s 안에 끝나는 조회는 진행 표시가 나타나지 않습니다(번쩍이지 않게 고른 값).
                  {ROUTE_SLOW_AFTER_S} s 를 넘으면 ‘보통 경로 계산값보다 오래 걸림’을 덧붙입니다. 움직임 줄이기 설정이면 막대가 움직이지 않습니다.</li>
                <li><B>집중 추적</B> — 항공기를 고르면 서버 수집기가 그 항공기만 따로 조회합니다{ref("aircraft", 2)}. 고르지 않고 확대하면 화면 중심 주변을 따로 조회합니다(핫 리전). 칩에는 서버가 보고한 상태 · 주기만 쓰고, 호출 상한 때문에 늦어지면 그렇다고 적습니다. 창을 닫으면 최대 60초 안에 멈추고, 한 세션의 연속 집중 추적은 30분까지입니다.</li>
                <li><B>항적 · 예측</B> — 항적은 DB 기록(최근 2 h)에 실시간 관측을 이은 선, 점선 궤적은 서버가 예측할 수 있다고 판단할 때만 그리는 10분 추정입니다. 예측하지 않으면 카드에 이유(선회 중 · 저속 · 지상 · 속도/방위 없음 · 수신 지연)를 적습니다.</li>
              </UL>
            </Sec>
            <Sec id="dashboard-ship" sub>
              {fig("ship")}
              <UL>
                <li><B>고르기</B> — 지도의 선박 기호, ship 탭의 ‘화면 안 선박’ 표(머리글 정렬 · 이름/MMSI 거르기){ref("ship", 1)}, 통합 검색.</li>
                <li><B>보고값</B> — 이름 · 크기 · 흘수 · 목적지 · ETA 는 선원이 입력한 값 그대로입니다(ETA 는 연도 없음). AIS 에는 출발지 항목이 없고, 목적지 문자열은 정해진 규칙(“A&gt;B” · “&gt;B” · “A&lt;&gt;B”)으로만 풀며 UN/LOCODE 항구 코드 모양일 때만 이름 · 국가를 붙입니다.</li>
                <li><B>{STORED_STATIC_LABEL}</B> — 서버가 다시 시작한 직후처럼 실시간 선박 스트림(최대 2.5 h)에 그 선박의 정적 보고가 아직 없으면 DB 에 저장된 마지막 AIS 정적 보고를 대신 보이고,
                  카드의 정적 필드 위에 ‘{STORED_STATIC_LABEL} · {STORED_STATIC_TIME_LABEL} (KST)’로 밝힙니다 — 실시간 값이 아니고, 시각은 DB 에 기록된 수신 시각(내용이 바뀔 때,
                  그리고 수집기가 다시 시작했거나 그 선박을 30분 넘게 받지 못했다가 다시 받을 때 새로 기록 — 그 내용의 첫 수신도 마지막 수신도 아님)입니다. 저장 행은 받은 필드만 덮으므로 그 시각의 보고가 싣지 않은 필드(예: Class B 의 선명 조각만 받았을 때의 호출부호 · 선종 · 크기)는 그보다 앞서 저장된 보고의 값입니다. 서버가 선택 때 그 보고를 읽었으면 입출항도 그 호출부호로 찾고, 읽지 못했으면 카드가 찾지 않았다고 적습니다.</li>
                <li><B>항적</B> — 기간 {SHIP_TRACK_HOURS.join(" / ")} h 단추{ref("ship", 3)}. 기록(60 s 에 1점) + 실시간 관측. 수신이 끊긴 구간은 되살릴 수 없어 <B>회색 점선(공백)</B>으로 남기고, 공백 횟수 · 합계를 카드에 적습니다.</li>
                <li><B>기호</B> — 선수방위 방향으로 회전, 선수방위가 없으면 침로 기준(점선 외곽), 둘 다 없으면 방향 없는 원. ‘추측항법 · 수동 입력’으로 보고된 위치는 배지로 구분합니다.</li>
                <li><B>개별 · 격자</B> — {SHIPS_RULE_TEXT}. 격자 원의 크기 = 선박 수, 색 = 가장 많은 선종.</li>
                <li><B>선박이 안 보일 때</B> — 지도 칩{ref("ship", 4)}이 이유를 적습니다. 예: ‘{SHIPS_ZERO_TEXT}’ · ‘{SHIPS_OUT_OF_COVERAGE_TEXT}’ · ‘{SHIPS_ZERO_AIS_DOWN_TEXT}’.</li>
                <li><B>{RECEPTION_LAYER_LABEL}</B> — 레이어 단추(처음에 꺼짐). 이 서비스가 최근 24 h 에 실제로 선박 위치를 받은 0.5° 칸을 옅은 파랑으로 칠합니다 —
                  칸이 진할수록 그 칸에서 받은 서로 다른 선박이 많습니다(구간 {RECEPTION_BINS.map((b) => b.label).join(" · ")}척, 표시용 선택). 선박 레이어의 점선(수신 범위 · 운영 설정)은
                  구독한 영역이고 이 칸은 잰 값입니다 — aisstream 은 육상 수신국이 받은 것만 보내므로 점선 안이어도 수신국이 없는 해역은 칸이 없습니다.
                  칸에 마우스를 올리면 선박 수 · 위치 수(선박마다 60 s 창의 첫 보고 — 많아야 1건, 저장과 같은 표본) · 마지막 표본 수신(KST — 그 창의 첫 보고라 실제 마지막 수신보다
                  60 s 안쪽으로 이를 수 있음) · 창. 서버가 다시 시작한 직후처럼 창을 다 세지 못했으면 상태 줄이 ‘창의 일부만 셈 — … 부터’와 까닭(기동 전 기록을 읽는 중 · 일부만 읽음 ·
                  읽기 실패)을 적고, 범례도 ‘최근 24 h’ 대신 실제로 센 구간(‘… KST 부터’)을 적습니다(메모리 상한으로 세지 못한 위치가 있으면 그것도). 켜 두면 선박 칩의 설명(마우스를
                  올리면)과 0척 알림 글자에 ‘이 화면에 관측 수신 칸 N개(최근 24 h)’가 붙습니다 — 창을 다 세지 못했으면 ‘(… KST 부터만 셈)’처럼 실제로 센 구간을, 조회가 실패했으면
                  마지막 값이라고 적습니다.</li>
              </UL>
              {fig("reception")}
              {fig("port-calls")}
              <UL>
                <li><B>{PORT_CALL_TITLE}</B>{ref("port-calls", 1)} — 서버 수집기가 공공데이터포털의 {PORT_CALL_SOURCE}에서 항만청 {PORT_CALL_AUTHORITIES}곳의 입출항 신고를
                  KST 날짜별로 모두 받아 <B>색인</B>해 두고, 선박을 고르면 그 선박이 AIS 로 보낸 <B>호출부호로만</B> 색인에서 최근 {PORT_CALL_WINDOW_DAYS}일(KST 날짜 · 입항일 기준) 기록을 찾습니다.
                  고를 때 외부에 묻지 않습니다(원천의 호출부호 검색이 거르지 않아 — 선박마다 틀린 ‘기록 없음’이 나왔습니다 — 색인으로 바꿨습니다). 선명으로는 찾지 않습니다 — 호출부호가 틀리거나
                  같은 호출부호를 쓰는 다른 선박이 있으면 다른 선박의 신고일 수 있습니다.</li>
                <li><B>결과 표</B>{ref("port-calls", 3)} — 항만청 · 입항 · 출항(KST, 그 신고의 판 — 최종 · 최초) · 선석 · 목적 · 전출항지 → 차항지, 최근 {PORT_CALL_MAX_ITEMS}건까지.
                  출항 신고가 색인에 없으면 —(아직 입항 중이거나 색인이 그 뒤를 다시 읽지 않았을 수 있습니다). 00:00(KST)으로 온 신고는 날짜만 신고했는지 자정인지 원천이 구분하지 않아
                  날짜만 보이고 ‘시각 미확인’이라고 적습니다. PORT-MIS 에 신고된 선명이 AIS 선명과 다르면 경고로 밝히고 같은 선박인지 판정하지 않습니다 —
                  두 이름이 모두 영문일 때만 견줍니다(한글 신고 선명은 비교하지 않고 그렇다고만 적습니다).</li>
                <li><B>색인 상태</B>{ref("port-calls", 4)} — ‘색인: {PORT_CALL_AUTHORITIES}개 항만청 · 최근 {PORT_CALL_WINDOW_DAYS}일 · 갱신 (KST)’. 수집기는 한 시간마다 항만청마다 최근 3일을
                  다시 받고(출항 · 최종 신고가 뒤에 붙습니다) 그보다 오래된 날은 하루에 한 번쯤 다시 받습니다. 갱신 시각은 {PORT_CALL_AUTHORITIES}곳의 최근 3일 다시 받기 중 가장 오래된 것 —
                  <B>최근 3일</B>은 그 시각까지 올라온 신고가 색인에 있고, 더 오래된 날은 마지막으로 다시 받은 때(하루 안쪽 — 서버가 다시 시작하면 그 시각을 모릅니다)까지의 신고입니다.</li>
                <li><B>상태</B>{ref("port-calls", 2)} — <B>기록 없음</B>은 {PORT_CALL_AUTHORITIES}곳 모두 창 전체를 오늘(KST) 목록까지 빈 곳 없이 색인했고 {PORT_CALL_STALE_AFTER_S / 3600}시간 안에 갱신됐을 때만 말합니다.
                  아니면 ‘색인 불완전’과 항만청마다 이유(아직 색인 안 됨 · 창 앞쪽 일부만 · 오늘 목록 아직 — 자정 직후 · 갱신 오래됨 — 마지막 갱신 시각 · 끝까지 색인하지 못한 날 — 그 날짜)를
                  적습니다. 끝까지 색인하지 못한 날은 원천 응답이 어긋난 날(키 없는 신고 · 쪽 사이 어긋남 등)이고, 수집기가 다시 받아 끝까지 색인하면 사라집니다. 그 밖에 꺼짐(공공데이터포털 키 없음 · 운영자가 끔) ·
                  AIS 호출부호를 아직 받지 않음(정적 정보 전 — ‘없음’이 아닙니다) · 찾는 형식 밖 호출부호 · 색인 읽기 실패를 그대로 적습니다.</li>
              </UL>
            </Sec>
            <Sec id="dashboard-alerts" sub>
              {fig("alerts")}
              <UL>
                <li><B>관측(inside)</B> — 항공기가 지금 SIGMET 경보 구역(폴리곤 · 고도대 · 유효시간) 안. <B>예측(predicted)</B> — 지금 속도 · 방위로 10분 직선 외삽하면 들어감. 항상 ‘추정’이며, 선회 중(최근 트랙 변화 15° 초과)이거나 60 kt 미만이면 예측하지 않습니다.</li>
                <li><B>범위</B>{ref("alerts", 1)} — 관심 지역(서버 설정의 중심 · 반경)과 전세계. 관심 지역 설정을 아직 받지 못했으면 수를 —로 두고 기다립니다.</li>
                <li><B>근거 카드</B> — 행을 누르면 목록 안에서 펼칩니다{ref("alerts", 3)}. ‘항공기 카드 · 지도’ 단추{ref("alerts", 4)}가 항공기를 고르고, 위치가 화면 밖이면 지도를 옮깁니다.</li>
                <li><B>배너</B> — 진입 · 이탈 · 신호 끊김 · 진입 예상만 목록 위에 잠시 보입니다.</li>
                <li><B>연결이 끊기면</B> — 목록 위에 ‘마지막으로 받은 목록 · 갱신 안 됨 · ETA 멈춤’처럼 지금 상태를 적습니다. 목록을 아직 받지 못했으면 ‘없음’이 아니라 ‘수신 대기’입니다.</li>
                <li><B>SIGMET 탭</B>{ref("alerts", 5)} — 목록 → 카드: 유형 · FIR · 고도대 · 유효시간 · 안에 있는 항공기 · 원문(발표 그대로). 지도에서는 30분 안에 만료될 SIGMET 이 점선, 발효 전 SIGMET 이 잔 점선(아직 판정 안 함)입니다.</li>
              </UL>
            </Sec>
            <Sec id="dashboard-radar" sub>
              {fig("radar")}
              <UL>
                <li><B>RainViewer</B> — 전세계 합성, 과거 2 h · 10분 간격 · 줌 7 이하. 커버리지 밖은 회색으로 가려 ‘에코 없음(투명)’과 구분합니다.</li>
                <li><B>기상청 HSR</B> — 한반도 500 m · 5분 합성. 관측 범위 안은 연한 회색, 밖은 투명. 수집된 프레임이 없으면 단추가 꺼지고 이유를 적습니다.</li>
                <li><B>합성 N/M곳</B>{ref("radar", 4)} — N = 그 프레임 헤더의 레이더 지점 수, M = 지난 {KR_REF_WINDOW_MIN}분 저장 프레임 중 최대(기준).
                  N &lt; M 이면 <span className="text-warn">일부 합성</span>(주황) — 실자료라 숨기지 않고, 수집기가 다시 받아 지점이 늘면 바꿉니다. N = M 은 ‘기준 도달’(파랑)일 뿐 기상청 합성이 완전하다는 뜻은 아닙니다.
                  기준에 닿은 프레임이 {KR_REF_MIN_SUPPORT}개 미만이면 판정하지 않습니다(—).</li>
                <li><B>프레임 띠</B>{ref("radar", 5)} — 왼쪽이 오래된 프레임. 주황 = 일부 합성, 파랑 = 기준 도달, 빈 칸 = 판정 없음, 테두리 = 지금 프레임.</li>
                <li><B>애니메이션</B>{ref("radar", 2)} — 프레임을 차례로 보여 줍니다. 슬라이더로 한 프레임을 고르면 멈추고, ‘latest’ 는 최신 프레임으로.</li>
                <li>기상청 프레임이 {KR_RADAR_STALE_S / 60}분 넘게 새로 오지 않으면 상태 바의 기상청 칩이 경고로 바뀝니다: <span className="mono text-bad">KMA {HEALTH_MARK.bad} age …m STALE</span>(칩 설명에 최신 프레임을 처음 받은 시각).</li>
                <li>기상청이 목록에는 tm 을 올렸는데 내려받기가 ‘파일 없음’으로 답하면(수집기가 확인 — 2026-09-30 관찰) 칩에 <span className="text-warn">파일 없음</span>이 붙고,
                  칩 설명 · 상세 · 레이더 패널 · 범례 · 타임라인 · 운영 공급자 표가 없다는 답을 받은 첫 · 마지막 tm · 확인한 tm 수(그 사이 확인하지 않은 tm 은 세지 않음) · 기상청 답의 파일 이름 · 목록의 파일 종류 · 마지막 확인(KST)을 적습니다 — 나이(STALE)만으로는 까닭을 모릅니다.
                  연속이 {KR_MISSING_SLOW_AFTER_MIN}분을 넘으면 수집기가 {KR_MISSING_SLOW_EVERY_MIN}분마다만 확인합니다(예산 — 설명에 ‘{KR_MISSING_SLOW_EVERY_MIN}분마다 확인’, 그 사이 실행은 waiting).
                  마지막 확인이 확인 간격 × {KR_MISSING_STALE_PROBES}(아래로 {KR_MISSING_CHECK_STALE_MIN}분 — 늘린 뒤에는 {KR_MISSING_SLOW_EVERY_MIN * KR_MISSING_STALE_PROBES}분, 모두 수집기 선택값)을 넘으면 <span className="text-warn">파일 없음 · 확인 멈춤</span> — 지금도 그런지는 모릅니다.</li>
              </UL>
            </Sec>
            <Sec id="dashboard-legend" sub>
              <P>범례{ref("dashboard", 6)}는 지도에 쓰인 모든 기호 · 색의 뜻을 적습니다. ‘범례 ▸’ 단추로 접고 펼칩니다.</P>
              <Table label="범례 묶음" head={["묶음", "읽는 법"]} rows={[
                ["항공기", "색 = 고도 띠(지상은 GND 색). 흰 외곽선 = 관측 위치, 외곽선 없음 = 추정 위치. 반투명 = STALE. 방위를 모르면 방향 없는 마름모. 비상 squawk 는 따로 표시."],
                ["선박", "색 = 선종(USCG AIS 코드표 분류). 선수방위 · 침로(점선 외곽) · 방향 모름(원). 선택한 선박은 흰 고리 + 이름. 점선 경계 = 운영 설정 수신 범위. 항적과 회색 점선 공백."],
                ["SIGMET", "색 = 위험 유형. 30분 안에 만료 = 점선, 발효 전 = 잔 점선 · 연한 채움(판정 안 함). 안에 항공기가 있으면 관측 알림."],
                ["공항", "색 = 비행 카테고리. 판정할 수 없으면 —. METAR 가 오래되면 회색 고리. 줌 7 이상에서 라벨에 카테고리 글자."],
                ["레이더", "dBZ 색 구간. 커버리지 밖 · 관측 범위 안 에코 없음 · 일부 합성 표시."],
                ["관측 수신 범위", `칸 진하기 = 최근 24 h 에 그 0.5° 칸에서 위치를 받은 선박 수 구간(${RECEPTION_BINS.map((b) => b.label).join(" · ")}척). 잰 값 — 구독 범위(점선)가 아님(레이어를 켰을 때만 보임).`],
                ["연안 교통량", `칸 색 = 척수 구간(${TRAFFIC_BINS.map((b) => b.label).join(" · ")}척 — 많을수록 밝은 주황), 0척은 회색. 5분 집계 · 개별 선박 위치 아님(레이어를 켰을 때만 보임).`],
                ["공통", "점선 테두리 = 추정 · 가정 값. — = 값 모름(채우지 않음)."],
              ]} />
            </Sec>
            <Sec id="dashboard-status" sub>
              <P>상태 바{ref("dashboard", 1)}는 한 줄입니다(가로로 스크롤되지 않습니다). 왼쪽부터 연결 → 경고 → 피드마다 칩 하나 → 오른쪽 끝 ‘상세’ 단추.
                칩은 이름 · 상태 모양 · 핵심 수 하나(lag = 서버가 보고한 피드 지연, age = 마지막 수집 뒤 경과)입니다. 상태는 색과 함께 모양으로도 말합니다 —
                {HEALTH_MARK.ok} 정상 · {HEALTH_MARK.warn} 주의 · {HEALTH_MARK.bad} 경고 · {HEALTH_MARK.unknown} 모름 — 정상이 아니면 STALE · 끊김 같은 낱말이 붙습니다.
                창이 좁아 다 들어가지 않으면 정상 · 모름 칩만 뒤에서부터 상세로 옮기고 단추에 ‘+N’ 을 적습니다(주의 · 경고 칩은 줄에서 빼지 않습니다).
                주의 · 경고 칩만으로도 폭이 모자라면(좁은 창에 경고가 많을 때) 잘라 내지 않고 둘째 줄로 넘어갑니다.
                아래 ‘모양’의 N 과 한글 낱말은 자리 표시입니다(실제 값이 들어갑니다). 시각은 KST 입니다.</P>
              <Table label="상태 바 항목" head={["항목", "모양", "뜻"]} rows={[
                ["연결", <span key="c" className="mono">WS open · WS paused · 탭 숨김 · WS connecting · retry N</span>, <>실시간 연결 상태. 열려 있어도 {RX_FRESH_MS / 1000} s 넘게 아무것도 받지 못하면 ‘수신 없음’, {RX_DEAD_MS / 1000} s 가 되면 다시 연결합니다. ‘paused · 탭 숨김’ 은 탭이 숨겨져 서버에 일시정지를 보낸 상태 — 그동안 화면 값은 멈추고, 탭이 보이면 처음 값부터 다시 받습니다.</>],
                ["경고", <span key="b" className="mono">FIXTURE MODE · 형식 오류 · AIS 공백 진행 중 N · AIS 공백 n/m 구역 진행 중 N</span>, "따로 붙는 경고(줄 앞쪽). 형식 오류 배지는 눌러서 무엇을 버렸는지 · 어떻게 다시 받는지 봅니다. AIS 공백은 진행 중인 길이를 셉니다 — 일부 구역만 공백이면 가장 이른 구역부터."],
                ["항공기 수", <span key="a" className="mono">aircraft N</span>, "지금 지도 영역 안의 항공기 수(STALE 포함). 레이어가 꺼져 있거나 아직 받지 않았으면 —."],
                ["지역 · 전세계", <span key="r" className="mono">region {HEALTH_MARK.ok} lag Ns · world {HEALTH_MARK.ok} lag Ns</span>, <>서버가 보고한 지연. 지역 {REGION_STALE_S} s · 전세계 {GLOBAL_STALE_S} s 를 넘으면 STALE, 자료가 없으면 NO DATA. 공급자 · 수집 시각은 상세.
                  수집기가 관심 지역에 쓸 공급자를 하나도 찾지 못하면 region 칩에 ‘공급자 없음’(경고) — 쉬는 공급자를 주기마다 다시 시도하는 동안에도(그 공급자가 답할 때까지). 건너뛴 공급자와 까닭 · 다시 시도하는 공급자 · 가장 먼저 풀리는 때(KST)는 마우스를 올리면.</>],
                ["AIS", <span key="s" className="mono">AIS {HEALTH_MARK.ok} lag Ns · AIS {HEALTH_MARK.bad} 끊김 · 끊김 n/m 구역</span>, <>선박 스트림 연결과 지연({AIS_LAG_WARN_S} s 를 넘으면 주의). 초당 메시지는 상세.</>],
                ["AIS 공백", <span key="p" className="mono">AIS 공백 N s · HH:MM KST 끝남</span>, <>끝난 공백은 길이와 끝난 시각 — 끝난 뒤 {AIS_GAP_SHOW_MS / 60_000}분까지 줄에(주의), 그 뒤로는 상세에만. 상세에서도 끝난 지 {AIS_GAP_SHOW_MS / 60_000}분이 지난 공백은 주의 표시 없이 기록으로만 보입니다. 1분이 안 되는 공백도 초로 적습니다.</>],
                ["SIGMET · 레이더", <span key="g" className="mono">sigmet {HEALTH_MARK.ok} age Ns · radar {HEALTH_MARK.ok} age Ns · KMA {HEALTH_MARK.ok} age Nm</span>, <>마지막 수집 뒤 경과. SIGMET {SIGMET_STALE_S} s · RainViewer {RADAR_STALE_S} s(서버 기준과 같음) · 기상청 {KR_RADAR_STALE_S / 60}분을 넘으면 STALE. 기상청은 최신 프레임이 일부 합성이면 ‘일부 합성’, 기상청 내려받기가 ‘파일 없음’으로 답하는 동안 ‘파일 없음’.</>],
                ["상세", <span key="d" className="mono">상세 +N ▾</span>, "눌러서(또는 Enter · Space) 표를 엽니다: 항목마다 상태 · 값 · 출처와 수집 시각 · 기준 — 공급자 · 초당 메시지 · 유효 SIGMET 수 · 레이더 프레임 수 · 기상청 최신 tm · 합성 N/M곳 · 엔진(폴리곤 수 · 주기) · 스냅샷 판 · 마지막 AIS 공백. Esc(초점이 상세 표나 단추에 있을 때 — 초점은 단추로 돌아옵니다) · 바깥 누르기 · 닫기로 닫고, 초점이 밖으로 나가면(예: / 로 검색) 닫힙니다(초점은 옮겨 간 곳에 그대로 — 검색의 Esc 는 검색만 닫습니다)."],
              ]} />
            </Sec>
          </Sec>

          {/* ---------------- 3 ---------------- */}
          <Sec id="replay">
            {fig("replay")}
            <UL>
              <li><B>기록</B> — 최근 {REPLAY_SUMMARY_MS / 86_400_000}일. {REPLAY_FULL_RES_MS / 3_600_000} h 안은 원해상도(받은 그대로), 그 이전은 관심 지역의 1분 요약(1분 평균 위치 · 방위 없음). 기록 사이를 보간하지 않습니다.</li>
              <li><B>시각 고르기</B> — KST 날짜 · 시각 입력{ref("replay", 2)}, 이동 단추({REPLAY_STEPS.map(([, l]) => l).join(" · ")}){ref("replay", 3)}, 슬라이더(눈금 = {REPLAY_FULL_RES_MS / 3_600_000} h 경계){ref("replay", 4)}. 재생은 배속을 골라 시각을 앞으로 보냅니다.</li>
              <li><B>지도</B> — 그 시각의 항공기 · SIGMET. 레이더는 RainViewer 가 보관하는 최근 2 h 안일 때만 나옵니다. 응답이 늦으면 지도 시각 옆에 ‘불러오는 중’{ref("replay", 5)}.</li>
              <li><B>목록</B>{ref("replay", 6)} — 그 시각의 SIGMET · 항공기 단추로 상세를 엽니다(지도를 누르지 않고 키보드로).</li>
              <li><B>넓은 화면</B> — 조회 면적 상한({n0(REPLAY_MAX_AREA_SQDEG)} sq°)을 넘으면 가운데 점선 상자만 조회하고 그렇다고 적습니다. 확대하면 전체.</li>
              <li><B>시각</B> — 입력과 표시는 모두 KST 입니다(서버에는 고른 순간을 그대로 보냅니다).</li>
            </UL>
          </Sec>

          {/* ---------------- 4 ---------------- */}
          <Sec id="stats">
            {fig("stats")}
            <UL>
              <li><B>집계 시각</B> — 매일 <span className="mono">{STATS_RUN_KST}</span> 에 전날(KST 날짜 — 00:00–24:00 KST)을 집계합니다. 오늘 날짜는 아직 없고, 기본 날짜는 어제(KST 날짜)입니다.</li>
              <li><B>SIGMET</B> — 최근 7일 FIR별(상위 24) · 위험 유형별 발표 건수.</li>
              <li><B>시간대별 고유 항공기</B> — 날짜는 KST 날짜이고 막대 이름은 그날의 KST 시(00시 → 23시)입니다. 자료가 없는 시간은 점선 —(수집 중단일 수 있어 0 대와 구분).</li>
              <li><B>알림</B> — 날짜 · 종류별 건수와 평균 체류. † 표시 행은 수정 전 기준으로 판정된 관측 알림이라 이후 날짜와 비교할 수 없습니다.</li>
              <li><B>비어 있을 때</B> — ‘집계 전’ · ‘집계됨(자료 없음)’ · ‘모름’을 구분해 적습니다. 이 문구는 응답을 받은 패널에만 적습니다.</li>
              <li><B>받는 중 · 받지 못함</B> — 패널마다 따로입니다. 받는 동안은 ‘{STATS_LOADING_TEXT}’(가는 진행 막대 — {BUSY_APPEAR_DELAY_MS / 1000} s 안에 끝나면 나타나지 않음),
                받지 못하면 그 패널만 ‘{STATS_FAILED_TEXT}’와 HTTP 상태 · 요청 id · <B>다시 시도</B>(그 패널만 다시 받음)를 보입니다 — 받는 중 · 실패를 ‘자료 없음’으로 적지 않습니다.</li>
            </UL>
          </Sec>

          {/* ---------------- 5 ---------------- */}
          <Sec id="airport">
            {fig("airport")}
            <UL>
              <li><B>여는 법</B> — 상황판 지도의 공항 원을 누르거나 airport 탭 목록에서 고르면 공항 카드가 열리고, 카드의 ‘이력’ 단추가 이 화면(<span className="mono">/airports/ICAO</span>, 예: <span className="mono">/airports/RKSI</span>)을 엽니다.</li>
              <li><B>METAR</B>{ref("airport", 1)} — 관측 시각과 경과, 원문. 원문은 발표된 그대로입니다(안의 “…Z” 시각은 발표 형식 — KST 보다 9시간 이릅니다).</li>
              <li><B>비행 카테고리</B>{ref("airport", 2)} — AWC 제공값을 먼저 쓰고, 없을 때만 실링 · 시정 규칙으로 계산해 ‘계산’이라고 적습니다. 실링이나 시정을 모르면 계산하지 않고 —(판정 불가).</li>
              <li><B>실링</B> — ‘실링 없음’(구름 자료 있음 · 실링층 없음)과 —(높이 모름 · 자료 없음)을 구분합니다. <B>시정</B>은 AWC 원문(법정마일, “6+” = 6 SM 이상).</li>
              <li><B>오래된 METAR</B> — 관측 후 {METAR_STALE_S / 3600}시간이 넘으면 ‘오래됨’ — 지도의 공항 원도 색을 빼고 회색 고리로 그립니다.</li>
            </UL>
          </Sec>

          {/* ---------------- 6 ---------------- */}
          <Sec id="ops">
            <P>운영(<span className="mono">/ops</span>) · 로그(<span className="mono">/logs</span>) 화면은 운영자 전용입니다. 로그인하지 않았으면 같은 자리에 로그인 폼이 나오고, 조회 API 도 로그인하지 않은 요청에는 없는 자원(404)으로 답합니다.</P>
            <Sec id="ops-login" sub>
              <UL>
                <li>계정은 서버에서 <span className="mono">make ops-user</span> 로만 만듭니다(비밀번호 12자 이상). 로그인 폼은 보내기 전에 아이디 필수 · 비밀번호 8자 이상을 확인합니다.</li>
                <li>세션은 8 h(HttpOnly · SameSite=Strict · CSRF 이중 제출). 만료되면 로그인 화면으로 돌아와 이유를 적습니다. 나갈 때는 ‘sign out’.</li>
                <li>로그인 시도가 많으면 잠시 제한되고, 기다릴 시간을 적습니다.</li>
              </UL>
            </Sec>
            <Sec id="ops-dashboard" sub>
              {fig("ops")}
              <Table label="운영 탭" head={["탭", "보는 것"]} rows={[
                ["providers", `공급자별 마지막 성공 · 지연 · 기록 수 · 연속 실패 · 사용량/한도 · 마지막 오류, 켜고 끄기(원본 DB 와 수집기가 따르는 Redis 미러 — 다르면 경고), 수집기 자동 전환 기록, 예산 창별 사용량(매일 09:00 KST 에 새로 시작하는 창 — KST 로 적음). 위쪽 작업 배지는 작업이 쓰는 공급자 — 쓸 공급자가 하나도 없으면 빨강 ‘region: 공급자 없음 · 시작 시각(KST) 부터’ — 다른 공급자가 없어 쉬는 공급자를 다시 시도하는 동안에도 빨강이고 ‘· adsb_fi 다시 시도 중’이 붙습니다(건너뛴 공급자와 까닭 · 가장 먼저 풀리는 때는 마우스를 올리면). 기상청 내려받기가 ‘파일 없음’으로 답하는 동안 kma_radar 행 아래에 주황 줄 — 없다는 답을 받은 첫 · 마지막 tm · 확인한 tm 수 · 마지막 확인(KST). 연속이 ${KR_MISSING_SLOW_AFTER_MIN}분을 넘으면 ‘${KR_MISSING_SLOW_EVERY_MIN}분마다 확인’. 마지막 확인이 서버 시각으로 확인 간격 × ${KR_MISSING_STALE_PROBES}(아래로 ${KR_MISSING_CHECK_STALE_MIN}분)을 넘으면 ‘확인 멈춤’.`],
                ["runs", "최근 24 h 작업별 요약과 최근 실행(상태 · HTTP · 소요 · 입력/격리 · 오류). 상태 missing(새 tm 이 있었으나 기상청이 ‘파일 없음’ — 저장한 프레임 없음) · quarantined(받았으나 해석할 수 없어 격리)는 주황 — 호출 실패는 아니지만 공급자의 마지막 성공을 갱신하지 않습니다. throttled(속도 상한 — http 429 면 공급자가 거절해 수집기가 그 호스트를 잠시 멈춤, 비었으면 수집기가 보내지 않음) · waiting(기상청 ‘파일 없음’ 연속이 길어 확인 간격을 늘린 사이 — 그 주기는 기상청을 부르지 않음)도 주황 — 공급자 오류가 아닙니다(뜻은 상태에 마우스를 올리면)."],
                ["quality", "규칙별 격리 건수(7일)와 최근 격리."],
                ["settings · audit · dlq", "운영 설정(판 번호로 충돌 확인), 운영 행동 감사 기록, 처리하지 못한 메시지."],
                ["pipeline", "파이프라인 손실 지표 — 0 이 아닌 손실 지표가 있으면 탭에 ● 수. AIS 수신 진단(keepalive 왕복 · 이벤트 루프 지연 · 멈춤 · WS 수신 버퍼 · 원문 대기 시간 · 깊이 · 짧은 재연결)도 여기 — 최근 창의 최댓값과 누적 수이고 손실 수가 아니라 색으로 판정하지 않습니다. 창 · 상한 · 시간 초과는 수집기가 고른 값을 응답에서 읽어 ‘수집기 설정’으로 적습니다."],
              ]} />
              <P>15 s 마다 모든 탭을 다시 받습니다(곧바로 받으려면 ‘새로고침’). 탭마다 마지막 성공 시각{ref("ops", 2)}을 따로 두고, 한 탭만 실패해도 그 탭에 ‘갱신 실패’와 이유가 붙습니다.
                공공데이터포털 공급자 셋(portmis — 항만 입출항 · komsa_traffic · mof_grid4 — 연안 교통량)도 여기서 상태를 보고 켜고 끕니다.</P>
              <h4 className="mt-4 mb-1 text-[12.5px] font-semibold">공급자 오류 해결 표시</h4>
              <UL>
                <li><B>해결 처리</B> — providers 탭 마지막 오류(last error) 칸의 단추. 그 공급자 오류를 ‘그 오류 시각(upto)까지 해결’로 적습니다. 확인 창이 먼저 범위와 결과를 말합니다:
                  “{RESOLVE_EFFECT.provider_error}”</li>
                <li><B>해결됨 · 되돌리기</B> — 해결된 오류는 흐리게 ‘해결됨 · 처리한 사람 · upto’와 ‘되돌리기’ 단추. “{RESOLVE_EFFECT.revoke}”</li>
                <li><B>재발</B> — upto 뒤에 새 오류가 나면 해결되지 않은 것으로 다시 보입니다(‘이전 해결 #id(upto …) 뒤 다시 남’). 오류 시각을 읽을 수 없으면 해결 처리를 막고, 재발이라고도 하지 않습니다.</li>
                <li><B>runs 탭</B> — 기본은 해결 처리한 오류 실행을 24 h 요약에서 빼고 뺀 수(‘해결 처리로 요약에서 뺀 오류 실행 N건’)를 적습니다. ‘해결된 오류 포함’ 단추로 빼지 않고 봅니다.
                  아래 실행 기록(Recent runs)은 가리지 않습니다.</li>
                <li><B>감사</B> — 해결 · 되돌리기는 audit 탭에 RESOLVE · UNRESOLVE 로 남습니다.</li>
                <li><B>해결 기록을 읽지 못할 때</B> — 가림이 조용히 바뀌지 않게 경고합니다: ‘{RESOLUTION_STATE_TEXT.stale}’ · ‘{RESOLUTION_STATE_TEXT.unavailable}’.</li>
              </UL>
            </Sec>
            <Sec id="ops-logs" sub>
              {fig("logs")}
              <UL>
                <li><B>무엇이 모이나</B> — api · collector · ais 의 WARN · ERROR(비밀값 가림)와 브라우저 오류(web-client — 브라우저가 보낸 내용이라 검증 안 됨 · untrusted 표시).</li>
                <li><B>필터</B>{ref("logs", 2)} — 서비스({LOG_SERVICES.join(" · ")}, 여러 개) · 수준({LOG_LEVELS.join(" · ")}) · 기간({Object.values(LOG_PERIOD_LABEL).join(" · ")}) · 글자 검색(Enter 로 적용) · 요청 id.</li>
                <li><B>보기</B>{ref("logs", 3)} — 목록(최신 순) / 묶음(같은 지문 fp 끼리, 건수 · 처음 · 마지막).</li>
                <li><B>상세</B> — 전체 메시지 · 예외 · 스택 · 같은 지문 묶음 통계 · 같은 요청 id 의 다른 항목. 화면의 오류 문구에 붙은 요청 id 로 여기서 같은 요청을 찾습니다.</li>
                <li><B>복사 · 내려받기</B> — 보이는 목록 복사, <span className="mono">.txt</span>(시각 KST), <span className="mono">.ndjson</span>(api 가 준 그대로 — ts 는 서버 형식 “…Z”).</li>
                <li><B>새 항목</B> — 15 s 마다 확인해 ‘새 항목 N건’ 단추를 띄웁니다. 누를 때만 목록이 바뀝니다(읽는 중에 줄이 밀리지 않게). ‘새로고침’은 지금 필터로 목록을 곧바로 다시 받습니다(AIS 수신 공백 탭에도 같은 단추).</li>
                <li><B>AIS 수신 공백</B> — 두 번째 탭. AIS 수신이 끊긴 구간의 기록.</li>
              </UL>
              <h4 className="mt-4 mb-1 text-[12.5px] font-semibold">해결 표시 — 지우지 않고 가린다</h4>
              <UL>
                <li><B>해결 처리</B> — 같은 지문(fp) 묶음을 ‘upto 까지 해결’로 적습니다: 묶음 보기의 ‘해결 처리’(upto = 그 묶음의 마지막 항목 시각) · ‘보이는 묶음 모두 해결 처리’(확인 창이
                  수와 뺀 것을 먼저 말함) · 항목 상세의 ‘해결 처리’(upto = 그 항목 시각). 메모는 선택(한 줄, {NOTE_MAX}자 이하). 확인 창의 말: “{RESOLVE_EFFECT.log_group}”</li>
                <li><B>숨긴 수</B>{ref("logs", 6)} — 기본 보기는 해결된 항목을 목록 · 묶음에서 빼고 ‘해결 처리로 숨김 N건’을 적습니다(로그 스트림의 항목은 그대로 — 지우지 않습니다).</li>
                <li><B>해결된 항목 보기</B>{ref("logs", 5)} — 켜면 해결된 항목도 흐리게 함께(해결됨 · 처리한 사람 · upto) 보이고, 그 줄 · 묶음 · 상세의 ‘되돌리기’로 해결을 되돌립니다.</li>
                <li><B>재발</B> — upto 뒤에 같은 지문의 항목이 새로 나면 해결되지 않은 것으로 다시 보입니다(묶음은 그 뒤 항목만 셉니다).</li>
                <li>해결 기록을 읽지 못하면 운영 화면과 같은 문구로 경고합니다.</li>
              </UL>
            </Sec>
          </Sec>

          {/* ---------------- 7 ---------------- */}
          <Sec id="time">
            <UL>
              <li>화면의 시각은 모두 <B>한국 표준시(KST)</B>입니다(계약 v5 §G20 — 모든 화면이 같은 형식기 하나를 씁니다). 시각에 마우스를 올리면 연도 · ms 까지의 같은 순간(KST)이 보입니다.</li>
              <li><B>모르는 시각</B>은 — 만 적습니다(KST 글자도 붙이지 않습니다).</li>
              <li><B>발표 원문</B>(METAR · TAF · SIGMET)은 글자 그대로 둡니다 — 안의 “…Z” 시각은 발표 형식이라 KST 보다 9시간 이릅니다(KST = …Z + 9시간). 원문에는 ‘{RAW_BULLETIN_LABEL}’ 이름표를 답니다.</li>
              <li><B>기상청 레이더 tm</B> 은 기상청이 KST 로 준 값 그대로입니다.</li>
              <li><B>통계 날짜 · 운영 화면의 격리 수 날짜</B>는 KST 날짜(00:00–24:00 KST)입니다 — 서버가 그 날짜로 셉니다. <B>공급자 예산</B>은 수집기가 매일 09:00 KST 에 새로 시작하는 창이라 그 창을 KST 로 적습니다(예산 날을 KST 날짜로 이름만 바꾸지 않습니다).</li>
              <li><B>선박 ETA</B> 는 선원이 입력한 월 · 일 · 시 · 분(연도 없음)을 KST 로 바꿔 적습니다. <B>항만 입출항 신고</B>의 00:00(KST)은 날짜만 적습니다(2.6).</li>
              <li>복사 · 내려받기 텍스트의 머리 줄은 ISO(+09:00)입니다. JSON 복사 · 내려받은 .ndjson 은 서버가 준 그대로라 ts 가 서버 형식(“…Z”)입니다.</li>
            </UL>
            <Table label="시각 표기 예" head={["자리", "모양", "설명"]} rows={[
              ["카드 · 문장", <KstTime key="i" v={EXAMPLE_AT} />, "날짜 · 초까지."],
              ["상태 바 · 지도 툴팁", <KstTime key="c" v={EXAMPLE_AT} date={false} seconds={false} />, "좁은 자리 — 분까지."],
              ["표 칸(머리글 “(KST)”)", <KstTime key="t" v={EXAMPLE_AT} variant="cell" />, "시간대는 머리글이 말합니다."],
              ["마우스를 올리면", <span key="h" className="mono whitespace-nowrap">{fmtTimeTitle(EXAMPLE_AT)}</span>, "연도 · ms 까지의 같은 순간."],
              [<span key="m">METAR 원문 <span className="mono" data-raw="bulletin">{metarToken ?? "—"}</span></span>, <KstTime key="m" v={METAR_AT} />, "원문 글자는 바꾸지 않습니다(일 · 시 · 분 + Z — 발표 형식) — 같은 순간을 KST 로 옆에 적습니다."],
              [<span key="k">기상청 tm <span className="mono">{KMA_TM}</span></span>, <KstTime key="k" v={kstWallMs(KMA_TM)} seconds={false} />, "기상청이 KST 로 준 값 그대로."],
              [<span key="d">통계 날짜 <span className="mono">{STATS_DAY}</span>(KST 날짜)</span>, <RangeText key="d" text={fmtKstRange(STATS_DAY_START, STATS_DAY_START + 86_400_000 - 60_000, { seconds: false })} />, "서버가 KST 날짜로 셉니다."],
              ["공급자 예산 창", <RangeText key="b" text={utcDayWindowKst(BUDGET_DAY) ?? "—"} />, "수집기 예산은 매일 09:00 KST 에 새로 시작 — 한 행 = 그 창(KST 날짜 하루가 아님)."],
              ["모르는 시각", <KstTime key="u" v={null} />, "— 만(시간대 글자 없음)."],
            ]} />
            <P>이 설명서의 스크린샷 캡처 시각도 같은 규칙입니다(예: <KstTime v={EXAMPLE_AT} year />).</P>
          </Sec>

          {/* ---------------- 8 ---------------- */}
          <Sec id="rules">
            <Table label="표시 규칙" head={["규칙", "모양", "뜻"]} rows={[
              ["모르는 값", <span key="u" className="mono">—</span>, "공급자가 주지 않았거나 읽을 수 없는 값. 0 이나 기본값으로 채우지 않고, — 뒤에 단위를 붙이지 않습니다(단위가 붙으면 잰 값처럼 읽힙니다)."],
              ["추정", <span key="e"><span className="badge est">추정</span> <span className="est-val mono">보라 점선 밑줄</span></span>, "관측이 아니라 계산으로 내다본 값 — 위치 추정(dead reckoning) · 10분 예측 궤적 · 예측 알림과 ETA · 진입 시 고도."],
              ["계산값", <span key="c" className="mono">… · 계산값</span>, "공급자가 주지 않아 정해진 규칙으로 계산한 값 — 노선 경로와의 거리, AWC 값이 없을 때의 비행 카테고리(‘계산’)."],
              ["보고값", <span key="r" className="mono">보고값</span>, "보낸 쪽이 입력한 그대로 — 선박 이름 · 크기 · 흘수 · 목적지 · ETA(선원 입력), 기종 · 등록번호(공급자 값 — 추정하지 않음)."],
              ["오래된 값", <span key="s"><span className="badge warn">STALE</span> <span className="badge warn">오래됨</span></span>, "새 값이 들어오지 않는 동안 마지막 값을 남기되 그렇다고 표시합니다. 공급자가 모두 실패하면 마지막 스냅샷을 STALE 로 유지합니다."],
              ["원문", <span key="o" className="mono">({RAW_BULLETIN_LABEL})</span>, "발표된 글자 그대로 — 화면 시각(KST)으로 바꾸지 않습니다(안의 “…Z” 시각은 KST 보다 9시간 이릅니다)."],
              ["서버 보고 상태", <span key="d" className="badge normal-case!">집중 추적 · N s</span>, "칩의 상태 · 주기는 서버가 보고한 값만. 연결이 실시간이 아니면 ‘모름’이라고 적습니다."],
              ["판정 제외", <span key="x" className="mono">제외 (사유)</span>, "판정할 수 없는 자료(폴리곤을 만들 수 없는 SIGMET 등)는 빼고 사유를 적습니다."],
            ]} />
            <Note>값이 없거나 틀릴 수 있을 때 화면은 그 사실을 숨기지 않습니다 — 빈칸 대신 —, 관측 대신 추정이면 보라 점선, 오래되면 STALE. 모양이 다르면 뜻이 다릅니다.</Note>
          </Sec>

          {/* ---------------- 9 ---------------- */}
          <Sec id="shortcuts">
            <Table label="키보드 단축키" head={["키", "어디서", "하는 일"]} rows={SHORTCUTS.map((s) => [
              <span key="k" className="flex flex-wrap gap-1">{s.keys.map((k) => <Kbd key={k}>{k}</Kbd>)}</span>, s.where, s.action,
            ])} />
            <P>마우스 없이도 쓸 수 있게 목록(알림 · SIGMET · 공항 · 선박 · 재생 항목)은 모두 단추로 고를 수 있습니다 — 지도를 누르지 않아도 됩니다.</P>
          </Sec>
          {/* 마지막 절도 목차의 '지금 읽는 절'이 될 수 있게(위쪽 띠까지 올라오도록) 끝에 여백 */}
          <footer className="mt-12 flex min-h-[45vh] items-start justify-between gap-3 border-t border-line pt-3 text-[11px] text-fg-3">
            <span>설명서 끝</span>
            <Link href="/about" prefetch={false} className="text-fg-2 underline underline-offset-2 hover:text-fg">출처·한계 — 출처 · 라이선스 · 한계 전체</Link>
          </footer>
        </article>
      </div>
    </div>
  );
}
