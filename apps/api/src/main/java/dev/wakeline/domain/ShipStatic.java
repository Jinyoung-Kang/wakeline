package dev.wakeline.domain;

import java.time.Instant;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * 선박 정적·항해 정보(AIS 5·24·19 를 MMSI 별로 합친 최신값) — schemas/ship_static.v1.json 과 같은 계약.
 * 모두 선박이 입력·송신한 보고값이다(검증된 등록 정보가 아님). 받지 못했거나 '값 없음' 인 필드는 null.
 * ETA 는 연도가 없는 선원 입력값(UTC). updated_at = 수집기 메모리(ShipBook)에서 이 정적 정보의 내용(또는 받은 필드)이 마지막으로 바뀐 메시지의 aisstream
 * 수신 시각 — 수집기가 다시 시작했거나 선박이 그 메모리에서 빠졌다(30분 무수신 · 상한) 다시 잡히면 같은 내용이어도 새 시각이다(첫 수신이 아니다 — 계약 v5 §G17).
 * <p>received(계약 v5 §G19): 수집기 레코드가 시작된 뒤(재시작 · 제거 뒤 새로) 실제로 받은 필드({@link #FIELDS} 의 이름) — 스트림 payload
 * {@code static_received}. 받은 필드의 null 은 '빈 값으로 받음', 받지 않은 필드의 null 은 '받지 않음'. null = 모름(DB 에서 읽은 행 · 받은 필드를 싣지 않는
 * 이전 수집기 · 시험). 화면 · WS · REST 로는 내보내지 않는다(저장 규칙에만 쓴다 — {@link #written()}).
 */
public record ShipStatic(String mmsi, String name, String callSign, Integer imo, Integer shipType,
                         Integer dimA, Integer dimB, Integer dimC, Integer dimD, Double draughtM, String destination,
                         Integer etaMonth, Integer etaDay, Integer etaHour, Integer etaMinute, Instant updatedAt, String provider,
                         Set<String> received) {
    /** 정적 필드 이름 = 스트림 계약(ship_static.v1)의 키 = DB ship 열 이름(수집기 parse.STATIC_FIELDS 와 같은 순서). */
    public static final List<String> FIELDS = List.of("name", "call_sign", "imo", "ship_type", "dim_a", "dim_b", "dim_c", "dim_d", "draught_m",
            "destination", "eta_month", "eta_day", "eta_hour", "eta_minute");

    public ShipStatic {
        if (received != null) {
            for (String f : received) if (!FIELDS.contains(f)) throw new IllegalArgumentException("unknown static field: " + f);
            received = Set.copyOf(received);
        }
    }

    /** 받은 필드를 모르는 정적 정보(DB 에서 읽은 행 · 이전 수집기 · 시험). */
    public ShipStatic(String mmsi, String name, String callSign, Integer imo, Integer shipType,
                      Integer dimA, Integer dimB, Integer dimC, Integer dimD, Double draughtM, String destination,
                      Integer etaMonth, Integer etaDay, Integer etaHour, Integer etaMinute, Instant updatedAt, String provider) {
        this(mmsi, name, callSign, imo, shipType, dimA, dimB, dimC, dimD, draughtM, destination, etaMonth, etaDay, etaHour, etaMinute, updatedAt,
                provider, null);
    }

    /** {@link #FIELDS} 이름 → 값. */
    public Object value(String field) {
        return switch (field) {
            case "name" -> name;
            case "call_sign" -> callSign;
            case "imo" -> imo;
            case "ship_type" -> shipType;
            case "dim_a" -> dimA;
            case "dim_b" -> dimB;
            case "dim_c" -> dimC;
            case "dim_d" -> dimD;
            case "draught_m" -> draughtM;
            case "destination" -> destination;
            case "eta_month" -> etaMonth;
            case "eta_day" -> etaDay;
            case "eta_hour" -> etaHour;
            case "eta_minute" -> etaMinute;
            default -> throw new IllegalArgumentException("unknown static field: " + field);
        };
    }

    /**
     * 저장할 때 덮어쓸 필드(계약 v5 §G19): 받은 필드를 알면 그것(빈 값으로 받은 것도 — 선박이 비워 보냈다), 모르면 값이 있는 필드만 — null 을 '받지 않음' 으로
     * 본다(이전 수집기와의 배포 전환 중: 저장된 값을 지우지 않는 쪽. 선박이 실제로 비운 값은 새 수집기가 받은 필드를 실을 때부터 반영된다).
     */
    public Set<String> written() {
        if (received != null) return received;
        Set<String> out = new LinkedHashSet<>();
        for (String f : FIELDS) if (value(f) != null) out.add(f);
        return Set.copyOf(out);
    }

    /**
     * 같은 MMSI 의 더 새 정적 정보(newer)를 이 위에 겹친다: newer 가 덮어쓰는 필드({@link #written()})는 newer 의 값, 나머지는 이 값. 받은 필드 = 둘의 합,
     * updated_at · provider = newer 것. 한 저장 배치 안의 같은 MMSI 행을 한 행으로 합칠 때 쓴다(ShipRepository.upsertStatics).
     */
    public ShipStatic overlay(ShipStatic newer) {
        Set<String> top = newer.written();
        Set<String> union = new LinkedHashSet<>(written());
        union.addAll(top);
        java.util.function.Function<String, Object> v = f -> top.contains(f) ? newer.value(f) : value(f);
        return new ShipStatic(mmsi, (String) v.apply("name"), (String) v.apply("call_sign"), (Integer) v.apply("imo"), (Integer) v.apply("ship_type"),
                (Integer) v.apply("dim_a"), (Integer) v.apply("dim_b"), (Integer) v.apply("dim_c"), (Integer) v.apply("dim_d"),
                (Double) v.apply("draught_m"), (String) v.apply("destination"), (Integer) v.apply("eta_month"), (Integer) v.apply("eta_day"),
                (Integer) v.apply("eta_hour"), (Integer) v.apply("eta_minute"), newer.updatedAt(), newer.provider(), union);
    }
}
