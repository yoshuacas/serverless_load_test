"""Lambda handler: entry point for the load generator."""

import asyncio
import json
import time

from glide_client import close_clients, create_clients
from metrics_collector import MetricsCollector
from traffic_generator import pre_populate, run_traffic


async def write_trace(client, trace_key, tag, msg):
    """Write a trace entry to the ElastiCache trace list."""
    try:
        entry = json.dumps({"ts": time.time(), "tag": tag, "msg": msg})
        await client.rpush(trace_key, [entry])
        await client.expire(trace_key, 3600)
    except Exception:
        pass


async def async_handler(event: dict) -> dict:
    config = event
    worker_id = config["worker_id"]
    execution_name = config.get("execution_name")
    lambda_count = config.get("lambda_count", 0)
    client_count = config.get("client_count", 3)
    inflight_limit = config.get("inflight_requests_limit", 1000)
    report_interval = config.get("report_interval_seconds", 5)

    # Create Glide clients
    clients = await create_clients(
        endpoint=config["cache_endpoint"],
        port=config.get("cache_port", 6379),
        client_count=client_count,
        inflight_requests_limit=inflight_limit,
    )

    collector = MetricsCollector(
        report_interval_s=report_interval,
        client_count=client_count,
    )

    # Write execution metadata and trace to ElastiCache
    if execution_name:
        trace_key = f"trace:{execution_name}"

        # Write exec metadata (all workers write same data, last write wins)
        exec_data = json.dumps({
            "execution_name": execution_name,
            "scenario": config.get("scenario", "unknown"),
            "lambda_count": lambda_count,
            "config": {
                "target_rps": config.get("target_rps", 0),
                "payload_size_bytes": config.get("payload_size_bytes", 1024),
                "duration_seconds": config.get("duration_seconds", 0),
                "read_write_ratio": config.get("read_write_ratio", 0.8),
                "ramp_pattern": config.get("ramp_pattern", "step"),
                "client_count": client_count,
                "key_distribution": config.get("key_distribution", "uniform"),
            },
            "started_at": time.time(),
        })
        try:
            await clients[0].set(f"exec:{execution_name}", exec_data)
            await clients[0].expire(f"exec:{execution_name}", 3600)
        except Exception:
            pass

        await write_trace(clients[0], trace_key, "LAMBDA",
            f"Worker {worker_id} connected ({client_count} GLIDE clients, {inflight_limit} inflight limit)")

    try:
        # Pre-populate if requested (for read-heavy tests)
        if config.get("pre_populate"):
            key_space = config.get("key_space_size", 100_000)
            payload_size = config.get("payload_size_bytes", 1024)
            if execution_name:
                await write_trace(clients[0], trace_key, "CACHE",
                    f"Pre-populating {key_space:,} keys ({payload_size} bytes each)")
            await pre_populate(clients, key_space, payload_size)
            if execution_name:
                await write_trace(clients[0], trace_key, "CACHE",
                    f"Pre-populate complete: {key_space:,} keys seeded")

        # Run the traffic generator (skip if duration is 0, e.g. pre-populate only)
        if config.get("duration_seconds", 0) > 0:
            # Set up progress snapshot callback
            on_snapshot = None
            if execution_name:
                async def on_snapshot(snapshot):
                    live_key = f"live:{execution_name}:{worker_id}"
                    await clients[0].set(live_key, json.dumps(snapshot))
                    await clients[0].expire(live_key, 300)

                await write_trace(clients[0], trace_key, "LAMBDA",
                    f"Worker {worker_id} starting traffic: {config.get('target_rps', 0)} RPS, "
                    f"{config.get('ramp_pattern', 'step')} pattern, "
                    f"{config.get('duration_seconds', 0)}s duration")

            await run_traffic(clients, config, collector, on_snapshot=on_snapshot)

            if execution_name:
                summary = collector.build_summary()
                await write_trace(clients[0], trace_key, "LAMBDA",
                    f"Worker {worker_id} completed: {summary['peak_rps']:,} peak RPS, "
                    f"{summary['total_requests']:,} total, "
                    f"{summary['total_throttled']:,} throttled")

    finally:
        await close_clients(clients)

    # Build return payload
    return {
        "worker_id": worker_id,
        "scenario": config.get("scenario", "unknown"),
        "config": {
            "target_rps": config.get("target_rps", 0),
            "payload_size_bytes": config.get("payload_size_bytes", 1024),
            "client_count": client_count,
            "inflight_requests_limit": inflight_limit,
        },
        "time_series": collector.time_series,
        "summary": collector.build_summary(),
    }


def handler(event, context):
    """AWS Lambda entry point."""
    return asyncio.run(async_handler(event))
