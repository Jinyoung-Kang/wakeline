import Link from "next/link";
import { creditGroups } from "@/lib/attribution";
import { KR_RADAR_STALE_S, METAR_STALE_S } from "@/lib/format";
import {
  dualTime, flattenToc, GUIDE_TOC, kstClockToUtc, metarTimeToken, PLAN, SHORTCUTS, shotView, tocItem, type GuideManifest,
} from "@/lib/guide";
import { EXTRAPOLATE_CAP_OPENSKY_S, EXTRAPOLATE_CAP_S, STALE_AFTER_OPENSKY_S, STALE_AFTER_S } from "@/lib/interpolate";
import { KR_REF_MIN_SUPPORT, KR_REF_WINDOW_MIN } from "@/lib/kr-radar";
import { LOG_LEVELS, LOG_PERIOD_LABEL, LOG_SERVICES } from "@/lib/logs";
import { LEGEND_OPEN_MIN_WIDTH } from "@/lib/prefs";
import { REPLAY_FULL_RES_MS, REPLAY_MAX_AREA_SQDEG, REPLAY_STEPS, REPLAY_SUMMARY_MS } from "@/lib/replay";
import { ROUTE_CAVEAT, ROUTE_STATUS_TEXT, ROUTE_TITLE } from "@/lib/route";
import {
  SHIP_STALE_S, SHIP_TRACK_HOURS, SHIPS_OUT_OF_COVERAGE_TEXT, SHIPS_RULE_TEXT, SHIPS_ZERO_AIS_DOWN_TEXT, SHIPS_ZERO_TEXT,
} from "@/lib/ships";
import { STATS_RUN_KST } from "@/lib/stats";
import { GLOBAL_STALE_S, REGION_STALE_S, RX_DEAD_MS, RX_FRESH_MS } from "@/lib/ws-protocol";
import { DualTime, GuideFigure } from "./GuideFigure";
import { GuideToc } from "./GuideToc";

/*
 * 설명서(/guide) 본문 — 서버 컴포넌트(정적 내용, 데이터 요청 없음). 클라이언트 코드는 목차(GuideToc)뿐.
 * 숫자 · 문구는 가능한 한 화면 코드가 쓰는 상수를 그대로 가져온다(lib/*) — 동작이 바뀌면 설명도 같이 바뀐다.
 * 출처 목록은 하단 출처 줄과 같은 lib/attribution 에서. 시각 예는 한 순간(EXAMPLE_AT)에서 계산한다(KST 기본 + UTC 병기).
 */

/** 시각 예의 기준 순간 — 2026-09-29 14:22:11 KST */
const EXAMPLE_AT = "2026-09-29T05:22:11Z";
const n0 = (n: number) => n.toLocaleString("en-US");

function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="mono inline-block min-w-[1.6em] border border-line-2 bg-bg-2 px-1 text-center text-[11px] leading-[1.5] text-fg">{children}</kbd>;
}

function Note({ tone = "info", children }: { tone?: "info" | "warn"; children: React.ReactNode }) {
  return <div className={`my-3 border-l-2 bg-bg-1 px-3 py-2 text-[12px] ${tone === "warn" ? "border-warn text-fg" : "border-accent text-fg-2"}`}>{children}</div>;
}

/** 절: id · 번호 · 제목은 목차(lib/guide GUIDE_TOC)에서만 — 목차와 본문 제목이 어긋날 수 없다 */
function Sec({ id, sub = false, children }: { id: string; sub?: boolean; children: React.ReactNode }) {
  const t = tocItem(id);
  const H = sub ? "h3" : "h2";
  return (
    <section id={id} data-guide-section={id} aria-labelledby={`${id}-h`} className={`scroll-mt-14 min-[900px]:scroll-mt-4 ${sub ? "mt-8" : "mt-12 border-t border-line pt-6 first:mt-0 first:border-t-0 first:pt-0"}`}>
      <H id={`${id}-h`} tabIndex={-1} className={`flex items-baseline gap-3 outline-none ${sub ? "mb-2 text-[14px] font-semibold" : "mb-3 text-[18px] font-semibold tracking-tight"}`}>
        <span className={`mono ${sub ? "text-[12px]" : "text-[13px]"} text-accent`}>{t.n}</span><span>{t.title}</span>
      </H>
      {children}
    </section>
  );
}

