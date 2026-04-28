# market_summary.py
# 為指定月份的金控資料補上「本月市場概況」欄位（market_summary）。
#
# 抓取的指標（target month-end vs previous month-end）：
#   1. 美元兌台幣匯率（yfinance TWD=X）
#   2. 台股加權指數（yfinance ^TWII）
#   3. 台股月日均成交額（TWSE FMTQIK API）
#   4. 美股 S&P 500（yfinance ^GSPC）
#   5. 美國 10 年期公債殖利率（yfinance ^TNX，單位 % → bps）
#
# 預設目標月份為「上個月」（每月 5 號 cron 跑時，上個月已結束）。
# 結果寫入 docs/data/{period}.json 的 market_summary 欄位，並同步 latest.json
# （若 latest.json 指向同一期）。若該期月份檔不存在，會建立 stub 並更新 index.json。

import sys
import json
import logging
import argparse
import calendar
from datetime import datetime, timedelta
from pathlib import Path

import requests

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler("scraper.log", encoding="utf-8"),
    ],
)
logger = logging.getLogger(__name__)

BASE_DIR = Path(__file__).parent.parent
DATA_DIR = BASE_DIR / "docs" / "data"


# ── 期間工具 ─────────────────────────────────────────────

def default_period() -> str:
    """回傳「上個月」的民國年/月，例 2026-05 跑 → 115/04"""
    now = datetime.now()
    first = now.replace(day=1)
    prev = first - timedelta(days=1)
    return f"{prev.year - 1911:03d}/{prev.month:02d}"


def parse_period(period: str) -> tuple[int, int]:
    """115/04 → (2026, 4)"""
    roc, m = period.split("/")
    return int(roc) + 1911, int(m)


def prev_month(year: int, month: int) -> tuple[int, int]:
    return (year - 1, 12) if month == 1 else (year, month - 1)


# ── yfinance：取月末最後交易日收盤 ───────────────────────

def fetch_yf_month_end(symbol: str, year: int, month: int) -> tuple[datetime, float] | None:
    """
    回傳 (last_trading_date, close)。
    抓該月的所有交易日，取最後一筆。週末／假日自動跳過。
    """
    try:
        import yfinance as yf
    except ImportError:
        logger.error("yfinance not installed (pip install yfinance)")
        return None

    last_day = calendar.monthrange(year, month)[1]
    # 多抓幾天 buffer
    start = datetime(year, month, 1) - timedelta(days=3)
    end = datetime(year, month, last_day) + timedelta(days=2)

    try:
        df = yf.download(
            symbol, start=start.date(), end=end.date(),
            progress=False, auto_adjust=False, threads=False,
        )
    except Exception as e:
        logger.warning(f"yfinance download failed for {symbol}: {e}")
        return None

    if df is None or df.empty:
        logger.warning(f"yfinance returned empty for {symbol} {year}-{month:02d}")
        return None

    # 過濾到目標月份
    df = df[df.index.month == month]
    if df.empty:
        logger.warning(f"No trading days in {symbol} for {year}-{month:02d}")
        return None

    last = df.iloc[-1]
    close = last["Close"]
    # yfinance 可能回傳 DataFrame 或 Series（多 ticker 模式）；統一轉 float
    if hasattr(close, "iloc"):
        close = close.iloc[0]
    return df.index[-1].to_pydatetime(), float(close)


# ── TWSE：月日均成交金額 ────────────────────────────────

