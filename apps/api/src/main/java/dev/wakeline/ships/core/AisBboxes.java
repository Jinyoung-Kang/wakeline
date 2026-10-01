package dev.wakeline.ships.core;

import java.util.ArrayList;
import java.util.List;
import java.util.regex.Pattern;

/**
 * AIS 구독 영역 문자열(ADR-014 §7 · 계약 v4 §D): "lat1,lon1,lat2,lon2" 상자를 ';' 로 이어 쓴 것이 구역 하나, 구역은 '|' 로 나눈다(최대 3 —
 * 공급자의 키당 연결 수). ais/bbox.py 와 같은 규칙 — 구역마다 상자 1~16 개, 전체 1,024 자 이하, |lat| ≤ 90, |lon| ≤ 180, 넓이 0 인 상자 금지,
 * 빈 조각(끝의 ';')은 건너뛴다. 빈 구역('|' 앞뒤가 비었음)은 상자가 0개라 틀린 값이다. '|' 가 없으면 구역 하나(기존과 같다).
 * 숫자는 소수 6자리까지(수집기는 float() 로 더 넓게 받는다 — 여기서 더 엄격하면 api 를 통과한 값은 수집기도 받는다).
 * 운영 설정 검사(SettingsService)·수신 범위 표시(AisStatus — 상태 해시의 bbox·shards)·공백 scope 검사가 같은 규칙을 쓴다.
 */
public final class AisBboxes {
    /** ais/bbox.py MAX_BOXES(구역당) · MAX_TEXT 와 같다. */
    public static final int MAX_BOXES = 16, MAX_TEXT = 1024;
    /** 구역 수 상한(aisstream 키당 연결 3개, 계약 v4 §D). */
    public static final int MAX_SHARDS = 3;
    private static final Pattern NUM = Pattern.compile("^-?\\d{1,3}(\\.\\d{1,6})?$");

    private AisBboxes() {}

    /**
     * 구역 하나('|' 없음).
     * @return 상자들(각 [lat1, lon1, lat2, lon2], 입력 순서·모서리 순서 그대로)
     * @throws IllegalArgumentException 형식·범위 오류(메시지는 운영 API 의 400 응답에 쓴다 — 입력값을 되풀이하지 않는다)
     */
    public static List<double[]> parse(String s) {
        if (s.length() > MAX_TEXT) throw new IllegalArgumentException("at most " + MAX_TEXT + " characters");
        List<double[]> out = new ArrayList<>();
        for (String raw : s.split(";", -1)) {
            String part = raw.strip();
            if (part.isEmpty()) continue;
            String[] p = part.split(",", -1);
            if (p.length != 4) throw new IllegalArgumentException("each box needs 4 numbers lat1,lon1,lat2,lon2");
            double[] d = new double[4];
            for (int i = 0; i < 4; i++) {
                String t = p[i].strip();
                if (!NUM.matcher(t).matches()) throw new IllegalArgumentException("box values must be decimal numbers");
                d[i] = Double.parseDouble(t);
            }
            if (Math.abs(d[0]) > 90 || Math.abs(d[2]) > 90) throw new IllegalArgumentException("latitude must be within ±90");
            if (Math.abs(d[1]) > 180 || Math.abs(d[3]) > 180) throw new IllegalArgumentException("longitude must be within ±180");
            if (d[0] == d[2] || d[1] == d[3]) throw new IllegalArgumentException("box has zero area");
            if (out.size() == MAX_BOXES) throw new IllegalArgumentException("at most " + MAX_BOXES + " boxes");
            out.add(d);
        }
        if (out.isEmpty()) throw new IllegalArgumentException("no bounding box");
        return out;
    }

    /**
     * 구역 나누기 문법(계약 v4 §D): '|' 로 나눈 구역 1~3 개, 구역마다 {@link #parse} 규칙(상자 1~16 개), 전체 1,024 자 이하.
     * @return 구역별 상자 목록(입력 순서 그대로)
     * @throws IllegalArgumentException 형식·범위 오류(입력값을 되풀이하지 않는다)
     */
    public static List<List<double[]>> parseShards(String s) {
        if (s.length() > MAX_TEXT) throw new IllegalArgumentException("at most " + MAX_TEXT + " characters");
        String[] parts = s.split("\\|", -1);
        if (parts.length > MAX_SHARDS) throw new IllegalArgumentException("at most " + MAX_SHARDS + " shards separated by '|'");
        List<List<double[]>> out = new ArrayList<>(parts.length);
        for (String part : parts) {
            if (part.isBlank()) throw new IllegalArgumentException("empty shard (each '|'-separated shard needs 1 to " + MAX_BOXES + " boxes)");
            out.add(parse(part));
        }
        return out;
    }

    /**
     * (lat, lon) 이 상자들 중 하나 안(경계 포함)인가. 두 모서리는 어느 순서여도 된다(남·북·서·동으로 정리 — 웹 수신 범위 표시와 같은 해석).
     * 날짜변경선을 넘는 상자는 모서리 순서로 구별할 수 없으므로 작은 경도 → 큰 경도로만 읽는다.
     */
    public static boolean contains(List<double[]> boxes, double lat, double lon) {
        for (double[] b : boxes) {
            if (lat >= Math.min(b[0], b[2]) && lat <= Math.max(b[0], b[2]) && lon >= Math.min(b[1], b[3]) && lon <= Math.max(b[1], b[3])) return true;
        }
        return false;
    }
}
