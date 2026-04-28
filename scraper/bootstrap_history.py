# bootstrap_history.py
# 一次性：爬取整個民國 114 年（12 個月）的金控月自結損益歸檔，
# 用來當作 115 年 YoY 比較基準。
#
# 執行方式：python scraper/bootstrap_history.py
# 約耗時 60-90 分鐘（13 家 × 12 個月 × MOPS 速率限制）。
#
# 已存在的 114-MM.json 預設跳過（idempotent）；--force 才重爬。

import sys
import argparse
import logging
import subprocess
from pathlib import Path

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] bootstrap: %(message)s",
)
logger = logging.getLogger(__name__)

BASE_DIR = Path(__file__).parent.parent
DATA_DIR = BASE_DIR / "docs" / "data"
SCRAPER_DIR = Path(__file__).parent


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--year", default="114", help="目標民國年（預設 114）")
    ap.add_argument(
        "--months",
        nargs="+",
        type=int,
        default=list(range(1, 13)),
        help="要爬的月份（1-12，預設全部）",
    )
    ap.add_argument(
        "--force",
        action="store_true",
        help="強制重爬，即使檔案已存在",
    )
    args = ap.parse_args()

    total = len(args.months)
    success = 0
    skipped = 0
    failed = []

    for i, m in enumerate(args.months, 1):
        period = f"{args.year}/{m:02d}"
        period_file = DATA_DIR / f"{args.year}-{m:02d}.json"

        if period_file.exists() and not args.force:
            logger.info(f"[{i}/{total}] {period} already exists → skip")
            skipped += 1
            continue

        logger.info(f"[{i}/{total}] Scraping {period}...")
        try:
            result = subprocess.run(
                [sys.executable, "main.py", "--month", period],
                cwd=SCRAPER_DIR,
                check=False,
            )
            # main.py exit code 1 表示有公司失敗，不視為整體失敗
            if result.returncode in (0, 1) and period_file.exists():
                success += 1
                logger.info(f"[{i}/{total}] {period} done")
            else:
                failed.append(period)
                logger.error(f"[{i}/{total}] {period} FAILED (exit={result.returncode})")
        except Exception as e:
            failed.append(period)
            logger.error(f"[{i}/{total}] {period} exception: {e}")

    logger.info(
        f"\n{'='*50}\n"
        f"Bootstrap complete: success={success}, skipped={skipped}, failed={len(failed)}\n"
        f"Failed periods: {failed if failed else 'none'}\n"
        f"{'='*50}"
    )


if __name__ == "__main__":
    main()
