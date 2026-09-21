import copy
import json
from pathlib import Path
import subprocess
import sys
from contextlib import contextmanager
from uuid import uuid4
import unittest
from types import SimpleNamespace

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'scraper'))
from monthly_report import publish, render_report, validate_commentary, evidence, generate_commentary
from periods import storage_period


@contextmanager
def report_output():
    path=ROOT/'.test-output'/('report-'+uuid4().hex)
    path.mkdir(parents=True)
    yield path


class MonthlyReportTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        (ROOT/'.test-output').mkdir(exist_ok=True)
        cls.pack=json.loads(subprocess.check_output(['node',str(ROOT/'scripts/build-analysis-pack.cjs'),'2026/08'],encoding='utf-8'))

    def test_manual_edits_survive_input_updates_and_can_explicitly_regenerate(self):
        with report_output() as tmp:
            first=publish(self.pack,tmp)
            path=Path(tmp)/'2026-08.md'
            text=path.read_text(encoding='utf-8')+'\n人工修訂測試\n'
            path.write_text(text,encoding='utf-8')
            pack=copy.deepcopy(self.pack);pack['holdings'][0]['monthly']+=1
            meta=publish(pack,tmp)
            self.assertTrue(meta['manual']);self.assertTrue(meta['data_changed'])
            self.assertEqual(path.read_text(encoding='utf-8'),text)
            meta=publish(pack,tmp,overwrite_manual=True)
            self.assertFalse(meta['manual']);self.assertNotIn('人工修訂測試',path.read_text(encoding='utf-8'))

    def test_stable_inputs_do_not_regenerate_or_call_model(self):
        with report_output() as tmp:
            meta=publish(self.pack,tmp)
            self.assertEqual(publish(self.pack,tmp)['generated_at'],meta['generated_at'])

    def test_model_failure_still_publishes_numbers_news_and_links(self):
        class Broken:
            def create(self,**kwargs):raise TimeoutError('private diagnostic')
        with report_output() as tmp:
            result=publish(self.pack,tmp,client=SimpleNamespace(messages=Broken()))
            self.assertEqual(result['ai_status'],'fallback')
            text=(Path(tmp)/'2026-08.md').read_text(encoding='utf-8')
            self.assertIn('新聞摘要與來源',text);self.assertIn('MOPS 月自結',text)
            self.assertNotIn('private diagnostic',json.dumps(result))

    def test_model_output_must_reference_evidence_and_cannot_invent_numbers(self):
        src=evidence(self.pack);key=next(iter(src))
        valid={'sections':[[{'text':'月度獲利增加，原因需核對公司說明。','sources':[key]}],[],[],[]]}
        self.assertEqual(len(validate_commentary(valid,src)),4)
        bad=copy.deepcopy(valid);bad['sections'][0][0]['text']='獲利增加999億元'
        with self.assertRaises(ValueError):validate_commentary(bad,src)
        bad=copy.deepcopy(valid);bad['sections'][0][0]['sources']=['invented']
        with self.assertRaises(ValueError):validate_commentary(bad,src)

    def test_gregorian_input_and_historical_reports(self):
        self.assertEqual(storage_period('2026/08'),'115/08')
        self.assertEqual(storage_period('2026-08'),'115/08')
        with self.assertRaises(ValueError):storage_period('2026/13')
        for period in ['2025/07','2026/01','2026/08']:
            pack=json.loads(subprocess.check_output(['node',str(ROOT/'scripts/build-analysis-pack.cjs'),period],encoding='utf-8'))
            text,headline=render_report(pack)
            self.assertTrue(text.startswith('# '+period))
            for heading in ['1. 金控','2. 壽險','3. 銀行','4. 證券']:self.assertIn(heading,text)
            self.assertNotIn('NaN',text)

    def test_model_format_repair_is_bounded_and_keeps_citations(self):
        key=next(iter(evidence(self.pack)))
        valid={'sections':[[{'text':'依既有新聞摘要，原因仍需核對公司說明。','sources':[key]}],[],[],[]]}
        bad=copy.deepcopy(valid);bad['sections'][0][0]['text']='增加999億元'
        class Responses:
            calls=0
            def create(self,**kwargs):
                self.calls+=1
                return SimpleNamespace(content=[SimpleNamespace(type='text',text=json.dumps(bad if self.calls==1 else valid))])
        messages=Responses()
        output=generate_commentary(self.pack,SimpleNamespace(messages=messages))
        self.assertEqual(messages.calls,2)
        self.assertEqual(output[0][0]['sources'],[key])


if __name__=='__main__':unittest.main()
