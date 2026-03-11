"""In-memory latency histogram tracking with snapshot/reset for reporting windows."""

import time
from dataclasses import dataclass, field

# Fixed histogram buckets (ms) — shared with aggregator
LATENCY_BUCKETS_MS = [
    0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.8, 1.0,
    1.5, 2.0, 3.0, 5.0, 10.0, 25.0, 50.0, 100.0, 250.0, float("inf"),
]

NUM_BUCKETS = len(LATENCY_BUCKETS_MS)


@dataclass
class WindowMetrics:
    """Metrics accumulated during a single reporting window."""

    histogram: list[int] = field(default_factory=lambda: [0] * NUM_BUCKETS)
    success_count: int = 0
    throttle_count: int = 0
    error_count: int = 0
    bytes_written: int = 0
    bytes_read: int = 0


class MetricsCollector:
    """Collects per-operation metrics and produces time-series snapshots."""

    def __init__(self, report_interval_s: int, client_count: int):
        self.report_interval_s = report_interval_s
        self.client_count = client_count
        self._current = WindowMetrics()
        self._window_start = time.monotonic()
        self.time_series: list[dict] = []
        self._elapsed_s = 0

    def record_success(self, latency_ms: float, bytes_transferred: int, is_write: bool):
        self._current.success_count += 1
        if is_write:
            self._current.bytes_written += bytes_transferred
        else:
            self._current.bytes_read += bytes_transferred

        # Bucket the latency
        for i, threshold in enumerate(LATENCY_BUCKETS_MS):
            if latency_ms <= threshold:
                self._current.histogram[i] += 1
                return
        # Should never reach here since last bucket is inf
        self._current.histogram[-1] += 1

    def record_throttle(self):
        self._current.throttle_count += 1

    def record_error(self):
        self._current.error_count += 1

    def maybe_flush(self) -> bool:
        """Check if the current window has elapsed. If so, snapshot and reset. Returns True if flushed."""
        now = time.monotonic()
        elapsed_in_window = now - self._window_start
        if elapsed_in_window < self.report_interval_s:
            return False

        self._elapsed_s += self.report_interval_s
        w = self._current

        snapshot = {
            "timestamp_s": self._elapsed_s,
            "actual_rps": round(w.success_count / self.report_interval_s),
            "latency_histogram": list(w.histogram),
            "success_count": w.success_count,
            "throttle_count": w.throttle_count,
            "error_count": w.error_count,
            "bytes_written": w.bytes_written,
            "bytes_read": w.bytes_read,
            "active_clients": self.client_count,
        }
        self.time_series.append(snapshot)

        # Reset for next window
        self._current = WindowMetrics()
        self._window_start = now
        return True

    def flush_final(self):
        """Flush any remaining data in the current window (partial window at end of test)."""
        w = self._current
        if w.success_count == 0 and w.throttle_count == 0:
            return

        elapsed_in_window = time.monotonic() - self._window_start
        if elapsed_in_window < 0.1:
            return

        self._elapsed_s += elapsed_in_window

        snapshot = {
            "timestamp_s": round(self._elapsed_s),
            "actual_rps": round(w.success_count / elapsed_in_window),
            "latency_histogram": list(w.histogram),
            "success_count": w.success_count,
            "throttle_count": w.throttle_count,
            "error_count": w.error_count,
            "bytes_written": w.bytes_written,
            "bytes_read": w.bytes_read,
            "active_clients": self.client_count,
        }
        self.time_series.append(snapshot)

    def build_summary(self) -> dict:
        total_success = sum(s["success_count"] for s in self.time_series)
        total_throttled = sum(s["throttle_count"] for s in self.time_series)
        total_errors = sum(s["error_count"] for s in self.time_series)
        peak_rps = max((s["actual_rps"] for s in self.time_series), default=0)

        return {
            "total_requests": total_success,
            "total_throttled": total_throttled,
            "total_errors": total_errors,
            "peak_rps": peak_rps,
            "duration_actual_s": round(self._elapsed_s),
        }
