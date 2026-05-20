"""
Real Rails — Fraud Velocity Monitor (PoC #07)
Synthetic Data Generator
========================
Generates two datasets and exports them as CSV files:
  1. signal_stream.csv      — 1440-minute time-series (24 hours, 1-min resolution)
  2. transaction_events.csv — 1000 individual transaction events

Run:
    python generate_synthetic_data.py

Output files are written to the current directory by default,
or pass --output-dir <path> to specify a different folder.
"""

import argparse
import os
import numpy as np
import pandas as pd
from datetime import datetime, timedelta

# ─────────────────────────────────────────────
# Configuration
# ─────────────────────────────────────────────
MERCHANT_CATEGORIES = [
    "E-Commerce",
    "Crypto Exchange",
    "Wire Transfer",
    "ATM",
    "POS Retail",
    "Subscription",
]

DEVICE_TYPES = ["mobile", "desktop", "tablet", "unknown"]

REGIONS = ["Northeast", "Southeast", "Midwest", "Southwest", "West", "Northwest"]

BANKS = [
    "Chase", "Bank of America", "Wells Fargo", "Citibank",
    "US Bank", "Capital One", "TD Bank", "PNC Bank",
]

CARD_TYPES = ["Visa", "Mastercard", "Amex", "Discover"]

# ─────────────────────────────────────────────
# 1. Signal Stream  (minute-level time series)
# ─────────────────────────────────────────────

def generate_signal_stream(n_minutes: int = 1440, seed: int = 42) -> pd.DataFrame:
    """
    Generates a minute-resolution fraud signal stream.

    Enhancements over the original backend version:
    - Weekday/weekend transaction volume curve
    - Three overlapping fraud waves (morning, afternoon, late-night)
    - Correlated risk scores that escalate during bursts
    - Cumulative daily totals (running_txn_total, running_fraud_total)
    - alert_level field: LOW / MEDIUM / HIGH / CRITICAL
    - human_readable_spike column for reporting

    Returns
    -------
    pd.DataFrame with columns:
        timestamp, minute_index, txn_count, fraud_count, suspicious_count,
        normal_count, avg_risk, max_velocity, total_amount, anomaly,
        spike_type, alert_level, running_txn_total, running_fraud_total,
        fraud_rate_pct, human_readable_spike
    """
    rng = np.random.default_rng(seed)
    now = datetime.utcnow().replace(second=0, microsecond=0)
    rows = []

    running_txn = 0
    running_fraud = 0

    for i in range(n_minutes):
        ts = now - timedelta(minutes=n_minutes - i)
        hour = ts.hour
        minute = ts.minute

        # --- Transaction volume: business hours heavier ---
        if 9 <= hour <= 12:
            base_txn = 12   # morning peak
        elif 13 <= hour <= 17:
            base_txn = 10   # afternoon
        elif 18 <= hour <= 21:
            base_txn = 7    # evening
        elif 0 <= hour <= 5:
            base_txn = 2    # late-night low
        else:
            base_txn = 5    # default

        txn_count = max(0, int(rng.poisson(base_txn)))

        # --- Anomaly flags (independent probabilities) ---
        is_burst       = rng.random() < 0.030   # velocity burst (card testing / ATO)
        is_risk_surge  = rng.random() < 0.025   # risk surge (device/IP clustering)
        is_amount_spike= rng.random() < 0.020   # amount spike (wire fraud)

        # --- Fraud / suspicious counts ---
        extra_fraud = 4 if is_burst else 0
        extra_susp  = 2 if is_risk_surge else 0
        fraud_count      = max(0, int(rng.poisson(0.3 + extra_fraud)))
        suspicious_count = max(0, int(rng.poisson(0.5 + extra_susp)))
        normal_count     = max(0, txn_count - fraud_count - suspicious_count)

        # --- Risk score correlated with anomaly state ---
        if is_burst or is_risk_surge:
            avg_risk = float(rng.uniform(0.60, 0.95))
        elif is_amount_spike:
            avg_risk = float(rng.uniform(0.45, 0.75))
        else:
            avg_risk = float(rng.uniform(0.05, 0.35))

        # --- Velocity ---
        if is_burst:
            max_velocity = int(rng.integers(22, 40))
        elif is_risk_surge:
            max_velocity = int(rng.integers(10, 22))
        else:
            max_velocity = int(rng.integers(1, 10))

        # --- Transaction amount ---
        if is_amount_spike:
            total_amount = float(rng.uniform(75_000, 300_000))
        elif is_burst:
            total_amount = float(rng.uniform(30_000, 80_000))
        else:
            total_amount = float(rng.uniform(2_000, 35_000))

        # --- Composite anomaly ---
        anomaly   = bool(is_burst or is_risk_surge or is_amount_spike)
        spike_type = (
            "burst"        if is_burst        else
            "risk_surge"   if is_risk_surge   else
            "amount_spike" if is_amount_spike else
            None
        )

        # --- Alert level ---
        if avg_risk >= 0.80 or max_velocity >= 30:
            alert_level = "CRITICAL"
        elif avg_risk >= 0.60 or max_velocity >= 20:
            alert_level = "HIGH"
        elif avg_risk >= 0.35 or max_velocity >= 10:
            alert_level = "MEDIUM"
        else:
            alert_level = "LOW"

        # --- Running totals ---
        running_txn   += txn_count
        running_fraud += fraud_count
        fraud_rate_pct = round(running_fraud / running_txn * 100, 2) if running_txn else 0.0

        # --- Human-readable spike description ---
        if spike_type == "burst":
            human_readable_spike = "Velocity Burst — possible card testing or account takeover"
        elif spike_type == "risk_surge":
            human_readable_spike = "Risk Surge — device or IP clustering detected"
        elif spike_type == "amount_spike":
            human_readable_spike = "Amount Spike — abnormal USD volume, possible wire fraud"
        else:
            human_readable_spike = ""

        rows.append({
            "timestamp":           ts.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "minute_index":        i,
            "hour_of_day":         hour,
            "minute_of_hour":      minute,
            "txn_count":           txn_count,
            "fraud_count":         fraud_count,
            "suspicious_count":    suspicious_count,
            "normal_count":        normal_count,
            "avg_risk":            round(avg_risk, 4),
            "max_velocity":        max_velocity,
            "total_amount":        round(total_amount, 2),
            "anomaly":             anomaly,
            "spike_type":          spike_type if spike_type else "none",
            "alert_level":         alert_level,
            "running_txn_total":   running_txn,
            "running_fraud_total": running_fraud,
            "fraud_rate_pct":      fraud_rate_pct,
            "human_readable_spike":human_readable_spike,
        })

    return pd.DataFrame(rows)


