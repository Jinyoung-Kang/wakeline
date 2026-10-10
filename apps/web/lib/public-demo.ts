/**
 * 공개 데모(AWS 배포 — ADR-039)인지: web 컨테이너의 실행 시 환경 변수 WAKELINE_PUBLIC_DEMO 가 정확히 "1" 일 때만(없거나 다른 값 = 로컬과 같음).
 * 앞단 Caddy 가 운영자 전용 경로(/ops · /logs · /api/v1/ops)를 404 로 닫으므로, 공개 화면에서는 그리로 가는 메뉴 · 링크를 감춘다.
 * 서버에서만 부른다(루트 레이아웃 — 요청마다 렌더해 빌드에 굳지 않는다). 브라우저로는 boolean 하나만 넘긴다(components/PublicDemo) —
 * NEXT_PUBLIC_ 변수는 쓰지 않는다(next.config.ts).
 */
export function isPublicDemo(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return env.WAKELINE_PUBLIC_DEMO === "1";
}
