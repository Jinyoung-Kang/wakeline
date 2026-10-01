package dev.wakeline.ws;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.annotation.JsonRawValue;
import dev.wakeline.aircraft.web.AircraftJson;
import dev.wakeline.domain.Alert;
import dev.wakeline.domain.DestinationInfo;
import dev.wakeline.engine.PredictionAvailability;
import dev.wakeline.portcalls.PortCallsInfo;
import dev.wakeline.route.RouteInfo;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * WS 프로토콜 v1 메시지(설계 9.5절 · 계약서 §1). 필드는 snake_case, null 값인 키는 보내지 않는다(없는 키 = 모름).
 * snapshot/diff 는 세션별 seq(스냅샷마다 1, diff 마다 +1)로 연속성을 판단하고, v(전역 스냅샷 버전)는 참고용이다.
 */
public final class WsMessages {
    private WsMessages() {}

    public record Welcome(String type, String sessionId, Instant serverTime, long snapshotVersion, Map<String, Object> limits) {
        public static Welcome of(String sid, long v, double maxBbox, int diffS, int resyncS, int resyncWorldS, int maxMsgs, int msgWindowS, int helloTimeoutS) {
            Map<String, Object> limits = new LinkedHashMap<>();
            limits.put("max_bbox_area", maxBbox);
            limits.put("diff_interval_s", diffS);
            limits.put("resync_interval_s", resyncS);
            limits.put("resync_world_interval_s", resyncWorldS);
            limits.put("max_client_messages", maxMsgs);
            limits.put("client_message_window_s", msgWindowS);
            limits.put("hello_timeout_s", helloTimeoutS);
            return new Welcome("welcome", sid, Instant.now(), v, limits);
        }
    }

    /** aircraft 는 이미 직렬화된 JSON 배열(항공기별 인코딩을 버전마다 한 번만 만들어 이어 붙인다, PERF-8). */
    public record SnapshotMsg(String type, int seq, long v, Instant ts, AircraftJson.Sources sources, long sigmetsVersion,
                              @JsonRawValue String aircraft) {}

    /** upsert 는 이미 직렬화된 JSON 배열. 비어 있는 diff 는 보내지 않는다(seq 틈이 생기지 않게). */
    public record DiffMsg(String type, int seq, long v, Instant ts, @JsonRawValue String upsert, List<String> remove) {}

    public record AlertsMsg(String type, long version, List<Alert> alerts) {}

    public record AlertItem(String event, Alert alert) {}

    public record AlertsBatchMsg(String type, long version, List<AlertItem> items) {}

    /**
     * state: FULL 인코딩(이미 직렬화된 JSON) 또는 null(스냅샷에 더 이상 없음 — 키는 남긴다).
     * route(계약 v4 §A): 그 상태의 콜사인으로 읽은 등록 노선 — 상태가 없으면 null(콜사인을 모른다, 키는 남긴다).
     */
    public record SelectedMsg(String type, String hex, @JsonInclude(JsonInclude.Include.ALWAYS) @JsonRawValue String state,
                              PredictionAvailability prediction, @JsonInclude(JsonInclude.Include.ALWAYS) RouteInfo route) {}

    public record ErrorMsg(String type, String code, String title, String detail) {}

    /**
     * 수요 상태(계약 v2 §A3): {type:"demand", hot:{…}|null, focus:{…}|null}. hot·focus 키는 null 이어도 보낸다(없음 = 이 세션의 수요 없음).
     * 안쪽 값이 null 인 키는 빠진다(모름 — interval_s 가 없으면 화면은 주기를 말하지 않는다).
     */
    public record DemandMsg(String type, @JsonInclude(JsonInclude.Include.ALWAYS) HotDemand hot,
                            @JsonInclude(JsonInclude.Include.ALWAYS) FocusDemand focus) {}

    /**
     * 핫 리전. state: active | pending | throttled | covered_by_region | error(수집기가 보고한 조회 실패) | disabled(운영자가 공급자를 끔) | limited(세션 제한 — 새 셀 60 s 에 6개).
     * cell·radius_nm 은 covered_by_region 이면 없다. interval_s·last_success_at 은 수집기가 wakeline:demand:status 에 보고한 값 그대로.
     */
    public record HotDemand(String cell, Integer radiusNm, String state, Integer intervalS, Instant lastSuccessAt) {}

