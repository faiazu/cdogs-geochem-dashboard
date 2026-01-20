import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.cluster import DBSCAN

META_COLS = [
    'Lab_Sample_Identifier','Lab_Key','Bundle_Key','Survey_Key','Site_Key','Field_Key',
    'Control_Reference_ID','Latitude_NAD83','Longitude_NAD83','Sample_Type_Name_en',
    'Preparation_Method_Name_en','QAQC_Block_ID','QAQC_Sample_Identifier','Order_Of_Analysis'
]

SAMPLE_TYPE_FIELD = 'NGR bulk stream sediment'
SAMPLE_TYPE_CONTROL = 'Control Reference'


def percentile_stats(x: pd.Series):
    x = x.dropna()
    if x.empty:
        return None
    return {
        'n': int(x.shape[0]),
        'min': float(x.min()),
        'p50': float(x.quantile(0.50)),
        'p90': float(x.quantile(0.90)),
        'p95': float(x.quantile(0.95)),
        'p99': float(x.quantile(0.99)),
        'max': float(x.max()),
        'mean': float(x.mean()),
        'std': float(x.std(ddof=1)) if x.shape[0] > 1 else 0.0,
    }


def haversine_dbscan(lat, lon, eps_km=7.5, min_samples=4):
    """DBSCAN clustering on a sphere using haversine distance."""
    # Convert to radians
    coords = np.radians(np.c_[lat, lon])
    eps_rad = eps_km / 6371.0
    model = DBSCAN(eps=eps_rad, min_samples=min_samples, metric='haversine')
    labels = model.fit_predict(coords)
    return labels


def to_geojson_points(df: pd.DataFrame, lat_col='lat', lon_col='lon', props_cols=None):
    props_cols = props_cols or []
    features = []
    for _, r in df.iterrows():
        props = {c: (None if pd.isna(r[c]) else r[c]) for c in props_cols}
        # JSON can't handle numpy types cleanly
        for k, v in list(props.items()):
            if isinstance(v, (np.integer,)):
                props[k] = int(v)
            elif isinstance(v, (np.floating,)):
                props[k] = float(v)
        features.append({
            'type': 'Feature',
            'geometry': {'type': 'Point', 'coordinates': [float(r[lon_col]), float(r[lat_col])]},
            'properties': props,
        })
    return {'type': 'FeatureCollection', 'features': features}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--input', required=True, help='Path to CDoGS bundle .xlsx (Negative convention)')
    ap.add_argument('--out', required=True, help='Output directory (e.g., web/data)')
    ap.add_argument('--eps-km', type=float, default=7.5, help='DBSCAN cluster radius in km for target grouping')
    ap.add_argument('--min-samples', type=int, default=4, help='DBSCAN min points to form a target')
    args = ap.parse_args()

    in_path = Path(args.input)
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    df = pd.read_excel(in_path)

    # Identify measurement columns
    meas_cols = [c for c in df.columns if c not in META_COLS]

    # Separate field vs control
    n_total = len(df)
    df_field = df[df['Sample_Type_Name_en'] == SAMPLE_TYPE_FIELD].copy()
    df_control = df[df['Sample_Type_Name_en'] == SAMPLE_TYPE_CONTROL].copy()

    # Rename coords
    df_field = df_field.rename(columns={'Latitude_NAD83': 'lat', 'Longitude_NAD83': 'lon'})

    # Basic QC checks
    qc = {
        'rows_total': int(n_total),
        'rows_field': int(len(df_field)),
        'rows_control_reference': int(len(df_control)),
        'missing_coords_field': int(df_field['lat'].isna().sum() + df_field['lon'].isna().sum()),
        'duplicate_lab_sample_identifier': int(df_field['Lab_Sample_Identifier'].duplicated().sum()),
    }

    # Clean coords
    df_field = df_field.dropna(subset=['lat', 'lon']).copy()

    # Detection limit handling: negative values mean "below DL"
    stats = {}

    for col in meas_cols:
        x = pd.to_numeric(df_field[col], errors='coerce')
        is_bdl = x < 0
        dl = x.abs().where(is_bdl)
        used = np.where(is_bdl, dl / 2.0, x)

        df_field[col] = used
        df_field[f'{col}__is_bdl'] = is_bdl.astype(int)
        df_field[f'{col}__dl'] = dl

        s = percentile_stats(pd.Series(used))
        if s is None:
            continue
        s['bdl_count'] = int(is_bdl.sum())
        s['bdl_pct'] = float(is_bdl.mean() * 100.0)
        stats[col] = s

    # Compute targets per element: top 95th percentile points clustered
    target_features = []
    for col, s in stats.items():
        thresh = s['p95']
        sub = df_field[df_field[col] >= thresh].copy()
        if len(sub) < args.min_samples:
            continue
        labels = haversine_dbscan(sub['lat'].to_numpy(), sub['lon'].to_numpy(), eps_km=args.eps_km, min_samples=args.min_samples)
        sub['cluster'] = labels

        for cl in sorted(set(labels)):
            if cl == -1:
                continue
            pts = sub[sub['cluster'] == cl]
            # centroid
            lat_c = float(pts['lat'].mean())
            lon_c = float(pts['lon'].mean())
            target_features.append({
                'type': 'Feature',
                'geometry': {'type': 'Point', 'coordinates': [lon_c, lat_c]},
                'properties': {
                    'element': col,
                    'threshold_p95': thresh,
                    'n_points': int(len(pts)),
                    'max_value': float(pts[col].max()),
                    'mean_value': float(pts[col].mean()),
                    'cluster_id': f'{col}_c{int(cl)}',
                    'eps_km': float(args.eps_km),
                }
            })

    targets_geojson = {'type': 'FeatureCollection', 'features': target_features}

    # Field ops: treat QAQC_Block_ID as "batch" (lab block) and create a manifest
    field_ops = (
        df_field.groupby('QAQC_Block_ID')
        .agg(
            samples=('Lab_Sample_Identifier', 'count'),
            lat_min=('lat', 'min'),
            lat_max=('lat', 'max'),
            lon_min=('lon', 'min'),
            lon_max=('lon', 'max'),
        )
        .reset_index()
        .sort_values('QAQC_Block_ID')
    )

    # Export mapped samples (keep it reasonably sized)
    props = [
        'Lab_Sample_Identifier','QAQC_Block_ID','Order_Of_Analysis','lat','lon',
        'Sample_Type_Name_en','Preparation_Method_Name_en'
    ] + meas_cols

    # GeoJSON can't store NaN; replace with None in export helper
    samples_geojson = to_geojson_points(df_field[props].copy(), lat_col='lat', lon_col='lon', props_cols=[c for c in props if c not in ['lat','lon']])

    (out_dir / 'samples.geojson').write_text(json.dumps(samples_geojson))
    (out_dir / 'targets.geojson').write_text(json.dumps(targets_geojson))
    (out_dir / 'stats.json').write_text(json.dumps(stats, indent=2))
    (out_dir / 'qc_summary.json').write_text(json.dumps(qc, indent=2))
    field_ops.to_csv(out_dir / 'field_ops.csv', index=False)

    print('Wrote:', out_dir)
    print(' - samples.geojson')
    print(' - targets.geojson')
    print(' - stats.json')
    print(' - qc_summary.json')
    print(' - field_ops.csv')


if __name__ == '__main__':
    main()
