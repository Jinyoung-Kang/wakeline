package dev.wakeline;

import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Package rules (ADR-028 · CTO review 2026-10 api §2.1), checked from source (no ArchUnit, no new dependency): imports + fully qualified
 * references in src/main/java. The rule names are in violations() and in ADR-028.
 * Ratchet: KNOWN lists the violations accepted for now and MAX_CYCLE_EDGES the imports inside package cycles. A new violation fails; a
 * KNOWN entry that disappeared also fails (delete it), and so does a cycle count below the constant (lower it) — the numbers only go down.
 */
class ArchitectureTest {
    static final Path MAIN = Path.of("src/main/java");
    static final String ROOT = "dev.wakeline.";

    static final List<String> DATA_APIS = List.of("org.springframework.jdbc", "java.sql", "javax.sql", "com.zaxxer",
            "org.springframework.data.redis", "io.lettuce");
    static final List<String> WEB_APIS = List.of("jakarta.servlet", "org.springframework.web", "org.springframework.http",
            "org.apache.catalina", "org.apache.tomcat");

    /** Class-level imports inside package cycles. 0 since the end of phase 1 — any package cycle fails. */
    static final int MAX_CYCLE_EDGES = 0;
    static final Set<String> KNOWN = Set.of(
            "controller-data-access|ops.OpsPipelineController|org.springframework.data.redis.core",
            "controller-data-access|weather.web.WeatherController|org.springframework.data.redis.core");

    record Src(String cls, String pkg, boolean controller, Set<String> refs) {}

    static final Pattern IMPORT = Pattern.compile("(?m)^import\\s+(?:static\\s+)?([\\w.]+?)(?:\\.\\*)?;");
    /** Inline fully qualified names (field types, `new dev.wakeline.x.Y`, string class names): package part only. */
    static final Pattern FQN = Pattern.compile("\\b((?:dev|org|java|javax|jakarta|com|io|tools)(?:\\.[a-z]\\w*)+)\\.[A-Z]");
    static final Pattern CONTROLLER = Pattern.compile("@(Rest)?Controller\\b");

    static List<Src> sources() throws IOException {
        List<Src> out = new ArrayList<>();
        try (Stream<Path> files = Files.walk(MAIN)) {
            for (Path p : files.filter(f -> f.toString().endsWith(".java")).sorted().toList()) {
                String code = Files.readString(p, StandardCharsets.UTF_8).replaceAll("(?s)/\\*.*?\\*/", "").replaceAll("(?m)//.*$", "");
                String cls = MAIN.relativize(p).toString().replace('\\', '/').replace('/', '.').replaceAll("\\.java$", "");
                Set<String> refs = new TreeSet<>();
                Matcher m = IMPORT.matcher(code);
                while (m.find()) refs.add(packageOf(m.group(1)));
                Matcher fq = FQN.matcher(code.replaceAll("(?m)^(import|package)\\s.*$", ""));
                while (fq.find()) refs.add(fq.group(1));
                out.add(new Src(cls, cls.substring(0, cls.lastIndexOf('.')), CONTROLLER.matcher(code).find(), refs));
            }
        }
        return out;
    }

    /** a.b.Cls / a.b.Cls.member / a.b → a.b */
    static String packageOf(String name) {
        StringBuilder b = new StringBuilder();
        for (String s : name.split("\\.")) {
            if (!s.isEmpty() && Character.isUpperCase(s.charAt(0))) break;
            if (!b.isEmpty()) b.append('.');
            b.append(s);
        }
        return b.toString();
    }

    static String rel(String pkg) { return pkg.startsWith(ROOT) ? pkg.substring(ROOT.length()) : pkg.equals("dev.wakeline") ? "(root)" : pkg; }
    static boolean ours(String pkg) { return pkg.equals("dev.wakeline") || pkg.startsWith(ROOT); }
    static boolean under(String pkg, String prefix) { return pkg.equals(prefix) || pkg.startsWith(prefix + "."); }
    static boolean anyUnder(String pkg, List<String> prefixes) { return prefixes.stream().anyMatch(a -> under(pkg, a)); }
    static String feature(String relPkg) { int i = relPkg.indexOf('.'); return i < 0 ? relPkg : relPkg.substring(0, i); }

