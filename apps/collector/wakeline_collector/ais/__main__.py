import asyncio
import sys

from wakeline_collector.ais.main import main

if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
