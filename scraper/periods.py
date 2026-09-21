"""Public inputs use Gregorian YYYY/MM; MOPS storage retains ROC identifiers."""
import re


def storage_period(value):
    match = re.fullmatch(r'(\d{3,4})[/-](\d{1,2})', value or '')
    if not match:
        raise ValueError('月份格式必須為 YYYY/MM，例如 2026/08')
    year, month = map(int, match.groups())
    if year >= 1912:
        year -= 1911
    if not 1 <= year <= 999 or not 1 <= month <= 12:
        raise ValueError('月份超出範圍')
    return f'{year:03d}/{month:02d}'
