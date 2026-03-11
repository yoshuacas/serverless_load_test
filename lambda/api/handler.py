"""API Lambda: bridges the dashboard to Step Functions and S3.

Routes:
  POST /api/executions          — start a new test
  GET  /api/executions/{id}     — check status / get results
  GET  /api/scenarios           — list available scenarios
"""

import json
import os
import time

import boto3

SFN_ARN = os.environ["STATE_MACHINE_ARN"]
RESULTS_BUCKET = os.environ["RESULTS_BUCKET"]
CACHE_ENDPOINT = os.environ["CACHE_ENDPOINT"]
CACHE_PORT = int(os.environ.get("CACHE_PORT", "6379"))

sfn = boto3.client("stepfunctions")
s3 = boto3.client("s3")

SCENARIOS = {
    "gradual_ramp": {
        "description": "Linear ramp from 0 to 100K total RPS over 30 min",
        "lambda_count": 20, "target_rps": 5000, "payload_size_bytes": 1024,
        "read_write_ratio": 0.8, "key_distribution": "uniform",
        "key_space_size": 100000, "ramp_pattern": "linear",
        "duration_seconds": 1800, "client_count": 3,
        "inflight_requests_limit": 1000, "command_type": "get_set",
        "report_interval_seconds": 5, "pre_populate": True,
    },
    "sudden_spike": {
        "description": "Hold at 10% then spike to 500K RPS",
        "lambda_count": 50, "target_rps": 10000, "payload_size_bytes": 1024,
        "read_write_ratio": 0.8, "key_distribution": "uniform",
        "key_space_size": 100000, "ramp_pattern": "spike",
        "duration_seconds": 300, "client_count": 3,
        "inflight_requests_limit": 1000, "command_type": "get_set",
        "report_interval_seconds": 5, "pre_populate": True,
    },
    "large_payloads": {
        "description": "50KB payloads to test ECPU-per-KB scaling",
        "lambda_count": 10, "target_rps": 2000, "payload_size_bytes": 51200,
        "read_write_ratio": 0.7, "key_distribution": "uniform",
        "key_space_size": 50000, "ramp_pattern": "step",
        "duration_seconds": 600, "client_count": 2,
        "inflight_requests_limit": 1000, "command_type": "get_set",
        "report_interval_seconds": 5, "pre_populate": True,
    },
    "memory_growth": {
        "description": "Write-heavy with sequential keys for storage scaling",
        "lambda_count": 20, "target_rps": 10000, "payload_size_bytes": 10240,
        "read_write_ratio": 0.2, "key_distribution": "sequential",
        "key_space_size": 500000, "ramp_pattern": "step",
        "duration_seconds": 900, "client_count": 3,
        "inflight_requests_limit": 1000, "command_type": "get_set",
        "report_interval_seconds": 5, "pre_populate": False,
    },
    "hot_key": {
        "description": "Zipfian distribution to test single-slot limits",
        "lambda_count": 30, "target_rps": 8000, "payload_size_bytes": 1024,
        "read_write_ratio": 0.9, "key_distribution": "zipfian",
        "key_space_size": 100000, "ramp_pattern": "step",
        "duration_seconds": 300, "client_count": 5,
        "inflight_requests_limit": 500, "command_type": "get_set",
        "report_interval_seconds": 5, "pre_populate": True,
    },
    "quick_test": {
        "description": "60-second smoke test with 2 Lambdas",
        "lambda_count": 2, "target_rps": 500, "payload_size_bytes": 1024,
        "read_write_ratio": 0.8, "key_distribution": "uniform",
        "key_space_size": 10000, "ramp_pattern": "step",
        "duration_seconds": 60, "client_count": 2,
        "inflight_requests_limit": 500, "command_type": "get_set",
        "report_interval_seconds": 5, "pre_populate": True,
    },
}


def handler(event, context):
    method = event.get("httpMethod", event.get("requestContext", {}).get("http", {}).get("method", ""))
    path = event.get("path", event.get("rawPath", ""))

    try:
        if method == "POST" and path == "/api/executions":
            return start_execution(event)
        elif method == "GET" and path.startswith("/api/executions/"):
            execution_name = path.split("/api/executions/")[1]
            return get_execution(execution_name)
        elif method == "GET" and path == "/api/scenarios":
            return respond(200, {
                name: {"description": s["description"]} for name, s in SCENARIOS.items()
            })
        elif method == "GET" and path.startswith("/api/results/"):
            scenario = path.split("/api/results/")[1]
            return get_latest_result(scenario)
        else:
            return respond(404, {"error": f"Not found: {method} {path}"})
    except Exception as e:
        return respond(500, {"error": str(e)})


def start_execution(event):
    body = json.loads(event.get("body", "{}"))
    scenario_name = body.get("scenario", "quick_test")

    if scenario_name not in SCENARIOS:
        return respond(400, {"error": f"Unknown scenario: {scenario_name}"})

    # Allow config overrides from the request body
    config = {**SCENARIOS[scenario_name]}
    config.pop("description", None)
    if "config" in body:
        config.update(body["config"])

    # Inject cache endpoint
    config["cache_endpoint"] = CACHE_ENDPOINT
    config["cache_port"] = CACHE_PORT

    execution_name = f"{scenario_name}-{int(time.time())}"

    sfn_input = {
        "scenario": scenario_name,
        "config": config,
    }

    result = sfn.start_execution(
        stateMachineArn=SFN_ARN,
        name=execution_name,
        input=json.dumps(sfn_input),
    )

    return respond(200, {
        "execution_name": execution_name,
        "execution_arn": result["executionArn"],
        "scenario": scenario_name,
        "config": config,
    })


def get_execution(execution_name):
    # Build ARN from name
    arn_prefix = SFN_ARN.replace(":stateMachine:", ":execution:")
    execution_arn = f"{arn_prefix}:{execution_name}"

    result = sfn.describe_execution(executionArn=execution_arn)
    status = result["status"]

    response = {
        "execution_name": execution_name,
        "status": status,
        "start_date": result["startDate"].isoformat(),
    }

    if status == "SUCCEEDED":
        output = json.loads(result.get("output", "{}"))
        # The aggregated results are nested under 'aggregated'
        response["results"] = output.get("aggregated", output)
    elif status in ("FAILED", "TIMED_OUT", "ABORTED"):
        response["error"] = result.get("error", "Unknown")
        response["cause"] = result.get("cause", "")

    return respond(200, response)


def get_latest_result(scenario):
    # List objects under results/<scenario>/ and return the most recent
    prefix = f"results/{scenario}/"
    resp = s3.list_objects_v2(Bucket=RESULTS_BUCKET, Prefix=prefix, MaxKeys=10)
    contents = resp.get("Contents", [])

    if not contents:
        return respond(404, {"error": f"No results for scenario: {scenario}"})

    # Get the latest by LastModified
    latest = max(contents, key=lambda o: o["LastModified"])
    obj = s3.get_object(Bucket=RESULTS_BUCKET, Key=latest["Key"])
    data = json.loads(obj["Body"].read())

    return respond(200, data)


def respond(status_code, body):
    return {
        "statusCode": status_code,
        "headers": {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
        },
        "body": json.dumps(body, default=str),
    }
