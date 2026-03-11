"""Aggregator Lambda: merges N worker payloads into a unified time-series.

Input: List of worker return payloads from Step Functions Map state.
Output: Single aggregated result written to S3 and returned.
"""

import json
import math
import os
from collections import defaultdict

import boto3

from histogram_merge import extract_percentiles, merge_histograms

# ElastiCache Serverless pricing (us-east-1)
ECPU_PRICE_PER_MILLION = 0.0034
STORAGE_PRICE_PER_GB_HOUR = 0.125


def handler(event, context):
    """AWS Lambda entry point.

    event shape:
    {
        "scenario": "gradual_ramp",
        "config": { "lambda_count": 20, "target_rps": 5000, "payload_size_bytes": 1024, ... },
        "worker_results": [ <worker_payload>, <worker_payload>, ... ]
    }
    """
    scenario = event["scenario"]
    config = event["config"]
    worker_results = event["worker_results"]
    report_interval = config.get("report_interval_seconds", 5)

    aggregated_ts = aggregate_time_series(worker_results, config, report_interval)
    events = detect_events(aggregated_ts)
    summary = build_summary(aggregated_ts, worker_results)

    result = {
        "scenario": scenario,
        "config": config,
        "time_series": aggregated_ts,
        "summary": summary,
        "events": events,
    }

    # Write to S3 if bucket is configured
    bucket = os.environ.get("RESULTS_BUCKET")
    if bucket:
        execution_id = event.get("execution_id", context.aws_request_id)
        key = f"results/{scenario}/{execution_id}.json"
        s3 = boto3.client("s3")
        s3.put_object(
            Bucket=bucket,
            Key=key,
            Body=json.dumps(result),
            ContentType="application/json",
        )
        result["s3_key"] = key

    return result


def aggregate_time_series(
    worker_results: list[dict],
    config: dict,
    report_interval: int,
) -> list[dict]:
    """Align and merge time-series data across all workers by timestamp."""
    payload_size = config.get("payload_size_bytes", 1024)
    target_rps_total = config.get("lambda_count", 1) * config.get("target_rps", 0)

    # Group worker snapshots by timestamp
    by_timestamp: dict[int, list[dict]] = defaultdict(list)
    for worker in worker_results:
        for snapshot in worker.get("time_series", []):
            ts = snapshot["timestamp_s"]
            by_timestamp[ts].append(snapshot)

    # Aggregate each timestamp
    aggregated = []
    cumulative_bytes_written = 0
    cumulative_ecpu = 0
    cumulative_cost = 0.0

    for ts in sorted(by_timestamp.keys()):
        snapshots = by_timestamp[ts]

        # Sum scalar metrics
        total_rps = sum(s["actual_rps"] for s in snapshots)
        total_success = sum(s["success_count"] for s in snapshots)
        total_throttle = sum(s["throttle_count"] for s in snapshots)
        total_error = sum(s["error_count"] for s in snapshots)
        total_bytes_written = sum(s["bytes_written"] for s in snapshots)
        total_bytes_read = sum(s["bytes_read"] for s in snapshots)
        total_clients = sum(s.get("active_clients", 0) for s in snapshots)

        # Merge latency histograms
        histograms = [s["latency_histogram"] for s in snapshots]
        merged_hist = merge_histograms(histograms)
        percentiles = extract_percentiles(merged_hist)

        # Estimated ECPU: success_count * ceil(payload_bytes / 1024)
        ecpu_per_request = math.ceil(payload_size / 1024)
        ecpu_demand = total_success * ecpu_per_request

        # Estimate capacity from throttle behavior
        ecpu_capacity = estimate_capacity(ecpu_demand, total_throttle, total_success)

        # Throttle percentage
        total_attempts = total_success + total_throttle
        throttle_pct = round(total_throttle / total_attempts * 100, 1) if total_attempts > 0 else 0

        # Cumulative memory estimate
        cumulative_bytes_written += total_bytes_written
        cumulative_gb = cumulative_bytes_written / (1024 ** 3)

        # Cost for this window
        ecpu_cost = ecpu_demand * ECPU_PRICE_PER_MILLION / 1_000_000
        storage_cost = cumulative_gb * (report_interval / 3600) * STORAGE_PRICE_PER_GB_HOUR
        window_cost = ecpu_cost + storage_cost
        cumulative_cost += window_cost
        cumulative_ecpu += ecpu_demand

        aggregated.append({
            "timestamp_s": ts,
            "actual_rps": total_rps,
            "target_rps": target_rps_total,
            "p50_ms": percentiles["p50_ms"],
            "p90_ms": percentiles["p90_ms"],
            "p99_ms": percentiles["p99_ms"],
            "ecpu_demand": ecpu_demand,
            "ecpu_capacity_estimate": ecpu_capacity,
            "throttle_pct": throttle_pct,
            "total_throttled": total_throttle,
            "total_errors": total_error,
            "cumulative_bytes_written_gb": round(cumulative_gb, 4),
            "active_clients": total_clients,
            "window_cost_usd": round(window_cost, 6),
            "cumulative_cost_usd": round(cumulative_cost, 6),
        })

    return aggregated


