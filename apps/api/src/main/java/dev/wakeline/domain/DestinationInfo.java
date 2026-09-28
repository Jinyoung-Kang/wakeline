package dev.wakeline.domain;

import com.fasterxml.jackson.annotation.JsonInclude;

import java.util.List;

/**
 * AIS 목적지(선원이 입력한 자유 문자열)의 결정적 풀이(계약 v4 §B). 추정하지 않는다 — 규칙에 맞는 구분자와 UN/LOCODE 항구 표에 있는 코드만 푼다.
 * raw = 보고된 원문 그대로. kind: between(A&lt;=&gt;B · A&lt;&gt;B 왕복) · from_to(A&gt;B, 보고된 출발 A · 도착 B) · to(&gt;B) · text(그 밖 — 원문 전체가 목적지).
 * from·to 는 없으면 키 없음(between 은 둘 다 없고 places 에 두 곳). places = 풀이한 조각 순서대로.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record DestinationInfo(String raw, String kind, Place from, Place to, List<Place> places) {
    public static final String BETWEEN = "between";
    public static final String FROM_TO = "from_to";
    public static final String TO = "to";
    public static final String TEXT = "text";

    /**
     * 한 조각. text = 정규화한 조각 문자열. locode·name·country·subdivision 은 항구 표에서 찾았을 때만(아니면 키 없음).
     * ambiguous = 붙임형 5자 코드가 같은 글자의 UN/LOCODE 지명과도 같다(예: CAVAN — 코드로 읽었지만 지명일 수도 있음).
     */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record Place(String text, String locode, String name, String country, String subdivision, boolean ambiguous) {}
}