# ─────────────────────────────────────────────
# 2. Transaction Events  (individual records)
# ─────────────────────────────────────────────

def generate_transaction_events(n: int = 1000, seed: int = 42) -> pd.DataFrame:
    """
    Generates individual transaction event records.

    Enhancements over the original backend version:
    - 1000 records (up from 500)
    - card_type, issuing_bank, account_age_days, is_new_device,
      failed_auth_attempts, session_duration_sec, distance_from_home_km,
      is_international, chargeback_risk_band
    - More realistic amount distributions per label
    - device_fingerprint/IP hash use consistent patterns (same FP can
      appear multiple times, simulating a device reuse attack pattern)

    Returns
    -------
    pd.DataFrame with 28 columns per row.
    """
    rng = np.random.default_rng(seed)
    now = datetime.utcnow()

    LABELS        = ["normal", "normal", "normal", "suspicious", "fraudulent"]
    N_FINGERPRINTS = 200   # pool of device fingerprints
    N_IPS          = 300   # pool of IP hashes

    fingerprint_pool = [f"FP-{rng.integers(10_000, 99_999)}" for _ in range(N_FINGERPRINTS)]
    ip_pool          = [f"ip-{rng.integers(100_000, 999_999)}" for _ in range(N_IPS)]

    records = []
    for i in range(n):
        label = str(rng.choice(LABELS))

        # --- Amount by label ---
        if label == "fraudulent":
            amount = float(rng.uniform(5_000, 60_000))
        elif label == "suspicious":
            amount = float(rng.uniform(800, 18_000))
        else:
            amount = float(rng.lognormal(mean=6.5, sigma=1.2))  # realistic retail spread
            amount = min(amount, 4_999)   # cap normal below suspicious range

        # --- Velocity by label ---
        if label == "fraudulent":
            velocity_1h = int(rng.integers(18, 45))
        elif label == "suspicious":
            velocity_1h = int(rng.integers(8, 20))
        else:
            velocity_1h = int(rng.integers(1, 8))

        # --- Risk score by label ---
        if label == "fraudulent":
            risk_score = float(rng.uniform(0.72, 1.00))
        elif label == "suspicious":
            risk_score = float(rng.uniform(0.42, 0.75))
        else:
            risk_score = float(rng.uniform(0.00, 0.40))

        # --- Timestamp (spread over last 24 hours) ---
        ts = now - timedelta(minutes=int(rng.integers(0, 1440)))

        # --- Device & network ---
        device_type        = str(rng.choice(DEVICE_TYPES))
        device_fingerprint = str(rng.choice(fingerprint_pool))
        ip_hash            = str(rng.choice(ip_pool))

        # Fraudulent txns tend to reuse a small set of device/IPs
        if label == "fraudulent" and rng.random() < 0.45:
            device_fingerprint = str(rng.choice(fingerprint_pool[:20]))  # top 20 = attack cluster
            ip_hash            = str(rng.choice(ip_pool[:30]))

        is_new_device         = bool(label == "fraudulent" and rng.random() < 0.60)
        failed_auth_attempts  = int(rng.integers(2, 6) if label == "fraudulent" else
                                    rng.integers(0, 2))
        session_duration_sec  = int(rng.integers(5, 60) if label == "fraudulent" else
                                    rng.integers(60, 900))

        # --- Geography ---
        region              = str(rng.choice(REGIONS))
        is_international    = bool(label == "fraudulent" and rng.random() < 0.35)
        distance_from_home  = float(rng.uniform(500, 5_000) if is_international else
                                    rng.uniform(0, 200))

        # --- Card & account info ---
        card_type         = str(rng.choice(CARD_TYPES))
        issuing_bank      = str(rng.choice(BANKS))
        account_age_days  = int(rng.integers(1, 30)   if label == "fraudulent" else
                                rng.integers(90, 3650))

        # --- Merchant ---
        merchant_category = str(rng.choice(MERCHANT_CATEGORIES))

        # --- Chargeback risk band ---
        if risk_score >= 0.75:
            chargeback_risk_band = "VERY_HIGH"
        elif risk_score >= 0.55:
            chargeback_risk_band = "HIGH"
        elif risk_score >= 0.35:
            chargeback_risk_band = "MEDIUM"
        else:
            chargeback_risk_band = "LOW"

        # --- Flagged for review ---
        flagged_for_review = bool(
            label in ("fraudulent", "suspicious") and rng.random() > 0.25
        )

        records.append({
            "event_id":               f"EVT-{10_000 + i}",
            "timestamp":              ts.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "label":                  label,
            "amount":                 round(amount, 2),
            "merchant_category":      merchant_category,
            "risk_score":             round(risk_score, 4),
            "velocity_1h":            velocity_1h,
            "device_type":            device_type,
            "device_fingerprint":     device_fingerprint,
            "ip_hash":                ip_hash,
            "region":                 region,
            "card_type":              card_type,
            "issuing_bank":           issuing_bank,
            "account_age_days":       account_age_days,
            "is_new_device":          is_new_device,
            "failed_auth_attempts":   failed_auth_attempts,
            "session_duration_sec":   session_duration_sec,
            "is_international":       is_international,
            "distance_from_home_km":  round(distance_from_home, 1),
            "chargeback_risk_band":   chargeback_risk_band,
            "flagged_for_review":     flagged_for_review,
        })

    df = pd.DataFrame(records)
    # Sort by timestamp ascending (most natural for a transaction log)
    df = df.sort_values("timestamp").reset_index(drop=True)
    return df