def estimate_capacity(ecpu_demand: int, throttle_count: int, success_count: int) -> int:
    """Infer ElastiCache capacity from throttle behavior.

    - No throttling: we're below capacity, show ~30% headroom above demand.
    - Throttling: served portion approximates current capacity.
    """
    total_attempts = success_count + throttle_count
    if total_attempts == 0:
        return 30_000  # empty cache baseline

    if throttle_count == 0:
        return int(ecpu_demand * 1.3)

    served_fraction = success_count / total_attempts
    return int(ecpu_demand * served_fraction)


def detect_events(time_series: list[dict]) -> list[dict]:
    """Derive scaling events from transitions in the aggregated data."""
    events = []
    for i in range(1, len(time_series)):
        curr = time_series[i]
        prev = time_series[i - 1]
        ts = curr["timestamp_s"]

        # Throttling started
        if curr["throttle_pct"] > 5 and prev["throttle_pct"] <= 5:
            events.append({
                "timestamp_s": ts,
                "type": "warn",
                "message": f"Throttling started ({curr['throttle_pct']}% rejected)",
            })

        # Throttling resolved
        if curr["throttle_pct"] <= 1 and prev["throttle_pct"] > 5:
            events.append({
                "timestamp_s": ts,
                "type": "success",
                "message": "Scaling caught up - throttling resolved",
            })

        # Capacity step-up
        if curr["ecpu_capacity_estimate"] > prev["ecpu_capacity_estimate"] * 1.15:
            events.append({
                "timestamp_s": ts,
                "type": "scale",
                "message": (
                    f"Capacity scaled {prev['ecpu_capacity_estimate']:,} "
                    f"-> {curr['ecpu_capacity_estimate']:,} ECPU/s"
                ),
            })

        # Latency spike
        if curr["p99_ms"] > prev["p99_ms"] * 3 and curr["p99_ms"] > 5:
            events.append({
                "timestamp_s": ts,
                "type": "warn",
                "message": f"Latency spike - p99 jumped to {curr['p99_ms']:.1f}ms",
            })

    return events


def build_summary(time_series: list[dict], worker_results: list[dict]) -> dict:
    """Build a summary across the entire test run."""
    if not time_series:
        return {}

    total_requests = sum(w.get("summary", {}).get("total_requests", 0) for w in worker_results)
    total_throttled = sum(w.get("summary", {}).get("total_throttled", 0) for w in worker_results)
    total_errors = sum(w.get("summary", {}).get("total_errors", 0) for w in worker_results)

    return {
        "total_requests": total_requests,
        "total_throttled": total_throttled,
        "total_errors": total_errors,
        "peak_rps": max(s["actual_rps"] for s in time_series),
        "peak_p99_ms": max(s["p99_ms"] for s in time_series),
        "peak_throttle_pct": max(s["throttle_pct"] for s in time_series),
        "final_ecpu_capacity_estimate": time_series[-1]["ecpu_capacity_estimate"],
        "total_cost_usd": time_series[-1]["cumulative_cost_usd"],
        "duration_s": time_series[-1]["timestamp_s"],
    }
