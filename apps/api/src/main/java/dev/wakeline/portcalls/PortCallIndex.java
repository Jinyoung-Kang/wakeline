package dev.wakeline.portcalls;

import dev.wakeline.platform.data.ReadPool;
import dev.wakeline.platform.data.Sql;
import dev.wakeline.persist.TrackRepository;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

import java.sql.Array;
import java.sql.Date;
import java.sql.SQLException;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.Map;
import java.util.TreeSet;

/**
 * 한국 항만 입출항 색인 읽기(ADR-022 개정 · V15). 수집기가 항만청 10곳의 KST 날짜별 신고를 모두 받아 port_call 에 두고, 항만청마다 끝까지 색인한
 * 날짜 범위를 port_call_coverage 에 적는다 — api 는 읽기만 한다(SELECT 권한뿐). 문장마다 공개 조회 상한({@link Sql#PUBLIC_READ_TIMEOUT_S} s)을 건다
 * (실패는 호출자가 status error 로 말한다). 운영은 선택 조회 전용 풀({@link ReadPool} — 연결 대기 ≤ 문장 상한, 계약 v5 §G18)로 읽고, 부르는 쪽은 WS 세션
 * 우편함 밖의 선택 조회 실행기다(ShipFanout · ShipLookups).
 */
@Repository
public class PortCallIndex implements PortCallReader.Source {
    private final JdbcClient db;

    @Autowired
    public PortCallIndex(ReadPool pool) { this(pool.jdbc()); }

    /** 시험용: 주어진 연결 출처로 읽는다. */
    public PortCallIndex(JdbcClient db) { this.db = db; }

    /** 항만청별 색인 범위와 빈 곳(행이 없는 항만청은 아직 색인하지 않았다). 배열(hole_days)은 연결을 돌려주기 전에 행 안에서 풀어 둔다. */
    @Override
    public List<Coverage> coverage() {
        return Sql.publicRead(db, "portcalls.coverage", "SELECT prt_ag_cd, covered_from, covered_to, refreshed_at, hole_days FROM port_call_coverage")
                .query((rs, n) -> new Coverage(rs.getString("prt_ag_cd"), date(rs.getObject("covered_from")), date(rs.getObject("covered_to")),
                        TrackRepository.toInstant(rs.getObject("refreshed_at")), dates(rs.getArray("hole_days"))))
                .list();
    }

    /** date[] → 날짜(오름차순 · 중복 없음). NULL 원소는 V15 CHECK 가 막지만 읽을 때도 버린다. */
    static List<LocalDate> dates(Array a) throws SQLException {
        if (a == null) return List.of();
        try {
            TreeSet<LocalDate> out = new TreeSet<>();
            for (Object x : (Object[]) a.getArray()) {
                LocalDate d = date(x);
                if (d != null) out.add(d);
            }
            return List.copyOf(out);
        } finally {
            a.free();
        }
    }

    /**
     * 정규화한 호출부호의 기록 — 목록 날짜(KST)가 [from, to] 인 것, 최근 순(입항 · 출항 시각 중 늦은 것, 모르면 뒤 · 같으면 목록 날짜 · 항만청 순), 많아야 limit 건.
     * 인덱스 port_call_clsgn_idx (clsgn, listed_date DESC) 를 쓴다.
     */
    @Override
    public List<Row> byCallSign(String callSign, LocalDate from, LocalDate to, int limit) {
        return Sql.publicRead(db, "portcalls.by_call_sign", """
                SELECT prt_ag_cd, prt_ag_nm, clsgn, listed_date, vssl_nm, nationality_nm, kind_nm, purpose_nm,
                       first_port_cd, first_port_nm, prev_port_cd, prev_port_nm, next_port_cd, next_port_nm, dest_port_cd, dest_port_nm,
                       entry_at, entry_revision, exit_at, exit_revision, berth, fetched_at
                FROM port_call
                WHERE clsgn = :cs AND listed_date BETWEEN :from AND :to
                ORDER BY greatest(entry_at, exit_at) DESC NULLS LAST, listed_date DESC, prt_ag_cd, etrypt_year DESC, etrypt_co DESC
                LIMIT :limit""")
                .param("cs", callSign).param("from", from).param("to", to).param("limit", limit)
                .query().listOfRows().stream().map(PortCallIndex::row).toList();
    }

    static Row row(Map<String, Object> r) {
        return new Row(str(r, "prt_ag_cd"), str(r, "prt_ag_nm"), str(r, "clsgn"), date(r.get("listed_date")), str(r, "vssl_nm"), str(r, "nationality_nm"),
                str(r, "kind_nm"), str(r, "purpose_nm"), str(r, "first_port_cd"), str(r, "first_port_nm"), str(r, "prev_port_cd"), str(r, "prev_port_nm"),
                str(r, "next_port_cd"), str(r, "next_port_nm"), str(r, "dest_port_cd"), str(r, "dest_port_nm"),
                TrackRepository.toInstant(r.get("entry_at")), str(r, "entry_revision"), TrackRepository.toInstant(r.get("exit_at")), str(r, "exit_revision"),
                str(r, "berth"), TrackRepository.toInstant(r.get("fetched_at")));
    }

    private static String str(Map<String, Object> r, String k) {
        Object v = r.get(k);
        return v == null ? null : v.toString();
    }

    private static LocalDate date(Object v) {
        if (v instanceof LocalDate d) return d;
        if (v instanceof Date d) return d.toLocalDate();
        return null;
    }

    /**
     * 항만청 하나의 색인 범위: [coveredFrom, coveredTo](KST 날짜)의 모든 날을 받았다 — holeDays(빈 곳: 받았지만 끝까지 색인하지 못한 날)만 빼고 끝까지
     * 색인했다 · refreshedAt = 마지막으로 끝난 꼬리 갱신(최근 3일)이 시작한 때(없으면 null).
     */
    public record Coverage(String portAuthority, LocalDate coveredFrom, LocalDate coveredTo, Instant refreshedAt, List<LocalDate> holeDays) {
        public Coverage {
            holeDays = holeDays == null ? List.of() : List.copyOf(holeDays);
        }

        /** 빈 곳이 없는 범위. */
        public Coverage(String portAuthority, LocalDate coveredFrom, LocalDate coveredTo, Instant refreshedAt) {
            this(portAuthority, coveredFrom, coveredTo, refreshedAt, List.of());
        }
    }

    /** port_call 한 행(화면에 쓰는 열만). */
    public record Row(String portAuthorityCode, String portAuthority, String callSign, LocalDate listedDate, String reportedName, String nationality,
                      String kind, String purpose, String firstPortCode, String firstPortName, String prevPortCode, String prevPortName,
                      String nextPortCode, String nextPortName, String destPortCode, String destPortName, Instant entryAt, String entryRevision,
                      Instant exitAt, String exitRevision, String berth, Instant fetchedAt) {}
}
