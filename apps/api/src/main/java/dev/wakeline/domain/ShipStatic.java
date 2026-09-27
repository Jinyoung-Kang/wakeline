package dev.wakeline.domain;

import java.time.Instant;

/**
 * 선박 정적·항해 정보(AIS 5·24·19 를 MMSI 별로 합친 최신값) — schemas/ship_static.v1.json 과 같은 계약.
 * 모두 선박이 입력·송신한 보고값이다(검증된 등록 정보가 아님). 받지 못했거나 '값 없음' 인 필드는 null.
 * ETA 는 연도가 없는 선원 입력값(UTC). updated_at = 이 정적 정보의 내용이 마지막으로 바뀐 메시지의 aisstream 수신 시각.
 */
public record ShipStatic(String mmsi, String name, String callSign, Integer imo, Integer shipType,
                         Integer dimA, Integer dimB, Integer dimC, Integer dimD, Double draughtM, String destination,
                         Integer etaMonth, Integer etaDay, Integer etaHour, Integer etaMinute, Instant updatedAt, String provider) {
}