/** 표(머리글 · 줄) — 설명서의 표는 모두 이 모양 */
function Table({ head, rows, label }: { head: string[]; rows: React.ReactNode[][]; label: string }) {
  return (
    <div className="my-3 overflow-x-auto border border-line">
      <table aria-label={label} className="min-w-[560px]">
        <thead className="bg-bg-1"><tr>{head.map((h) => <th key={h} scope="col">{h}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} className={j === 0 ? "whitespace-nowrap text-fg" : "text-fg-2"}>{c}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

const P = ({ children }: { children: React.ReactNode }) => <p className="my-2 max-w-[860px] text-fg-2">{children}</p>;
const UL = ({ children }: { children: React.ReactNode }) => <ul className="my-2 max-w-[860px] list-disc space-y-1 pl-5 text-fg-2 marker:text-fg-3">{children}</ul>;
const B = ({ children }: { children: React.ReactNode }) => <b className="font-semibold text-fg">{children}</b>;

export function GuideView({ manifest, dropped }: { manifest: GuideManifest; dropped: readonly string[] }) {
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
  const ex = dualTime(EXAMPLE_AT)!;
  const exNight = dualTime("2026-09-29T20:30:00Z")!;
  const exMetar = dualTime("2026-09-29T05:00:00Z")!;
  const metarToken = metarTimeToken("2026-09-29T05:00:00Z")!;
  const exTm = dualTime("2026-09-29T05:20:00Z")!;
  const tm = exTm.kst.replace(/\D/g, "").slice(0, 12);
  const dayFrom = dualTime("2026-09-28T00:00:00Z")!;
  const dayTo = dualTime("2026-09-28T23:59:00Z")!;
  const statsUtc = kstClockToUtc(STATS_RUN_KST);
  return (
    <div className="h-full overflow-y-auto" data-testid="guide" data-guide-scroll="">
      <div className="mx-auto grid max-w-[1320px] grid-cols-1 gap-x-8 px-4 pb-16 min-[900px]:grid-cols-[236px_minmax(0,1fr)] min-[900px]:px-6">
        <GuideToc items={GUIDE_TOC} />
        {/* 글줄은 읽기 좋은 폭(860 px)까지, 그림 · 표는 더 넓게 — 스크린샷의 작은 글자가 덜 줄어들게 */}
        <article className="min-w-0 max-w-[1120px] pt-4 text-[13px] leading-relaxed">
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
              <span>시각 표기: KST 기본 · UTC 병기(7장)</span>
            </div>
          </header>

          {dropped.length ? (
            <div role="alert" className="mb-6 border border-warn/60 bg-bg-1 px-3 py-2 text-[12px] text-warn">
              스크린샷 결과(lib/guide-manifest.json)에서 형식이 틀린 항목을 버렸습니다 — 해당 그림은 자리표시로 보입니다:
              <ul className="mono mt-1 list-disc pl-5 text-[11px]">{dropped.map((d) => <li key={d}>{d}</li>)}</ul>
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
                  육상 수신국 기반이라 수신국이 없는 해역은 비어 있을 수 있습니다.</>],
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
                <li><B>레이어 단추</B>{ref("dashboard", 5)} — 레이더 · SIGMET · 항공기 · 선박 · 공항 · 항적 · 예측(추정). 켜진 단추는 파란 테두리입니다. 선박은 처음에 꺼져 있습니다.</li>
                <li><B>선종 필터</B> — 선박을 켜면 <span className="mono">선종 필터 N/M</span> 단추가 생깁니다. 누르면 범례가 펼쳐지고, 범례의 선종 항목을 눌러 켜고 끕니다(‘모두 켜기’). 일부만 켜면 단추가 주황색이고, 지도 칩과 선박 목록이 걸러진 수를 따로 적습니다.</li>
                <li><B>저장</B> — 레이어 · 범례 열림 · 선종 필터는 이 브라우저에만 저장됩니다(다른 기기 · 브라우저와 공유되지 않음). 범례는 폭 {n0(LEGEND_OPEN_MIN_WIDTH)} px 이상 화면에서 처음부터 펼쳐집니다.</li>
              </UL>
            </Sec>
            <Sec id="dashboard-search" sub>
              {fig("search")}
              <UL>
                <li><B>항공기</B> — 호출부호 · hex · 등록번호 앞부분(영문 · 숫자 2–10자). <B>선박</B> — 선명 · 호출부호 앞부분, MMSI, IMO(2–40자, 영문 · 숫자 · 공백 . - /).</li>
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
                <li><B>{ROUTE_TITLE}</B> — {ROUTE_CAVEAT}. 판단 근거로 마지막 관측 위치와 노선 대권 경로 사이 거리를 <B>계산값</B>으로 함께 보입니다. 상태는 그대로 적습니다: {Object.values(ROUTE_STATUS_TEXT).map((s, i) => <span key={s}>{i ? " · " : ""}‘{s}’</span>)}.</li>
                <li><B>집중 추적</B> — 항공기를 고르면 서버 수집기가 그 항공기만 따로 조회합니다{ref("aircraft", 2)}. 고르지 않고 확대하면 화면 중심 주변을 따로 조회합니다(핫 리전). 칩에는 서버가 보고한 상태 · 주기만 쓰고, 호출 상한 때문에 늦어지면 그렇다고 적습니다. 창을 닫으면 최대 60초 안에 멈추고, 한 세션의 연속 집중 추적은 30분까지입니다.</li>
                <li><B>항적 · 예측</B> — 항적은 DB 기록(최근 2 h)에 실시간 관측을 이은 선, 점선 궤적은 서버가 예측할 수 있다고 판단할 때만 그리는 10분 추정입니다. 예측하지 않으면 카드에 이유(선회 중 · 저속 · 지상 · 속도/방위 없음 · 수신 지연)를 적습니다.</li>
              </UL>
            </Sec>
            <Sec id="dashboard-ship" sub>
              {fig("ship")}
              <UL>
                <li><B>고르기</B> — 지도의 선박 기호, ship 탭의 ‘화면 안 선박’ 표(머리글 정렬 · 이름/MMSI 거르기){ref("ship", 1)}, 통합 검색.</li>
                <li><B>보고값</B> — 이름 · 크기 · 흘수 · 목적지 · ETA 는 선원이 입력한 값 그대로입니다(ETA 는 연도 없음). AIS 에는 출발지 항목이 없고, 목적지 문자열은 정해진 규칙(“A&gt;B” · “&gt;B” · “A&lt;&gt;B”)으로만 풀며 UN/LOCODE 항구 코드 모양일 때만 이름 · 국가를 붙입니다.</li>
                <li><B>항적</B> — 기간 {SHIP_TRACK_HOURS.join(" / ")} h 단추{ref("ship", 3)}. 기록(60 s 에 1점) + 실시간 관측. 수신이 끊긴 구간은 되살릴 수 없어 <B>회색 점선(공백)</B>으로 남기고, 공백 횟수 · 합계를 카드에 적습니다.</li>
                <li><B>기호</B> — 선수방위 방향으로 회전, 선수방위가 없으면 침로 기준(점선 외곽), 둘 다 없으면 방향 없는 원. ‘추측항법 · 수동 입력’으로 보고된 위치는 배지로 구분합니다.</li>
                <li><B>개별 · 격자</B> — {SHIPS_RULE_TEXT}. 격자 원의 크기 = 선박 수, 색 = 가장 많은 선종.</li>
                <li><B>선박이 안 보일 때</B> — 지도 칩{ref("ship", 4)}이 이유를 적습니다. 예: ‘{SHIPS_ZERO_TEXT}’ · ‘{SHIPS_OUT_OF_COVERAGE_TEXT}’ · ‘{SHIPS_ZERO_AIS_DOWN_TEXT}’.</li>
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
                <li>기상청 프레임이 {KR_RADAR_STALE_S / 60}분 넘게 새로 오지 않으면 상태 바에 <span className="badge bad">KMA STALE</span>.</li>
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
                ["공통", "점선 테두리 = 추정 · 가정 값. — = 값 모름(채우지 않음)."],
              ]} />
            </Sec>
            <Sec id="dashboard-status" sub>
              <P>상태 바{ref("dashboard", 1)}는 가로로 스크롤될 수 있습니다. 경고 배지는 앞쪽에 옵니다. 아래 ‘모양’의 N 과 한글 낱말은 자리 표시입니다(실제 값이 들어갑니다).</P>
              <Table label="상태 바 항목" head={["항목", "모양", "뜻"]} rows={[
                ["연결", <span key="c" className="mono">WS open · WS connecting · retry N</span>, <>실시간 연결 상태. 열려 있어도 {RX_FRESH_MS / 1000} s 넘게 아무것도 받지 못하면 ‘수신 없음’, {RX_DEAD_MS / 1000} s 가 되면 다시 연결합니다.</>],
                ["항공기 수", <span key="a" className="mono">aircraft N</span>, "지금 지도 영역 안의 항공기 수(STALE 포함). 레이어가 꺼져 있거나 아직 받지 않았으면 —."],
                ["지역 피드", <span key="r" className="mono">region 공급자 · 수집 시각 · lag Ns</span>, <>공급자 · 수집 시각 · 서버가 보고한 지연. {REGION_STALE_S} s 를 넘으면 STALE, 자료가 없으면 NO DATA.</>],
                ["전세계 피드", <span key="w" className="mono">world 공급자 · lag Ns</span>, <>전세계 스냅샷. {GLOBAL_STALE_S} s 를 넘으면 STALE.</>],
                ["AIS", <span key="s" className="mono">AIS …</span>, "선박 스트림 연결 · 초당 메시지 · 지연. 구역이 여럿이면 일부만 끊겨도 ‘AIS 공백 n/m 구역’으로 따로 알립니다."],
                ["SIGMET", <span key="g" className="mono">sigmet 공급자 · N active · 경과</span>, "유효 SIGMET 수와 마지막 수집 뒤 경과."],
                ["레이더", <span key="d" className="mono">radar N frames · 경과 · KMA Nf 최신 tm · 합성 N/M곳</span>, "RainViewer 프레임 수와 경과, 기상청 프레임 수 · 최신 tm · 합성 크기."],
                ["엔진", <span key="e" className="mono">engine N polys · cycle N ms</span>, "판정 엔진이 보는 SIGMET 폴리곤 수와 마지막 주기 시간."],
                ["판", <span key="v" className="mono">vN</span>, "받은 스냅샷의 판 번호."],
                ["경고 배지", <span key="b" className="mono">KMA STALE · KMA 일부 합성 · FIXTURE MODE · 형식 오류</span>, "따로 붙는 경고. 형식 오류 배지는 눌러서 무엇을 버렸는지 · 어떻게 다시 받는지 봅니다."],
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
              <li><B>시각</B> — 입력과 표시는 KST 이고, 서버에는 같은 순간을 UTC 로 보냅니다.</li>
            </UL>
          </Sec>

          {/* ---------------- 4 ---------------- */}
          <Sec id="stats">
            {fig("stats")}
            <UL>
              <li><B>집계 시각</B> — 매일 {STATS_RUN_KST} ({statsUtc}) 에 전날(UTC 날짜)을 집계합니다. 오늘 날짜는 아직 없고, 기본 날짜는 어제(UTC 날짜)입니다.</li>
              <li><B>SIGMET</B> — 최근 7일 FIR별(상위 24) · 위험 유형별 발표 건수.</li>
              <li><B>시간대별 고유 항공기</B> — 날짜는 UTC 날짜(09:00 KST = 00:00 UTC 에 바뀜)이고, 막대 이름은 KST 시각이라 09시부터 다음 날 08시 순서입니다. 자료가 없는 시간은 점선 —(수집 중단일 수 있어 0 대와 구분).</li>
              <li><B>알림</B> — 날짜 · 종류별 건수와 평균 체류. † 표시 행은 수정 전 기준으로 판정된 관측 알림이라 이후 날짜와 비교할 수 없습니다.</li>
              <li><B>비어 있을 때</B> — ‘집계 전’ · ‘집계됨(자료 없음)’ · ‘모름’을 구분해 적습니다.</li>
            </UL>
          </Sec>

          {/* ---------------- 5 ---------------- */}
          <Sec id="airport">
            {fig("airport")}
            <UL>
              <li><B>여는 법</B> — 상황판 지도의 공항 원을 누르거나 airport 탭 목록에서 고르면 공항 카드가 열리고, 카드의 ‘이력’ 단추가 이 화면(<span className="mono">/airports/ICAO</span>, 예: <span className="mono">/airports/RKSI</span>)을 엽니다.</li>
              <li><B>METAR</B>{ref("airport", 1)} — 관측 시각과 경과, 원문. 원문은 발표된 그대로이고 안의 “…Z” 는 UTC 입니다.</li>
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
                ["providers", "공급자별 마지막 성공 · 지연 · 기록 수 · 연속 실패 · 사용량/한도 · 마지막 오류, 켜고 끄기(원본 DB 와 수집기가 따르는 Redis 미러 — 다르면 경고), 수집기 자동 전환 기록, 일별 사용량(UTC 날짜)."],
                ["runs", "최근 24 h 작업별 요약과 최근 실행(상태 · HTTP · 소요 · 입력/격리 · 오류)."],
                ["quality", "규칙별 격리 건수(7일)와 최근 격리."],
                ["settings · audit · dlq", "운영 설정(판 번호로 충돌 확인), 운영 행동 감사 기록, 처리하지 못한 메시지."],
                ["pipeline", "파이프라인 손실 지표 — 0 이 아닌 지표가 있으면 탭에 ● 수."],
              ]} />
              <P>15 s 마다 모든 탭을 다시 받습니다. 탭마다 마지막 성공 시각{ref("ops", 2)}을 따로 두고, 한 탭만 실패해도 그 탭에 ‘갱신 실패’와 이유가 붙습니다.</P>
            </Sec>
            <Sec id="ops-logs" sub>
              {fig("logs")}
              <UL>
                <li><B>무엇이 모이나</B> — api · collector · ais 의 WARN · ERROR(비밀값 가림)와 브라우저 오류(web-client — 브라우저가 보낸 내용이라 검증 안 됨 · untrusted 표시).</li>
                <li><B>필터</B>{ref("logs", 2)} — 서비스({LOG_SERVICES.join(" · ")}, 여러 개) · 수준({LOG_LEVELS.join(" · ")}) · 기간({Object.values(LOG_PERIOD_LABEL).join(" · ")}) · 글자 검색(Enter 로 적용) · 요청 id.</li>
                <li><B>보기</B>{ref("logs", 3)} — 목록(최신 순) / 묶음(같은 지문 fp 끼리, 건수 · 처음 · 마지막).</li>
                <li><B>상세</B> — 전체 메시지 · 예외 · 스택 · 같은 지문 묶음 통계 · 같은 요청 id 의 다른 항목. 화면의 오류 문구에 붙은 요청 id 로 여기서 같은 요청을 찾습니다.</li>
                <li><B>복사 · 내려받기</B> — 보이는 목록 복사, <span className="mono">.txt</span>(시각 KST), <span className="mono">.ndjson</span>(api 가 준 그대로 — ts 는 UTC).</li>
                <li><B>새 항목</B> — 15 s 마다 확인해 ‘새 항목 N건’ 단추를 띄웁니다. 누를 때만 목록이 바뀝니다(읽는 중에 줄이 밀리지 않게).</li>
                <li><B>AIS 수신 공백</B> — 두 번째 탭. AIS 수신이 끊긴 구간의 기록.</li>
              </UL>
            </Sec>
          </Sec>

          {/* ---------------- 7 ---------------- */}
          <Sec id="time">
            <UL>
              <li>화면의 시각은 <B>한국 표준시(KST, UTC+9)가 기본</B>이고 <B>UTC 를 함께</B> 적습니다.</li>
              <li><B>발표 원문</B>(METAR · TAF · SIGMET)은 글자 그대로 둡니다 — 안의 “…Z” 는 UTC 입니다.</li>
              <li><B>기상청 레이더 tm</B> 은 기상청이 KST 로 준 값 그대로입니다(원본이 KST).</li>
              <li><B>통계 날짜 · 운영 화면의 일 단위 집계</B>는 UTC 날짜입니다 — 09:00 KST(00:00 UTC)에 날짜가 바뀝니다.</li>
              <li><B>선박 ETA</B> 는 선원이 UTC 로 입력한 값(연도 없음)이라 KST 로 바꿔 입력값과 함께 적습니다.</li>
              <li><B>서버 · API</B> 는 UTC 로 주고받습니다(내려받은 .ndjson 의 ts 도 UTC).</li>
            </UL>
            <Table label="시각 표기 예" head={["경우", "KST", "UTC", "설명"]} rows={[
              ["같은 순간", <span key="k" className="mono">{ex.kst}</span>, <span key="u" className="mono">{ex.utc}</span>, "9시간 차이 — 같은 순간입니다."],
              ["자정 전후", <span key="k" className="mono">{exNight.kst}</span>, <span key="u" className="mono">{exNight.utc}</span>, "KST 로는 다음 날 — 날짜까지 함께 봅니다."],
              [<span key="m">METAR 원문 <span className="mono">{metarToken}</span></span>, <span key="k" className="mono">{exMetar.kst}</span>, <span key="u" className="mono">{exMetar.utc}</span>, `원문 글자는 바꾸지 않습니다 — ${metarToken} = ${Number(exMetar.utc.slice(8, 10))}일 ${exMetar.utc.slice(11, 16)} UTC.`],
              [<span key="t">기상청 tm <span className="mono">{tm}</span></span>, <span key="k" className="mono">{exTm.kst.slice(0, 16)}</span>, <span key="u" className="mono">{exTm.utc.slice(0, 16)}</span>, "원본이 KST — 그대로 적습니다."],
              [<span key="d">통계 날짜 <span className="mono">{dayFrom.utc.slice(0, 10)}</span>(UTC 날짜)</span>, <span key="k" className="mono">{dayFrom.kst.slice(5, 16)} – {dayTo.kst.slice(5, 16)}</span>, <span key="u" className="mono">{dayFrom.utc.slice(5, 16)} – {dayTo.utc.slice(5, 16)}</span>, "집계 단위는 UTC 날짜 — KST 날짜로 옮기지 않습니다."],
            ]} />
            <P>이 설명서의 스크린샷 캡처 시각도 같은 규칙입니다(예: <DualTime v={EXAMPLE_AT} />).</P>
          </Sec>

          {/* ---------------- 8 ---------------- */}
          <Sec id="rules">
            <Table label="표시 규칙" head={["규칙", "모양", "뜻"]} rows={[
              ["모르는 값", <span key="u" className="mono">—</span>, "공급자가 주지 않았거나 읽을 수 없는 값. 0 이나 기본값으로 채우지 않고, — 뒤에 단위를 붙이지 않습니다(단위가 붙으면 잰 값처럼 읽힙니다)."],
              ["추정", <span key="e"><span className="badge est">추정</span> <span className="est-val mono">보라 점선 밑줄</span></span>, "관측이 아니라 계산으로 내다본 값 — 위치 추정(dead reckoning) · 10분 예측 궤적 · 예측 알림과 ETA · 진입 시 고도."],
              ["계산값", <span key="c" className="mono">… · 계산값</span>, "공급자가 주지 않아 정해진 규칙으로 계산한 값 — 노선 경로와의 거리, AWC 값이 없을 때의 비행 카테고리(‘계산’)."],
              ["보고값", <span key="r" className="mono">보고값</span>, "보낸 쪽이 입력한 그대로 — 선박 이름 · 크기 · 흘수 · 목적지 · ETA(선원 입력), 기종 · 등록번호(공급자 값 — 추정하지 않음)."],
              ["오래된 값", <span key="s"><span className="badge warn">STALE</span> <span className="badge warn">오래됨</span></span>, "새 값이 들어오지 않는 동안 마지막 값을 남기되 그렇다고 표시합니다. 공급자가 모두 실패하면 마지막 스냅샷을 STALE 로 유지합니다."],
              ["원문", <span key="o" className="mono">(원문 · UTC)</span>, "발표된 글자 그대로 — 화면 시각(KST)으로 바꾸지 않습니다."],
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
