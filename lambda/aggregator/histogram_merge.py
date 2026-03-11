"""Histogram merge and percentile extraction across workers."""

# Must match the load-generator's LATENCY_BUCKETS_MS exactly
LATENCY_BUCKETS_MS = [
    0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.8, 1.0,
    1.5, 2.0, 3.0, 5.0, 10.0, 25.0, 50.0, 100.0, 250.0, float("inf"),
]

NUM_BUCKETS = len(LATENCY_BUCKETS_MS)


def merge_histograms(worker_histograms: list[list[int]]) -> list[int]:
    """Sum histograms element-wise across all workers."""
    merged = [0] * NUM_BUCKETS
    for hist in worker_histograms:
        for i in range(min(len(hist), NUM_BUCKETS)):
            merged[i] += hist[i]
    return merged


def percentile_from_histogram(merged_hist: list[int], pct: float) -> float:
    """Walk merged histogram to find the bucket upper bound containing the target percentile.

    Returns the bucket upper bound in ms. For the last bucket (inf), returns
    the previous bucket's upper bound as a conservative estimate.
    """
    total = sum(merged_hist)
    if total == 0:
        return 0.0

    target = total * pct / 100.0
    cumulative = 0
    for i, count in enumerate(merged_hist):
        cumulative += count
        if cumulative >= target:
            if LATENCY_BUCKETS_MS[i] == float("inf"):
                # Return the previous finite bucket as conservative upper bound
                return LATENCY_BUCKETS_MS[i - 1] if i > 0 else 250.0
            return LATENCY_BUCKETS_MS[i]

    # Fallback — shouldn't reach here
    return LATENCY_BUCKETS_MS[-2]


def extract_percentiles(merged_hist: list[int]) -> dict:
    """Extract p50, p90, p99 from a merged histogram."""
    return {
        "p50_ms": round(percentile_from_histogram(merged_hist, 50), 2),
        "p90_ms": round(percentile_from_histogram(merged_hist, 90), 2),
        "p99_ms": round(percentile_from_histogram(merged_hist, 99), 2),
    }
