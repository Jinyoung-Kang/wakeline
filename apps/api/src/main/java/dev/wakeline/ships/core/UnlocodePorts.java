package dev.wakeline.ships.core;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.BitSet;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * UN/LOCODE 항구·내륙항 표(계약 v4 §B) — tools/gen_unlocode.py 가 만든 resources/data/unlocode-ports.tsv(ODC-PDDL-1.0, 원천 UNECE).
 * JVM 에서 한 번 읽는다({@link #bundled}). 약 17,500 행을 정렬된 int 키(5자 코드의 36진수) + 이름·행정구역 배열로 두고
 * 항목마다 객체를 만들지 않는다(조회는 이진 탐색). 형식이 틀린 행·중복 코드는 싣지 않는다(수는 로그).
 */
public final class UnlocodePorts {
    private static final Logger log = LoggerFactory.getLogger(UnlocodePorts.class);
    public static final String RESOURCE = "data/unlocode-ports.tsv";
    static final String HEADER = "code\tname\tcountry\tsubdivision\tfunction\tname_collision";
    static final Pattern CODE = Pattern.compile("^[A-Z]{2}[A-Z0-9]{3}$");
    static final Pattern SUBDIVISION = Pattern.compile("^[A-Z0-9]{1,3}$");
    static final Pattern FUNCTION = Pattern.compile("^[0-9B-]{8}$");
    static final int NAME_MAX = 120;

    /** 한 항목. subdivision 은 없으면 null. nameCollision = 5자 코드가 어떤 UN/LOCODE 지명(글자로만 된 이름)과 같다. */
    public record Port(String code, String name, String country, String subdivision, boolean nameCollision) {}

    private final int[] keys;
    private final String[] names;
    private final String[] subdivisions;
    private final BitSet collisions;
    private final int skipped;

    private UnlocodePorts(int[] keys, String[] names, String[] subdivisions, BitSet collisions, int skipped) {
        this.keys = keys;
        this.names = names;
        this.subdivisions = subdivisions;
        this.collisions = collisions;
        this.skipped = skipped;
    }

    private static final class Holder {
        static final UnlocodePorts BUNDLED = loadResource(RESOURCE);
    }

    /** 앱에 실린 표(처음 부를 때 한 번 읽는다 — 선박 REST·WS 빈이 기동할 때). 파일이 없거나 머리글이 틀리면 기동 실패. */
    public static UnlocodePorts bundled() { return Holder.BUNDLED; }

    static UnlocodePorts loadResource(String name) {
        try (InputStream in = UnlocodePorts.class.getClassLoader().getResourceAsStream(name)) {
            if (in == null) throw new IllegalStateException("missing classpath resource " + name);
            UnlocodePorts p = read(new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8)));
            log.info("UN/LOCODE ports loaded: {} codes ({} rows skipped)", p.size(), p.skipped());
            return p;
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    /** TSV 읽기: '#' 줄은 머리 주석, 첫 비주석 줄은 열 이름(틀리면 IllegalStateException). */
    public static UnlocodePorts read(BufferedReader in) throws IOException {
        record Row(int key, String name, String subdivision, boolean collision) {}
        List<Row> rows = new ArrayList<>(20_000);
        Map<String, String> shared = new HashMap<>(); // 행정구역 코드는 몇백 가지뿐 — 같은 문자열을 나눠 쓴다
        boolean header = false;
        int skipped = 0;
        String line;
        while ((line = in.readLine()) != null) {
            if (line.startsWith("#")) continue;
            if (!header) {
                if (!HEADER.equals(line)) throw new IllegalStateException("unexpected UN/LOCODE header: " + line);
                header = true;
                continue;
            }
            if (line.isEmpty()) continue;
            String[] f = line.split("\t", -1);
            if (f.length != 6 || !CODE.matcher(f[0]).matches() || !f[2].equals(f[0].substring(0, 2)) || f[1].isBlank() || f[1].length() > NAME_MAX
                    || !(f[3].isEmpty() || SUBDIVISION.matcher(f[3]).matches()) || !FUNCTION.matcher(f[4]).matches() || !isPort(f[4])
                    || !(f[5].equals("0") || f[5].equals("1"))) {
                skipped++;
                continue;
            }
            String sub = f[3].isEmpty() ? null : shared.computeIfAbsent(f[3], s -> s);
            rows.add(new Row(key(f[0]), f[1], sub, f[5].equals("1")));
        }
        if (!header) throw new IllegalStateException("UN/LOCODE table has no header");
        rows.sort((a, b) -> Integer.compare(a.key(), b.key()));
        int[] keys = new int[rows.size()];
        String[] names = new String[rows.size()];
        String[] subs = new String[rows.size()];
        BitSet coll = new BitSet(rows.size());
        int n = 0;
        for (Row r : rows) {
            if (n > 0 && keys[n - 1] == r.key()) { skipped++; continue; } // 중복 코드는 첫 행만
            keys[n] = r.key();
            names[n] = r.name();
            subs[n] = r.subdivision();
            if (r.collision()) coll.set(n);
            n++;
        }
        return new UnlocodePorts(Arrays.copyOf(keys, n), Arrays.copyOf(names, n), Arrays.copyOf(subs, n), coll, skipped);
    }

    /** 항구(첫 자리 '1') 또는 내륙항('8' 이 어디든) — 생성기와 같은 규칙. */
    static boolean isPort(String function) {
        return function.startsWith("1") || function.indexOf('8') >= 0;
    }

    /** 5자 코드(대문자·숫자) → 항목. 표에 없거나 형식이 틀리면 null. */
    public Port find(String code) {
        if (code == null || !CODE.matcher(code).matches()) return null;
        int i = Arrays.binarySearch(keys, key(code));
        if (i < 0) return null;
        return new Port(code, names[i], code.substring(0, 2), subdivisions[i], collisions.get(i));
    }

    public int size() { return keys.length; }

    /** 읽을 때 뺀 행 수(형식 오류·중복). */
    public int skipped() { return skipped; }

    /** [A-Z0-9]{5} → 36진수(0–9 = 0–9, A–Z = 10–35). 36^5 − 1 = 60,466,175 라 int 에 들어간다. */
    static int key(String code) {
        int k = 0;
        for (int i = 0; i < 5; i++) {
            char c = code.charAt(i);
            k = k * 36 + (c <= '9' ? c - '0' : c - 'A' + 10);
        }
        return k;
    }
}
