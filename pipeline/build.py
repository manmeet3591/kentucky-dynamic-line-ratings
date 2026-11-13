"""Fetch weather, rate every segment hourly and write the dashboard data to docs/data/.

  python pipeline/build.py            # showcase periods (hindcast + 1-3 day forecasts)
  python pipeline/build.py --year     # also the full-year 2025 ERA5 statistics

A line's rating in an hour is the minimum over its ~1 km segments (the hottest span limits
the whole circuit). Ratios are stored as uint8 = round(ratio * 80), i.e. 0.0125 steps, max 3.19.
"""
import argparse
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).parent))
import ieee738 as I
import rate
import weather

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs/data"
SCALE = 80.0
YEAR = 2025

PERIODS = [
    dict(id="heatwave", name="Summer heat wave", start="2025-08-14", end="2025-08-20",
         blurb="Mid-August 2025: five days in a row with afternoon highs up to 37 °C (99 °F) in Kentucky, with mostly light wind."),
    dict(id="calmhot", name="Calm hot afternoon", start="2025-06-23", end="2025-06-26",
         blurb="The late-June 2025 heat dome: 35 °C with almost no wind in the afternoon. This is the worst case DLR is meant to catch. In the worst hour the tightest 5 % of lines drop to about 0.8× their summer rating."),
    dict(id="windycool", name="Windy cool day", start="2025-03-04", end="2025-03-06",
         blurb="4–5 March 2025: a strong cold front with sustained 7 m/s winds and mild temperatures. The median line could carry about 1.8× its static rating."),
    dict(id="warmwinter", name="Warm calm winter day", start="2024-02-18", end="2024-02-20",
         blurb="February 2024: a sunny, calm 14–18 °C afternoon while the winter rating assumes 5 °C. On days like this the winter rating is more than the line can safely carry."),
]
SOURCES = ["era5", "d1", "d2", "d3"]


def encode(r):
    return np.clip(np.round(np.nan_to_num(r, nan=0) * SCALE), 0, 255).astype(np.uint8)


def setup():
    seg = pd.read_parquet(ROOT / "data/segments.parquet")
    lines = json.loads((ROOT / "data/lines.geojson").read_text())
    ids = [f["properties"]["line_id"] for f in lines["features"]]
    nodes = seg[["glat", "glon"]].drop_duplicates().sort_values(["glat", "glon"]).reset_index(drop=True)
    key = {k: i for i, k in enumerate(zip(nodes.glat, nodes.glon))}
    ni = np.array([key[k] for k in zip(seg.glat, seg.glon)])
    li = pd.Index(ids).get_indexer(seg.line_id)
    assert (li >= 0).all()
    return seg, lines, ids, nodes, ni, li


def line_min(amp, li, n_lines):
    """Per-line minimum over segments, plus which segment limited it."""
    out = np.full((n_lines, amp.shape[1]), np.inf, dtype=np.float32)
    np.minimum.at(out, li, amp)
    return out


def line_static(kv_by_line, times):
    return rate.seasonal_static(np.asarray(kv_by_line), times).astype(np.float32)


def periods(seg, lines, ids, nodes, ni, li):
    kv_line = [f["properties"]["kv"] for f in lines["features"]]
    meta_periods, skill = [], {}
    for p in PERIODS:
        print("period", p["id"], flush=True)
        pdir = OUT / p["id"]
        pdir.mkdir(parents=True, exist_ok=True)
        res, wx = {}, {}
        for src in SOURCES:
            if src == "era5":
                t, w = weather.era5(nodes, p["start"], p["end"])
            else:
                t, w = weather.forecast(nodes, p["start"], p["end"], int(src[1]))
            amp = rate.rate_segments(seg, ni, t, w)
            res[src] = line_min(amp, li, len(ids))
            wx[src] = w
            if src == "era5":
                times = t
                aar = line_min(rate.rate_segments(seg, ni, t, w, mode="aar"), li, len(ids))
                # limiting node per line: mode over hours of the argmin segment
                lim = np.zeros(len(ids), dtype=int)
                am = pd.DataFrame(amp).groupby(li).idxmin()  # segment row index per line x hour
                for l, row in am.iterrows():
                    lim[l] = pd.Series(ni[row.values]).mode().iloc[0]
        stat = line_static(kv_line, times)
        for src in SOURCES:
            (pdir / f"{src}.bin").write_bytes(encode(res[src] / stat).tobytes())
        (pdir / "aar.bin").write_bytes(encode(aar / stat).tobytes())
        # forecast skill vs ERA5 hindcast (ratio space), all line-hours
        r0 = res["era5"] / stat
        sk = {}
        for src in SOURCES[1:]:
            r = res[src] / stat
            ok = np.isfinite(r) & (r > 0)
            sk[src] = dict(
                mae=float(np.mean(np.abs(r - r0)[ok])),
                bias=float(np.mean((r - r0)[ok])),
                # forecast promised headroom (>1) but hindcast says deficit (<1): the risky miss
                false_headroom=float(np.mean(((r > 1) & (r0 < 1))[ok])),
                missed_headroom=float(np.mean(((r < 1) & (r0 > 1.1))[ok])),
                n=int(ok.sum()))
        skill[p["id"]] = sk
        weather_out = {}
        for src in SOURCES:
            w = wx[src]
            weather_out[src] = dict(ta=np.round(w["ta"], 1).tolist(), ws=np.round(w["ws"], 1).tolist(),
                                    wd=np.round(w["wd"]).astype(int).tolist(),
                                    ghi=np.round(w["dhi"] + w["dni"] * np.sin(np.radians(np.clip(
                                        I.solar_position(times, nodes.glat.values[:, None], nodes.glon.values[:, None])[0], 0, 90))), 0).tolist())
        (pdir / "weather.json").write_text(json.dumps(dict(nodes=nodes[["glat", "glon"]].values.tolist(),
                                                           line_node=lim.tolist(), **weather_out),
                                                      separators=(",", ":")))
        meta_periods.append(dict(**p, times=[x.isoformat() for x in times], n_hours=len(times)))
    return meta_periods, skill


