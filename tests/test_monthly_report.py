import copy,json,subprocess,sys,unittest
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from uuid import uuid4
from datetime import datetime
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'scraper'))
from monthly_report import publish,render_report,generate_commentary,model_json,report_content,report_clients
from monthly_report_v2 import context,validate,aggregate,security_direction,market_change
from report_sources import allowed,collect
from news_summary import refresh_due

@contextmanager
def report_output():
    p=ROOT/'.test-output'/('report-'+uuid4().hex);p.mkdir(parents=True);yield p

def response():
    return {'headline':{'text':'獲利方向分化，關注主要變動公司。','sources':[]},
        'sections':[{'title':name,'paragraphs':[{'text':'單月方向與累計成長分開觀察。','sources':[]}]} for name in ['金控獲利綜觀','壽險子公司','銀行子公司','證券子公司']],
        'securities':[]}

class MonthlyReportTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pack=json.loads(subprocess.check_output(['node',str(ROOT/'scripts/build-analysis-pack.cjs'),'2026/08'],encoding='utf-8'))
    def test_manual_edits_survive_data_and_template_updates(self):
        with report_output() as out:
            publish(self.pack,out)
            path=out/'2026-08.md';manual=path.read_text(encoding='utf-8')+'\n人工修訂測試\n';path.write_text(manual,encoding='utf-8')
            meta=publish(self.pack,out)
            self.assertTrue(meta['manual']);self.assertFalse(meta['data_changed'])
            pack=copy.deepcopy(self.pack);pack['holdings'][0]['monthly']+=1
            meta=publish(pack,out)
            self.assertTrue(meta['data_changed']);self.assertEqual(path.read_text(encoding='utf-8'),manual)
            self.assertIn('人工修訂測試',(out/'2026-08.html').read_text(encoding='utf-8'))
            publish(pack,out,overwrite_manual=True)
            self.assertNotIn('人工修訂測試',path.read_text(encoding='utf-8'))
    def test_stable_inputs_do_not_call_model(self):
        with report_output() as out:
            first=publish(self.pack,out)
            self.assertEqual(publish(self.pack,out)['generated_at'],first['generated_at'])
    def test_historical_news_does_not_stale_current_report(self):
        pack=copy.deepcopy(self.pack)
        pack['news'].append({'period':'2026/07','summary':'修正歷史新聞'})
        self.assertEqual(report_content(pack),report_content(self.pack))
        pack['news'].append({'period':pack['period'],'summary':'新增本月原因'})
        self.assertNotEqual(report_content(pack),report_content(self.pack))
    @patch('report_sources.collect',return_value={})
    def test_failure_does_not_disclose_diagnostics(self,_):
        class Broken:
            def create(self,**kwargs):raise TimeoutError('private diagnostic')
        with report_output() as out:
            meta=publish(self.pack,out,client=SimpleNamespace(messages=Broken()))
            self.assertEqual(meta['ai_status'],'fallback')
            self.assertNotIn('private diagnostic',json.dumps(meta))
            self.assertIn('MOPS 月自結',(out/'2026-08.md').read_text(encoding='utf-8'))
    def test_numbers_must_use_valid_tokens_and_sources(self):
        ctx=context(self.pack,{})
        valid=response();valid['headline']['text']='單月{{r0.monthly}}億元。'
        validate(valid,ctx)
        for text in ['獲利999億元','{{invented}}億元','<script>','因提存增加而下降。']:
            bad=copy.deepcopy(valid);bad['headline']['text']=text
            with self.assertRaises(ValueError):validate(bad,ctx)
        bad=copy.deepcopy(valid);bad['headline']['sources']=['invented']
        with self.assertRaises(ValueError):validate(bad,ctx)
    def test_media_only_is_valid_without_official_press_release(self):
        src={'media':{'text':'自營及承銷利得增加','url':'https://udn.com/news/story/1/2','title':'當月獲利','kind':'媒體報導','code':'2890'}}
        ctx=context(self.pack,src);v=response()
        v['securities']=[{'name':'永豐金證券','text':'自營與承銷利得抵銷手續費下滑。','sources':['media'],'basis':'單月原因'}]
        validate(v,ctx)
        text,_=render_report(self.pack,v,src)
        self.assertIn('自營與承銷',text);self.assertIn('https://udn.com/',text)
        self.assertNotIn('公司新聞摘要與來源',text)
    @patch('monthly_report.review_commentary',return_value=[])
    def test_model_format_repair_is_bounded(self,_):
        class Responses:
            calls=0
            def create(self,**kwargs):
                self.calls+=1;v=response()
                if self.calls==1:v['headline']['text']='獲利999亿元'
                return SimpleNamespace(content=[SimpleNamespace(type='text',text=json.dumps(v))])
        messages=Responses();generate_commentary(self.pack,SimpleNamespace(messages=messages),{})
        self.assertEqual(messages.calls,2)
    def test_semantic_review_triggers_revision(self):
        class Responses:
            calls=0
            def create(self,**kwargs):
                self.calls+=1
                v={'issues':['群體合計不等於增減額，請修正。']} if self.calls==2 else {'issues':[]} if self.calls==4 else response()
                return SimpleNamespace(content=[SimpleNamespace(type='text',text=json.dumps(v))])
        messages=Responses();generate_commentary(self.pack,SimpleNamespace(messages=messages),{})
        self.assertEqual(messages.calls,4)
    def test_deepseek_drafts_and_anthropic_reviews_only(self):
        class Responses:
            def __init__(self,result):self.result=result;self.calls=[]
            def create(self,**kwargs):
                self.calls.append(kwargs)
                return SimpleNamespace(content=[SimpleNamespace(type='text',text=json.dumps(self.result))])
        drafts=Responses(response());reviews=Responses({'issues':[]})
        generate_commentary(self.pack,SimpleNamespace(messages=drafts),{},
                            SimpleNamespace(messages=reviews),'deepseek-v4-pro','claude-sonnet-4-6')
        self.assertEqual([c['model'] for c in drafts.calls],['deepseek-v4-pro'])
        self.assertEqual([c['model'] for c in reviews.calls],['claude-sonnet-4-6'])
    @patch.dict('os.environ',{'ANTHROPIC_API_KEY':'test-anthropic','DEEPSEEK_API_KEY':'test-deepseek'})
    @patch('anthropic.Anthropic')
    def test_deepseek_credentials_are_confined_to_report_writer(self,anthropic_client):
        writer,reviewer,writer_model,reviewer_model=report_clients('deepseek')
        self.assertEqual((writer_model,reviewer_model),('deepseek-v4-pro','claude-sonnet-4-6'))
        self.assertEqual(anthropic_client.call_args_list[0].kwargs['api_key'],'test-anthropic')
        self.assertEqual(anthropic_client.call_args_list[1].kwargs['api_key'],'test-deepseek')
        self.assertEqual(anthropic_client.call_args_list[1].kwargs['base_url'],'https://api.deepseek.com/anthropic')
    def test_review_json_can_follow_a_preface_with_metric_braces(self):
        raw='檢查{{r39.delta}}與來源。\n```json\n{"issues":["金額不是月增額"]}\n```'
        self.assertEqual(model_json(raw),{'issues':['金額不是月增額']})
    def test_group_totals_exclude_missing_pairs(self):
        rows=[r for r in self.pack['subsidiaries'] if r['industry']=='securities']
        a=aggregate(rows);self.assertEqual(a['n'],12);self.assertEqual(a['delta'],66.4)
        ex=aggregate(rows,['凱基證券','台新證券']);self.assertAlmostEqual(ex['pct'],16.7695,3)
        self.assertIsNone(aggregate([])['current'])
    def test_cross_zero_securities_not_treated_as_missing(self):
        row=next(r for r in self.pack['subsidiaries'] if r['name']=='台新證券')
        self.assertIn('轉盈',security_direction(row,-9))
        row=next(r for r in self.pack['subsidiaries'] if r['name']=='元富證券')
        self.assertIn('缺單月',security_direction(row,-9))
    def test_refresh_window_and_daily_limit(self):
        c={'news_generated_at':'2026-09-10T00:00:00'}
        self.assertTrue(refresh_due(c,'115/08',datetime(2026,9,11,1)))
        self.assertFalse(refresh_due(c,'115/08',datetime(2026,9,10,10)))
        self.assertFalse(refresh_due(c,'115/08',datetime(2026,10,11)))
        self.assertFalse(refresh_due(c,'115/08',datetime(2026,9,21)))
    def test_original_article_allowlist_rejects_unsafe_urls(self):
        for u in ['http://udn.com/','https://localhost/','https://udn.com.attacker.test/','https://user@udn.com/','https://udn.com:8080/']:
            self.assertFalse(allowed(u))
        self.assertTrue(allowed('https://udn.com/news/story/7239/9742503'))
    @patch('report_sources.article',return_value=None)
    def test_source_failure_keeps_media_summary_and_rejects_stale_news(self,_):
        sources=collect(self.pack)
        self.assertNotIn('news-2026-08-2886',sources)
        self.assertTrue(any('摘要' in s['kind'] for s in sources.values()))
    def test_market_bps_and_report_index_cutoff(self):
        self.assertAlmostEqual(market_change({'key':'us10y','value_pct':4.758,'prev_value_pct':4.745}),1.3)
        with report_output() as out:
            (out/'index.json').write_text(json.dumps({'reports':[{'period':'2026/05'},{'period':'2026/06'}]}))
            publish(self.pack,out)
            index=json.loads((out/'index.json').read_text(encoding='utf-8'))
            self.assertEqual([r['period'] for r in index['reports']],['2026/08','2026/06'])
    def test_html_escapes_manual_content(self):
        with report_output() as out:
            publish(self.pack,out)
            (out/'2026-08.md').write_text('# 測試\n\n<script>alert(1)</script>\n',encoding='utf-8')
            publish(self.pack,out)
            html=(out/'2026-08.html').read_text(encoding='utf-8')
            self.assertNotIn('<script>alert(1)',html)
            self.assertIn('&lt;script&gt;',html)
if __name__=='__main__':unittest.main()
