"""QA-1130 탐침: 작은 KMZ(bzip2 · LZMA 멤버)를 airspace.kml_bytes 로 읽을 때 최고 메모리(tracemalloc)."""
import io, sys, time, tracemalloc, zipfile

try:
    from wakeline_collector import airspace
    kml_bytes, Err, src = airspace.kml_bytes, airspace.AirspaceError, "wakeline_collector.airspace"
    LIMIT = airspace.MAX_KML_BYTES
except ImportError:  # 같은 규칙의 사본(표준 라이브러리만 있는 이미지에서)
    import zlib
    LIMIT = 20 * 2**20
    class Err(ValueError): pass
    def kml_bytes(data):
        z = zipfile.ZipFile(io.BytesIO(data)); k = [i for i in z.infolist() if i.filename.endswith(".kml")]
        out = bytearray()
        with z.open(k[0]) as f:
            while chunk := f.read(1 << 16):
                out += chunk
                if len(out) > LIMIT: raise Err("KML larger than limit when unpacked")
        return bytes(out)
    src = "copy of kml_bytes"

def kmz(method, mib):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", method) as z, z.open("doc.kml", "w", force_zip64=True) as w:
        block = b" " * (1 << 20)
        for _ in range(mib): w.write(block)
    return buf.getvalue()

mib = int(sys.argv[1]) if len(sys.argv) > 1 else 256
print(f"python {sys.version.split()[0]} · {src} · limit {LIMIT >> 20} MiB · member {mib} MiB unpacked")
for name, method in (("bzip2", zipfile.ZIP_BZIP2), ("lzma", zipfile.ZIP_LZMA), ("deflate", zipfile.ZIP_DEFLATED)):
    data = kmz(method, mib)
    tracemalloc.start(); t = time.perf_counter()
    try:
        kml_bytes(data); res = "accepted"
    except Err as e:
        res = f"{type(e).__name__}: {e}"
    peak = tracemalloc.get_traced_memory()[1]; tracemalloc.stop()
    print(f"{name:8s} kmz={len(data):>8,d} B  peak={peak / 2**20:8.1f} MiB  {time.perf_counter() - t:5.2f}s  -> {res}")