    /**
     * 선택 항공기 집중 추적. state: active | pending | throttled | not_found | error | disabled(운영자가 공급자를 끔) | expired_session_cap | limited(세션 제한 — 새 hex 60 s 에 6개).
     * since = 이 세션이 이 hex 를 (다시) 선택한 시각. interval_s·last_success_at 은 수집기 보고값.
     */
    public record FocusDemand(String hex, String state, Integer intervalS, Instant since, Instant lastSuccessAt) {}

    public record Simple(String type) {}

    // ---- 선박(계약 v2 §B3) ----

    /** 개별 표시(줌 ≥ 7, 또는 줌 4~6 에서 선박이 적을 때 — 계약 v4 §C): 뷰포트 안 선박 전체(ShipLite, 이미 직렬화된 배열). sseq 는 항공기 seq 와 같은 규칙(스냅샷마다 1). */
    public record ShipsSnapshotMsg(String type, int sseq, Instant ts, @JsonRawValue String ships) {}

    /** 개별 표시: 마지막으로 보낸 상태와의 차이. 빈 diff 는 보내지 않는다(sseq 틈이 생기지 않게). */
    public record ShipsDiffMsg(String type, int sseq, Instant ts, @JsonRawValue String upsert, List<String> remove) {}

    /**
     * 줌 < 4, 또는 뷰포트 안 선박이 개별 표시 상한(줌 ≥ 7 은 5,000 척, 줌 4~6 은 1,500 척)을 넘을 때(capped = true — 계약 v4 §C): 격자 칸별 선박 수. cells = [[칸 중심 lat, 칸 중심 lon, 수, 대표 분류, [선종별 수]], ...]
     * (이미 직렬화된 배열). 대표 분류 = 칸에서 가장 많은 선종 분류(동률이면 web 과 같은 순서의 앞 — 결정적). 선종별 수(계약 v5 §B2) = 11개 정수
     * [n0..n10], 순서는 schemas/vectors/ship-categories.v1.json(ShipCategory 선언 순서) — 합은 수와 같다.
     */
    public record ShipsGridMsg(String type, Instant ts, double cellDeg, @JsonRawValue String cells, Boolean capped) {}

    /**
     * 선택 선박: state(ShipState 전체)·static(ShipStatic 전체) — 각각 없으면 null(키는 남긴다). 이미 직렬화된 JSON.
     * static_source(계약 v5 §G17): static 의 출처 — live · stored · none · stored_unavailable({@link dev.wakeline.ships.web.ShipJson#STATIC_LIVE} 등). null 은 저장 정적 보고를 읽는 쪽이
     * 연결되지 않은 구성(시험)에서 메모리에 없을 때뿐이다(키는 남긴다). static_updated_at: stored 일 때만 저장 행(ship)의 updated_at — DB 에 기록된 수신
     * 시각(= static.updated_at): 내용이 바뀔 때와 수집기 재시작 · 선박이 수집기 메모리에서 빠졌다(30분 무수신 · 상한) 다시 잡힐 때 새로 기록되므로 첫 수신도
     * 마지막 수신도 아니다({@link dev.wakeline.persist.StoredStaticReader}). 저장 행은 받은 필드만 덮으므로(계약 v5 §G19) 이 시각은 마지막으로 저장한 보고의
     * 것이고, 그 보고가 싣지 않은 static 필드는 그보다 앞서 저장된 보고의 값이다. 그 밖에는 null(키는 남긴다).
     * destination_info(계약 v4 §B): 보고된 목적지의 결정적 풀이 — 목적지를 모르면 null(키는 남긴다).
     * port_calls(ADR-022 개정): 호출부호로 DB 색인에서 찾은 한국 항만 입출항(해양수산부 PORT-MIS — 수집기가 색인한다) — 늘 객체(상태로 말한다). null 은 읽는 쪽이
     * 연결되지 않은 구성(시험)뿐이다(키는 남긴다).
     */
    public record ShipSelectedMsg(String type, String mmsi,
                                  @JsonInclude(JsonInclude.Include.ALWAYS) @JsonRawValue String state,
                                  @JsonInclude(JsonInclude.Include.ALWAYS) @JsonRawValue @JsonProperty("static") String stat,
                                  @JsonInclude(JsonInclude.Include.ALWAYS) @JsonProperty("static_source") String staticSource,
                                  @JsonInclude(JsonInclude.Include.ALWAYS) @JsonProperty("static_updated_at") String staticUpdatedAt,
                                  @JsonInclude(JsonInclude.Include.ALWAYS) @JsonProperty("destination_info") DestinationInfo destinationInfo,
                                  @JsonInclude(JsonInclude.Include.ALWAYS) @JsonProperty("port_calls") PortCallsInfo portCalls) {}
}
