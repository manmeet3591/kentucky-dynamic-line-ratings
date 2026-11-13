"""Clip HIFLD transmission lines to Kentucky and cut them into ~1 km segments with azimuth.

Output: data/segments.parquet (one row per segment) and data/lines.geojson (simplified
line geometry for the map, one feature per line).
"""
import json
from pathlib import Path

import geopandas as gpd
import numpy as np
import pandas as pd
from shapely.geometry import LineString, MultiLineString

ROOT = Path(__file__).resolve().parents[1]
SRC = Path("/home/airlab1/Documents/energy/kentucky-grid-fm/data/raw/static")
SEG_M = 1000.0
GRID = 0.25  # ERA5 grid spacing (deg); segments are matched to the nearest grid node

CLASSES = [69, 138, 161, 230, 345, 500, 765]


def main():
    lines = gpd.read_file(SRC / "hifld_lines_ky.geojson")
    counties = gpd.read_file(SRC / "counties.geojson")
    ky = counties.to_crs(5070).geometry.buffer(0).union_all()
    lines = lines[lines.VOLTAGE.isin(CLASSES) & (lines.STATUS == "IN SERVICE")].copy()
    lines = lines.to_crs(5070)
    lines["geometry"] = lines.geometry.intersection(ky)
    lines = lines[~lines.geometry.is_empty & (lines.geometry.length > 200)]

    rows, feats = [], []
    for _, ln in lines.iterrows():
        parts = ln.geometry.geoms if isinstance(ln.geometry, MultiLineString) else [ln.geometry]
        parts = [p for p in parts if isinstance(p, LineString) and p.length > 50]
        if not parts:
            continue
        for p in parts:
            n = max(1, int(round(p.length / SEG_M)))
            cuts = np.linspace(0, p.length, n + 1)
            for a, b in zip(cuts[:-1], cuts[1:]):
                rows.append(dict(line_id=ln.ID, kv=int(ln.VOLTAGE), owner=ln.OWNER,
                                 p0=p.interpolate(a), p1=p.interpolate(b),
                                 pm=p.interpolate((a + b) / 2), len_m=b - a))
        feats.append((ln.ID, int(ln.VOLTAGE), ln.OWNER, MultiLineString(parts)))

    seg = pd.DataFrame(rows)
    pts = {k: gpd.GeoSeries(seg[k], crs=5070).to_crs(4326) for k in ("p0", "p1", "pm")}
    lat0, lon0 = pts["p0"].y.values, pts["p0"].x.values
    lat1, lon1 = pts["p1"].y.values, pts["p1"].x.values
    # azimuth of the segment chord, clockwise from north, folded to 0-180 (a line has no direction)
    dx = (lon1 - lon0) * np.cos(np.radians((lat0 + lat1) / 2))
    dy = lat1 - lat0
    seg["az"] = np.degrees(np.arctan2(dx, dy)) % 180.0
    seg["lat"], seg["lon"] = pts["pm"].y.values.round(5), pts["pm"].x.values.round(5)
    seg["glat"] = (np.round(seg.lat / GRID) * GRID).round(2)
    seg["glon"] = (np.round(seg.lon / GRID) * GRID).round(2)
    seg = seg.drop(columns=["p0", "p1", "pm"])
    seg["len_m"] = seg.len_m.round(1)
    (ROOT / "data").mkdir(exist_ok=True)
    seg.to_parquet(ROOT / "data/segments.parquet", index=False)

    g = gpd.GeoDataFrame(feats, columns=["line_id", "kv", "owner", "geometry"], crs=5070)
    g["km"] = (g.geometry.length / 1000).round(1)
    g["geometry"] = g.geometry.simplify(60)
    g = g.to_crs(4326)
    g.to_file(ROOT / "data/lines.geojson", driver="GeoJSON", COORDINATE_PRECISION=4)
    print(f"{len(g)} lines, {len(seg)} segments, {seg.len_m.sum()/1000:.0f} km, "
          f"{seg[['glat','glon']].drop_duplicates().shape[0]} weather grid nodes")
    print(g.groupby("kv").km.agg(["count", "sum"]).round(0))


if __name__ == "__main__":
    main()
