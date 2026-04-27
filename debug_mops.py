"""
debug_mops.py
診斷 MOPS API 連線與回應內容
執行方式：python debug_mops.py
"""
import sys
import re
import requests
from bs4 import BeautifulSoup

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Referer": "https://mops.twse.com.tw/mops/web/t05st02",
    "Accept-Language": "zh-TW,zh;q=0.9",
}

# ── 步驟 1：初始化 session，取得 cookie ─────────────────
print("=" * 55)
print("步驟 1：初始化 session")
print("=" * 55)
session = requests.Session()
session.headers.update(HEADERS)

try:
    r = session.get("https://mops.twse.com.tw/mops/web/t05st02", timeout=15)
    print(f"  狀態碼：{r.status_code}")
    print(f"  Cookies：{dict(session.cookies)}")
except Exception as e:
    print(f"  ❌ 失敗：{e}")
    sys.exit(1)

# ── 步驟 2：查詢重大訊息（三種日期範圍都試） ────────────
print()
print("=" * 55)
print("步驟 2：查詢富邦金 (2881) 重大訊息")
print("=" * 55)

test_ranges = [
    ("115/04/01", "115/04/21", "4月份（115/03 月報應在此期間公告）"),
    ("115/03/01", "115/03/20", "3月份（115/02 月報公告期）"),
    ("115/01/01", "115/04/21", "全年寬範圍"),
]

for date1, date2, label in test_ranges:
    print(f"\n  [{label}] 搜尋 {date1} ~ {date2}")

    # 方法 A：ajax_t05st02（舊版 API）
    payload_a = {
        "encodeURIComponent": "1",
        "step": "1",
        "firstin": "1",
        "off": "1",
        "keyword4": "",
        "code1": "",
        "TYPEK2": "",
        "checkbtn": "",
        "queryName": "co_id",
        "inpuType": "co_id",
        "TYPEK": "all",
        "isnew": "false",
        "co_id": "2881",
        "date1": date1.replace("/", ""),   # 1150401
        "date2": date2.replace("/", ""),
    }

    try:
        resp = session.post(
            "https://mops.twse.com.tw/mops/web/ajax_t05st02",
            data=payload_a,
            timeout=20,
        )
        resp.encoding = "utf-8"
        html = resp.text
        soup = BeautifulSoup(html, "html.parser")
        rows_all = soup.find_all("tr")
        # 找含日期格式的列
        hits = [r for r in rows_all
                if re.search(r"\d{3}/\d{2}/\d{2}", r.get_text())]
        print(f"    方法A (ajax_t05st02)：HTTP {resp.status_code}，"
              f"共 {len(rows_all)} 個 <tr>，含日期的列：{len(hits)} 筆")
        for h in hits[:5]:
            print(f"      → {h.get_text(strip=True)[:80]}")

        # 如果有結果，印出原始 HTML 前 500 字
        if len(hits) > 0:
            print(f"\n    ✅ 找到資料！原始 HTML 前 500 字：")
            print(html[:500])
    except Exception as e:
        print(f"    方法A 失敗：{e}")

# ── 步驟 3：嘗試新版 API ────────────────────────────────
print()
print("=" * 55)
print("步驟 3：嘗試新版 MOPS REST API")
print("=" * 55)

# 新版 MOPS SPA 使用的後端端點
new_api_attempts = [
    (
        "GET",
        "https://mops.twse.com.tw/server-java/t05st02ajax"
        "?co_id=2881&date1=1150401&date2=1150421&TYPEK=all",
        None,
    ),
    (
        "POST",
        "https://mops.twse.com.tw/server-java/t05st02ajax",
        {"co_id": "2881", "date1": "1150401", "date2": "1150421", "TYPEK": "all"},
    ),
]

for method, url, data in new_api_attempts:
    try:
        if method == "GET":
            r = session.get(url, timeout=15)
        else:
            r = session.post(url, data=data, timeout=15)
        print(f"  {method} {url[:60]}...")
        print(f"  → HTTP {r.status_code}，長度 {len(r.text)}")
        if r.status_code == 200 and len(r.text) > 100:
            print(f"  → 前 300 字：{r.text[:300]}")
    except Exception as e:
        print(f"  → 失敗：{e}")

# ── 步驟 4：直接抓已知公告詳細頁 ───────────────────────
print()
print("=" * 55)
print("步驟 4：直接驗證已知公告是否可存取")
print("  （115/04/15 富邦金 115年3月合併自結損益）")
print("=" * 55)

# 用 MOPS 搜尋頁直接 GET（模擬手動操作）
test_url = (
    "https://mops.twse.com.tw/mops/web/t05st02"
    "?co_id=2881&TYPEK=all&isnew=false&step=1"
    "&date1=1150401&date2=1150421"
)
try:
    r = session.get(test_url, timeout=20)
    r.encoding = "utf-8"
    soup = BeautifulSoup(r.text, "html.parser")
    links = soup.find_all("a", string=re.compile("自結|損益"))
    print(f"  GET {test_url[-50:]}")
    print(f"  HTTP {r.status_code}，含損益關鍵字的連結：{len(links)} 個")
    for lk in links[:5]:
        print(f"  → {lk.get_text(strip=True)[:60]}")
except Exception as e:
    print(f"  失敗：{e}")

print()
print("=" * 55)
print("診斷完成")
print("=" * 55)
