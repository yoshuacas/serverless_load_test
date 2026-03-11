# CLAUDE.md - Project Instructions for Claude Code

## What This Is
ElastiCache Serverless auto-scaling demo. Customers visit a dashboard, pick a scenario, and run real load tests against ElastiCache Serverless (Valkey 8.0) to observe scaling behavior.

## Quick Reference
- **Live dashboard**: https://d12kr8oyzfxx5v.cloudfront.net
- **Region**: us-east-2
- **Full architecture docs**: `ARCHITECTURE.md`
- **CDK app**: `infra/` (TypeScript, CDK v2.180.0)

## Common Commands
```bash
# Deploy everything (Docker must be running)
cd infra && npx cdk deploy --all --require-approval never

# Deploy website only (fast - no Docker needed)
cd infra && npx cdk deploy EcoffsiteWebsite --require-approval never

# Deploy Lambda code (Docker required)
cd infra && npx cdk deploy EcoffsiteLambda --require-approval never

# Run a test via CLI
./run_test.sh quick_test

# CDK synth check
cd infra && npx cdk synth --quiet
```

## Critical Gotchas
1. **ARM64**: Load generator Lambda is ARM64 Docker. Must use `Platform.LINUX_ARM64` and `Architecture.ARM_64` in lambda-stack.ts
2. **Docker**: Must be running before `cdk deploy` (load-generator is DockerImageFunction)
3. **Field names**: Use `read_write_ratio` everywhere (not `read_ratio`). Use `itemSelector` in Step Functions Map (not deprecated `parameters`)
4. **Pre-populate guard**: handler.py skips traffic when `duration_seconds == 0` (pre-populate-only invocations)
5. **Never average percentiles**: Histograms are merged element-wise, then walked for p50/p90/p99

## Stack Dependencies
VPC → Cache → Storage → Lambda → StepFunctions → Website
(CDK handles ordering automatically)

## Key Files to Know
| File | What It Does |
|------|-------------|
| `infra/bin/app.ts` | CDK entry point, instantiates all 6 stacks |
| `infra/lib/website-stack.ts` | CloudFront + S3 + API Gateway + API Lambda |
| `infra/lib/step-functions-stack.ts` | State machine: fan-out Lambdas, aggregate |
| `lambda/load-generator/handler.py` | Main load gen entry point (asyncio + GLIDE) |
| `lambda/api/handler.py` | REST API with built-in scenario definitions |
| `lambda/aggregator/handler.py` | Merges N worker payloads, writes to S3 |
| `website/app.js` | Dashboard JS (Chart.js, API integration, simulated fallback) |
