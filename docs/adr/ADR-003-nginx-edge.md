# ADR-003 nginx edge 단일 공개 포트(127.0.0.1:8700)

**상태** 채택

## 결정
브라우저는 edge 만 본다. web·api·collector·redis·db 는 내부 네트워크(10.77.0.0/24, 고정 IP)이며 포트를 공개하지 않는다. edge 는 `X-Forwarded-For` 를 실제 접속 주소로 **덮어쓰고**, api 는 edge 의 고정 IP(10.77.0.10)에서 온 요청의 XFF 만 믿는다(`ClientIp`). IP당 `limit_req` 10 r/s(1차) + api Lua 분당 120회(2차).

## 실측으로 찾은 함정 (VERIFICATION #3, #4)
- nginx 는 `location` 안에 `proxy_set_header` 가 하나라도 있으면 상위 블록의 `proxy_set_header` 를 **전부 무시**한다. 처음 구성에서 `/api/` 의 `Connection ""` 때문에 XFF 덮어쓰기가 사라져 위조 XFF 가 api 까지 갔다(E2E 3경로 검사로 발견). 공통 헤더를 `proxy_headers.conf` 로 분리해 모든 location 에서 include 한다.
- `Host $host` 는 포트를 뺀다. Spring 의 WebSocket same-origin 검사는 포트까지 비교하므로 403 이 났다. `Host $http_host` 로 바꿨다.
- 단일 파일 bind mount 는 파일을 새로 쓰면(inode 변경) 컨테이너에서 사라진다. 설정 변경 후에는 `docker compose up -d edge` 로 재생성한다.

## 포트
8080 은 같은 Mac 의 SmartCollab 이 쓴다. Wakeline 는 8700 을 쓰고 127.0.0.1 에만 바인딩한다.

## 이후 변경(R-50, 리뷰 v1 — 현재 값)
- 요청 제한 구역이 둘이다: `perip`(IP당 10 r/s — `/api/` burst 30 · 화면 `/` burst 60)과 WebSocket 핸드셰이크 전용 `perip_ws`(5 r/s · burst 10, IP당 동시 연결 10).
- 버전이 붙은 불변 정적 파일 `/_next/static/` · `/maplibre/<버전>/` 은 제한 밖(1년 immutable) — MapLibre 가 제한 안에 있으면 같은 IP 의 여러 창이 첫 화면에서 429 를 받았다(R-02 후속, VERIFICATION #29).
- edge 는 `X-Request-Id` 도 자기 `$request_id` 로 덮어쓰고 접근 로그에 남긴다(R-49). 망은 public · internal · egress 로 나뉘었다(R-64 · R-77, ADR-017 §4) — 내부 서비스의 고정 IP 는 internal 망에 있다.