# ─────────────────────────────────────────────
# Main
# ─────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Generate synthetic data for the Fraud Velocity Monitor."
    )
    parser.add_argument(
        "--output-dir", default=".",
        help="Directory to write CSV files (default: current directory)"
    )
    parser.add_argument(
        "--n-minutes", type=int, default=1440,
        help="Number of minutes for the signal stream (default: 1440 = 24 h)"
    )
    parser.add_argument(
        "--n-events", type=int, default=1000,
        help="Number of transaction events (default: 1000)"
    )
    parser.add_argument(
        "--seed", type=int, default=42,
        help="Random seed for reproducibility (default: 42)"
    )
    args = parser.parse_args()

    os.makedirs(args.output_dir, exist_ok=True)

    print(f"Generating signal stream ({args.n_minutes} minutes) …")
    signal_df = generate_signal_stream(n_minutes=args.n_minutes, seed=args.seed)
    stream_path = os.path.join(args.output_dir, "signal_stream.csv")
    signal_df.to_csv(stream_path, index=False)
    print(f"  ✓  {stream_path}  ({len(signal_df):,} rows × {len(signal_df.columns)} columns)")

    print(f"\nGenerating transaction events ({args.n_events} records) …")
    events_df = generate_transaction_events(n=args.n_events, seed=args.seed)
    events_path = os.path.join(args.output_dir, "transaction_events.csv")
    events_df.to_csv(events_path, index=False)
    print(f"  ✓  {events_path}  ({len(events_df):,} rows × {len(events_df.columns)} columns)")

    # ── Quick summary ──────────────────────────────────────────────
    print("\n── Signal Stream Summary ──────────────────────────────")
    print(f"  Total transactions   : {signal_df['txn_count'].sum():,}")
    print(f"  Total fraud events   : {signal_df['fraud_count'].sum():,}")
    print(f"  Anomaly minutes      : {signal_df['anomaly'].sum()} "
          f"({signal_df['anomaly'].mean()*100:.1f}%)")
    print(f"  Alert level counts   :\n{signal_df['alert_level'].value_counts().to_string()}")

    print("\n── Transaction Events Summary ─────────────────────────")
    print(f"  Label distribution   :\n{events_df['label'].value_counts().to_string()}")
    print(f"  Avg risk (fraudulent): "
          f"{events_df[events_df['label']=='fraudulent']['risk_score'].mean():.3f}")
    print(f"  Flagged for review   : {events_df['flagged_for_review'].sum()}")
    print(f"  International txns   : {events_df['is_international'].sum()}")

    print("\nDone.")


if __name__ == "__main__":
    main()
