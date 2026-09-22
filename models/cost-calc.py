"""Recompute blended agent cost from pricing.csv.

Usage: python3 cost-calc.py [cached_share fresh_share output_share]
Default mix: 0.80 cached read, 0.15 fresh input, 0.05 output.
"""
import csv
import sys
from pathlib import Path

mix = [float(x) for x in sys.argv[1:4]] if len(sys.argv) >= 4 else [0.80, 0.15, 0.05]
cached, fresh, out = mix

rows = list(csv.DictReader(open(Path(__file__).with_name("pricing.csv"))))
for r in rows:
    inp = float(r["input"])
    cache = float(r["cache_read"]) if r["cache_read"] else inp  # no cache price listed: assume full input price
    r["blend"] = cached * cache + fresh * inp + out * float(r["output"])

print(f"Mix: {cached:.0%} cached / {fresh:.0%} fresh input / {out:.0%} output\n")
print(f"{'Model ID':36}{'Blended $/1M':>14}")
for r in sorted(rows, key=lambda r: r["blend"]):
    print(f"{r['id']:36}{r['blend']:>14.3f}")
