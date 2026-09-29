package dev.wakeline.rest;

import tools.jackson.databind.JsonNode;

import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Consumer;
import java.util.regex.Pattern;

/**
 * 기상청 레이더 프레임 목록(수집기 wakeline:radar_kr:frames)의 항목 → 공개 /radar/kr frames[] (FR-31 · ADR-021 부분 합성).
 * <p>수집기 값을 믿지 않는다(R-72): 형식이 틀리거나 서로 맞지 않는 필드는 키를 빼고(모름) {@code parseError(필드)} 로 센다 — 500 이 되지 않고,
 * 지어내거나 0 으로 채우지 않는다. 필드가 없는 옛 항목은 틀린 것이 아니라 모르는 것이다(세지 않는다).
 * <ul>
 *   <li>stations: 헤더 STN_LIST 의 지점 수(0–{@value #MAX_STATIONS}) · station_ids: 그 코드(영숫자 1–6자, 개수 = stations)</li>
 *   <li>stations_ref: 기준 지점 수(수집기: 가장 새 저장 tm 에서 60분 안의 최대 — stations 이상) · partial: stations &lt; stations_ref 와 같을 때만</li>
 *   <li>refetches · upgrades: 다시 받은 횟수 · 지점이 늘어 바꾼 횟수(0 이상) · refetched_at · refetch_until: 시간대 있는 시각</li>
 *   <li>url: 받은 시각(fetched_at)을 아는 프레임은 {@code ?v=<epoch ms>} — 다시 받아 바뀐 영상이 브라우저 캐시(1 h)의 옛 영상으로 보이지 않게</li>
 * </ul>
 */
final class KrRadarFrames {
    /** 헤더 STN_LIST 는 20 B × 48 자리(기상청 포맷 문서). */
    static final int MAX_STATIONS = 48;
    private static final Pattern TM = Pattern.compile("^\\d{12}$");
    private static final Pattern STATION_ID = Pattern.compile("^[A-Za-z0-9]{1,6}$");
    /** 응답 최상위(최신 프레임의 합성 요약)에 옮기는 키. */
    private static final List<String> LATEST_KEYS = List.of("stations", "station_ids", "stations_ref", "partial");

    private KrRadarFrames() { }

    /** 항목 하나. 객체가 아니거나 tm 이 틀리면 null(목록에서 뺀다). */
    static Map<String, Object> frame(JsonNode f, Consumer<String> parseError) {
        if (f == null || !f.isObject()) return null;
        String tm = f.path("tm").asString("");
        if (!TM.matcher(tm).matches()) return null;
        Map<String, Object> fr = new LinkedHashMap<>();
        fr.put("tm", tm);
        fr.put("obs_tm", f.path("obs_tm").asString());
        fr.put("fetched_at", f.path("fetched_at").asString());
        fr.put("echo_cells", f.path("echo_cells").asInt());
        fr.put("url", url(tm, StatusService.isoInstant(f.path("fetched_at").asString(null))));
        Integer stations = count(f, "stations", 0, MAX_STATIONS, parseError);
        if (stations != null) fr.put("stations", stations);
        List<String> ids = stationIds(f, stations, parseError);
        if (ids != null) fr.put("station_ids", ids);
        Integer ref = count(f, "stations_ref", 0, MAX_STATIONS, parseError);
        if (ref != null && stations != null && ref < stations) { // 기준은 자기 지점 수를 포함한 최대다
            parseError.accept("stations_ref");
            ref = null;
        }
        if (ref != null) fr.put("stations_ref", ref);
        Boolean partial = partial(f, stations, ref, parseError);
        if (partial != null) fr.put("partial", partial);
        for (String k : List.of("refetches", "upgrades")) {
            Integer n = count(f, k, 0, Integer.MAX_VALUE, parseError);
            if (n != null) fr.put(k, n);
        }
        for (String k : List.of("refetched_at", "refetch_until")) {
            JsonNode v = f.get(k);
            if (v == null || v.isNull()) continue;
            Instant t = v.isString() ? StatusService.isoInstant(v.asString()) : null;
            if (t == null) parseError.accept(k);
            else fr.put(k, t);
        }
        return fr;
    }

    /** 영상 URL. 받은 시각을 알면 그 순간(epoch ms)을 버전으로 붙인다. */
    static String url(String tm, Instant fetchedAt) {
        String base = "/api/v1/radar/kr/" + tm + ".png";
        return fetchedAt == null ? base : base + "?v=" + fetchedAt.toEpochMilli();
    }

    /** 응답 최상위: 목록의 마지막(최신) 프레임의 합성 지점 수 · 코드 · 기준 · partial. 모르면 키 없음(이전 프레임 값으로 채우지 않는다). */
    static Map<String, Object> latest(List<Map<String, Object>> frames) {
        Map<String, Object> m = new LinkedHashMap<>();
        if (frames.isEmpty()) return m;
        Map<String, Object> last = frames.getLast();
        for (String k : LATEST_KEYS) if (last.containsKey(k)) m.put(k, last.get(k));
        return m;
    }

    /** 정수 필드. 없거나 null 이면 null(모름, 세지 않음). 정수가 아니거나 범위 밖이면 null + 셈. */
    private static Integer count(JsonNode f, String key, int lo, int hi, Consumer<String> parseError) {
        JsonNode v = f.get(key);
        if (v == null || v.isNull()) return null;
        if (v.isIntegralNumber() && v.canConvertToInt() && v.intValue() >= lo && v.intValue() <= hi) return v.intValue();
        parseError.accept(key);
        return null;
    }

    private static List<String> stationIds(JsonNode f, Integer stations, Consumer<String> parseError) {
        JsonNode v = f.get("station_ids");
        if (v == null || v.isNull()) return null;
        List<String> ids = new ArrayList<>();
        boolean ok = v.isArray() && v.size() <= MAX_STATIONS && (stations == null || v.size() == stations);
        if (ok) {
            for (JsonNode id : v) {
                if (!id.isString() || !STATION_ID.matcher(id.asString()).matches()) { ok = false; break; }
                ids.add(id.asString());
            }
        }
        if (ok) return ids;
        parseError.accept("station_ids");
        return null;
    }

    /**
     * partial: 참·거짓이고, 지점 수와 기준을 둘 다 알며, stations &lt; stations_ref 와 같을 때만. 둘 중 하나가 없으면(판정의 근거가 없다)
     * 또는 값이 맞지 않으면 null + 셈. 둘 중 하나가 틀려서 이미 센 경우에는 다시 세지 않는다.
     */
    private static Boolean partial(JsonNode f, Integer stations, Integer ref, Consumer<String> parseError) {
        JsonNode v = f.get("partial");
        if (v == null || v.isNull()) return null;
        if (!v.isBoolean()) { parseError.accept("partial"); return null; }
        if (stations == null || ref == null) {
            if (!present(f, "stations") || !present(f, "stations_ref")) parseError.accept("partial");
            return null;
        }
        if (v.booleanValue() != (stations < ref)) { parseError.accept("partial"); return null; }
        return v.booleanValue();
    }

    private static boolean present(JsonNode f, String key) {
        JsonNode v = f.get(key);
        return v != null && !v.isNull();
    }
}
