# add_provenance.py
# 一次性／冪等：為 docs/data/ 下所有既有 JSON（月份檔、latest.json、index.json）
# 回填 _meta 來源聲明區塊。之後的新檔由 main.py 的 save_data()/update_index() 自動夾帶，
# 本腳本僅在歷史檔缺 _meta（或 DATASET_META 內容更新）時需要重跑。輸出格式與 main.py
# 一致（ensure_ascii=False, indent=2），未變動的檔案不重寫（保持 git 乾淨）。

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from provenance import with_meta

DATA_DIR = Path(__file__).parent.parent / "docs" / "data"


def main():
    if not DATA_DIR.exists():
        print(f"找不到資料目錄：{DATA_DIR}")
        sys.exit(1)
    stamped, skipped = [], []
    for path in sorted(DATA_DIR.glob("*.json")):
        data = json.loads(path.read_text(encoding="utf-8"))
        new = with_meta(data)
        new_text = json.dumps(new, ensure_ascii=False, indent=2)
        if json.dumps(data, ensure_ascii=False, indent=2) == new_text:
            skipped.append(path.name)
            continue
        path.write_text(new_text, encoding="utf-8")
        stamped.append(path.name)
    print(f"已回填 _meta：{len(stamped)} 檔；已是最新：{len(skipped)} 檔")
    for n in stamped:
        print(f"  ✓ {n}")


if __name__ == "__main__":
    main()
