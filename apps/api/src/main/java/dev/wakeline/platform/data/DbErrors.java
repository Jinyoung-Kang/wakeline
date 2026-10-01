package dev.wakeline.platform.data;

import org.springframework.dao.DataAccessResourceFailureException;
import org.springframework.dao.NonTransientDataAccessResourceException;
import org.springframework.dao.RecoverableDataAccessException;
import org.springframework.dao.TransientDataAccessException;
import org.springframework.transaction.CannotCreateTransactionException;

import java.sql.SQLException;

/**
 * DB 쓰기 오류의 분류 — 쓰기 큐(OrderedWriter · 항적 · 선박 저장기)가 다시 시도할지, 몇 번 뒤 버릴지를 이것으로 정한다(리뷰 cto-2026-10 D3 · api §2.5-2:
 * 예전에는 OrderedWriter.isTransient · TrackWriter.isPermanent/isUnclassified 로 흩어져 저장기끼리 서로의 클래스를 빌려 썼다).
 */
public final class DbErrors {
    private DbErrors() {}

    /**
     * 기다리면 나을 오류인가: 연결 실패·풀 대기 초과·타임아웃·교착/직렬화 실패, 또는 SQLState 08(연결)·53(자원 부족)·57P(관리자 종료)·40(롤백)·
     * 55P03(lock_not_available — lock_timeout 5 s. Spring 의 기본 번역이 부류 55 를 몰라 UncategorizedSQLException 으로 온다 — 조사 2026-10-01).
     * 제약 위반·권한·문법 오류는 기다려도 같다.
     */
    public static boolean isTransient(Throwable e) {
        if (e instanceof DataAccessResourceFailureException || e instanceof NonTransientDataAccessResourceException
                || e instanceof TransientDataAccessException || e instanceof RecoverableDataAccessException
                || e instanceof CannotCreateTransactionException) return true;
        for (Throwable c = e; c != null; c = c.getCause() == c ? null : c.getCause()) {
            if (c instanceof SQLException s && s.getSQLState() != null) {
                String st = s.getSQLState();
                if (st.startsWith("08") || st.startsWith("53") || st.startsWith("57P") || st.startsWith("40") || st.equals("55P03")) return true;
            }
        }
        return false;
    }

    /**
     * 재시도해도 같은 결과인 오류: SQLState 21(카디널리티 — 한 문장이 같은 행을 두 번 upsert)·22(데이터)·23(제약 — 파티션 없음 포함)·
     * 42(문법·권한). 파티션 없음은 3회 재시도 사이에 ensurePartitions 가 만들 수 있어 바로 버리지 않는다. 연결·자원 오류는 일시 장애로 본다.
     */
    public static boolean isPermanent(Throwable e) {
        if (isTransient(e)) return false;
        for (Throwable c = e; c != null; c = c.getCause() == c ? null : c.getCause()) {
            if (c instanceof SQLException s && s.getSQLState() != null) {
                String st = s.getSQLState();
                return st.startsWith("21") || st.startsWith("22") || st.startsWith("23") || st.startsWith("42");
            }
        }
        return false;
    }

    /**
     * 분류할 수 없는 오류(리뷰 cto-2026-10 D3): 일시 장애로 아는 종류({@link #isTransient})도 아니고 원인 사슬에 SQLState 도 없다 — 쓰기 코드의
     * 결함(예: 문장 값을 채우는 람다의 예외)이나 상태 없는 드라이버 · 번역 예외다. 예전에는 일시 장애처럼 같은 배치를 끝없이 다시 시도해 큐 머리를 막았다
     * (새 행이 넘쳐 버려지고 영수증이 묶였다). 항적 · 선박 저장기는 영구 오류처럼 PERMANENT_ATTEMPTS(3)번 뒤 버리고 ERROR 로 남긴다(OrderedWriter 와 같은 결과).
     * SQLState 가 있는데 영구 · 일시 어느 쪽도 아닌 것은 전처럼 다시 시도한다.
     */
    public static boolean isUnclassified(Throwable e) {
        if (isTransient(e)) return false;
        for (Throwable c = e; c != null; c = c.getCause() == c ? null : c.getCause())
            if (c instanceof SQLException s && s.getSQLState() != null) return false;
        return true;
    }
}
