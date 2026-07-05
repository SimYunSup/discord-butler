#!/usr/bin/env python3
"""스모크용 소형 합성 캔들(U1 CSV 스키마와 동일). 5섹터×6종목, 모멘텀 신호 삽입."""
import os, sys
import numpy as np
import pandas as pd

OUT = sys.argv[1] if len(sys.argv) > 1 else "synth_csv"
os.makedirs(OUT, exist_ok=True)
rng = np.random.default_rng(42)
dates = pd.bdate_range("2021-01-04", "2024-12-31")
N = len(dates)
SECTORS = ["TECH", "FIN", "BIO", "CONS", "ENERGY"]
rows = []
for si, sec in enumerate(SECTORS):
    secincr = rng.normal(0, 0.008, N)
    for k in range(6):
        sym = f"SYM{si * 6 + k:02d}"
        rows.append((sym, sec))
        ret = np.zeros(N)
        idio = rng.normal(0.0003, 0.018, N)
        for t in range(N):
            mom = 0.15 * np.tanh(ret[t - 5:t].sum() * 8) if t >= 6 else 0.0
            ret[t] = 0.6 * secincr[t] + mom * 0.01 + idio[t]
        close = 10000 * np.exp(np.clip(ret, -0.15, 0.15).cumsum())
        prev = np.concatenate([[close[0]], close[:-1]])
        openp = prev * (1 + rng.normal(0, 0.003, N))
        high = np.maximum(openp, close) * (1 + np.abs(rng.normal(0, 0.004, N)))
        low = np.minimum(openp, close) * (1 - np.abs(rng.normal(0, 0.004, N)))
        pd.DataFrame({
            "date": dates.strftime("%Y-%m-%d"),
            "open": openp.round(1), "high": high.round(1), "low": low.round(1),
            "close": close.round(1), "volume": rng.integers(1e5, 5e6, N),
            "vwap": ((high + low + close) / 3).round(1), "factor": 1.0,
            "change": (close / prev - 1).round(6),
        }).to_csv(os.path.join(OUT, f"{sym}.csv"), index=False)

pd.DataFrame(rows, columns=["symbol", "sector"]).to_csv(
    os.path.join(os.path.dirname(OUT) or ".", "synth_sectors.csv"), index=False)
print(f"wrote {len(rows)} symbols x {N} days -> {OUT}")