def fetch_twse_avg_turnover(year: int, month: int) -> tuple[float, int] | None:
    """
    呼叫 TWSE FMTQIK，取得當月每個交易日的成交金額（元），
    回傳 (日均成交金額_億元, 交易日數)。
    """
    url = "https://www.twse.com.tw/rwd/zh/afterTrading/FMTQIK"
    params = {"date": f"{year}{month:02d}01", "response": "json"}
    try:
        r = requests.get(url, params=params, timeout=20)
        r.raise_for_status()
        payload = r.json()
    except Exception as e:
        logger.warning(f"TWSE FMTQIK failed for {year}-{month:02d}: {e}")
        return None

    rows = payload.get("data") or []
    if not rows:
        logger.warning(f"TWSE FMTQIK empty for {year}-{month:02d}")
        return None

    # rows 結構：[日期, 成交股數, 成交金額, 成交筆數, 加權指數, 漲跌點數]
    turnovers = []
    for row in rows:
        if len(row) < 3:
            continue
        try:
            t = float(row[2].replace(",", ""))  # 成交金額（元）
            turnovers.append(t)
        except (ValueError, AttributeError):
            continue

    if not turnovers:
        return None

    avg_yuan = sum(turnovers) / len(turnovers)
    avg_yi = avg_yuan / 1e8  # → 億元
    return avg_yi, len(turnovers)


# ── 組合一個月的資料 ────────────────────────────────────

def collect_month(year: int, month: int) -> dict:
    """回傳該月最後交易日的各項收盤值。"""
    out = {"year": year, "month": month}

    twd = fetch_yf_month_end("TWD=X", year, month)
    if twd:
        out["usdtwd_date"] = twd[0].date().isoformat()
        out["usdtwd"] = round(twd[1], 4)

    twii = fetch_yf_month_end("^TWII", year, month)
    if twii:
        out["taiex_date"] = twii[0].date().isoformat()
        out["taiex"] = round(twii[1], 2)

    avg_to = fetch_twse_avg_turnover(year, month)
    if avg_to:
        out["taiex_avg_turnover_yi"] = round(avg_to[0], 1)
        out["taiex_trading_days"] = avg_to[1]

    spx = fetch_yf_month_end("^GSPC", year, month)
    if spx:
        out["spx_date"] = spx[0].date().isoformat()
        out["spx"] = round(spx[1], 2)

    tnx = fetch_yf_month_end("^TNX", year, month)
    if tnx:
        # ^TNX 已是百分比（例：4.25 表 4.25%）
        out["us10y_date"] = tnx[0].date().isoformat()
        out["us10y_pct"] = round(tnx[1], 3)

    return out


def pct_change(curr: float | None, prev: float | None) -> float | None:
    if curr is None or prev is None or prev == 0:
        return None
    return round((curr - prev) / prev * 100, 2)


def bps_change(curr_pct: float | None, prev_pct: float | None) -> int | None:
    if curr_pct is None or prev_pct is None:
        return None
    return round((curr_pct - prev_pct) * 100)  # 1% = 100 bps


def build_market_summary(period: str) -> dict:
    """產生 market_summary 欄位內容。"""
    target_y, target_m = parse_period(period)
    prev_y, prev_m = prev_month(target_y, target_m)

    logger.info(f"Collecting market data for {target_y}-{target_m:02d} (vs {prev_y}-{prev_m:02d})")

    curr = collect_month(target_y, target_m)
    prev = collect_month(prev_y, prev_m)

    summary = {
        "period": period,
        "generated_at": datetime.now().isoformat(),
        "items": {
            "usdtwd": {
                "value": curr.get("usdtwd"),
                "date": curr.get("usdtwd_date"),
                "prev_value": prev.get("usdtwd"),
                "prev_date": prev.get("usdtwd_date"),
                "pct_change": pct_change(curr.get("usdtwd"), prev.get("usdtwd")),
                "source": "Yahoo Finance (TWD=X)",
            },
            "taiex": {
                "value": curr.get("taiex"),
                "date": curr.get("taiex_date"),
                "prev_value": prev.get("taiex"),
                "prev_date": prev.get("taiex_date"),
                "pct_change": pct_change(curr.get("taiex"), prev.get("taiex")),
                "source": "Yahoo Finance (^TWII)",
            },
            "taiex_turnover": {
                "value_yi": curr.get("taiex_avg_turnover_yi"),
                "trading_days": curr.get("taiex_trading_days"),
                "prev_value_yi": prev.get("taiex_avg_turnover_yi"),
                "prev_trading_days": prev.get("taiex_trading_days"),
                "pct_change": pct_change(
                    curr.get("taiex_avg_turnover_yi"),
                    prev.get("taiex_avg_turnover_yi"),
                ),
                "source": "TWSE FMTQIK",
            },
            "spx": {
                "value": curr.get("spx"),
                "date": curr.get("spx_date"),
                "prev_value": prev.get("spx"),
                "prev_date": prev.get("spx_date"),
                "pct_change": pct_change(curr.get("spx"), prev.get("spx")),
                "source": "Yahoo Finance (^GSPC)",
            },
            "us10y": {
                "value_pct": curr.get("us10y_pct"),
                "date": curr.get("us10y_date"),
                "prev_value_pct": prev.get("us10y_pct"),
                "prev_date": prev.get("us10y_date"),
                "bps_change": bps_change(curr.get("us10y_pct"), prev.get("us10y_pct")),
                "source": "Yahoo Finance (^TNX)",
            },
        },
    }
    return summary


