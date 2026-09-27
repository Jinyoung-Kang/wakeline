export default function AboutPage() {
  const rows: [string, string, string][] = [
    ["항공기 (1순위)", "adsb.lol — readsb v2 API", "ODbL 1.0 · 출처 표기 · 429 시 백오프 후 adsb.fi 폴백"],
    ["항공기 (2순위)", "adsb.fi opendata", "개인·비상업 · 초당 1회(토큰 버킷) · 출처 표기"],
    ["항공기 (전세계)", "OpenSky Network (OAuth2)", "연구·비상업 · 하루 4,000 크레딧 · 계정 없으면 비활성"],
    ["SIGMET · METAR · TAF", "AviationWeather.gov Data API", "미국 정부 공개 데이터 · 분당 20회 자체 상한 · 커스텀 UA"],
    ["레이더 타일", "RainViewer", "개인·교육 전용 · 과거 2 h · 줌 ≤ 7 · 링크 출처"],
    ["배경지도", "OpenFreeMap + MapLibre GL JS", "OpenMapTiles · OpenStreetMap contributors · BSD-3"],
  ];
  return (
    <div className="h-full overflow-y-auto p-4 text-[12px]">
      <div className="label mb-2">Data sources · licenses</div>
      <table className="mb-4"><thead><tr><th>역할</th><th>서비스</th><th>조건</th></tr></thead><tbody>{rows.map((r) => <tr key={r[0]}><td>{r[0]}</td><td>{r[1]}</td><td>{r[2]}</td></tr>)}</tbody></table>
      <div className="label mb-2">한계 · 정직성 규칙</div>
      <ul className="list-disc space-y-1 pl-5 text-fg-2">
        <li>지도의 항공기 위치는 갱신(10 s) 사이 브라우저가 dead reckoning 으로 <b>추정</b>한 것이며, 아이콘 테두리와 카드의 “추정” 배지로 관측값과 구분합니다. 60 s 이상 미수신은 반투명, 300 s 초과는 제거됩니다.</li>
        <li>진입 예측(PREDICTED)은 현재 속도·방위의 10분 직선 외삽입니다. 선회 중(최근 트랙 변화 15° 초과)이거나 60 kt 미만이면 예측하지 않습니다. 관측 알림과 유형을 분리하고 항상 “추정”으로 표시합니다.</li>
        <li>폴리곤을 만들 수 없는 SIGMET(라인형 서술, 좌표 결측)은 목록에 원문으로 남기되 판정에서 제외하고, 제외 사유를 표시합니다.</li>
        <li>값이 없으면 “—”로 둡니다. 기종·등록번호는 공급자 값이며 추정하지 않습니다. 비행 카테고리는 AWC 제공값을 우선하고, 없을 때만 실링·시정 규칙으로 계산해 “계산”으로 표시합니다.</li>
        <li>모든 값에 출처(provider)와 수집 시각(fetched_at)이 붙고, 지연이 60 s(지역)를 넘으면 상단에 배지가 뜹니다. 공급자가 전부 실패하면 마지막 스냅샷을 STALE 로 유지합니다.</li>
        <li>한반도 상공 커버리지는 자원봉사 수신기망에 의존합니다. 수신기가 없는 해역·저고도는 비어 있을 수 있습니다.</li>
        <li>비상업·학습·포트폴리오 용도이며 운항 판단에 쓰면 안 됩니다.</li>
      </ul>
      <div className="label mt-4 mb-2">Design</div>
      <p className="text-fg-2">설계서(docs/SkyWx_설계서_로컬개발용_v0.2.pdf), ADR(docs/adr), 검증 기록(docs/VERIFICATION.md), 성능 측정(docs/PERF.md)은 저장소에 있습니다.</p>
    </div>
  );
}
