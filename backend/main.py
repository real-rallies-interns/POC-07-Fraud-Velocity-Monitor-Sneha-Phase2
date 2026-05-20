"""
Real Rails — Fraud Velocity Monitor (PoC #07)
Backend: FastAPI + Pandas
Archetype: TEMPORAL (Signal Stream)
Version: v2-temporal
"""

from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, JSONResponse
import pandas as pd
import numpy as np
import io
import math
from datetime import datetime, timedelta
from typing import Optional

app = FastAPI(title="Fraud Velocity Monitor API — Temporal", version="2.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

MERCHANT_CATEGORIES = ["E-Commerce", "Crypto Exchange", "Wire Transfer", "ATM", "POS Retail", "Subscription"]
DEVICE_TYPES = ["mobile", "desktop", "tablet", "unknown"]
REGIONS = ["Northeast", "Southeast", "Midwest", "Southwest", "West", "Northwest"]


def generate_signal_stream(n_minutes: int = 1440, seed: int = 42) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    now = datetime.utcnow().replace(second=0, microsecond=0)
    rows = []
    for i in range(n_minutes):
        ts = now - timedelta(minutes=n_minutes - i)
        hour = ts.hour
        base_txn = 8 if 9 <= hour <= 18 else 3
        txn_count = int(rng.poisson(base_txn))
        is_burst = rng.random() < 0.03
        is_risk_surge = rng.random() < 0.025
        is_amount_spike = rng.random() < 0.02
        fraud_count = int(rng.poisson(0.3 + (4 if is_burst else 0)))
        suspicious_count = int(rng.poisson(0.5 + (2 if is_risk_surge else 0)))
        avg_risk = float(rng.uniform(0.55, 0.9) if is_burst or is_risk_surge else rng.uniform(0.1, 0.35))
        max_velocity = int(rng.integers(20, 38) if is_burst else rng.integers(8, 15) if is_risk_surge else rng.integers(1, 8))
        total_amount = float(rng.uniform(50000, 250000) if is_amount_spike else rng.uniform(5000, 40000))
        anomaly = bool(is_burst or is_risk_surge or is_amount_spike)
        spike_type = ("burst" if is_burst else "risk_surge" if is_risk_surge else "amount_spike" if is_amount_spike else None)
        rows.append({
            "timestamp": ts.isoformat() + "Z",
            "minute_index": i,
            "txn_count": txn_count,
            "fraud_count": fraud_count,
            "suspicious_count": suspicious_count,
            "normal_count": max(0, txn_count - fraud_count - suspicious_count),
            "avg_risk": round(avg_risk, 4),
            "max_velocity": max_velocity,
            "total_amount": round(total_amount, 2),
            "anomaly": anomaly,
            "spike_type": spike_type,
        })
    return pd.DataFrame(rows)


def generate_events(n: int = 500, seed: int = 42) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    now = datetime.utcnow()
    LABELS = ["normal", "normal", "normal", "suspicious", "fraudulent"]
    records = []
    for i in range(n):
        label = str(rng.choice(LABELS))
        amount = float(rng.uniform(5000, 50000) if label == "fraudulent" else rng.uniform(500, 15000) if label == "suspicious" else rng.uniform(10, 5000))
        velocity = int(rng.integers(15, 40) if label == "fraudulent" else rng.integers(8, 18) if label == "suspicious" else rng.integers(1, 8))
        risk = float(rng.uniform(0.7, 1.0) if label == "fraudulent" else rng.uniform(0.4, 0.75) if label == "suspicious" else rng.uniform(0.0, 0.4))
        ts = now - timedelta(minutes=int(rng.integers(0, 1440)))
        records.append({
            "event_id": f"EVT-{10000 + i}",
            "timestamp": ts.isoformat() + "Z",
            "amount": round(amount, 2),
            "merchant_category": str(rng.choice(MERCHANT_CATEGORIES)),
            "label": label,
            "risk_score": round(risk, 3),
            "velocity_1h": velocity,
            "device_type": str(rng.choice(DEVICE_TYPES)),
            "device_fingerprint": f"FP-{int(rng.integers(10000, 99999))}",
            "ip_hash": f"ip-{int(rng.integers(100000, 999999))}",
            "region": str(rng.choice(REGIONS)),
            "flagged_for_review": bool(label in ["fraudulent", "suspicious"] and float(rng.random()) > 0.3),
        })
    return pd.DataFrame(records)


SIGNAL_STREAM = generate_signal_stream(1440)
EVENTS_DF = generate_events(500)


def clean_nan(obj):
    """Recursively replace NaN/inf float values with None for JSON safety."""
    if isinstance(obj, list):
        return [clean_nan(i) for i in obj]
    if isinstance(obj, dict):
        return {k: clean_nan(v) for k, v in obj.items()}
    if isinstance(obj, float) and (math.isnan(obj) or math.isinf(obj)):
        return None
    return obj


@app.get("/api/health")
def health():
    return {"status": "ok", "version": "v2-temporal", "archetype": "Temporal/SignalStream", "signal_minutes": len(SIGNAL_STREAM)}


@app.get("/api/signal-stream")
def get_signal_stream(
    resolution: str = Query("5min"),
    hours_back: int = Query(24, le=24),
):
    df = SIGNAL_STREAM.copy().tail(hours_back * 60)
    if resolution == "5min":
        df["bucket"] = (df["minute_index"] // 5) * 5
    elif resolution == "15min":
        df["bucket"] = (df["minute_index"] // 15) * 15
    elif resolution == "1h":
        df["bucket"] = df["minute_index"] // 60
    else:
        records = df.to_dict(orient="records")
        clean = clean_nan(records)
        return JSONResponse({"resolution": "1min", "stream": clean, "data_points": len(clean)})

    df = df.groupby("bucket").agg(
        timestamp=("timestamp", "first"),
        txn_count=("txn_count", "sum"),
        fraud_count=("fraud_count", "sum"),
        suspicious_count=("suspicious_count", "sum"),
        normal_count=("normal_count", "sum"),
        avg_risk=("avg_risk", "mean"),
        max_velocity=("max_velocity", "max"),
        total_amount=("total_amount", "sum"),
        anomaly=("anomaly", "any"),
        spike_type=("spike_type", lambda x: next((v for v in x if pd.notna(v) and v is not None), None)),
    ).reset_index(drop=True)
    df["avg_risk"] = df["avg_risk"].round(4)
    df["total_amount"] = df["total_amount"].round(2)
    # Force spike_type NaN → None
    df["spike_type"] = df["spike_type"].where(df["spike_type"].notna(), other=None)
    records = df.to_dict(orient="records")
    clean = clean_nan(records)
    return JSONResponse({"resolution": resolution, "data_points": len(clean), "stream": clean})


@app.get("/api/anomalies")
def get_anomalies():
    df = SIGNAL_STREAM[SIGNAL_STREAM["anomaly"] == True].copy()
    return {"anomalies": df.to_dict(orient="records"), "total": len(df), "by_type": df["spike_type"].value_counts().to_dict()}


@app.get("/api/metrics/summary")
def get_summary():
    df = SIGNAL_STREAM
    evdf = EVENTS_DF
    total = int(df["txn_count"].sum())
    fraud = int(df["fraud_count"].sum())
    exposure = float(evdf[evdf["label"].isin(["fraudulent", "suspicious"])]["amount"].sum())
    fraud_rate = round(fraud / total * 100, 2) if total else 0
    regional_avg = float(evdf["amount"].mean())
    return {
        "total_events": total,
        "fraud_count": fraud,
        "flagged_for_review": int(len(evdf[evdf["flagged_for_review"] == True])),
        "fraud_rate_pct": fraud_rate,
        "total_exposure_usd": round(exposure, 2),
        "peak_velocity_1h": int(df["max_velocity"].max()),
        "anomaly_minutes": int(df["anomaly"].sum()),
        "avg_fraud_velocity_1h": round(float(evdf[evdf["label"] == "fraudulent"]["velocity_1h"].mean()), 1),
        "pct_above_regional_avg": round(len(evdf[evdf["amount"] > regional_avg]) / len(evdf) * 100, 1),
    }


@app.get("/api/metrics/velocity-heatmap")
def get_velocity_heatmap():
    df = SIGNAL_STREAM.copy()
    df["timestamp"] = pd.to_datetime(df["timestamp"])
    df["hour"] = df["timestamp"].dt.hour
    result = df.groupby("hour").agg(avg_fraud=("fraud_count", "mean"), avg_velocity=("max_velocity", "mean"), anomaly_rate=("anomaly", "mean")).reset_index().round(3)
    return {"heatmap": result.to_dict(orient="records")}


@app.get("/api/metrics/category-breakdown")
def get_category_breakdown():
    df = EVENTS_DF.copy()
    result = df.groupby("merchant_category").agg(total=("event_id", "count"), fraud=("label", lambda x: (x == "fraudulent").sum()), avg_risk=("risk_score", "mean"), total_amount=("amount", "sum")).reset_index()
    result["fraud_rate"] = (result["fraud"] / result["total"] * 100).round(1)
    result["avg_risk"] = result["avg_risk"].round(3)
    return {"categories": result.to_dict(orient="records")}


@app.get("/api/review-queue")
def get_review_queue(limit: int = 20):
    df = EVENTS_DF[EVENTS_DF["flagged_for_review"] == True].copy()
    df = df.sort_values("risk_score", ascending=False).head(limit)
    return {"queue": df.to_dict(orient="records"), "total_flagged": len(df)}


@app.get("/api/events")
def get_events(label: Optional[str] = None, region: Optional[str] = None, min_risk: float = 0.0, limit: int = Query(200, le=500)):
    df = EVENTS_DF.copy()
    if label and label != "all": df = df[df["label"] == label]
    if region and region != "all": df = df[df["region"] == region]
    df = df[df["risk_score"] >= min_risk]
    return {"events": df.sort_values("timestamp", ascending=False).head(limit).to_dict(orient="records"), "total": len(df)}


@app.get("/api/download/sample-data")
def download_sample():
    buf = io.StringIO()
    SIGNAL_STREAM.head(100).to_csv(buf, index=False)
    buf.seek(0)
    return StreamingResponse(iter([buf.getvalue()]), media_type="text/csv", headers={"Content-Disposition": "attachment; filename=fraud_signal_stream_sample.csv"})