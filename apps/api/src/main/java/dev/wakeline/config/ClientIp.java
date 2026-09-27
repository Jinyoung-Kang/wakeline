package dev.wakeline.config;

import jakarta.servlet.http.HttpServletRequest;

/**
 * 클라이언트 IP 해석. X-Forwarded-For 는 요청이 edge(고정 IP)에서 왔을 때만 믿는다.
 * edge 가 XFF 를 실제 접속 주소로 덮어쓰므로 첫 값이 곧 클라이언트다. 그 밖의 경로(직접 접속·위조)는 remote address 를 쓴다.
 */
public final class ClientIp {
    public static final String ATTR = "wakeline.clientIp";

    private ClientIp() {}

    public static String resolve(HttpServletRequest req, String trustedProxy) {
        Object cached = req.getAttribute(ATTR);
        if (cached instanceof String s) return s;
        String remote = req.getRemoteAddr();
        String ip = remote;
        if (trustedProxy != null && !trustedProxy.isBlank() && trustedProxy.equals(remote)) {
            String xff = req.getHeader("X-Forwarded-For");
            if (xff != null && !xff.isBlank()) {
                String first = xff.split(",")[0].trim();
                if (!first.isEmpty() && first.length() <= 45) ip = first;
            }
        }
        req.setAttribute(ATTR, ip);
        return ip;
    }
}
