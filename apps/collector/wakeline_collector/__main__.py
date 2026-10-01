import asyncio
import sys

from wakeline_collector.main import main

if __name__ == "__main__":
    sys.exit(asyncio.run(main()))  # 1 = 작업 태스크가 예상 밖으로 끝났다(main)