# ── 寫入月份檔案 + index ────────────────────────────────

def update_index(period: str, data: dict):
    """index.json 中若無此期，新增一筆並重新排序。"""
    index_path = DATA_DIR / "index.json"
    if index_path.exists():
        with open(index_path, encoding="utf-8") as f:
            index = json.load(f)
    else:
        index = {"latest": "", "months": []}

    period_file = period.replace("/", "-") + ".json"
    if not any(m.get("period") == period for m in index.get("months", [])):
        index.setdefault("months", []).append({
            "period": period,
            "file": period_file,
            "success_count": data.get("success_count", 0),
            "last_updated": data.get("last_updated", ""),
        })
        index["months"].sort(key=lambda m: m["period"], reverse=True)
        index["latest"] = index["months"][0]["period"] if index["months"] else ""
        with open(index_path, "w", encoding="utf-8") as f:
            json.dump(index, f, ensure_ascii=False, indent=2)
        logger.info(f"Updated index.json: added {period}")


def write_summary(period: str, summary: dict, dry_run: bool = False):
    """把 market_summary 寫進 docs/data/{period}.json，必要時建立 stub。"""
    period_file = DATA_DIR / f"{period.replace('/', '-')}.json"

    if period_file.exists():
        with open(period_file, encoding="utf-8") as f:
            data = json.load(f)
    else:
        # 建 stub：金控資料尚未抓取（5號跑、8號才開始爬 MOPS）
        data = {
            "report_period": period,
            "last_updated": datetime.now().isoformat(),
            "success_count": 0,
            "fail_count": 0,
            "companies": [],
        }

    data["market_summary"] = summary

    if dry_run:
        logger.info("DRY RUN — would write market_summary:")
        print(json.dumps(summary, ensure_ascii=False, indent=2))
        return

    with open(period_file, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    logger.info(f"Saved {period_file.name} with market_summary")

    update_index(period, data)

    # 同步 latest.json（若指向同一期）
    latest_path = DATA_DIR / "latest.json"
    if latest_path.exists():
        with open(latest_path, encoding="utf-8") as f:
            latest = json.load(f)
        if latest.get("report_period") == period:
            latest["market_summary"] = summary
            with open(latest_path, "w", encoding="utf-8") as f:
                json.dump(latest, f, ensure_ascii=False, indent=2)
            logger.info("Also synced latest.json")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--period",
        help="目標月份 民國年/月，例 115/04。預設為上個月。",
        default=None,
    )
    ap.add_argument(
        "--dry-run",
        action="store_true",
        help="只印出結果，不寫檔",
    )
    args = ap.parse_args()

    period = args.period or default_period()
    summary = build_market_summary(period)
    write_summary(period, summary, dry_run=args.dry_run)


if __name__ == "__main__":
    main()
