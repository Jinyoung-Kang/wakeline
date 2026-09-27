# ADR-002 Next.js 16 화면 + 브라우저는 키·내부 주소를 모른다

**상태** 채택

## 결정
- 화면은 Next.js 16(App Router, Turbopack) 클라이언트 컴포넌트가 중심이며 SSR 셸은 최소다. `NEXT_PUBLIC_` 변수는 빌드 시 금지한다(`next.config.ts` 가 발견 즉시 실패).
- API·WS 는 edge(nginx)가 api 로 직접 라우팅한다. 화면 서버는 프록시 경로에 없어 처리량 손실이 없다.
- CSP 는 요청마다 nonce 를 발급하는 `proxy.ts` 가 붙인다(`script-src 'self' 'nonce-…' 'strict-dynamic'`). 외부 스크립트 없음, 타일·글꼴·레이더 호스트만 허용.

## 실측으로 바뀐 것
- MapLibre GL 6 은 워커를 `new Worker(new URL(...), {type:"module"})` 로 만드는데 Turbopack 이 이를 자산으로 취급해 워커 로드에 실패했다. `scripts/copy-maplibre-worker.mjs` 가 워커와 shared 청크를 `public/maplibre/` 로 복사하고 `setWorkerUrl()` 로 지정한다.
- 같은 이유로 보간 워커는 번들러를 거치지 않는 순수 JS(`public/interpolate.worker.js`)로 두고, `tests/worker-sync.test.ts` 가 TS 구현(`lib/interpolate.ts`)과 결과가 같음을 검사한다.
