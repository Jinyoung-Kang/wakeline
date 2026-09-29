/**
 * 시각 짝 검사(사용자 요청 2026-09-29 "UTC 와 KST 함께"): 화면 글자에서 KST 시각마다 바로 뒤에 같은 순간의 UTC 가 붙어 있는지.
 * "08:41:14 KST · 09-28 23:41:14 UTC" · "08:41 KST · 23:41Z" · 구간 "… KST · 09-28 23:00:00 – …" 는 짝이 있다. 짝 없는 KST 시각 목록을 돌려준다.
 * 원문(METAR · TAF · SIGMET)과 선박 ETA(선원이 UTC 로 입력한 값을 함께 적는 형식)는 부르는 쪽이 빼고 넘긴다.
 */
const KST_TIME = /(?:\d\d-\d\d )?\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:–(?:\d\d:\d\d|—))? KST/g;
const UTC_PARTNER = /^ · (?:\d{4}-)?(?:\d\d-\d\d )?(?:\d\d:\d\d(?::\d\d(?:\.\d+)?)?|—)/;

export function unpairedKst(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(KST_TIME)) {
    const rest = text.slice(m.index! + m[0].length);
    if (!UTC_PARTNER.test(rest)) out.push(`${m[0]}${rest.slice(0, 24)}`);
  }
  return out;
}
