"""Traffic generation: RPS control, ramp patterns, and operation dispatch."""

import asyncio
import os
import random
import time

from glide import ClosingError, GlideClusterClient, RequestError, TimeoutError

from key_generator import create_key_generator
from metrics_collector import MetricsCollector


def compute_target_rps(t: float, duration: float, max_rps: int, pattern: str) -> int:
    """Compute the target RPS at time t given the ramp pattern."""
    progress = min(t / duration, 1.0) if duration > 0 else 1.0

    if pattern == "linear":
        # Ramp from 0 to max over the first 20%, then hold
        ramp_fraction = min(progress / 0.2, 1.0)
        return max(1, int(max_rps * ramp_fraction))

    elif pattern == "step":
        # Instant jump to max
        return max_rps

    elif pattern == "spike":
        # Hold at 10% for first half, then spike to 100%
        if progress < 0.5:
            return max(1, int(max_rps * 0.1))
        else:
            return max_rps

    return max_rps


def generate_value(size_bytes: int) -> bytes:
    """Generate a random-ish payload of the given size."""
    # Use a repeating pattern rather than random bytes to avoid entropy cost
    pattern = b"abcdefghijklmnopqrstuvwxyz0123456789"
    repeats = (size_bytes // len(pattern)) + 1
    return (pattern * repeats)[:size_bytes]


async def run_traffic(
    clients: list[GlideClusterClient],
    config: dict,
    collector: MetricsCollector,
):
    """Main traffic loop. Drives operations at target RPS using asyncio concurrency."""
    duration = config["duration_seconds"]
    max_rps = config["target_rps"]
    pattern = config["ramp_pattern"]
    payload_size = config["payload_size_bytes"]
    read_ratio = config["read_write_ratio"]
    key_dist = config["key_distribution"]
    key_space = config.get("key_space_size", 100_000)
    command_type = config.get("command_type", "get_set")

    key_gen = create_key_generator(key_dist, key_space)
    value = generate_value(payload_size)

    num_clients = len(clients)
    start_time = time.monotonic()
    op_counter = 0

    # Semaphore to limit total in-flight ops across all clients
    max_concurrency = num_clients * config.get("inflight_requests_limit", 1000)
    # Cap the semaphore at a reasonable level to avoid overloading the event loop
    sem = asyncio.Semaphore(min(max_concurrency, 5000))

    async def execute_op(client: GlideClusterClient, key: str, is_write: bool):
        async with sem:
            start = time.monotonic()
            try:
                if command_type == "mget" and not is_write:
                    # Multi-key read: read 5 keys at once
                    keys = [key_gen.next_key() for _ in range(5)]
                    result = await client.mget(keys)
                    latency_ms = (time.monotonic() - start) * 1000
                    # Estimate bytes: each key could return payload_size or None
                    est_bytes = sum(payload_size for v in (result or []) if v is not None)
                    collector.record_success(latency_ms, est_bytes, False)
                elif is_write:
                    await client.set(key, value)
                    latency_ms = (time.monotonic() - start) * 1000
                    collector.record_success(latency_ms, payload_size, True)
                else:
                    result = await client.get(key)
                    latency_ms = (time.monotonic() - start) * 1000
                    bytes_read = len(result) if result else 0
                    collector.record_success(latency_ms, bytes_read, False)

            except (TimeoutError, ClosingError):
                collector.record_throttle()
            except RequestError as e:
                if "OOM" in str(e) or "BUSY" in str(e):
                    collector.record_throttle()
                else:
                    collector.record_error()
            except Exception:
                collector.record_error()

    tasks: list[asyncio.Task] = []

    while True:
        now = time.monotonic()
        elapsed = now - start_time
        if elapsed >= duration:
            break

        current_rps = compute_target_rps(elapsed, duration, max_rps, pattern)

        # Calculate how many ops to fire this tick (10ms resolution)
        tick_interval = 0.01
        ops_this_tick = max(1, int(current_rps * tick_interval))

        for _ in range(ops_this_tick):
            key = key_gen.next_key()
            is_write = random.random() > read_ratio
            client = clients[op_counter % num_clients]
            op_counter += 1

            task = asyncio.create_task(execute_op(client, key, is_write))
            tasks.append(task)

        # Flush metrics window if needed
        collector.maybe_flush()

        # Clean up completed tasks periodically to avoid memory growth
        if len(tasks) > 10_000:
            done = [t for t in tasks if t.done()]
            for t in done:
                # Re-raise exceptions from tasks so they don't get silently swallowed
                if t.exception():
                    pass  # Already recorded in collector
            tasks = [t for t in tasks if not t.done()]

        await asyncio.sleep(tick_interval)

    # Wait for all remaining in-flight operations
    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)

    # Final flush of partial window
    collector.flush_final()


async def pre_populate(
    clients: list[GlideClusterClient],
    key_space_size: int,
    payload_size_bytes: int,
):
    """Pre-populate keys for read-heavy tests."""
    value = generate_value(payload_size_bytes)
    sem = asyncio.Semaphore(500)

    async def write_key(client, key):
        async with sem:
            await client.set(key, value)

    tasks = []
    for i in range(key_space_size):
        key = f"k:{i}"
        client = clients[i % len(clients)]
        tasks.append(asyncio.create_task(write_key(client, key)))

        # Batch to avoid creating millions of tasks at once
        if len(tasks) >= 5000:
            await asyncio.gather(*tasks, return_exceptions=True)
            tasks = []

    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)