def year_stats(seg, lines, ids, nodes, ni, li):
    """Full-year ERA5 statistics: per-line shares and statewide monthly / hour-of-day mix."""
    kv_line = [f["properties"]["kv"] for f in lines["features"]]
    bins = [0, 0.9, 1.0, 1.2, 1.5, 99]
    labels = ["<0.9", "0.9–1.0", "1.0–1.2", "1.2–1.5", "≥1.5"]
    n = len(ids)
    per_line = dict(h=np.zeros(n), deficit=np.zeros(n), deficit10=np.zeros(n), head20=np.zeros(n),
                    head50=np.zeros(n), aar_deficit=np.zeros(n), p05=[], p50=[])
    monthly, hourly = {}, np.zeros((24, len(labels)))
    by_kv = {}
    all_r = []
    for m in range(1, 13):
        start = f"{YEAR}-{m:02d}-01"
        end = (pd.Timestamp(start) + pd.offsets.MonthEnd(0)).strftime("%Y-%m-%d")
        print("year month", m, flush=True)
        t, w = weather.era5(nodes, start, end)
        stat = line_static(kv_line, t)
        r = line_min(rate.rate_segments(seg, ni, t, w), li, n) / stat
        ra = line_min(rate.rate_segments(seg, ni, t, w, mode="aar"), li, n) / stat
        per_line["h"] += r.shape[1]
        per_line["deficit"] += (r < 1).sum(1)
        per_line["deficit10"] += (r < 0.9).sum(1)
        per_line["head20"] += (r >= 1.2).sum(1)
        per_line["head50"] += (r >= 1.5).sum(1)
        per_line["aar_deficit"] += (ra < 1).sum(1)
        cnt = np.histogram(r, bins)[0]
        monthly[m] = (cnt / cnt.sum()).round(4).tolist()
        loc_h = t.tz_convert("America/New_York").hour
        for h in range(24):
            hourly[h] += np.histogram(r[:, loc_h == h], bins)[0]
        for kv in sorted(set(kv_line)):
            mk = np.array(kv_line) == kv
            c = by_kv.setdefault(kv, np.zeros(len(labels)))
            c += np.histogram(r[mk], bins)[0]
        all_r.append(encode(r))
    allr = np.concatenate(all_r, axis=1) / SCALE
    p05 = np.percentile(allr, 5, axis=1)
    p50 = np.percentile(allr, 50, axis=1)
    H = per_line["h"]
    lines_out = dict(
        deficit=(per_line["deficit"] / H).round(4).tolist(),
        deficit10=(per_line["deficit10"] / H).round(4).tolist(),
        head20=(per_line["head20"] / H).round(4).tolist(),
        head50=(per_line["head50"] / H).round(4).tolist(),
        aar_deficit=(per_line["aar_deficit"] / H).round(4).tolist(),
        p05=p05.round(3).tolist(), p50=p50.round(3).tolist())
    tot = np.histogram(allr, bins)[0]
    return dict(year=YEAR, labels=labels, total=(tot / tot.sum()).round(4).tolist(),
                monthly=monthly, hourly=(hourly / hourly.sum(1, keepdims=True)).round(4).tolist(),
                by_kv={str(k): (v / v.sum()).round(4).tolist() for k, v in by_kv.items()},
                lines=lines_out, line_hours=int(allr.size))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--year", action="store_true")
    args = ap.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    seg, lines, ids, nodes, ni, li = setup()
    tab = rate.static_table()
    for f in lines["features"]:
        pr = f["properties"]
        pr["summer_a"] = round(tab[pr["kv"]]["summer"])
        pr["winter_a"] = round(tab[pr["kv"]]["winter"])
        pr["nseg"] = int((seg.line_id == pr["line_id"]).sum())
    (OUT / "lines.geojson").write_text(json.dumps(lines, separators=(",", ":")))
    meta_p, skill = periods(seg, lines, ids, nodes, ni, li)
    meta = dict(built=pd.Timestamp.now(tz="UTC").strftime("%Y-%m-%d"), scale=SCALE, periods=meta_p, skill=skill,
                static={str(k): v for k, v in tab.items()}, static_assumptions=rate.STATIC,
                winter_months=list(rate.WINTER_MONTHS), t_max=I.T_MAX, emissivity=I.EMISSIVITY,
                absorptivity=I.ABSORPTIVITY, n_lines=len(ids), n_segments=len(seg), n_nodes=len(nodes),
                km=round(float(seg.len_m.sum() / 1000)))
    (OUT / "meta.json").write_text(json.dumps(meta, separators=(",", ":")))
    if args.year:
        ys = year_stats(seg, lines, ids, nodes, ni, li)
        (OUT / "year.json").write_text(json.dumps(ys, separators=(",", ":")))
    print("done")


if __name__ == "__main__":
    main()
