#!/usr/bin/env bash
set -euo pipefail

# ElastiCache Serverless Scaling Demo — Test Launcher
# Usage: ./run_test.sh [scenario_name]
#   scenario_name: gradual_ramp | sudden_spike | large_payloads | memory_growth | hot_key
#   Defaults to gradual_ramp if not specified.

SCENARIO="${1:-gradual_ramp}"
REGION="${AWS_DEFAULT_REGION:-us-east-2}"
STATE_MACHINE_ARN=$(aws cloudformation describe-stacks \
  --stack-name EcoffsiteStepFunctions \
  --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='StateMachineArn'].OutputValue" \
  --output text)

CACHE_ENDPOINT=$(aws cloudformation describe-stacks \
  --stack-name EcoffsiteCache \
  --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='CacheEndpoint'].OutputValue" \
  --output text)

SCENARIO_FILE="scenarios/${SCENARIO}.json"
if [ ! -f "$SCENARIO_FILE" ]; then
  echo "ERROR: Scenario file not found: $SCENARIO_FILE"
  echo "Available: gradual_ramp, sudden_spike, large_payloads, memory_growth, hot_key"
  exit 1
fi

echo "=== ElastiCache Serverless Scaling Demo ==="
echo "Scenario:       $SCENARIO"
echo "Cache endpoint: $CACHE_ENDPOINT"
echo "State machine:  $STATE_MACHINE_ARN"
echo ""

# Substitute the cache endpoint placeholder in the scenario JSON
INPUT=$(sed "s|\${CACHE_ENDPOINT}|${CACHE_ENDPOINT}|g" "$SCENARIO_FILE")

echo "Starting execution..."
EXECUTION_ARN=$(aws stepfunctions start-execution \
  --state-machine-arn "$STATE_MACHINE_ARN" \
  --name "${SCENARIO}-$(date +%Y%m%d-%H%M%S)" \
  --input "$INPUT" \
  --region "$REGION" \
  --query "executionArn" \
  --output text)

echo "Execution ARN: $EXECUTION_ARN"
echo ""
echo "Polling for completion..."

while true; do
  STATUS=$(aws stepfunctions describe-execution \
    --execution-arn "$EXECUTION_ARN" \
    --region "$REGION" \
    --query "status" \
    --output text)

  case "$STATUS" in
    RUNNING)
      echo "  $(date +%H:%M:%S) — still running..."
      sleep 10
      ;;
    SUCCEEDED)
      echo "  $(date +%H:%M:%S) — SUCCEEDED"
      break
      ;;
    FAILED|TIMED_OUT|ABORTED)
      echo "  $(date +%H:%M:%S) — $STATUS"
      echo ""
      echo "Execution failed. Fetching error details..."
      aws stepfunctions describe-execution \
        --execution-arn "$EXECUTION_ARN" \
        --region "$REGION" \
        --query "{error: error, cause: cause}" \
        --output json
      exit 1
      ;;
  esac
done

# Fetch the output
echo ""
echo "Fetching results..."
OUTPUT=$(aws stepfunctions describe-execution \
  --execution-arn "$EXECUTION_ARN" \
  --region "$REGION" \
  --query "output" \
  --output text)

# Save to website/data/ for the dashboard
mkdir -p website/data
RESULT_FILE="website/data/${SCENARIO}_latest.json"
echo "$OUTPUT" | python3 -m json.tool > "$RESULT_FILE"
echo "Results saved to: $RESULT_FILE"

# Also check if results were written to S3
S3_KEY=$(echo "$OUTPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('aggregated',{}).get('s3_key',''))" 2>/dev/null || true)
if [ -n "$S3_KEY" ]; then
  BUCKET=$(aws cloudformation describe-stacks \
    --stack-name EcoffsiteStorage \
    --region "$REGION" \
    --query "Stacks[0].Outputs[?OutputKey=='ResultsBucketName'].OutputValue" \
    --output text)
  echo "S3 copy:        s3://$BUCKET/$S3_KEY"
fi

echo ""
echo "=== Done ==="
echo "Open website/index.html to view results."
echo "The dashboard will auto-load from: $RESULT_FILE"
