# ElastiCache Serverless Auto-Scaling Demo

## Goal

Demonstrate that ElastiCache Serverless automatically scales across multiple dimensions (compute/ECPU, memory, network) without impacting application performance. The demo drives variable traffic patterns via Lambda-based load generators and visualizes scaling behavior through a hosted web dashboard where customers can run tests themselves.

## Live Dashboard

**URL**: `https://d12kr8oyzfxx5v.cloudfront.net`

Customers visit the dashboard, pick a scenario, optionally tweak config, and click "Run Scenario". The dashboard calls the API to start a Step Functions execution, polls for completion, and renders real results.

## Architecture Overview

```
Customer Browser
      |
      v
CloudFront (d12kr8oyzfxx5v.cloudfront.net)
  ├── / ──────────> S3 (static website: index.html, app.js, styles.css)
  └── /api/* ─────> API Gateway ──> API Lambda
                                      |
                      ┌───────────────┤
                      v               v
              Step Functions      S3 Results Bucket
                    |
        ┌───────────┼───────────┐
        v           v           v
    Lambda #1   Lambda #2 ... Lambda #N   (Load Generators, VPC-attached)
        |           |           |
        └───────────┼───────────┘
                    v
          ElastiCache Serverless (Valkey 8.0)
                    |
        ┌───────────┘
        v
    Aggregator Lambda ──> S3 Results Bucket
```

## Components

### 1. ElastiCache Serverless Cache

- **Engine**: Valkey 8.0
- **Cache name**: `ecoffsite-demo`
- **Endpoint**: `ecoffsite-demo-y2t7ss.serverless.use2.cache.amazonaws.com`
- **Region**: `us-east-2`
- **Scaling limits**: 1–100 GB storage, 1,000–500,000 ECPU/s
- **Encryption**: TLS always on (mandatory for serverless)
- **VPC**: Private isolated subnets, 2 AZs

**Scaling behavior**:
- 25–35% burst headroom instantly
- Capacity doubles every 10–12 minutes under sustained load
- Pre-warming requires 60 minutes via `modify-serverless-cache`

### 2. Load Generator Lambda

**Function**: `ecoffsite-load-generator`
**Runtime**: Python 3.12 (Docker image, ARM64)
**Memory**: 1024 MB | **Timeout**: 15 min | **Reserved concurrency**: 200

