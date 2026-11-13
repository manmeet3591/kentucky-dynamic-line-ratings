"""IEEE Std 738-2012 steady-state thermal rating of bare overhead conductors (SI units).

Everything is vectorised with numpy so a whole (segment x hour) array is rated in one call.
Equation numbers refer to IEEE 738-2012, clause 4.4.
"""
import numpy as np

# Conductor library. Values are typical manufacturer-table numbers (Southwire / Aluminum
# Association ACSR tables, rounded); treat them as +-5 %.
#   d_m: outside diameter, r25/r75: AC resistance per conductor at 25 / 75 C (ohm/m)
CONDUCTORS = {
    "Linnet": dict(name="336.4 kcmil ACSR 26/7 'Linnet'", d_m=0.01831, r25=1.709e-4, r75=2.100e-4),
    "Drake": dict(name="795 kcmil ACSR 26/7 'Drake'", d_m=0.02812, r25=7.283e-5, r75=8.688e-5),
    "Cardinal": dict(name="954 kcmil ACSR 54/7 'Cardinal'", d_m=0.03038, r25=6.10e-5, r75=7.28e-5),
    "Bittern": dict(name="1272 kcmil ACSR 45/7 'Bittern'", d_m=0.03416, r25=4.69e-5, r75=5.58e-5),
}

# Assumed conductor per voltage class (kV): (conductor, sub-conductors per phase).
# These are common US choices, not the actual Kentucky conductors (not public).
VOLTAGE_CLASSES = {
    69: ("Linnet", 1),
    138: ("Drake", 1),
    161: ("Cardinal", 1),
    230: ("Bittern", 1),
    345: ("Cardinal", 2),
    500: ("Cardinal", 3),
    765: ("Cardinal", 4),
}

EMISSIVITY = 0.8      # weathered conductor (IEEE 738 example value)
ABSORPTIVITY = 0.8
T_MAX = 100.0         # max operating (normal) conductor temperature, C

# Clear-atmosphere total solar heat flux polynomial, IEEE 738-2012 Table 3 (Hc in degrees)
_QS_CLEAR = [-42.2391, 63.8044, -1.9220, 3.46921e-2, -3.61118e-4, 1.94318e-6, -4.07608e-9]


def resistance(cond, t):
    """AC resistance (ohm/m) at conductor temperature t, linear through 25 and 75 C (eq. 10)."""
    c = CONDUCTORS[cond]
    return c["r25"] + (c["r75"] - c["r25"]) / 50.0 * (t - 25.0)


def _air(t_film, elev_m):
    mu = 1.458e-6 * (t_film + 273.0) ** 1.5 / (t_film + 383.4)                     # eq. 13a
    rho = (1.293 - 1.525e-4 * elev_m + 6.379e-9 * elev_m ** 2) / (1 + 0.00367 * t_film)  # eq. 14a
    k = 2.424e-2 + 7.477e-5 * t_film - 4.407e-9 * t_film ** 2                        # eq. 15a
    return mu, rho, k


def convective(d, ts, ta, wind, phi_rad, elev_m):
    """Convective cooling (W/m); phi = angle between wind and conductor axis."""
    tf = (ts + ta) / 2.0
    mu, rho, k = _air(tf, elev_m)
    nre = d * rho * np.maximum(wind, 0.0) / mu                                       # eq. 2c
    kang = 1.194 - np.cos(phi_rad) + 0.194 * np.cos(2 * phi_rad) + 0.368 * np.sin(2 * phi_rad)  # eq. 4a
    dt = ts - ta
    qc1 = kang * (1.01 + 1.35 * nre ** 0.52) * k * dt                                 # eq. 3a
    qc2 = kang * 0.754 * nre ** 0.6 * k * dt                                          # eq. 3b
    qcn = 3.645 * np.sqrt(rho) * d ** 0.75 * np.abs(dt) ** 1.25 * np.sign(dt)         # eq. 5a
    return np.maximum(np.maximum(qc1, qc2), qcn)


def radiative(d, ts, ta, eps=EMISSIVITY):
    return 17.8 * d * eps * (((ts + 273.0) / 100.0) ** 4 - ((ta + 273.0) / 100.0) ** 4)  # eq. 7a


def qs_clear_sky(hc_deg, elev_m):
    """Clear-sky total solar flux on a surface normal to the sun (W/m2), eq. 18 + 20."""
    hc = np.clip(hc_deg, 0, 90)
    q = sum(c * hc ** i for i, c in enumerate(_QS_CLEAR))
    k = 1 + 1.148e-4 * elev_m - 1.108e-8 * elev_m ** 2
    return np.where(hc_deg > 0, np.maximum(q, 0) * k, 0.0)


