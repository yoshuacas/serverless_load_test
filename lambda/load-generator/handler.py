"""Lambda handler: entry point for the load generator."""

import asyncio

from glide_client import close_clients, create_clients
from metrics_collector import MetricsCollector
from traffic_generator import pre_populate, run_traffic


async def async_handler(event: dict) -> dict:
    config = event
    worker_id = config["worker_id"]
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

    try:
        # Pre-populate if requested (for read-heavy tests)
        if config.get("pre_populate"):
            key_space = config.get("key_space_size", 100_000)
            payload_size = config.get("payload_size_bytes", 1024)
            await pre_populate(clients, key_space, payload_size)

        # Run the traffic generator (skip if duration is 0, e.g. pre-populate only)
        if config.get("duration_seconds", 0) > 0:
            await run_traffic(clients, config, collector)

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