    static Set<String> violations(List<Src> srcs) {
        Set<String> v = new TreeSet<>();
        for (Src s : srcs) {
            String from = rel(s.pkg());
            String who = rel(s.cls());
            for (String to : s.refs()) {
                if (!ours(to)) {
                    if (s.controller() && anyUnder(to, DATA_APIS)) v.add("controller-data-access|" + who + "|" + to);
                    if ((from.endsWith(".core") || from.equals("geo")) && (anyUnder(to, DATA_APIS) || anyUnder(to, WEB_APIS)))
                        v.add("core-imports-io|" + who + "|" + to);
                    if (from.endsWith(".data") && anyUnder(to, WEB_APIS)) v.add("data-imports-web|" + who + "|" + to);
                    continue;
                }
                String t = rel(to);
                if (t.equals(from)) continue;
                // target layout (ADR-028)
                if (under(from, "platform") && !under(t, "platform") && !t.equals("geo")) v.add("platform-imports-feature|" + who + "|" + t);
                if (from.equals("geo")) v.add("geo-imports|" + who + "|" + t);
                if (from.endsWith(".core") && !(t.endsWith(".core") || t.equals("geo") || t.equals("platform.support")))
                    v.add("core-imports-outer|" + who + "|" + t);
                if (from.endsWith(".data") && !(t.endsWith(".core") || t.equals("geo") || t.equals("platform.support")
                        || t.equals("platform.data") || t.equals("platform.config")))
                    v.add("data-imports-outer|" + who + "|" + t);
                if (under(t, "ws") && !under(from, "ws")) v.add("only-ws-imports-ws|" + who + "|" + t);
                if (under(from, "ops") && under(t, "logs")) v.add("ops-imports-logs|" + who + "|" + t);
                // ingest is the stream adapter (no state stores): only ops and status read it (pipeline signals, ingest health)
                if (under(t, "ingest") && !Set.of("ingest", "ops", "status").contains(feature(from)))
                    v.add("ingest-is-an-adapter|" + who + "|" + t);
            }
        }
        return v;
    }

    /** class-level references whose two packages are in the same strongly connected component */
    static Set<String> cycleEdges(List<Src> srcs) {
        Map<String, Set<String>> g = new TreeMap<>();
        for (Src s : srcs) for (String to : s.refs())
            if (ours(to) && !to.equals(s.pkg())) g.computeIfAbsent(s.pkg(), k -> new TreeSet<>()).add(to);
        Map<String, Integer> comp = components(g);
        Set<String> out = new TreeSet<>();
        for (Src s : srcs) for (String to : s.refs())
            if (ours(to) && !to.equals(s.pkg()) && comp.containsKey(s.pkg()) && comp.get(s.pkg()).equals(comp.get(to)))
                out.add(rel(s.cls()) + " -> " + rel(to));
        return out;
    }

    /** Tarjan: package → component id, only for components with more than one package. */
    static Map<String, Integer> components(Map<String, Set<String>> g) {
        Map<String, Integer> idx = new HashMap<>(), low = new HashMap<>(), comp = new HashMap<>();
        Deque<String> stack = new ArrayDeque<>();
        Set<String> on = new HashSet<>();
        int[] counter = {0, 0};
        Set<String> nodes = new TreeSet<>(g.keySet());
        g.values().forEach(nodes::addAll);
        for (String n : nodes) if (!idx.containsKey(n)) strong(n, g, idx, low, stack, on, comp, counter);
        return comp;
    }

    private static void strong(String v, Map<String, Set<String>> g, Map<String, Integer> idx, Map<String, Integer> low, Deque<String> stack,
                               Set<String> on, Map<String, Integer> comp, int[] counter) {
        idx.put(v, counter[0]);
        low.put(v, counter[0]++);
        stack.push(v);
        on.add(v);
        for (String w : g.getOrDefault(v, Set.of())) {
            if (!idx.containsKey(w)) { strong(w, g, idx, low, stack, on, comp, counter); low.put(v, Math.min(low.get(v), low.get(w))); }
            else if (on.contains(w)) low.put(v, Math.min(low.get(v), idx.get(w)));
        }
        if (low.get(v).equals(idx.get(v))) {
            List<String> c = new ArrayList<>();
            String w;
            do { w = stack.pop(); on.remove(w); c.add(w); } while (!w.equals(v));
            if (c.size() > 1) { int id = ++counter[1]; c.forEach(p -> comp.put(p, id)); }
        }
    }

    @Test
    void packageRulesHold() throws IOException {
        assertThat(MAIN).as("run from apps/api (the gradle test working directory)").isDirectory();
        List<Src> srcs = sources();
        Set<String> now = violations(srcs);
        Set<String> added = new TreeSet<>(now);
        added.removeAll(KNOWN);
        Set<String> gone = new TreeSet<>(KNOWN);
        gone.removeAll(now);
        assertThat(added).as("new package-rule violations (see the rule name before the first '|')").isEmpty();
        assertThat(gone).as("fixed — delete these from KNOWN").isEmpty();
    }

    @Test
    void packageCyclesOnlyShrink() throws IOException {
        Set<String> edges = cycleEdges(sources());
        assertThat(edges.size()).as("imports inside package cycles went up (all of them below)\n" + String.join("\n", edges))
                .isLessThanOrEqualTo(MAX_CYCLE_EDGES);
        assertThat(edges.size()).as("cycle imports went down — lower MAX_CYCLE_EDGES to " + edges.size()).isEqualTo(MAX_CYCLE_EDGES);
    }
}
