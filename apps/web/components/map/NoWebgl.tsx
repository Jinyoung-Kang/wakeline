/**
 * 지도를 그리지 못함 — 이 브라우저에서 WebGL2 문맥을 만들 수 없다(MapLibre 의 Map 생성자가 GPUInitializationError: 하드웨어 가속 끔 · GPU 차단 · 원격 데스크톱 등).
 * 지도 자리에만 알린다 — 상황판의 상태 바 · 알림 패널, 재생 화면의 조작 줄은 그대로(IM-21). 지도 없이 알림을 보는 화면은 /m.
 * 세로 가운데에 둔다 — 지도 위에 겹치는 것(상황판 LayerPanel 의 레이어 단추 · 칩, 재생 화면의 목록 · 상세 · 알림)은 위 · 아래 가장자리에 있다.
 */
export function NoWebgl() {
  return (
    <div className="grid-bg flex h-full w-full flex-col items-start justify-center gap-1.5 p-3 text-[11px]" role="status" data-testid="map-no-webgl">
      <span className="text-warn">WebGL2 를 쓸 수 없어 지도를 그리지 않음</span>
      <a className="btn" href="/m">지도 없는 알림 화면(/m)</a>
    </div>
  );
}
