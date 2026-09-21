import copy
import json
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scraper'))
from comparison_policy import apply_yoy_policy, metrics, months, reason, reported_yoy


class ComparisonPolicyTest(unittest.TestCase):
    def test_zero_and_loss(self):
        self.assertEqual(metrics(100, 0)[2], 'zero_to_profit')
        self.assertEqual(metrics(-10, -100)[2], 'loss_narrowing')
        self.assertIsNone(metrics(-10, -100)[0])
        self.assertEqual(metrics(100, 1)[2], 'low_base')

    def test_reported_yoy(self):
        self.assertEqual(reported_yoy(120, 100, '新制')[:3], (20.0, 20, 'normal'))
        self.assertEqual(reported_yoy(-50, -100)[0], 50.0)
        self.assertEqual(reported_yoy(50, -100)[0], 150.0)
        self.assertEqual(reported_yoy(200, 1)[0], 19900.0)
        self.assertIsNone(reported_yoy(100, 0)[0])

    def test_full_ytd(self):
        self.assertTrue(reason('2887', months('115/08'), months('114/08')))
        self.assertTrue(reason('2890', months('115/12'), months('114/12')))
        self.assertFalse(reason('2890', months('116/08'), months('115/08')))

    def test_preserve_announcement_amounts_and_clear_stale_yoy(self):
        data = json.loads((ROOT / 'docs/data/115-08.json').read_text(encoding='utf-8'))
        original = copy.deepcopy(data)
        baseline = json.loads((ROOT / 'docs/data/114-08.json').read_text(encoding='utf-8'))
        apply_yoy_policy(data, baseline, '115/08')
        for company, old in zip(data['companies'], original['companies']):
            for key in ['monthly_profit', 'cumulative_profit', 'monthly_eps', 'cumulative_eps']:
                self.assertEqual(company['holding_company'].get(key), old['holding_company'].get(key))
        by_code = {c['code']: c['holding_company'] for c in data['companies']}
        self.assertEqual(by_code['2887']['cumulative_profit_yoy_status'], 'normal')
        self.assertIsNone(by_code['2881']['fvoci_adjusted']['yoy_pct'])
        self.assertEqual(by_code['2881']['fvoci_adjusted']['yoy_status'], 'not_presented')
        self.assertEqual(by_code['2880']['cumulative_profit_yoy_status'], 'normal')
        for company in data['companies']:
            old = next(c for c in baseline['companies'] if c['code'] == company['code'])
            for sub in company.get('subsidiaries', []):
                if '人壽' not in sub['name']:
                    continue
                previous = next((s for s in old.get('subsidiaries', []) if s['name'] == sub['name']), None)
                if previous and previous.get('cumulative_profit'):
                    self.assertAlmostEqual(sub['cumulative_profit_yoy_pct'], round((sub['cumulative_profit']-previous['cumulative_profit'])/abs(previous['cumulative_profit'])*100, 1))
                if sub.get('fvoci_adjusted'):
                    self.assertEqual(sub['fvoci_adjusted']['yoy_status'], 'not_presented')
                    self.assertIsNone(sub['fvoci_adjusted']['yoy_pct'])
        apply_yoy_policy(data, None, '115/08')
        self.assertTrue(all(c['holding_company']['cumulative_profit_yoy_status'] == 'missing' for c in data['companies']))


if __name__ == '__main__':
    unittest.main()
