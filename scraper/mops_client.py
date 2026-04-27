# mops_client.py
# 公開資訊觀測站 (MOPS) API 客戶端
#
# 2025 年 MOPS 改版為 SPA，所有資料存取需經由新 API gateway：
#   POST https://mops.twse.com.tw/mops/api/redirectToOld
#        body: {"apiName": "ajax_t05st01", "parameters": {...}}
#   → 回傳 {"code":200, "result": {"url": "<加密 URL 指向 mopsov.twse.com.tw>"}}
#   → GET 該加密 URL 取得 HTML
#
# 歷史重大訊息查詢走 ajax_t05st01，參數以 year + month 為主（不是 date1/date2）。

import re
import time
import random
import logging
from datetime import datetime, timedelta
from typing import Optional

import requests
from bs4 import BeautifulSoup

logger = logging.getLogger(__name__)

API_BASE = "https://mops.twse.com.tw/mops/api/"
REDIRECT_ENDPOINT = API_BASE + "redirectToOld"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7",
    "Content-Type": "application/json",
    "Origin": "https://mops.twse.com.tw",
    "Referer": "https://mops.twse.com.tw/mops/",
}


def to_roc_year(year: int) -> int:
    return year - 1911


def gregorian_to_roc(dt: datetime) -> str:
    """民國年格式字串，例如 '1150401'。保留供 main.py 匯入相容。"""
    return f"{to_roc_year(dt.year):03d}{dt.month:02d}{dt.day:02d}"


