"""Valkey GLIDE client creation and management."""

from glide import (
    GlideClusterClient,
    GlideClusterClientConfiguration,
    NodeAddress,
)


async def create_clients(
    endpoint: str,
    port: int,
    client_count: int,
    inflight_requests_limit: int,
    request_timeout_ms: int = 500,
) -> list[GlideClusterClient]:
    """Create multiple GlideClusterClient instances.

    Each instance establishes 1 multiplexed TCP connection per cluster node.
    Total TCP connections = client_count x cluster_nodes.
    """
    addresses = [NodeAddress(endpoint, port)]
    clients = []

    for _ in range(client_count):
        config = GlideClusterClientConfiguration(
            addresses=addresses,
            use_tls=True,
            request_timeout=request_timeout_ms,
            inflight_requests_limit=inflight_requests_limit,
        )
        client = await GlideClusterClient.create(config)
        clients.append(client)

    return clients


async def close_clients(clients: list[GlideClusterClient]):
    """Close all Glide client connections."""
    for client in clients:
        try:
            await client.close()
        except Exception:
            pass
