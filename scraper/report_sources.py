"""Read public articles behind the existing media-first news feed.

Only allowlisted public hosts are fetched. Redirects are checked before following.
Article bodies are private build inputs; the public audit stores URLs and hashes.
"""
import hashlib
import re
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from urllib.parse import urlparse, urljoin

MEDIA = {'ctee.com.tw', 'www.ctee.com.tw', 'money.udn.com', 'udn.com',
         'news.cnyes.com', 'ec.ltn.com.tw', 'www.nownews.com'}
OFFICIAL = {'www.fubon.com', 'www.cathayholdings.com', 'www.kgi.com', 'www.sinopac.com', 'securities.sinopac.com'}


def allowed(url):
    try:
        p = urlparse(url)
        return p.scheme == 'https' and p.hostname in MEDIA | OFFICIAL and not p.username and p.port in (None, 443)
    except ValueError:
        return False


def article(url):
    import requests
    from bs4 import BeautifulSoup
    try:
        for _ in range(4):
            if not allowed(url): return None
            response = requests.get(url, timeout=18, allow_redirects=False,
                                    headers={'User-Agent': 'Mozilla/5.0'}, stream=True)
            if response.is_redirect:
                url = urljoin(url, response.headers.get('Location', ''))
                response.close()
                continue
            response.raise_for_status()
            if 'html' not in response.headers.get('Content-Type', ''): return None
            chunks = []; size = 0
            for chunk in response.iter_content(65536):
                size += len(chunk)
                if size > 2500000: response.close(); return None
                chunks.append(chunk)
            soup = BeautifulSoup(b''.join(chunks), 'html.parser')
            stamp = soup.select_one('meta[property="article:published_time"], meta[name="pubdate"], meta[itemprop="datePublished"], time[datetime]')
            published = (stamp.get('content') or stamp.get('datetime') or '') if stamp else ''
            if not published:
                stamp=soup.select_one('time, .article-content__time, .publish-time')
                match=re.search(r'(20\d{2})[/-](\d{2})[/-](\d{2})',stamp.get_text() if stamp else '')
                if match:published='-'.join(match.groups())
            title = soup.select_one('meta[property="og:title"]') or soup.find('h1') or soup.find('title')
            headline = (title.get('content') or title.get_text(' ', strip=True)) if title else ''
            for node in soup.select('script, style, nav, footer, header, aside, form, .menu, .header, .footer, .related, .recommend, .advertisement'):
                node.decompose()
            body = soup.select_one('.article-content__paragraph, .article-body, .article-content, article, main') or soup.body
            if not body: return None
            text = '\n'.join(dict.fromkeys(p.get_text(' ', strip=True) for p in body.find_all(['p','li']) if not (p.name=='li' and p.find('li'))))
            if len(text) < 120: return None
            return {'url':url, 'title':headline, 'published_at':published,
                    'text':text[:14000], 'kind':'公司新聞稿' if urlparse(url).hostname in OFFICIAL else '媒體報導'}
        return None
    except Exception:
        return None  # Paywalls, blocked pages, or unavailable sites never gate the report.


def collect(pack):
    """Current-period summaries remain usable when the original page is unavailable."""
    result = {}; candidates = []
    year, month = map(int, pack['period'].split('/'))
    next_month = f'{year+int(month==12):04d}-{1 if month==12 else month+1:02d}-01'
    for news in pack['news']:
        if news['period'] != pack['period'] or not news.get('analysis_eligible', True): continue
        links = [s for s in news['sources'] if allowed(s.get('url',''))]
        if any(re.search(r'展望|存股|配息有機會',s.get('title','')) and not re.search(r'月自結|月獲利|月賺',s.get('title','')) for s in links):continue
        # An old URL date can invalidate a blended summary even if its title has no year.
        def dated(s):
            m=re.search(r'(20\d{2})(\d{2})(\d{2})',s['url'])
            return s.get('published_at') or ('-'.join(m.groups()) if m else '')
        if any(dated(s) and dated(s).replace('/','-')[:10]<next_month for s in links):continue
        if not links: continue
        result[news['id']] = {'text':news['summary'], 'title':news['name']+'當月獲利報導摘要',
            'url':links[0]['url'], 'published_at':dated(links[0]),
            'kind':'既有新聞摘要（原文未核實）', 'code':news['code'], 'requested_period':pack['period']}
        candidates.extend((news, source) for source in links[:2])
    with ThreadPoolExecutor(max_workers=5) as pool:
        fetched = list(pool.map(lambda pair: article(pair[1]['url']), candidates))
    year, month = map(int, pack['period'].split('/'))
    next_month = f'{year+int(month==12):04d}-{1 if month==12 else month+1:02d}-01'
    for i, ((news, source), item) in enumerate(zip(candidates, fetched)):
        if not item: continue
        if item['published_at'] and item['published_at'][:10] < next_month:
            result.pop(news['id'],None)
            continue
        # Explicitly conflicting period in a result title is never current evidence.
        match = re.search(r'(20\d{2})\s*年\s*(\d{1,2})\s*月', item['title'])
        if match and tuple(map(int,match.groups())) != (year,month):
            result.pop(news['id'],None)
            continue
        if re.search(r'展望|存股|配息有機會',item['title']) and not re.search(r'月自結|月獲利|月賺',item['title']):
            result.pop(news['id'],None)
            continue
        item.update(code=news['code'], requested_period=pack['period'])
        result[f'article-{i}'] = item
    return result


def audit(sources):
    return {key:{k:v for k,v in value.items() if k!='text'} | {
        'content_hash':hashlib.sha256(value['text'].encode()).hexdigest()
    } for key,value in sources.items()}