class MopsClient:
    """公開資訊觀測站 API 封裝（2025 新版 API gateway）"""

    def __init__(self, delay_range=(2.0, 5.0)):
        self.session = requests.Session()
        self.session.headers.update(HEADERS)
        self.delay_range = delay_range

    def _sleep(self):
        t = random.uniform(*self.delay_range)
        logger.debug(f"Sleeping {t:.1f}s ...")
        time.sleep(t)

    def _fetch_legacy(self, api_name: str, parameters: dict) -> str:
        """
        透過新 API gateway 取得舊 MOPS 頁面 HTML。

        兩步驟：
          1. POST redirectToOld 拿到加密後的 mopsov URL
          2. GET 該 URL 取得 HTML 內容
        """
        self._sleep()
        body = {"apiName": api_name, "parameters": parameters}
        resp = self.session.post(REDIRECT_ENDPOINT, json=body, timeout=30)
        resp.raise_for_status()
        data = resp.json()
        if data.get("code") != 200:
            logger.warning(f"[{api_name}] gateway returned code={data.get('code')}: {data.get('message')}")
            return ""
        url = data.get("result", {}).get("url")
        if not url:
            logger.warning(f"[{api_name}] gateway response missing url")
            return ""

        self._sleep()
        html_resp = self.session.get(
            url,
            timeout=30,
            headers={"Accept": "text/html,application/xhtml+xml"},
        )
        html_resp.encoding = "utf-8"
        html_resp.raise_for_status()
        return html_resp.text

    # ── 1. 查詢重大訊息清單 ──────────────────────────────
    def get_announcements(
        self,
        stock_code: str,
        date_start: Optional[datetime] = None,
        date_end: Optional[datetime] = None,
    ) -> list[dict]:
        """
        取得指定公司在目標月份的歷史重大訊息清單。

        新版 MOPS 的 ajax_t05st01 以「年 + 月」為查詢單位，不支援任意日範圍。
        本函式會從 date_start 推出民國年/月；date_start 與 date_end 必須位於同一月份。
        若跨月，以 date_start 的月份為準。

        Returns:
            list of dict: {date, title, href, seq_no, spoke_time, stock_code}
        """
        if date_end is None:
            date_end = datetime.now()
        if date_start is None:
            date_start = date_end - timedelta(days=30)

        roc_year = to_roc_year(date_start.year)
        month = date_start.month

        parameters = {
            "encodeURIComponent": "1",
            "step": "1",
            "firstin": "true",
            "off": "1",
            "keyword4": "",
            "code1": "",
            "TYPEK2": "",
            "checkbtn": "",
            "queryName": "co_id",
            "inpuType": "co_id",
            "TYPEK": "all",
            "isnew": "false",
            "co_id": stock_code,
            "year": str(roc_year),
            "month": str(month),
            "b_date": "",
            "e_date": "",
            "type": "",
        }

        logger.info(f"[{stock_code}] Fetching announcements year={roc_year} month={month}")

        try:
            html = self._fetch_legacy("ajax_t05st01", parameters)
        except requests.RequestException as e:
            logger.error(f"[{stock_code}] Request failed: {e}")
            return []

        if not html:
            return []

        return self._parse_announcement_list(html, stock_code)

    # ── 2. HTML 解析 ────────────────────────────────────
    _ONCLICK_SEQNO_RE = re.compile(r"seq_no\.value\s*=\s*['\"](\d+)['\"]")
    _ONCLICK_SPOKE_TIME_RE = re.compile(r"spoke_time\.value\s*=\s*['\"](\d+)['\"]")
    _ONCLICK_SPOKE_DATE_RE = re.compile(r"spoke_date\.value\s*=\s*['\"](\d+)['\"]")
    _ONCLICK_TYPEK_RE = re.compile(r"TYPEK\.value\s*=\s*['\"](\w+)['\"]")

    def _parse_announcement_list(self, html: str, stock_code: str) -> list[dict]:
        """
        解析 ajax_t05st01 回傳 HTML。

        預期結構（2025 版）：
          Table 0: 標題列（公司識別）
          Table 1: 資料列，欄位為 [公司代號, 公司名稱, 發言日期, 發言時間, 主旨, 操作按鈕]
          操作按鈕 <input type=button> 的 onclick 會設定 seq_no 與 spoke_time。
        """
        soup = BeautifulSoup(html, "html.parser")
        results: list[dict] = []

        for table in soup.find_all("table"):
            rows = table.find_all("tr")
            if len(rows) < 2:
                continue

            # 只處理第一列含明確欄位名的資料表
            header_cells = [c.get_text(strip=True) for c in rows[0].find_all(["th", "td"])]
            if not any("發言日期" in c for c in header_cells):
                continue

            for row in rows[1:]:
                cells = row.find_all("td")
                if len(cells) < 5:
                    continue

                date_text = cells[2].get_text(strip=True)
                if not re.match(r"^\d{3}/\d{2}/\d{2}$", date_text):
                    continue
                time_text = cells[3].get_text(strip=True)
                title = cells[4].get_text(" ", strip=True)

                seq_no = ""
                spoke_time = ""
                spoke_date = ""
                typek = ""
                btn = row.find("input", attrs={"onclick": True})
                if btn:
                    onclick = btn.get("onclick", "")
                    m = self._ONCLICK_SEQNO_RE.search(onclick)
                    if m:
                        seq_no = m.group(1)
                    m = self._ONCLICK_SPOKE_TIME_RE.search(onclick)
                    if m:
                        spoke_time = m.group(1)
                    m = self._ONCLICK_SPOKE_DATE_RE.search(onclick)
                    if m:
                        spoke_date = m.group(1)
                    m = self._ONCLICK_TYPEK_RE.search(onclick)
                    if m:
                        typek = m.group(1)

                if not spoke_time:
                    spoke_time = time_text.replace(":", "")

                results.append({
                    "date": date_text,
                    "title": title,
                    "href": "",
                    "seq_no": seq_no,
                    "spoke_time": spoke_time,
                    "spoke_date": spoke_date,
                    "typek": typek or "sii",
                    "stock_code": stock_code,
                })

        logger.info(f"[{stock_code}] Found {len(results)} announcements")
        return results

    # ── 3. 取得公告詳細內容 ──────────────────────────────
    def get_announcement_detail(
        self,
        stock_code: str,
        seq_no: str,
        spoke_time: str = "",
        spoke_date: str = "",
        typek: str = "sii",
        roc_year: Optional[int] = None,
        month: Optional[int] = None,
        date: str = "",
    ) -> str:
        """
        取得特定重大訊息公告的完整 HTML。

        新版 MOPS 的 detail 仍走 ajax_t05st01（step=2）。瀏覽器表單實際送出的關鍵欄位：
          seq_no, spoke_time (HHMMSS), spoke_date (西元年 YYYYMMDD), TYPEK, co_id,
          year (民國年), month (兩位數月份), step=2, firstin=true, plus空字串占位欄位。

        呼叫端若提供 announcement dict 中的 'date' 欄位（民國年 YYY/MM/DD），本函式
        會自動轉成 spoke_date（西元年）並解出 year/month。
        """
        if date:
            m = re.match(r"^(\d{3})/(\d{2})/(\d{2})$", date)
            if m:
                ry, mm, dd = int(m.group(1)), int(m.group(2)), int(m.group(3))
                roc_year = roc_year or ry
                month = month or mm
                if not spoke_date:
                    spoke_date = f"{ry + 1911:04d}{mm:02d}{dd:02d}"
        if roc_year is None or month is None:
            now = datetime.now()
            roc_year = roc_year or to_roc_year(now.year)
            month = month or now.month

        parameters = {
            "encodeURIComponent": "1",
            "step": "2",
            "firstin": "true",
            "off": "1",
            "TYPEK": typek,
            "year": str(roc_year),
            "month": f"{month:02d}",
            "b_date": "",
            "e_date": "",
            "type": "",
            "co_id": stock_code,
            "spoke_date": spoke_date,
            "spoke_time": spoke_time,
            "seq_no": seq_no,
            "MEETING_STEP": "",
            "MODEL": "",
            "ITEM": "",
        }

        logger.info(
            f"[{stock_code}] Fetching detail seq_no={seq_no} spoke_date={spoke_date} spoke_time={spoke_time}"
        )
        try:
            return self._fetch_legacy("ajax_t05st01", parameters)
        except requests.RequestException as e:
            logger.error(f"[{stock_code}] Detail fetch failed: {e}")
            return ""

    # ── 4. 即時重大訊息（單日全市場掃描）─────────────────
    def get_realtime_announcements(
        self,
        market_kind: str = "sii",
        count: int = 200,
    ) -> list[dict]:
        """
        MOPS 首頁即時重大訊息 feed。
        走純 JSON 端點 home_page/t05sr01_1，不經 redirectToOld。
        回傳清單僅涵蓋近期（通常為當日），適合每日輪詢。

        Returns:
            list of dict: {date, time, companyId, companyAbbreviation, subject, url}
        """
        self._sleep()
        url = API_BASE + "home_page/t05sr01_1"
        try:
            resp = self.session.post(
                url,
                json={"count": count, "marketKind": market_kind},
                timeout=30,
            )
            resp.raise_for_status()
            data = resp.json()
        except Exception as e:
            logger.error(f"Realtime announcement fetch failed: {e}")
            return []

        if data.get("code") != 200:
            logger.warning(f"Realtime gateway code={data.get('code')}")
            return []
        return data.get("result", {}).get("data", []) or []
