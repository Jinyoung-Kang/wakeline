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
