/**
 * 진행 중 표시(app/globals.css .busy-appear · .busy-bar · .skeleton — 노선 조회 등)의 나타남 지연(ms). 선택값이다(잰 값이 아니다 — 사용자 요청
 * 2026-09-30 "노선 조회 중 UI 가 부자연스럽다"를 고치며 고른 값). 이보다 빨리 끝나는 조회는 진행 표시가 보이지 않아 번쩍이지 않는다.
 * 사람이 '바로'로 느끼는 응답(약 0.1 s)보다 조금 길고 0.2 s 를 넘지 않게 골랐다. 글자(role=status)는 처음부터 DOM 에 있어 화면 읽기 프로그램에는 바로 읽힌다.
 * globals.css 의 --busy-appear-delay 와 같아야 한다(tests/route-loading.test.ts 가 견준다).
 */
export const BUSY_APPEAR_DELAY_MS = 180;
