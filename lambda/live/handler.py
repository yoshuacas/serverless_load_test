"""Live data reader: reads progress snapshots and trace from ElastiCache."""

import json
import os

import redis

CACHE_ENDPOINT = os.environ["CACHE_ENDPOINT"]
CACHE_PORT = int(os.environ.get("CACHE_PORT", "6379"))

# Histogram buckets (must match metrics_collector.py)
LATENCY_BUCKETS_MS = [
    0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.8, 1.0,
    1.5, 2.0, 3.0, 5.0, 10.0, 25.0, 50.0, 100.0, 250.0, float("inf"),
]

# Lazy connection
_client = None


def get_client():
    global _client
    if _client is None:
        _client = redis.Redis(
            host=CACHE_ENDPOINT,
            port=CACHE_PORT,
            ssl=True,
            decode_responses=True,
            socket_connect_timeout=5,
            socket_timeout=5,
        )
    return _client


def percentile_from_histogram(histogram, p):
    """Walk merged histogram to find the given percentile."""
    total = sum(histogram)
    if total == 0:
        return 0.0
    target = total * p
    cumulative = 0
    for i, count in enumerate(histogram):
        cumulative += count
        if cumulative >= target:
            return LATENCY_BUCKETS_MS[i]
    return LATENCY_BUCKETS_MS[-2]  # return last finite bucket


def handler(event, context):
    """Read live progress and trace data from ElastiCache."""
    execution_name = event.get("execution_name", "")
    if not execution_name:
        return {"error": "execution_name required"}

    r = get_client()

    # Read execution metadata
    exec_raw = r.get(f"exec:{execution_name}")
    exec_meta = json.loads(exec_raw) if exec_raw else {}

    lambda_count = exec_meta.get("lambda_count", 0)
    config = exec_meta.get("config", {})

    # Read live snapshots from each worker
    snapshots = []
    workers_reporting = 0
    for i in range(max(lambda_count, 200)):
        key = f"live:{execution_name}:worker-{i}"
        raw = r.get(key)
        if raw:
            snapshots.append(json.loads(raw))
            workers_reporting += 1
        elif i >= lambda_count and lambda_count > 0:
            break

    # Aggregate snapshots
    aggregate = {}
    if snapshots:
        total_rps = sum(s.get("actual_rps", 0) for s in snapshots)
        total_success = sum(s.get("success_count", 0) for s in snapshots)
        total_throttle = sum(s.get("throttle_count", 0) for s in snapshots)
        total_error = sum(s.get("error_count", 0) for s in snapshots)
        total_bytes_written = sum(s.get("bytes_written", 0) for s in snapshots)
        total_bytes_read = sum(s.get("bytes_read", 0) for s in snapshots)
        total_clients = sum(s.get("active_clients", 0) for s in snapshots)
        max_ts = max(s.get("timestamp_s", 0) for s in snapshots)

        # Merge histograms
        merged_histogram = [0] * len(LATENCY_BUCKETS_MS)
        for s in snapshots:
            hist = s.get("latency_histogram", [])
            for j, count in enumerate(hist):
                if j < len(merged_histogram):
                    merged_histogram[j] += count

        # Compute ECPU
        payload_bytes = config.get("payload_size_bytes", 1024)
        ecpu_per_op = max(1, -(-payload_bytes // 1024))  # ceil division
        ecpu_demand = total_success * ecpu_per_op

        total_attempts = total_success + total_throttle + total_error
        throttle_pct = round(total_throttle / total_attempts * 100, 1) if total_attempts > 0 else 0

        aggregate = {
            "actual_rps": total_rps,
            "success_count": total_success,
            "throttle_count": total_throttle,
            "error_count": total_error,
            "throttle_pct": throttle_pct,
            "p50_ms": round(percentile_from_histogram(merged_histogram, 0.5), 2),
            "p90_ms": round(percentile_from_histogram(merged_histogram, 0.9), 2),
            "p99_ms": round(percentile_from_histogram(merged_histogram, 0.99), 2),
            "ecpu_demand": ecpu_demand,
            "bytes_written": total_bytes_written,
            "bytes_read": total_bytes_read,
            "active_clients": total_clients,
            "timestamp_s": max_ts,
        }

    # Read trace entries
    trace_raw = r.lrange(f"trace:{execution_name}", 0, -1)
    trace = [json.loads(t) for t in trace_raw] if trace_raw else []

    return {
        "execution_name": execution_name,
        "scenario": exec_meta.get("scenario", ""),
        "lambda_count": lambda_count,
        "workers_reporting": workers_reporting,
        "config": config,
        "aggregate": aggregate,
        "trace": trace,
    }
