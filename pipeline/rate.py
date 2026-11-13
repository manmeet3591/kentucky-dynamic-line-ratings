"""Rate every segment for every hour, plus the static seasonal and ambient-adjusted ratings."""
import numpy as np
import pandas as pd

import ieee738 as I

# Static (seasonal) rating assumptions - typical US practice, stated on the method page.
STATIC = {
    "summer": dict(ta=35.0, ws=0.61, sun_alt=75.5),  # 95 F, 2 ft/s perpendicular, clear noon ~21 Jun at 37.5 N
    "winter": dict(ta=5.0, ws=0.61, sun_alt=32.5),   # 41 F, 2 ft/s perpendicular, clear noon ~21 Jan
}
WINTER_MONTHS = (12, 1, 2)   # winter rating Dec-Feb, summer rating Mar-Nov (conservative)
STATIC_ELEV = 200.0          # m, typical Kentucky line elevation for the static calc


def static_rating(kv, season):
    cond, n = I.VOLTAGE_CLASSES[kv]
    s = STATIC[season]
    qs = I.ABSORPTIVITY * I.qs_clear_sky(s["sun_alt"], STATIC_ELEV) * I.CONDUCTORS[cond]["d_m"]  # sun normal to line
    return float(I.ampacity(cond, n, s["ta"], s["ws"], np.pi / 2, qs, STATIC_ELEV))


def static_table():
    return {kv: dict(summer=static_rating(kv, "summer"), winter=static_rating(kv, "winter"),
                     conductor=I.CONDUCTORS[c]["name"], n_sub=n)
            for kv, (c, n) in I.VOLTAGE_CLASSES.items()}


def seasonal_static(kv_arr, times):
    tab = static_table()
    summer = np.array([tab[k]["summer"] for k in kv_arr])
    winter = np.array([tab[k]["winter"] for k in kv_arr])
    is_w = np.isin(times.month, WINTER_MONTHS)
    return np.where(is_w[None, :], winter[:, None], summer[:, None])


def rate_segments(seg, node_index, times, w, mode="dlr"):
    """Ampacity (A) for every segment (rows) and hour (cols).

    mode 'dlr': measured/forecast ambient, wind speed and direction, solar.
    mode 'aar': ambient-adjusted rating (FERC Order 881): hourly ambient temperature and
                sun position, but the static 0.61 m/s perpendicular wind and clear-sky sun.
    """
    out = np.empty((len(seg), len(times)), dtype=np.float32)
    ni = node_index
    for kv, (cond, n) in I.VOLTAGE_CLASSES.items():
        m = (seg.kv.values == kv)
        if not m.any():
            continue
        idx = ni[m]
        az = seg.az.values[m][:, None]
        ta = w["ta"][idx]
        elev = w["elev"][idx][:, None]
        alt, saz = I.solar_position(times, seg.lat.values[m][:, None], seg.lon.values[m][:, None])
        if mode == "dlr":
            ws = w["ws"][idx]
            phi = np.radians(np.abs(((w["wd"][idx] - az) + 90) % 180 - 90))  # angle wind vs axis, 0-90
            qs = I.solar_gain(cond, w["dni"][idx], w["dhi"][idx], alt, saz, az)
        else:
            ws, phi = 0.61, np.pi / 2
            qs = I.ABSORPTIVITY * I.qs_clear_sky(alt, elev) * I.CONDUCTORS[cond]["d_m"]
        out[m] = I.ampacity(cond, n, ta, ws, phi, qs, elev)
    return out
