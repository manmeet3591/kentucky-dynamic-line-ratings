# Kentucky Dynamic Line Ratings (prototype)

Hourly IEEE 738 thermal ratings for Kentucky's transmission lines, computed from weather and compared with
conventional static seasonal ratings and FERC Order 881 ambient-adjusted ratings (AAR). Built for the Disaster
Science Operations Center (DSOC) to discuss dynamic line rating (DLR) with Kentucky utilities.

**Dashboard:** `docs/` (static, Leaflet; GitHub Pages from `/docs`).

- **Map**: lines coloured by rating ÷ static rating, with an hourly time slider, for four periods: a summer heat
  wave, a calm hot afternoon, a windy cool day and a warm calm winter day.
- **Weather sources**: switch between the ERA5 hindcast and NOAA GFS/HRRR forecasts issued 1, 2 and 3 days ahead.
- **Line detail**: amps over the period for each weather source, AAR and static, plus the weather at the line's limiting node.
- **Year 2025**: share of line-hours with headroom or deficit, broken down by month, hour of day and voltage, plus the lines with the most deficit hours.
- **Method & limits**: the assumptions (conductor per voltage class, static rating weather, max temperature) and what is not validated.

## Pipeline

```bash
mamba create -n ky-dlr python=3.12 numpy pandas geopandas shapely pyproj requests pyarrow
conda activate ky-dlr
python pipeline/ieee738.py          # self-check against the IEEE 738-2012 Drake example (1025 A)
python pipeline/segment_lines.py    # HIFLD lines -> ~1 km segments with azimuth, nearest 0.25° weather node
python pipeline/choose_periods.py   # ERA5 2024-2025 scan used to pick the showcase periods
python pipeline/build.py --year     # weather fetch + ratings -> docs/data/
```

Weather comes from Open-Meteo (no key needed): the ERA5 archive and the Previous Runs API (`gfs_seamless`,
`*_previous_dayN`). Responses are cached in `raw/openmeteo/` (not committed). The free tier is rate-limited, so the
full-year build takes about an hour. Everything runs on a CPU in a few minutes, apart from waiting on the API. Nothing is trained.

| file | what |
|---|---|
| `pipeline/ieee738.py` | vectorised IEEE 738-2012 steady-state heat balance, conductor library, solar position |
| `pipeline/rate.py` | per-segment hourly DLR and AAR, static seasonal ratings, assumptions |
| `pipeline/weather.py` | weather sources behind one interface `fetch(nodes, start, end) -> (times, {ta, ws, wd, dni, dhi})` |
| `pipeline/build.py` | periods, forecast skill, year statistics; writes `docs/data/` |

### Data layout (`docs/data/`)

- `lines.geojson`: one feature per line (simplified geometry, kV, owner, km, static summer/winter amps).
- `meta.json`: periods (hourly UTC times), assumptions, static table, forecast skill.
- `<period>/{era5,d1,d2,d3,aar}.bin`: uint8 matrix, lines × hours (row-major, line order as in
  `lines.geojson`), value = round(ratio × 80); 0 = no data.
- `<period>/weather.json`: node weather per source, and each line's limiting node.
- `year.json`: 2025 ERA5 statistics.

## Assumptions (short)

- Conductor by voltage class: 69 kV 336.4 ACSR Linnet; 138 kV 795 Drake; 161 kV 954 Cardinal; 345 kV 2× Cardinal;
  500 kV 3× Cardinal; 765 kV 4× Cardinal. Max conductor temperature 100 °C, emissivity and absorptivity 0.8.
- Static ratings: summer 35 °C, winter 5 °C; both with 0.61 m/s wind perpendicular to the line and clear-sky sun
  perpendicular to the line. The winter rating applies Dec–Feb and the summer rating Mar–Nov.
- A line's hourly rating is the minimum over its ~1 km segments.

## Limitations

No line sensor, conductor temperature or utility rating data are available, so nothing is validated. The conductors
are assumed. Weather is sampled at 0.25° nodes (~25 km), including the HRRR forecasts. Wind at 10 m in a grid cell
average is not the wind at a sheltered span, and that matters most at low wind, which is when ratings are tight.
The ratings are steady-state only, and terminal-equipment limits are ignored. Forecasts are scored against ERA5, not observations.

## Next step: DSOC Aircast SR (1 km)

Add a source in `pipeline/weather.py` that samples the 1 km super-resolved fields at each segment midpoint, and set
the segment-to-node mapping to one node per segment. Nothing else in the pipeline needs to change.

Data: HIFLD Open (public domain); Open-Meteo (CC BY 4.0) with ERA5 (Copernicus C3S) and NOAA GFS/HRRR.