Uses [Valkey GLIDE](https://github.com/valkey-io/valkey-glide) — the official Valkey client with a Rust core. GLIDE uses **multiplexed connections**: each `GlideClusterClient` instance maintains 1 TCP connection per cluster node, pipelining all commands.

**Connection model**:
```
1 GlideClusterClient = 1 multiplexed TCP connection per node
Total connections = lambda_count × client_count × cluster_nodes
```

**Key config parameters per Lambda**:
| Parameter | Description | Range |
|-----------|-------------|-------|
| `target_rps` | Requests per second per Lambda | 100–15M |
| `payload_size_bytes` | Value size for GET/SET | 1–102400 |
| `read_write_ratio` | Fraction of reads (0.0–1.0) | 0.0–1.0 |
| `key_distribution` | `uniform`, `zipfian`, or `sequential` | — |
| `ramp_pattern` | `linear`, `step`, or `spike` | — |
| `client_count` | GlideClusterClient instances per Lambda | 1–20 |
| `inflight_requests_limit` | Max concurrent commands per client | 100–5000 |
| `command_type` | `get_set`, `mget`, or `batch` | — |
| `duration_seconds` | How long to generate traffic | 1–1800 |

**Return payload**: Each Lambda returns a `time_series` (5-second windows) with:
- `actual_rps`, `success_count`, `throttle_count`, `error_count`
- `latency_histogram` (18 buckets: 0.1ms to ∞)
- `bytes_written`, `bytes_read`, `active_clients`

**Packaging**: Docker image required because `valkey-glide` includes a Rust native binary. Built for `linux/arm64` (Lambda Graviton).

### 3. Aggregator Lambda

**Function**: `ecoffsite-aggregator`
**Runtime**: Python 3.12 (standard) | **Memory**: 512 MB | **Timeout**: 5 min

Receives all N worker payloads from the Step Functions Map state, then:
1. Groups snapshots by `timestamp_s` across all workers
2. Sums scalar metrics (RPS, success, throttle, error, bytes)
3. **Merges latency histograms** element-wise, then walks the merged histogram for global p50/p90/p99 (you CANNOT average percentiles — this is mathematically wrong)
4. Estimates ECPU demand (`success_count × ceil(payload_bytes / 1024)`)
5. Infers capacity from throttle pattern (no throttle → demand × 1.3; throttling → demand × success_fraction)
6. Computes cumulative cost using ElastiCache Serverless pricing
7. Detects scaling events (throttle start/resolve, capacity step-ups, latency spikes)
8. Writes aggregated JSON to S3

### 4. Step Functions State Machine

**Name**: `ecoffsite-scaling-demo`

```
Input (scenario + config)
  │
  ├─ [Choice] pre_populate == true?
  │    ├─ Yes → [PrePopulate] invoke 1 Lambda to seed keys → continue
  │    └─ No → continue
  │
  ├─ [BuildWorkerConfigs] generate array [0..lambda_count-1]
  │
  ├─ [GenerateLoad] Map state, up to 200 concurrent Lambdas
  │    └─ Each: [InvokeLoadGenerator] with unique worker_id
  │
  └─ [AggregateResults] invoke aggregator with all worker payloads
```

### 5. API Lambda

**Function**: `ecoffsite-api`
**Runtime**: Python 3.12 | **Memory**: 256 MB

Routes (behind API Gateway, fronted by CloudFront at `/api/*`):

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/executions` | Start a test. Body: `{ "scenario": "gradual_ramp", "config": {...overrides} }` |
| `GET` | `/api/executions/{name}` | Poll status. Returns `RUNNING`, `SUCCEEDED` (with results), or `FAILED` |
| `GET` | `/api/scenarios` | List available scenarios |
| `GET` | `/api/results/{scenario}` | Get latest results from S3 for a scenario |

The API Lambda has built-in scenario definitions matching the JSON files in `scenarios/`. Config overrides from the request body are merged on top. The cache endpoint is injected from environment variables — customers never need to know it.

### 6. Website Dashboard

**Hosting**: S3 + CloudFront (`https://d12kr8oyzfxx5v.cloudfront.net`)

**Files**: `index.html`, `styles.css`, `app.js` (vanilla JS + Chart.js)

**Features**:
- 6 scenario cards (Gradual Ramp, Sudden Spike, Large Payloads, Memory Growth, Hot Key, Quick Test)
- Config panel with all tunable parameters
- 6 KPI cards: RPS, Latency (p50/p90/p99), ECPU, Throttle %, Memory, Cost
- 6 charts: Latency, Throughput, ECPU, Throttle, Memory, Connections
- Scaling Events log
- "Run Scenario" button triggers real tests via `/api/executions`
- Auto-polls for completion, renders real results when done
- Falls back to simulated data when no real results exist

**Simulated data**: On page load and scenario card click, the dashboard shows realistic simulated data using a seeded ElastiCache scaling model (burst budget, capacity doubling, throttle behavior). This gives customers instant visual feedback before running a real test.

### 7. Metrics & Calculations

All metrics are **client-side only** — no CloudWatch dependency.

**Latency**: Client-side round-trip in milliseconds (Lambda → VPC → TLS → ElastiCache → response). Tracked via 18-bucket histogram per 5-second window. Merged across workers by element-wise sum, then walked for percentiles. 144 bytes per window per Lambda.

**ECPU**: `1 ECPU = 1 KB transferred`. A 3.2KB GET = 3.2 ECPU. Computed as `success_count × ceil(payload_bytes / 1024)`.

**Capacity inference**: No throttle → capacity ≈ demand × 1.3. Throttling → capacity ≈ demand × (success / total_attempts).

**Cost**: `$0.0034 per 1M ECPU` + `$0.125 per GB-hour storage`. Computed per window, accumulated.

## Test Scenarios

| Scenario | Total RPS | Payload | Duration | Lambdas | Pattern | Tests |
|----------|-----------|---------|----------|---------|---------|-------|
| `gradual_ramp` | 100K (20×5K) | 1 KB | 30 min | 20 | linear | Smooth ECPU scaling |
| `sudden_spike` | 500K (50×10K) | 1 KB | 5 min | 50 | spike | Burst capacity, throttle recovery |
| `large_payloads` | 20K (10×2K) | 50 KB | 10 min | 10 | step | ECPU-per-KB cost amplification |
| `memory_growth` | 200K (20×10K) | 10 KB | 15 min | 20 | step | Storage auto-scaling (80% writes) |
| `hot_key` | 240K (30×8K) | 1 KB | 5 min | 30 | step | Zipfian hot-key, single-slot limits |
| `quick_test` | 1K (2×500) | 1 KB | 1 min | 2 | step | 60-second smoke test |

## Project Structure

```
ecoffsite/
├── ARCHITECTURE.md              # This file
├── run_test.sh                  # CLI test launcher (alternative to dashboard)
├── elasticache-scaling-demo-arch.excalidraw  # Architecture diagram
│
├── infra/                       # CDK app (TypeScript)
│   ├── bin/app.ts               # Entry point — instantiates all stacks
│   ├── lib/
│   │   ├── vpc-stack.ts         # VPC, private subnets, security groups, S3 endpoint
│   │   ├── cache-stack.ts       # ElastiCache Serverless (Valkey 8.0)
│   │   ├── storage-stack.ts     # S3 buckets (results + scenarios)
│   │   ├── lambda-stack.ts      # Load generator (Docker/ARM64) + aggregator Lambdas
│   │   ├── step-functions-stack.ts  # State machine orchestration
│   │   └── website-stack.ts     # S3 website + CloudFront + API Gateway + API Lambda
│   ├── package.json             # CDK v2.180.0, TypeScript 5.7
│   ├── tsconfig.json
│   └── cdk.json
│
├── lambda/
│   ├── load-generator/          # Packaged as Docker image (valkey-glide needs Rust binary)
│   │   ├── Dockerfile
│   │   ├── handler.py           # Entry point: asyncio.run(async_handler)
│   │   ├── glide_client.py      # GlideClusterClient creation (TLS, inflight limit)
│   │   ├── traffic_generator.py # RPS control, ramp patterns, operation dispatch
│   │   ├── metrics_collector.py # 18-bucket histogram, windowed snapshots
│   │   ├── key_generator.py     # Uniform, Zipfian (pre-computed CDF), Sequential
│   │   └── requirements.txt     # valkey-glide>=1.3.0
│   ├── aggregator/
│   │   ├── handler.py           # Merge N worker payloads, write to S3
│   │   ├── histogram_merge.py   # Element-wise sum + percentile extraction
│   │   └── requirements.txt     # boto3
│   └── api/
│       └── handler.py           # REST API: start/poll/results endpoints
│
├── website/
│   ├── index.html               # Dashboard layout
│   ├── styles.css               # Dark theme, responsive
│   └── app.js                   # Charts, API integration, simulated data fallback
│
└── scenarios/                   # Scenario JSON configs
    ├── gradual_ramp.json
    ├── sudden_spike.json
    ├── large_payloads.json
    ├── memory_growth.json
    ├── hot_key.json
    └── quick_test.json
```

## Deployed Resources (us-east-2, account 684618342405)

| Stack | Key Outputs |
|-------|-------------|
| `EcoffsiteVpc` | VPC `vpc-0e23a9138d7af469c`, 2 private subnets, Lambda SG, Cache SG |
| `EcoffsiteCache` | `ecoffsite-demo-y2t7ss.serverless.use2.cache.amazonaws.com` |
| `EcoffsiteStorage` | Results: `ecoffsitestorage-resultsbucketa95a2103-1ag9kumoctw8` |
| `EcoffsiteLambda` | `ecoffsite-load-generator` (Docker/ARM64), `ecoffsite-aggregator` |
| `EcoffsiteStepFunctions` | `ecoffsite-scaling-demo` state machine |
| `EcoffsiteWebsite` | `https://d12kr8oyzfxx5v.cloudfront.net`, API Gateway |

## Getting Started (for new contributors)

### Prerequisites
- AWS CLI configured with credentials for account `684618342405`
- Node.js 18+ and npm
- Docker (for building the load-generator Lambda image)
- Python 3.12 (for local Lambda testing)

### Deploy from scratch
```bash
cd infra
npm install
npx cdk deploy --all --require-approval never
```

Deployment order is handled automatically by CDK. The website stack outputs the CloudFront URL.

### Update just the website
```bash
npx cdk deploy EcoffsiteWebsite --require-approval never
```

### Update just the load generator code
```bash
# Docker must be running (the load generator uses DockerImageFunction)
npx cdk deploy EcoffsiteLambda --require-approval never
```

### Run a test via CLI
```bash
cd /path/to/ecoffsite
./run_test.sh quick_test          # 60-second smoke test
./run_test.sh gradual_ramp        # 30-minute full test
./run_test.sh sudden_spike        # 5-minute burst test
```

### Run a test via dashboard
1. Visit `https://d12kr8oyzfxx5v.cloudfront.net`
2. Click a scenario card
3. Optionally adjust config in the sidebar
4. Click "Run Scenario"
5. Watch the status pill — results render when the test completes

### Tear down
```bash
npx cdk destroy --all
```

## Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Coordinator | Step Functions | Serverless, native Map fan-out, built-in wait/retry |
| Client library | Valkey GLIDE | Official client, Rust core, multiplexed connections, async |
| Lambda packaging | Docker (ARM64) | Required for GLIDE's Rust binary; Graviton for cost |
| Metrics | Lambda return payloads only | No CloudWatch dependency, sub-second granularity |
| Percentiles | 18-bucket histograms | Accurate global p50/p90/p99 via merge. 144 bytes/window |
| Dashboard hosting | S3 + CloudFront | Zero server, auto-TLS, global CDN |
| API | API Gateway + Lambda behind CloudFront `/api/*` | Same-origin, no CORS issues |
| Website framework | Vanilla JS + Chart.js | Zero build step, fast iteration |

## Known Issues & Future Work

- **p99 shows 250ms on first window**: TLS connection establishment causes outliers in the first 5-second window. Subsequent windows are sub-5ms. Consider excluding the first window or adding a warm-up phase.
- **No live streaming during test**: Dashboard only shows results after the test completes. Future: poll partial results during execution, or use WebSocket push.
- **No authentication**: The API and dashboard are publicly accessible. Add Cognito or API key for production use.
- **Pre-warm not implemented**: The architecture supports a pre-warm phase (modify-serverless-cache to set minimum ECPU), but it's not wired up in the Step Functions definition yet.
- **Large payload scenario is fixed size**: The `large_payloads` scenario uses a single payload size. A stepped version (1KB → 10KB → 50KB over time) would better demonstrate ECPU-per-KB scaling. Requires traffic_generator changes.
