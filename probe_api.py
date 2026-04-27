"""Get the COMPLETE onclick string from the listing HTML, plus the full <form> hidden fields."""
import requests
import json
from bs4 import BeautifulSoup

H = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
    'Content-Type': 'application/json',
    'Origin': 'https://mops.twse.com.tw',
    'Referer': 'https://mops.twse.com.tw/mops/',
}
s = requests.Session()
s.headers.update(H)
BASE = 'https://mops.twse.com.tw/mops/api/'

params = {
    'encodeURIComponent': '1', 'step': '1', 'firstin': 'true', 'off': '1',
    'keyword4': '', 'code1': '', 'TYPEK2': '', 'checkbtn': '',
    'queryName': 'co_id', 'inpuType': 'co_id', 'TYPEK': 'all',
    'isnew': 'false', 'co_id': '2881',
    'year': '115', 'month': '4', 'b_date': '', 'e_date': '', 'type': '',
}
r = s.post(BASE + 'redirectToOld', json={'apiName': 'ajax_t05st01', 'parameters': params}, timeout=30)
url = r.json()['result']['url']
r2 = s.get(url, timeout=30)
r2.encoding = 'utf-8'
html = r2.text

soup = BeautifulSoup(html, 'html.parser')

# Find the announcement for 115/04/15
for table in soup.find_all('table'):
    rows = table.find_all('tr')
    for row in rows:
        cells = row.find_all('td')
        if len(cells) < 5:
            continue
        date_text = cells[2].get_text(strip=True)
        if date_text != '115/04/15':
            continue
        title = cells[4].get_text(' ', strip=True)
        if '3月' not in title or '自結' not in title:
            continue
        print(f'FOUND: {date_text} {title}')
        # Print ALL cells
        for i, c in enumerate(cells):
            print(f'  cell[{i}]: text={c.get_text(strip=True)[:80]!r}')
        # Find the button and dump the FULL onclick
        for btn in row.find_all(['input', 'button', 'a']):
            onclick = btn.get('onclick', '')
            if onclick:
                print(f'\n  FULL onclick ({len(onclick)} chars):')
                print(f'  {onclick}')
        break

# Also dump the form structure in full
print('\n\n=== ALL FORMS ===')
for form in soup.find_all('form'):
    print(f'form name={form.get("name")} action={form.get("action")} method={form.get("method")}')
    for inp in form.find_all('input'):
        print(f'  input name={inp.get("name")!r} type={inp.get("type")!r} value={inp.get("value", "")[:80]!r}')
