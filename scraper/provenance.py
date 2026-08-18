# provenance.py
# 資料集來源聲明：每份輸出 JSON 夾帶 _meta 區塊（單一事實來源，main.py 與 add_provenance.py 共用）。
# 內容為靜態常數（不含時間戳），重跑不會產生 diff；資料授權見 repo 根目錄 LICENSE-DATA。

DATASET_META = {
    "dataset": "台灣金控月自結獲利追蹤",
    "author": "Mandy Chao",
    "repository": "https://github.com/MllePallas/tw_fhcs_tracker",
    "site": "https://mllepallas.github.io/tw_fhcs_tracker/",
    "data_license": "CC BY 4.0",
    "license_url": "https://creativecommons.org/licenses/by/4.0/deed.zh-hant",
    "attribution": "使用本資料須標示來源：台灣金控月自結獲利追蹤（Mandy Chao），https://github.com/MllePallas/tw_fhcs_tracker，CC BY 4.0",
    "raw_source": "原始數據：公開資訊觀測站（MOPS）各金控月自結損益公告；市場概況：Yahoo Finance、TWSE",
}


def with_meta(payload: dict) -> dict:
    """回傳把 _meta 放在最前面的新 dict。冪等：既有 _meta 一律以現行 DATASET_META 覆蓋。"""
    rest = {k: v for k, v in payload.items() if k != "_meta"}
    return {"_meta": DATASET_META, **rest}
