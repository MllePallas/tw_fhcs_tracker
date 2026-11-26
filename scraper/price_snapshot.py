# price_snapshot.py
# 抓 13 家金控最近交易日收盤價與已發行普通股數，寫入 docs/data/prices.json，
# 供股利試算頁（docs/dividend.html）計算每股股利與殖利率。
#
# 資料源（依序嘗試，免 API key）：
#   1. TWSE OpenAPI STOCK_DAY_ALL（上市個股最近交易日行情，一次一個請求）
#   2. Yahoo Finance chart API（逐檔補缺）
# 股數：TWSE OpenAPI t187ap03_L（上市公司基本資料）「已發行普通股數或TDR原股發行股數」
#
# 只寫 prices.json 這一個新檔，不動既有月自結資料檔。

import sys
import json
import logging
from datetime import datetime, timezone, timedelta
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).parent))
from companies import FINANCIAL_HOLDINGS  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("price_snapshot")

BASE_DIR = Path(__file__).parent.parent
OUT_FILE = BASE_DIR / "docs" / "data" / "prices.json"
TPE = timezone(timedelta(hours=8))
UA = {"User-Agent": "Mozilla/5.0 (tw_fhcs_tracker price snapshot)"}

META = {
    "dataset": "台灣金控月自結獲利追蹤",
    "author": "Mandy Chao",
    "repository": "https://github.com/MllePallas/tw_fhcs_tracker",
    "data_license": "CC BY 4.0",
    "attribution": "使用本資料須標示來源：台灣金控月自結獲利追蹤（Mandy Chao），https://github.com/MllePallas/tw_fhcs_tracker，CC BY 4.0",
    "raw_source": "收盤價：TWSE OpenAPI（STOCK_DAY_ALL），缺值以 Yahoo Finance 補；已發行普通股數：TWSE OpenAPI（t187ap03_L 上市公司基本資料）",
}


def company_codes() -> dict[str, str]:
    return {str(c["code"]): c.get("name", "") for c in FINANCIAL_HOLDINGS}


def roc_to_iso(s: str) -> str | None:
    """1151124 → 2026-11-24"""
    s = (s or "").strip()
    if len(s) == 7 and s.isdigit():
        return f"{int(s[:3]) + 1911:04d}-{s[3:5]}-{s[5:7]}"
    return None


def to_float(v) -> float | None:
    try:
        f = float(str(v).replace(",", ""))
        return f if f > 0 else None
    except (TypeError, ValueError):
        return None


def fetch_twse(codes) -> dict:
    url = "https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL"
    r = requests.get(url, headers=UA, timeout=30)
    r.raise_for_status()
    out = {}
    for row in r.json():
        code = str(row.get("Code", "")).strip()
        if code not in codes:
            continue
        close = to_float(row.get("ClosingPrice"))
        if close is None:
            continue
        out[code] = {
            "close": close,
            "date": roc_to_iso(row.get("Date", "")),
            "source": "TWSE OpenAPI STOCK_DAY_ALL",
        }
    return out


def to_int(v) -> int | None:
    try:
        n = int(float(str(v).replace(",", "").strip()))
        return n if n > 0 else None
    except (TypeError, ValueError):
        return None


def fetch_shares(codes) -> dict:
    """TWSE 上市公司基本資料：已發行普通股數（股）、特別股（股，若有）"""
    url = "https://openapi.twse.com.tw/v1/opendata/t187ap03_L"
    r = requests.get(url, headers=UA, timeout=30)
    r.raise_for_status()
    out = {}
    for row in r.json():
        code = str(row.get("公司代號", "")).strip()
        if code not in codes:
            continue
        common = to_int(row.get("已發行普通股數或TDR原股發行股數"))
        if not common:
            continue
        out[code] = {
            "common_shares": common,
            "preferred_shares": to_int(row.get("特別股")) or 0,
            "date": roc_to_iso(row.get("出表日期", "")),
            "source": "TWSE OpenAPI t187ap03_L（已發行普通股數）",
        }
    return out


def fetch_yahoo(code: str) -> dict | None:
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{code}.TW?range=10d&interval=1d"
    r = requests.get(url, headers=UA, timeout=20)
    r.raise_for_status()
    res = r.json()["chart"]["result"][0]
    ts = res.get("timestamp") or []
    closes = res["indicators"]["quote"][0].get("close") or []
    for t, c in reversed(list(zip(ts, closes))):
        if c:
            d = datetime.fromtimestamp(t, TPE).strftime("%Y-%m-%d")
            return {"close": round(float(c), 2), "date": d, "source": f"Yahoo Finance ({code}.TW)"}
    return None


def main() -> int:
    codes = company_codes()
    prices: dict = {}
    try:
        prices = fetch_twse(codes)
        logger.info("TWSE: %d/%d", len(prices), len(codes))
    except Exception as e:  # noqa: BLE001
        logger.warning("TWSE 失敗：%s", e)

    for code in codes:
        if code in prices and prices[code].get("date"):
            continue
        try:
            y = fetch_yahoo(code)
            if y:
                prices[code] = y
                logger.info("Yahoo 補 %s", code)
        except Exception as e:  # noqa: BLE001
            logger.warning("Yahoo %s 失敗：%s", code, e)

    shares: dict = {}
    try:
        shares = fetch_shares(codes)
        logger.info("TWSE 股數: %d/%d", len(shares), len(codes))
    except Exception as e:  # noqa: BLE001
        logger.warning("TWSE 股數失敗：%s", e)

    if not prices and not shares:
        logger.error("收盤價與股數皆未取得，保留既有 prices.json")
        return 1

    # 保留舊檔中本次沒抓到的公司，避免整欄空白
    if OUT_FILE.exists():
        try:
            old_all = json.loads(OUT_FILE.read_text(encoding="utf-8"))
            for k, v in old_all.get("prices", {}).items():
                prices.setdefault(k, {**v, "stale": True})
            for k, v in old_all.get("shares", {}).items():
                shares.setdefault(k, {**v, "stale": True})
        except Exception:  # noqa: BLE001
            pass

    for code, name in codes.items():
        if code in prices:
            prices[code]["name"] = name

    payload = {
        "_meta": META,
        "generated_at": datetime.now(TPE).isoformat(timespec="seconds"),
        "prices": dict(sorted(prices.items())),
        "shares": dict(sorted(shares.items())),
    }
    OUT_FILE.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    logger.info("寫入 %s（收盤價 %d 檔、股數 %d 檔）", OUT_FILE, len(prices), len(shares))
    return 0


if __name__ == "__main__":
    sys.exit(main())