def ampacity(cond, n_sub, ta, wind, phi_rad, q_solar_wpm, elev_m, t_max=T_MAX):
    """Steady-state rating in amps per phase (n_sub sub-conductors).

    q_solar_wpm: solar heat gain per metre of one sub-conductor (W/m), already including
    absorptivity and diameter (see solar_gain).
    """
    d = CONDUCTORS[cond]["d_m"]
    qc = convective(d, t_max, ta, wind, phi_rad, elev_m)
    qr = radiative(d, t_max, ta)
    r = resistance(cond, t_max)
    net = np.maximum(qc + qr - q_solar_wpm, 0.0)
    return n_sub * np.sqrt(net / r)


def solar_gain(cond, beam_normal, diffuse, sun_alt_deg, sun_az_deg, line_az_deg,
               alpha=ABSORPTIVITY):
    """Solar heat gain (W/m) for one sub-conductor from beam-normal and diffuse irradiance.

    Beam: alpha * DNI * sin(theta) * D, theta = angle between sun ray and conductor axis
    (eq. 9). Diffuse: alpha * DHI * D (a simplification; IEEE 738 has no diffuse term
    separate from its clear-sky total flux).
    """
    d = CONDUCTORS[cond]["d_m"]
    hc = np.radians(sun_alt_deg)
    cos_theta = np.cos(hc) * np.cos(np.radians(sun_az_deg - line_az_deg))
    sin_theta = np.sqrt(np.clip(1 - cos_theta ** 2, 0, 1))
    return alpha * d * (np.maximum(beam_normal, 0) * sin_theta * (sun_alt_deg > 0) + np.maximum(diffuse, 0))


def solar_position(times_utc, lat, lon):
    """Approximate solar altitude and azimuth (deg, azimuth clockwise from north).

    NOAA low-precision formulas; times_utc is a pandas DatetimeIndex (UTC) and lat/lon
    broadcast against it. Accurate to ~0.5 deg, plenty for this use.
    """
    t = times_utc
    doy = np.asarray(t.dayofyear, dtype=float)
    hour = np.asarray(t.hour + t.minute / 60.0, dtype=float)
    g = 2 * np.pi / 365.0 * (doy - 1 + (hour - 12) / 24.0)
    eqt = 229.18 * (0.000075 + 0.001868 * np.cos(g) - 0.032077 * np.sin(g)
                    - 0.014615 * np.cos(2 * g) - 0.040849 * np.sin(2 * g))
    decl = (0.006918 - 0.399912 * np.cos(g) + 0.070257 * np.sin(g) - 0.006758 * np.cos(2 * g)
            + 0.000907 * np.sin(2 * g) - 0.002697 * np.cos(3 * g) + 0.00148 * np.sin(3 * g))
    tst = hour * 60 + eqt + 4 * lon
    ha = np.radians(tst / 4.0 - 180.0)
    la = np.radians(lat)
    cosz = np.sin(la) * np.sin(decl) + np.cos(la) * np.cos(decl) * np.cos(ha)
    zen = np.arccos(np.clip(cosz, -1, 1))
    alt = 90 - np.degrees(zen)
    az = np.degrees(np.arctan2(np.sin(ha), np.cos(ha) * np.sin(la) - np.tan(decl) * np.cos(la))) + 180.0
    return alt, az % 360.0


if __name__ == "__main__":
    # IEEE 738-2012 Annex example: Drake, Ta 40 C, 0.61 m/s perpendicular, Ts 100 C,
    # e = a = 0.8, clear sky, 11:00 solar time 10 June, lat 30 N, E-W line, sea level.
    # The standard's answer is ~1025 A (qc 81.93, qr 39.12, qs 22.44 W/m).
    d = CONDUCTORS["Drake"]["d_m"]
    qc = convective(d, 100.0, 40.0, 0.61, np.pi / 2, 0.0)
    qr = radiative(d, 100.0, 40.0)
    hc, zc = 74.88, 114.0
    theta = np.arccos(np.cos(np.radians(hc)) * np.cos(np.radians(zc - 90.0)))
    qs = ABSORPTIVITY * qs_clear_sky(hc, 0.0) * np.sin(theta) * d
    i = np.sqrt((qc + qr - qs) / resistance("Drake", 100.0))
    print(f"qc={qc:.2f} qr={qr:.2f} qs={qs:.2f} I={i:.0f} A (IEEE example: 81.93, 39.12, 22.44, 1025)")
