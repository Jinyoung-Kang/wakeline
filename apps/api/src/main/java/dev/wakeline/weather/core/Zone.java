package dev.wakeline.weather.core;

import org.locationtech.jts.geom.MultiPolygon;

import java.time.Instant;
import java.util.Map;

/**
 * 판정 구역 하나(ADR-035) — 항공기 위치와 교차 · 진입 예측을 판정하는 다각형 + 고도대 + 유효 시간. SIGMET({@link SigmetRecord})이 첫 구현이고, 공역
 * (airspace.core — 금지 · 원전 · 제한 구역)이 둘째다. 엔진(관측 교차 · 10분 예측 · 알림 상태 머신)은 이 인터페이스만 본다.
 * 근거에 무엇을 적는지(고도대와 그 가정 · 유효 시간이나 차수)와 알림 머리(SIGMET 필드 · 공역 필드)는 구역이 정한다 — 같은 엔진이 만든 알림도 구역마다
 * 근거의 모양이 다르다(계약 v5 §G48).
 */
public interface Zone {
    String SIGMET = "sigmet";
    String AIRSPACE = "airspace";
    String LEVEL_ALERT = "alert";
    String LEVEL_INFO = "info";

    /** 구역 종류(sigmet · airspace). */
    String zoneType();

    /** 종류 안에서 고유한 id(상태 머신의 열쇠 — 같은 종류끼리만 쓴다). */
    String zoneId();

    /** 판정 다각형. null 이면 판정 제외. */
    MultiPolygon geometry();

    Instant validFrom();

    Instant validTo();

    boolean validAt(Instant t);

    /** 판정 하한(ft). */
    int baseFt();

    /** 판정 상한(ft) — null 이면 무제한(가정이면 근거에 밝힌다). */
    Integer judgedTopFt();

    boolean bandContains(int altFt);

    String provider();

    /** 근거: 고도대와 판정 가정(관측 · 예측 공통). */
    void putBand(Map<String, Object> ev);

    /** 근거: 그 고도에 대한 판정 주석(공역 — 고도 경계 근처). SIGMET 은 적지 않는다(근거 그대로). */
    default void putJudgement(Map<String, Object> ev, int altFt) {}

    /** 근거: 유효 시간(SIGMET) 또는 기준 차수(공역). */
    void putValidity(Map<String, Object> ev);

    /** 이 구역에서 생긴 알림의 머리(SIGMET 필드 또는 공역 필드 · 알림 수준). */
    Alert.Head head();
}
