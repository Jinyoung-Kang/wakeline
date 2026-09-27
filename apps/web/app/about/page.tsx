export default function AboutPage() {
  const rows: [string, string, string][] = [
    ["항공기 (1순위)", "adsb.lol — readsb v2 API", "ODbL 1.0 · 출처 표기 · 429 시 백오프 후 adsb.fi 폴백"],
    ["항공기 (2순위)", "adsb.fi opendata", "개인·비상업 · 초당 1회(토큰 버킷) · 출처 표기"],
    ["항공기 (전세계)", "OpenSky Network (OAuth2)", "연구·비상업 · 하루 4,000 크레딧 · 계정 없으면 비활성"],
    ["항공기 (정밀 추적)", "adsb.fi opendata — hex 묶음 조회 · 반경 조회", "사람이 보는 곳만: 선택 항공기(집중 추적)·확대한 화면(핫 리전) · 수집기 전체 호출 상한 안에서 · 화면에는 서버가 보고한 주기·상태만"],
    ["선박 (AIS)", "aisstream.io — WebSocket 스트림", "API 키는 서버 ais 수집기에만 · 재전송 없음 → 끊긴 구간은 공백으로 기록·표시 · 구독 영역은 운영 설정"],
    ["SIGMET · METAR · TAF", "AviationWeather.gov Data API", "미국 정부 공개 데이터 · 분당 20회 자체 상한 · 커스텀 UA"],
    ["레이더 타일", "RainViewer", "개인·교육 전용 · 과거 2 h · 줌 ≤ 7 · 링크 출처"],
    ["한국 레이더 합성", "기상청 API허브 (HSR 500 m · 5분)", "본인 사용 · 활용신청 · LCC(30/60, N38 E126) 정의는 기상기후데이터위키 · 서버 재투영"],
    ["배경지도", "OpenFreeMap + MapLibre GL JS", "OpenMapTiles · OpenStreetMap contributors · BSD-3"],
  ];
  return (
    <div className="h-full overflow-y-auto p-4 text-[12px]">
      <h1 className="label mb-2">Data sources · licenses</h1>
      <table className="mb-4"><thead><tr><th scope="col">역할</th><th scope="col">서비스</th><th scope="col">조건</th></tr></thead><tbody>{rows.map((r) => <tr key={r[0]}><td>{r[0]}</td><td>{r[1]}</td><td>{r[2]}</td></tr>)}</tbody></table>
      <h2 className="label mb-2">한계 · 정직성 규칙</h2>
      <ul className="list-disc space-y-1 pl-5 text-fg-2">
        <li>지도의 항공기 위치는 갱신(10 s) 사이 브라우저가 dead reckoning 으로 <b>추정</b>한 것이며, 아이콘 외곽선(관측 = 흰 외곽선, 추정 = 없음)과 카드의 “추정” 배지로 관측값과 구분합니다. 외삽은 최대 60 s(OpenSky 180 s)까지만 하고 그 뒤에는 그 자리에 멈춥니다. 수신이 60 s(OpenSky 300 s) 넘게 끊기면 반투명(STALE)으로 남기며, 브라우저가 경과 시간만으로 지우지는 않습니다 — 공급자가 더 이상 보고하지 않을 때만 서버가 뺍니다.</li>
        <li>진입 예측(PREDICTED)은 현재 속도·방위의 10분 직선 외삽입니다. 선회 중(최근 트랙 변화 15° 초과)이거나 60 kt 미만이면 예측하지 않습니다. 관측 알림과 유형을 분리하고 항상 “추정”으로 표시합니다.</li>
        <li>폴리곤을 만들 수 없는 SIGMET(라인형 서술, 좌표 결측)은 목록에 원문으로 남기되 판정에서 제외하고, 제외 사유를 표시합니다.</li>
        <li>값이 없으면 “—”로 둡니다. 기종·등록번호는 공급자 값이며 추정하지 않습니다. 비행 카테고리는 AWC 제공값을 우선하고, 없을 때만 실링·시정 규칙으로 계산해 “계산”으로 표시합니다. 실링이나 시정을 모르면 계산하지 않고 “—”(판정 불가)로 둡니다.</li>
        <li>모든 값에 출처(provider)와 수집 시각(fetched_at)이 붙고, 지연이 60 s(지역)·300 s(전세계)를 넘으면 상단 배지가 STALE 로 바뀝니다. 공급자가 전부 실패하면 마지막 스냅샷을 STALE 로 유지합니다.</li>
        <li>레이더: RainViewer 는 커버리지 밖을 회색으로 가려 “에코 없음(투명)”과 구분합니다. 기상청 합성은 관측 범위 안을 연한 회색, 밖을 투명으로 둡니다. 재생 화면의 레이더는 RainViewer 가 보관하는 최근 2 h 안에서만 나옵니다.</li>
        <li>공항 비행 카테고리는 5분마다 다시 받아 그리며, METAR 가 2 시간보다 오래되면 색을 빼고 회색 고리 + “오래됨”으로 표시합니다. 실링은 “실링 없음”(구름 자료 있음·실링층 없음)과 “—”(높이 모름·자료 없음)을 구분합니다.</li>
        <li>한반도 상공 커버리지는 자원봉사 수신기망에 의존합니다. 수신기가 없는 해역·저고도는 비어 있을 수 있습니다.</li>
        <li>정밀 추적: 항공기를 선택하면 서버 수집기가 그 항공기만 따로 조회하고(집중 추적), 선택 없이 확대하면 화면 중심 주변을 따로 조회합니다(핫 리전). 칩에는 서버가 보고한 상태·주기만 쓰고, 호출 상한 때문에 늦어지면 그렇다고 표시합니다. 창을 닫으면 최대 60초 안에 멈추며, 한 세션의 연속 집중 추적은 30분까지입니다.</li>
        <li>선박(AIS): 위치는 받은 그대로(보간 없음)이고 15분 넘게 새 위치가 없으면 반투명(STALE)입니다. 아이콘은 선수방위, 없으면 침로(점선 외곽 · “침로 기준”), 둘 다 없으면 방향 없는 원입니다. 선박이 “추측항법·수동 입력”으로 보고한 위치는 배지로 구분합니다. 선종 색은 USCG AIS Guide 코드표의 분류이고, 이름·크기·흘수·목적지·ETA 는 선원이 입력한 보고값(ETA 는 연도 없음)입니다. 줌 7 미만에서는 격자별 선박 수로 묶어 보여 줍니다. 수신이 끊긴 구간은 되살릴 수 없어 항적에 회색 점선(공백)으로 남깁니다.</li>
        <li>비상업·학습·포트폴리오 용도이며 운항 판단에 쓰면 안 됩니다.</li>
      </ul>
      <h2 className="label mt-4 mb-2">Design</h2>
      <p className="text-fg-2">설계서(docs/SkyWx_설계서_로컬개발용_v0.2.pdf — 이전 이름 SkyWx 시절 원본, ADR-015), ADR(docs/adr), 검증 기록(docs/VERIFICATION.md), 성능 측정(docs/PERF.md)은 저장소에 있습니다.</p>
    </div>
  );
}
