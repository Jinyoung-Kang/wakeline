package dev.wakeline.qa;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * QA 2026-10-aws(api-sec) 재현 시험용 원시 HTTP/1.1 클라이언트. java.net.http 는 헤더 값의 바이트(0x80–0x9F 등)와 요청 줄을 그대로 보내지 못해,
 * 소켓에 ISO-8859-1 바이트를 직접 쓴다(Tomcat 이 헤더를 ISO-8859-1 로 읽는 것과 같다). 요청마다 새 연결 · Connection: close.
 */
final class QaRawHttp {
    private QaRawHttp() {}

    record Res(int status, Map<String, List<String>> headers, String body) {
        String header(String name) {
            List<String> v = headers.get(name.toLowerCase(Locale.ROOT));
            return v == null || v.isEmpty() ? null : v.getFirst();
        }

        List<String> headers(String name) {
            List<String> v = headers.get(name.toLowerCase(Locale.ROOT));
            return v == null ? List.of() : v;
        }
    }

    /**
     * @param target  요청 줄의 대상(원문 그대로 — 퍼센트 인코딩도 그대로 간다)
     * @param headers 헤더 이름 → 값(값은 ISO-8859-1 바이트로 쓴다 — 0x80–0xFF 를 그대로 보낼 수 있다)
     */
    static Res send(int port, String method, String target, Map<String, String> headers, byte[] body) {
        try (Socket s = new Socket("127.0.0.1", port)) {
            s.setSoTimeout(60_000);
            OutputStream out = s.getOutputStream();
            StringBuilder head = new StringBuilder();
            head.append(method).append(' ').append(target).append(" HTTP/1.1\r\n");
            head.append("Host: 127.0.0.1:").append(port).append("\r\n");
            head.append("Connection: close\r\n");
            for (var e : headers.entrySet()) head.append(e.getKey()).append(": ").append(e.getValue()).append("\r\n");
            if (body != null) head.append("Content-Length: ").append(body.length).append("\r\n");
            head.append("\r\n");
            out.write(head.toString().getBytes(StandardCharsets.ISO_8859_1));
            if (body != null) out.write(body);
            out.flush();
            return read(s.getInputStream());
        } catch (IOException e) {
            throw new IllegalStateException(method + " " + target + ": " + e, e);
        }
    }

    static Res get(int port, String target, Map<String, String> headers) { return send(port, "GET", target, headers, null); }

    static Res get(int port, String target) { return send(port, "GET", target, Map.of(), null); }

    private static Res read(InputStream in) throws IOException {
        byte[] all = in.readAllBytes();
        int sep = indexOf(all, "\r\n\r\n".getBytes(StandardCharsets.ISO_8859_1));
        if (sep < 0) throw new IOException("no header end in response: " + new String(all, StandardCharsets.ISO_8859_1));
        String[] lines = new String(all, 0, sep, StandardCharsets.ISO_8859_1).split("\r\n");
        int status = Integer.parseInt(lines[0].split(" ")[1]);
        Map<String, List<String>> h = new LinkedHashMap<>();
        for (int i = 1; i < lines.length; i++) {
            int c = lines[i].indexOf(':');
            if (c < 0) continue;
            h.computeIfAbsent(lines[i].substring(0, c).trim().toLowerCase(Locale.ROOT), k -> new ArrayList<>()).add(lines[i].substring(c + 1).trim());
        }
        byte[] raw = java.util.Arrays.copyOfRange(all, sep + 4, all.length);
        List<String> te = h.get("transfer-encoding");
        if (te != null && te.stream().anyMatch(v -> v.equalsIgnoreCase("chunked"))) raw = dechunk(raw);
        return new Res(status, h, new String(raw, StandardCharsets.UTF_8));
    }

    private static byte[] dechunk(byte[] b) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        int i = 0;
        while (i < b.length) {
            int eol = indexOf(b, "\r\n".getBytes(StandardCharsets.ISO_8859_1), i);
            if (eol < 0) break;
            String size = new String(b, i, eol - i, StandardCharsets.ISO_8859_1).split(";")[0].trim();
            int n = size.isEmpty() ? 0 : Integer.parseInt(size, 16);
            if (n == 0) break;
            out.write(b, eol + 2, Math.min(n, b.length - eol - 2));
            i = eol + 2 + n + 2;
        }
        return out.toByteArray();
    }

    private static int indexOf(byte[] a, byte[] p) { return indexOf(a, p, 0); }

    private static int indexOf(byte[] a, byte[] p, int from) {
        outer:
        for (int i = from; i <= a.length - p.length; i++) {
            for (int j = 0; j < p.length; j++) if (a[i + j] != p[j]) continue outer;
            return i;
        }
        return -1;
    }
}
