package dev.wakeline.weather.core;

import java.util.List;

/**
 * SIGMET 밖의 판정 구역 공급원(ADR-035) — 공역(airspace.core.AirspaceZones)이 구현한다. weather.core 는 공급원 쪽을 import 하지 않는다
 * (구현이 이 인터페이스를 따른다 — core → core 한 방향, 순환 없음). 엔진은 판(version)이 바뀔 때만 색인을 다시 짓는다.
 */
public interface ZoneSource {
    String MODE_OFF = "off";
    String MODE_SHADOW = "shadow";
    String MODE_ON = "on";

    /** 구역 종류(Zone#zoneType — 알림 · 지표의 꼬리표). */
    String zoneType();

    /** 판 — 구역 목록이 바뀌면 다른 값(공역: 켜진 차수 id, 없으면 0). */
    long version();

    /** 이 판의 판정 대상 구역. */
    List<? extends Zone> zones();

    /** 이 판 기준의 종료 판단(빠진 구역 = 끝남). */
    AlertStateMachine.ZoneSet set();

    /** 운영 설정: off(판정 안 함) · shadow(판정 · 건수만 — 저장 · 방송 없음) · on(알림). */
    String mode();
}
