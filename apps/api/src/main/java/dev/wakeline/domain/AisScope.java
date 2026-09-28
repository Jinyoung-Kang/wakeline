package dev.wakeline.domain;

import java.util.List;

/**
 * AIS 구역(계약 v4 §D): 수집기 연결 하나가 구독한 상자들 — 공백 이벤트의 scope · 상태 해시 shards[].scope 의 정규화 문자열과 그 상자.
 * 같음은 문자열로 판단한다(상자 배열은 파싱 결과일 뿐). 만료 멈춤·항적 끊기는 이 상자 안의 선박·점에만 적용한다.
 */
public record AisScope(String text, List<double[]> boxes) {

    /**
     * 구역 하나('|' 없음)를 {@link AisBboxes#parse} 규칙으로 읽는다(앞뒤 공백은 뺀다).
     * @throws IllegalArgumentException 비었거나 형식·범위 오류
     */
    public static AisScope parse(String text) {
        if (text == null) throw new IllegalArgumentException("no scope");
        String s = text.strip();
        return new AisScope(s, List.copyOf(AisBboxes.parse(s)));
    }

    /** 이 구역의 상자 안(경계 포함)인가. */
    public boolean contains(double lat, double lon) { return AisBboxes.contains(boxes, lat, lon); }

    /** 상자들 [[lat1, lon1, lat2, lon2], ...](상태 공개용 — 입력 순서·모서리 순서 그대로). */
    public List<List<Double>> coverage() {
        return boxes.stream().map(b -> List.of(b[0], b[1], b[2], b[3])).toList();
    }

    @Override public boolean equals(Object o) { return o instanceof AisScope other && text.equals(other.text); }

    @Override public int hashCode() { return text.hashCode(); }

    @Override public String toString() { return text; }
}
