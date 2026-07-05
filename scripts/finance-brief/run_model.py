#!/usr/bin/env python3
"""U3: qlib bin → Alpha158+LightGBM → signals.json.
함정(PoC 실측): kernels=1 + 파일 실행 + MLFLOW_ALLOW_FILE_STORE=true."""
import os
import sys
import json
import warnings

os.environ.setdefault("MLFLOW_ALLOW_FILE_STORE", "true")
# mlflow mlruns를 gitignored data/ 아래로 강제 — scripts/ 오염·경로 유출 방지.
_HERE = os.path.dirname(os.path.abspath(__file__))
os.environ.setdefault(
    "MLFLOW_TRACKING_URI",
    "file:" + os.path.abspath(os.path.join(_HERE, "../../data/finance-brief/mlruns")),
)
warnings.filterwarnings("ignore")
import pandas as pd  # noqa: E402
import qlib  # noqa: E402
from qlib.constant import REG_CN  # noqa: E402


def load_sectors(path: str):
    """(symbol→sector Series, symbol→name dict) 반환. universe.json 또는 sectors.csv."""
    if path.endswith(".json"):
        u = json.load(open(path, encoding="utf-8"))["instruments"]
        s = pd.DataFrame(u).set_index("symbol")
        return s["sector"], s["name"].to_dict()
    df = pd.read_csv(path, dtype={"symbol": str}).set_index("symbol")
    return df["sector"], {k: k for k in df.index}


def main(qlib_dir: str, sector_map: str, out_json: str, top_n: int = 5) -> None:
    qlib.init(provider_uri=qlib_dir, region=REG_CN, kernels=1)
    from qlib.contrib.data.handler import Alpha158
    from qlib.data.dataset import DatasetH
    from qlib.contrib.model.gbdt import LGBModel
    from qlib.data import D

    sectors, names = load_sectors(sector_map)
    cal = D.calendar()
    start, end = str(cal[0])[:10], str(cal[-1])[:10]
    n = len(cal)
    tr, va = str(cal[int(n * 0.7)])[:10], str(cal[int(n * 0.85)])[:10]
    seg = {"train": (start, tr), "valid": (tr, va), "test": (va, end)}

    h = Alpha158(instruments="all", start_time=start, end_time=end,
                 fit_start_time=start, fit_end_time=tr)
    ds = DatasetH(handler=h, segments=seg)
    model = LGBModel(loss="mse", learning_rate=0.05, num_leaves=63, max_depth=6,
                     colsample_bytree=0.8, subsample=0.8, lambda_l1=10.0,
                     lambda_l2=50.0, num_threads=4)
    model.fit(ds)
    pred = model.predict(ds)
    if isinstance(pred, pd.DataFrame):
        pred = pred.iloc[:, 0]
    pred.name = "score"

    label = ds.prepare("test", col_set="label")
    if isinstance(label, pd.DataFrame):
        label = label.iloc[:, 0]
    d = pd.concat([pred, label.rename("label")], axis=1).dropna()
    ic = d.groupby(level=0).apply(lambda g: g["score"].corr(g["label"]))
    ric = d.groupby(level=0).apply(lambda g: g["score"].corr(g["label"], method="spearman"))

    last = pred.index.get_level_values(0).max()
    xs = pred.xs(last, level=0).sort_values(ascending=False)
    df = xs.rename_axis("symbol").reset_index()
    df["sector"] = df["symbol"].map(sectors)
    df["name"] = df["symbol"].map(lambda s: names.get(s, s))

    def recs(frame):
        return [{"symbol": r.symbol, "name": r["name"], "sector": r.sector,
                 "score": round(float(r.score), 6)} for _, r in frame.iterrows()]

    rot = df.groupby("sector")["score"].mean().sort_values(ascending=False)
    out = {
        "asof": str(last)[:10],
        "universeSize": int(len(xs)),
        "top": recs(df.head(top_n)),
        "bottom": recs(df.tail(top_n).iloc[::-1]),
        "sectorRotation": [{"sector": s, "score": round(float(v), 6), "rank": i}
                           for i, (s, v) in enumerate(rot.items(), 1)],
        "meta": {"model": "Alpha158+LGBM", "ic": round(float(ic.mean()), 4),
                 "icir": round(float(ic.mean() / ic.std()), 3),
                 "rankic": round(float(ric.mean()), 4)},
    }
    json.dump(out, open(out_json, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    print(f"OK signals -> {out_json}  ic={out['meta']['ic']} sectors={len(rot)}")


if __name__ == "__main__":
    args = sys.argv[1:]
    top = 5
    if "--top" in args:
        i = args.index("--top")
        top = int(args[i + 1])
        args = args[:i] + args[i + 2:]
    main(args[0], args[1], args[2], top)
