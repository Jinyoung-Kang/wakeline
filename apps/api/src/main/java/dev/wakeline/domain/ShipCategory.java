package dev.wakeline.domain;

/**
 * AIS 선종 코드(ship_type) → 분류(지도 색·격자 대표 분류). 계약 v2 §B3 의 USCG AIS Guide 표 <b>한 곳</b>(web 은 lib/ships.ts 한 곳) —
 * 두 쪽 모두 같은 표(apps/web/tests/fixtures/ship-category-uscg.json)로 단위 시험한다.
 * <pre>
 *   30 fishing · 31,32,52 tug(예인) · 36,37 pleasure(요트·레저) · 40–49 hsc(고속선) · 50,51,53,54,55,58 special(도선·수색구조·항만·방제·법집행·의료)
 *   35 military · 60–69 passenger · 70–79 cargo · 80–89 tanker · 0/null(또는 음수) unknown · 그 밖(1–29, 33, 34, 38, 39, 56, 57, 59, 90–99, 100 이상) other
 * </pre>
 * 코드가 선박이 보낸 보고값이므로 분류도 보고값의 결정적 변환이다(추정 아님). 코드가 없으면 unknown — 색을 지어내지 않는다.
 * 열거 순서는 web 의 SHIP_CATEGORIES 순서와 같다(격자 대표 분류가 동률이면 앞의 것 — 결정적).
 */
public enum ShipCategory {
    CARGO("cargo"), TANKER("tanker"), PASSENGER("passenger"), FISHING("fishing"), TUG("tug"), PLEASURE("pleasure"),
    HSC("hsc"), SPECIAL("special"), MILITARY("military"), OTHER("other"), UNKNOWN("unknown");

    private static final ShipCategory[] VALUES = values();
    private final String key;

    ShipCategory(String key) { this.key = key; }

    /** 계약·JSON 에 쓰는 이름(web lib/ships.ts 의 ShipCategory 와 같다). */
    public String key() { return key; }

    public static ShipCategory of(Integer code) {
        if (code == null || code <= 0) return UNKNOWN;
        int c = code;
        if (c == 30) return FISHING;
        if (c == 31 || c == 32 || c == 52) return TUG;
        if (c == 36 || c == 37) return PLEASURE;
        if (c >= 40 && c <= 49) return HSC;
        if (c == 50 || c == 51 || c == 53 || c == 54 || c == 55 || c == 58) return SPECIAL;
        if (c == 35) return MILITARY;
        if (c >= 60 && c <= 69) return PASSENGER;
        if (c >= 70 && c <= 79) return CARGO;
        if (c >= 80 && c <= 89) return TANKER;
        return OTHER;
    }

    /** ordinal → 분류(격자 집계 배열 색인용). */
    public static ShipCategory at(int ordinal) { return VALUES[ordinal]; }

    public static int count() { return VALUES.length; }
}
