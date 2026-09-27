package dev.wakeline.domain;

import java.time.Instant;

/**
 * 선박 위치 보고 1건 — schemas/ship_state.v1.json 과 같은 계약(ais 수집기가 만들고 api 가 검증한다).
 * AIS '값 없음' 표기와 범위 밖 값은 수집기가 null 로 바꿔 보낸다 — 여기서도 추정해 채우지 않는다.
 * seen_at 은 aisstream 이 보고를 받은 시각(MetaData.time_utc)이지 선박 송신 시각이 아니다.
 *
 * @param positionSource gnss | manual(Timestamp 61) | estimated(62, 선박 자체 추측항법) | inoperative(63)
 * @param shipClass      AIS 장치 등급 A | B (메시지 형식에서 결정)
 */
public record ShipState(String mmsi, double lat, double lon, Double sogKn, Double cogDeg, Integer headingDeg, Integer navStatus, Integer rot,
                        String positionSource, Instant seenAt, String provider, String msgType, String shipClass) {
}
