# validate.py
# 資料一致性驗證：用算術關係自我檢查解析結果，攔截 LLM 誤讀。
#
# 動機：parse_profit_announcement() 實務上 13/13 都走 LLM 兜底（MOPS 重大訊息把
# 財務數字放在「說明」欄的純文字裡，規則式 TableParser 結構上無法命中）。LLM 判讀
# 若有誤，目前沒有任何機制會攔下來。本模組提供不依賴 LLM 的算術護欄。
#
# 用法：
#   python validate.py                  # 驗證 latest.json 的期別
#   python validate.py --period 115/06
#   python validate.py --all            # 驗證 index.json 列出的所有期別
#   python validate.py --strict         # 有未解釋的異常時 exit 1（CI 用）

import sys
import json
import logging
import argparse
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

logger = logging.getLogger(__name__)

BASE_DIR = Path(__file__).parent.parent
DATA_DIR = BASE_DIR / "docs" / "data"

# ── 容差 ─────────────────────────────────────────────────
#
# 公告數字以「億元」報到小數一位 → 換算成 NT$m 後粒度為 10。
# 連續性檢查用到三個各自四捨五入的值（本月累計、上月累計、當月），
# 最壞情況誤差 3 × 0.05 億 = 0.15 億 = 15 NT$m。
TOLERANCE_NTM = 15.0

# 量級跳動：疑似單位換算錯誤（千元/億元 沒換算）
MAGNITUDE_RATIO = 20.0
MAGNITUDE_MIN_ABS = 1000.0

EXPECTED_UNIT = "百萬元"

HOLDING_TARGET = "(金控)"


# ── 已知例外 ─────────────────────────────────────────────
#
# 經人工對照 MOPS 原始公告確認「非解析錯誤」的案例。列在這裡的異常仍會顯示，
# 但歸類為「已知例外」不計入未解釋異常，避免驗證器每月重複狂叫而被忽略。
#
# key: (公司代號, 檢查代號, 對象, 期別)；期別用 "*" 表示所有月份
KNOWN_EXCEPTIONS = {
    ("5880", "C1", HOLDING_TARGET, "*"): (
        "合庫金公告的當月數為「合併」稅後淨利（含非控制權益），累計數則取註解揭露的"
        "「歸屬於母公司業主」數 → 兩者基準不同，差額即當月非控制權益（每月約 0.1~1.5 億）。"
        "累計數取母公司業主是專案既定規則（見 CLAUDE.md EPS 欄位說明），不應改動。"
    ),
    ("2887", "C1", HOLDING_TARGET, "114/10"): (
        "已對照 MOPS 原始公告：114/09 累計 260.1 億、114/10 當月 78.3 億、累計 338.0 億，"
        "三數均忠實照抄公告註解的「歸屬於母公司」數字（260.1 + 78.3 = 338.4 ≠ 338.0）。"
        "改用「合併」基準亦對不上（260.4 + 78.4 = 338.8 ≠ 338.3），故非基準差異而是公告"
        "本身小幅重編，與 114/11 同源（台新新光合併後整併調整）。"
    ),
    ("2887", "C1", HOLDING_TARGET, "114/11"): (
        "已對照 MOPS 原始公告：114/10 累計 338.0 億、114/11 累計 338.7 億、當月 51.9 億，"
        "兩期 JSON 均忠實照抄公告註解的「歸屬於母公司」數字。六家子公司累計全部連續"
        "（子公司累計合計 10 月 293.9 億 → 11 月 345.2 億，增幅 51.3 億與當月相符），"
        "係台新新光金於 11 月重編金控累計數（合併相關調整），非解析錯誤。"
    ),
    ("2887", "C5", HOLDING_TARGET, "114/11"): (
        "同上：114/11 重編累計數導致累計 EPS 由 1.88 降為 1.79。"
    ),
}


# ── Finding ──────────────────────────────────────────────

