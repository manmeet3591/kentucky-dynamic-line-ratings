"""Scan 2024-2025 ERA5 at a subset of nodes to pick the showcase periods.

Prints candidates; the chosen dates are written into build.py by hand (kept reproducible).
"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).parent))
import rate
import weather

ROOT = Path(__file__).resolve().parents[1]

seg = pd.read_parquet(ROOT / "data/segments.parquet")
nodes = seg[["glat", "glon"]].drop_duplicates().reset_index(drop=True)
sub = nodes.iloc[::10].reset_index(drop=True)  # ~20 nodes spread over the state
key = list(zip(sub.glat, sub.glon))
s = seg[[k in set(key) for k in zip(seg.glat, seg.glon)]].reset_index(drop=True)
ni = np.array([key.index(k) for k in zip(s.glat, s.glon)])
print(len(sub), "nodes,", len(s), "segments")

times, w = weather.era5(sub, "2024-01-01", "2025-12-31")
amp = rate.rate_segments(s, ni, times, w)
ratio = amp / rate.seasonal_static(s.kv.values, times)
df = pd.DataFrame(dict(t=times, p05=np.percentile(ratio, 5, axis=0), med=np.median(ratio, axis=0),
                       tmax=w["ta"].max(0), tmean=w["ta"].mean(0), wmean=w["ws"].mean(0)))
df["local"] = df.t.dt.tz_convert("America/New_York")
df["day"] = df.local.dt.date
d = df.groupby("day").agg(tmax=("tmax", "max"), tmean=("tmean", "mean"), wmean=("wmean", "mean"),
                          p05min=("p05", "min"), medmin=("med", "min"), med=("med", "median"))
d["tmax5"] = d.tmax.rolling(5).mean()
print("\nHottest 5-day windows (end day):\n", d.tmax5.nlargest(8))
print("\nLowest hourly p05 ratio:\n", df.nsmallest(10, "p05")[["local", "p05", "med", "tmax", "wmean"]])
cool = d[d.tmean < 12]
print("\nWindiest cool days (highest median ratio):\n", cool.nlargest(8, "med"))
print("\nShare of hours with median ratio < 1:", (df.med < 1).mean().round(3))
