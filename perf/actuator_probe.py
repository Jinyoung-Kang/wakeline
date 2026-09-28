"""api 관리 포트(9000, 내부 전용)의 Prometheus 지표에서 누적 요청·5xx·힙을 읽는다. 같은 도커 네트워크의 일회용 컨테이너에서 stdin 으로 실행한다."""
import re
import urllib.request

t = urllib.request.urlopen("http://10.77.0.30:9000/actuator/prometheus", timeout=5).read().decode()


def total(pattern: str) -> float:
    return sum(float(m.group(1)) for m in re.finditer(pattern, t, re.M))


req = total(r'^http_server_requests_seconds_count\{[^}]*\} ([0-9.eE+-]+)')
err = total(r'^http_server_requests_seconds_count\{[^}]*status="5\d\d"[^}]*\} ([0-9.eE+-]+)')
heap = total(r'^jvm_memory_used_bytes\{[^}]*area="heap"[^}]*\} ([0-9.eE+-]+)')
print(f"api 누적 요청 {req:.0f} · 5xx {err:.0f} ({(100 * err / req if req else 0):.3f} %) · 힙 사용 {heap / 2**20:.0f} MiB")