class Finding:
    """一筆檢查異常。"""

    def __init__(self, level, check, code, name, target, period, message):
        self.level = level          # "warn" | "info"
        self.check = check          # "C0".."C5"
        self.code = code
        self.name = name
        self.target = target        # HOLDING_TARGET 或子公司名
        self.period = period
        self.message = message
        self.excuse = KNOWN_EXCEPTIONS.get((code, check, target, period)) or \
            KNOWN_EXCEPTIONS.get((code, check, target, "*"))

    @property
    def known(self):
        return self.excuse is not None

    def __str__(self):
        return (f"{self.period} {self.code} {self.name} {self.target} "
                f"[{self.check}] {self.message}")


# ── 期別工具 ─────────────────────────────────────────────

def period_to_file(period):
    return DATA_DIR / f"{period.replace('/', '-')}.json"


def load_period(period):
    fp = period_to_file(period)
    if not fp.exists():
        return None
    try:
        return json.loads(fp.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        logger.error(f"{fp.name} 解析失敗: {e}")
        return None


def prev_period(period):
    """回傳同一年的上個月；一月回傳 None（累計會歸零，改用 C2 檢查）。"""
    try:
        year, month = period.split("/")
        m = int(month)
    except (ValueError, AttributeError):
        return None
    if m <= 1:
        return None
    return f"{year}/{m - 1:02d}"


def _num(v):
    return v if isinstance(v, (int, float)) else None


# ── 檢查項 ───────────────────────────────────────────────

def _check_continuity(company, prev_company, period, findings):
    """C1 累計連續性：累計[N] − 累計[N−1] ≈ 當月[N]（金控 + 子公司）。"""
    code = company.get("code", "")
    name = company.get("name", "")

    def one(target, cur_obj, prev_obj):
        mo = _num(cur_obj.get("monthly_profit"))
        cu = _num(cur_obj.get("cumulative_profit"))
        pc = _num(prev_obj.get("cumulative_profit"))
        if mo is None or cu is None or pc is None:
            return
        implied = cu - pc
        diff = implied - mo
        if abs(diff) > TOLERANCE_NTM:
            findings.append(Finding(
                "warn", "C1", code, name, target, period,
                f"累計連續性不符：累計 {cu:,.0f} − 上月累計 {pc:,.0f} = {implied:,.0f}，"
                f"但當月為 {mo:,.0f}（差 {diff:+,.0f} NT$m）"
            ))

    one(HOLDING_TARGET, company.get("holding_company") or {},
        prev_company.get("holding_company") or {})

    prev_subs = {s.get("name"): s for s in prev_company.get("subsidiaries", [])}
    for sub in company.get("subsidiaries", []):
        pv = prev_subs.get(sub.get("name"))
        if pv:
            one(sub.get("name", "?"), sub, pv)


def _check_january(company, period, findings):
    """C2 一月起始：累計應等於當月。"""
    code = company.get("code", "")
    name = company.get("name", "")

    def one(target, obj):
        mo = _num(obj.get("monthly_profit"))
        cu = _num(obj.get("cumulative_profit"))
        if mo is None or cu is None:
            return
        if abs(cu - mo) > TOLERANCE_NTM:
            findings.append(Finding(
                "warn", "C2", code, name, target, period,
                f"一月累計應等於當月：累計 {cu:,.0f}、當月 {mo:,.0f}（差 {cu - mo:+,.0f} NT$m）"
            ))

    one(HOLDING_TARGET, company.get("holding_company") or {})
    for sub in company.get("subsidiaries", []):
        one(sub.get("name", "?"), sub)


def _check_required(company, period, findings):
    """C0 必填欄位：金控層級的當月/累計不應缺漏。"""
    code = company.get("code", "")
    name = company.get("name", "")
    h = company.get("holding_company") or {}
    missing = [k for k in ("monthly_profit", "cumulative_profit")
               if _num(h.get(k)) is None]
    if missing:
        findings.append(Finding(
            "warn", "C0", code, name, HOLDING_TARGET, period,
            f"金控層級缺少必填欄位：{', '.join(missing)}"
        ))


def _check_unit(company, period, findings):
    """C3 單位欄位：所有金額應已正規化為百萬元。"""
    code = company.get("code", "")
    name = company.get("name", "")
    unit = company.get("unit")
    if unit and unit != EXPECTED_UNIT:
        findings.append(Finding(
            "warn", "C3", code, name, HOLDING_TARGET, period,
            f"單位欄位為「{unit}」，預期「{EXPECTED_UNIT}」——金額可能未換算"
        ))


def _check_fvoci(company, period, findings):
    """C4 FVOCI 合理性：加計後累計應大於同層級原始累計。"""
    code = company.get("code", "")
    name = company.get("name", "")

    def one(target, obj):
        fv = obj.get("fvoci_adjusted")
        if not isinstance(fv, dict):
            return
        adj = _num(fv.get("cumulative_profit"))
        orig = _num(obj.get("cumulative_profit"))
        if adj is None or orig is None:
            return
        if adj <= orig:
            findings.append(Finding(
                "warn", "C4", code, name, target, period,
                f"加計 FVOCI 後累計 {adj:,.0f} 未大於原始累計 {orig:,.0f}"
            ))

    one(HOLDING_TARGET, company.get("holding_company") or {})
    for sub in company.get("subsidiaries", []):
        one(sub.get("name", "?"), sub)


def _check_eps_monotonic(company, prev_company, period, findings):
    """C5 累計 EPS 單調性（info）：累計獲利上升時累計 EPS 不應下降。

    增資、併購換股會讓股數變動而合理下降，故僅列為提示。
    """
    code = company.get("code", "")
    name = company.get("name", "")
    h = company.get("holding_company") or {}
    ph = prev_company.get("holding_company") or {}
    cu, pc = _num(h.get("cumulative_profit")), _num(ph.get("cumulative_profit"))
    ce, pe = _num(h.get("cumulative_eps")), _num(ph.get("cumulative_eps"))
    if None in (cu, pc, ce, pe):
        return
    if cu > pc and ce < pe - 0.005:
        findings.append(Finding(
            "info", "C5", code, name, HOLDING_TARGET, period,
            f"累計獲利上升（{pc:,.0f} → {cu:,.0f}）但累計 EPS 下降（{pe} → {ce}）"
        ))


def _check_magnitude(company, prev_company, period, findings):
    """C6 量級跳動（info）：疑似單位換算錯誤。"""
    code = company.get("code", "")
    name = company.get("name", "")
    h = company.get("holding_company") or {}
    ph = prev_company.get("holding_company") or {}
    cu, pc = _num(h.get("cumulative_profit")), _num(ph.get("cumulative_profit"))
    if cu is None or pc is None or pc == 0:
        return
    ratio = abs(cu) / abs(pc)
    if ratio > MAGNITUDE_RATIO and abs(cu - pc) > MAGNITUDE_MIN_ABS:
        findings.append(Finding(
            "info", "C6", code, name, HOLDING_TARGET, period,
            f"累計獲利量級跳動 {ratio:.0f} 倍（{pc:,.0f} → {cu:,.0f}）——可能是單位換算問題"
        ))


# ── 主流程 ───────────────────────────────────────────────

def _check_meta(data, period, findings):
    """C7 來源聲明：檔案應含 _meta 區塊（main.py save_data 自動夾帶；歷史檔用 add_provenance.py 回填）。"""
    meta = data.get("_meta")
    if not isinstance(meta, dict) or not meta.get("attribution"):
        findings.append(Finding(
            "warn", "C7", "—", "（檔案層級）", "_meta", period,
            "缺少 _meta 來源聲明——執行 `python add_provenance.py` 回填，或確認 main.py 為含 with_meta 的版本"))


def validate_period(period, data=None):
    """驗證單一期別，回傳 list[Finding]。"""
    if data is None:
        data = load_period(period)
    if data is None:
        logger.warning(f"{period} 找不到資料檔，跳過")
        return []

    findings = []
    _check_meta(data, period, findings)
    prev = prev_period(period)
    prev_data = load_period(prev) if prev else None
    prev_by_code = {}
    if prev_data:
        prev_by_code = {c["code"]: c for c in prev_data.get("companies", [])
                        if "code" in c and "error" not in c}

    for company in data.get("companies", []):
        if "error" in company:
            continue
        _check_required(company, period, findings)
        _check_unit(company, period, findings)
        _check_fvoci(company, period, findings)

        if prev is None:
            _check_january(company, period, findings)
            continue

        pv = prev_by_code.get(company.get("code"))
        if pv:
            _check_continuity(company, pv, period, findings)
            _check_eps_monotonic(company, pv, period, findings)
            _check_magnitude(company, pv, period, findings)

    return findings


def list_periods():
    """從 index.json 取得所有期別（舊到新）。"""
    idx_path = DATA_DIR / "index.json"
    if not idx_path.exists():
        return []
    idx = json.loads(idx_path.read_text(encoding="utf-8"))
    return [m["period"] for m in reversed(idx.get("months", []))]


def report(findings, period_label=""):
    """印出人類可讀的驗證報告，回傳未解釋的 warn 筆數。"""
    unexplained = [f for f in findings if not f.known and f.level == "warn"]
    known = [f for f in findings if f.known]
    infos = [f for f in findings if not f.known and f.level == "info"]

    head = f"驗證結果 {period_label}".strip()
    print(f"\n{'=' * 68}\n{head}\n{'=' * 68}")

    if unexplained:
        print(f"\n[異常] {len(unexplained)} 筆需確認：")
        for f in unexplained:
            print(f"  ✗ {f.period} {f.code} {f.name} {f.target}")
            print(f"      [{f.check}] {f.message}")

    if infos:
        print(f"\n[提示] {len(infos)} 筆：")
        for f in infos:
            print(f"  · {f.period} {f.code} {f.name} {f.target} [{f.check}] {f.message}")

    if known:
        print(f"\n[已知例外] {len(known)} 筆（已人工對照原始公告確認，非解析錯誤）：")
        for f in known:
            print(f"  ○ {f.period} {f.code} {f.name} {f.target} [{f.check}] {f.message}")

    if not unexplained and not infos and not known:
        print("\n全數通過，無異常。")
    elif not unexplained:
        print(f"\n無未解釋異常。")

    print()
    return len(unexplained)


def main():
    ap = argparse.ArgumentParser(description="資料一致性驗證")
    ap.add_argument("--period", help="指定期別，例：115/06")
    ap.add_argument("--all", action="store_true", help="驗證 index.json 列出的所有期別")
    ap.add_argument("--strict", action="store_true", help="有未解釋異常時 exit 1")
    ap.add_argument("--quiet", action="store_true", help="只印摘要")
    args = ap.parse_args()

    logging.basicConfig(level=logging.WARNING, format="%(levelname)s: %(message)s")

    if args.all:
        periods = list_periods()
    elif args.period:
        periods = [args.period]
    else:
        latest = load_period("latest")
        if not latest:
            print("找不到 latest.json", file=sys.stderr)
            sys.exit(2)
        periods = [latest.get("report_period")]

    all_findings = []
    for p in periods:
        if not p:
            continue
        all_findings.extend(validate_period(p))

    label = f"（{len(periods)} 個期別：{periods[0]} ~ {periods[-1]}）" if len(periods) > 1 \
        else f"（{periods[0]}）"
    unexplained = report(all_findings, label)

    if args.strict and unexplained:
        sys.exit(1)


if __name__ == "__main__":
    main()
