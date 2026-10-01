package dev.wakeline.platform.web;

/** 여러 컨트롤러가 같은 규칙으로 읽는 요청 파라미터(api-review §2.5-2 — 예전에는 날씨 컨트롤러가 항공기 컨트롤러의 도우미를 빌려 썼다). */
public final class Params {
    private Params() {}

    /** 항공기 hex(ICAO 24-bit 주소): 앞뒤 공백을 빼고 소문자 6자리 16진수만. 아니면 400 BAD_HEX. */
    public static String hex(String hex) {
        String h = hex == null ? "" : hex.trim().toLowerCase();
        if (!h.matches("^[0-9a-f]{6}$")) throw Problem.badRequest("BAD_HEX", "hex must be 6 hex chars");
        return h;
    }
}
