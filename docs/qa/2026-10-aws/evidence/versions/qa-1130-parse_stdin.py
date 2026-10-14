import sys
from wakeline_collector import airspace
data = sys.stdin.buffer.read(airspace.MAX_INPUT_BYTES + 1)
try:
    airspace.parse(data)
    print("accepted"); sys.exit(0)
except airspace.AirspaceError as e:
    print(f"거절: {e}", file=sys.stderr); sys.exit(1)
