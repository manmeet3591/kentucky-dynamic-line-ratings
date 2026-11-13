"""Hourly weather at the segment grid nodes from Open-Meteo (no API key needed).

Sources
  era5      ERA5 reanalysis, 0.25 deg (Open-Meteo historical archive)  -> "hindcast"
  fcst_d1-3 NOAA GFS/HRRR as issued 1, 2, 3 days ahead (Open-Meteo Previous Runs API,
            model gfs_seamless = HRRR 3 km over CONUS for the first ~48 h, GFS 0.11-0.25 deg after)

Every source returns the same layout: dict of 2-D arrays (node x hour) for
  ta (C), ws (m/s, 10 m), wd (deg, from), dni (W/m2, beam normal), dhi (W/m2, diffuse)
so another gridded source (e.g. DSOC's 1 km Aircast SR fields) can be added as one more
function with that signature: fetch(nodes_df, start, end) -> (times, dict).
"""
import hashlib
import json
import time
from pathlib import Path

import numpy as np
import pandas as pd
import requests

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / "raw/openmeteo"
VARS = ["temperature_2m", "wind_speed_10m", "wind_direction_10m", "direct_radiation", "diffuse_radiation"]
BATCH = 50


def _get(url, params):
    key = hashlib.sha1((url + json.dumps(params, sort_keys=True)).encode()).hexdigest()[:20]
    f = CACHE / f"{key}.json"
    if f.exists():
        return json.loads(f.read_text())
    for attempt in range(30):
        r = requests.get(url, params=params, timeout=180)
        if r.status_code == 429 or (r.status_code >= 500):
            wait = min(65 * (attempt + 1), 600)
            print(f"  HTTP {r.status_code}: {r.text[:120]} - waiting {wait}s", flush=True)
            time.sleep(wait)
            continue
        r.raise_for_status()
        CACHE.mkdir(parents=True, exist_ok=True)
        f.write_text(r.text)
        return r.json()
    raise RuntimeError("Open-Meteo kept refusing")


def _fetch(url, nodes, start, end, extra, suffix=""):
    out, times, elev = {v: [] for v in VARS}, None, []
    for i in range(0, len(nodes), BATCH):
        b = nodes.iloc[i:i + BATCH]
        params = dict(latitude=",".join(f"{x:.2f}" for x in b.glat),
                      longitude=",".join(f"{x:.2f}" for x in b.glon),
                      hourly=",".join(v + suffix for v in VARS), start_date=start, end_date=end,
                      wind_speed_unit="ms", timezone="GMT", **extra)
        js = _get(url, params)
        js = js if isinstance(js, list) else [js]
        for j in js:
            h = j["hourly"]
            times = pd.to_datetime(h["time"], utc=True)
            elev.append(j.get("elevation", 200.0))
            for v in VARS:
                out[v].append(np.array(h[v + suffix], dtype=float))
    arr = {v: np.vstack(out[v]) for v in VARS}
    return times, arr, np.array(elev)


def _to_std(times, arr, elev, nodes):
    from ieee738 import solar_position
    alt, _ = solar_position(times, nodes.glat.values[:, None], nodes.glon.values[:, None])
    # Open-Meteo radiation is the mean of the preceding hour; use mid-hour sun height to turn
    # horizontal beam into beam-normal, capped to avoid blow-up near sunrise/sunset.
    alt_mid, _ = solar_position(times - pd.Timedelta(minutes=30), nodes.glat.values[:, None], nodes.glon.values[:, None])
    s = np.sin(np.radians(np.clip(alt_mid, 0, 90)))
    dni = np.where(s > 0.05, arr["direct_radiation"] / np.maximum(s, 0.05), 0.0)
    dni = np.minimum(np.nan_to_num(dni), 1100.0)
    return dict(ta=arr["temperature_2m"], ws=arr["wind_speed_10m"], wd=arr["wind_direction_10m"],
                dni=dni, dhi=np.nan_to_num(arr["diffuse_radiation"]), elev=elev)


def era5(nodes, start, end):
    t, a, e = _fetch("https://archive-api.open-meteo.com/v1/archive", nodes, start, end, dict(models="era5"))
    return t, _to_std(t, a, e, nodes)


def forecast(nodes, start, end, lead_day):
    t, a, e = _fetch("https://previous-runs-api.open-meteo.com/v1/forecast", nodes, start, end,
                     dict(models="gfs_seamless"), suffix=f"_previous_day{lead_day}")
    return t, _to_std(t, a, e, nodes)
