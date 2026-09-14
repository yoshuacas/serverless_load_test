import * as cdk from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as sfn from "aws-cdk-lib/aws-stepfunctions";
import * as tasks from "aws-cdk-lib/aws-stepfunctions-tasks";
import { Construct } from "constructs";

export interface StepFunctionsStackProps extends cdk.StackProps {
  loadGeneratorFn: lambda.IFunction;
  aggregatorFn: lambda.IFunction;
  resultsBucket: s3.IBucket;
  scenariosBucket: s3.IBucket;
}

export class StepFunctionsStack extends cdk.Stack {
  public readonly stateMachine: sfn.IStateMachine;

  constructor(scope: Construct, id: string, props: StepFunctionsStackProps) {
    super(scope, id, props);

    // --- Step 1: Pre-populate Phase (optional) ---
    // Invokes a single Lambda with pre_populate: true to seed keys.
    const prePopulate = new tasks.LambdaInvoke(this, "PrePopulate", {
      lambdaFunction: props.loadGeneratorFn,
      payload: sfn.TaskInput.fromObject({
        worker_id: "pre-populate",
        "cache_endpoint.$": "$.config.cache_endpoint",
        "cache_port.$": "$.config.cache_port",
        "client_count.$": "$.config.client_count",
        "inflight_requests_limit.$": "$.config.inflight_requests_limit",
        pre_populate: true,
        "key_space_size.$": "$.config.key_space_size",
        "payload_size_bytes.$": "$.config.payload_size_bytes",
        // Minimal traffic run — just populate, then exit
        target_rps: 0,
        duration_seconds: 0,
      }),
      resultPath: "$.pre_populate_result",
      // Discard Lambda wrapper envelope, keep only Payload
      payloadResponseOnly: true,
    });

    // --- Step 2: Build worker configs ---
    // Generate an array of N worker config objects for the Map state.
    const buildWorkerConfigs = new sfn.Pass(this, "BuildWorkerConfigs", {
      parameters: {
        "scenario.$": "$.scenario",
        "config.$": "$.config",
        "worker_configs.$":
          "States.ArrayRange(0, States.MathAdd($.config.lambda_count, -1), 1)",
      },
    });

    // --- Step 3: Fan-out load generation (Map state) ---
    const generateLoad = new sfn.Map(this, "GenerateLoad", {
      maxConcurrency: 200,
      itemsPath: "$.worker_configs",
      itemSelector: {
        "worker_id.$": "States.Format('worker-{}', $$.Map.Item.Value)",
        "execution_name.$": "$$.Execution.Name",
        "scenario.$": "$.scenario",
        "lambda_count.$": "$.config.lambda_count",
        "cache_endpoint.$": "$.config.cache_endpoint",
        "cache_port.$": "$.config.cache_port",
        "target_rps.$": "$.config.target_rps",
        "payload_size_bytes.$": "$.config.payload_size_bytes",
        "duration_seconds.$": "$.config.duration_seconds",
        "read_write_ratio.$": "$.config.read_write_ratio",
        "key_space_size.$": "$.config.key_space_size",
        "key_distribution.$": "$.config.key_distribution",
        "ramp_pattern.$": "$.config.ramp_pattern",
        "client_count.$": "$.config.client_count",
        "inflight_requests_limit.$": "$.config.inflight_requests_limit",
        "command_type.$": "$.config.command_type",
        "report_interval_seconds.$": "$.config.report_interval_seconds",
      },
      resultPath: "$.worker_results",
    });

    generateLoad.itemProcessor(
      new tasks.LambdaInvoke(this, "InvokeLoadGenerator", {
        lambdaFunction: props.loadGeneratorFn,
        payloadResponseOnly: true,
      })
    );

    // --- Step 4: Aggregate results ---
    const aggregate = new tasks.LambdaInvoke(this, "AggregateResults", {
      lambdaFunction: props.aggregatorFn,
      payload: sfn.TaskInput.fromObject({
        "scenario.$": "$.scenario",
        "config.$": "$.config",
        "worker_results.$": "$.worker_results",
        "execution_id.$": "$$.Execution.Name",
      }),
      payloadResponseOnly: true,
      resultPath: "$.aggregated",
    });

    // --- Assemble the state machine ---
    // Check if pre-population is requested
    const shouldPrePopulate = new sfn.Choice(this, "ShouldPrePopulate")
      .when(
        sfn.Condition.booleanEquals("$.config.pre_populate", true),
        prePopulate.next(buildWorkerConfigs)
      )
      .otherwise(buildWorkerConfigs);

    const definition = shouldPrePopulate
      .afterwards()
      .next(generateLoad)
      .next(aggregate);

    this.stateMachine = new sfn.StateMachine(this, "ScalingDemo", {
      stateMachineName: "ecoffsite-scaling-demo",
      definitionBody: sfn.DefinitionBody.fromChainable(definition),
      timeout: cdk.Duration.hours(2),
    });

    // Grant the state machine permission to invoke the Lambdas
    props.loadGeneratorFn.grantInvoke(this.stateMachine);
    props.aggregatorFn.grantInvoke(this.stateMachine);

    // Grant read access to scenarios bucket (for future scenario loading)
    props.scenariosBucket.grantRead(this.stateMachine);

    // Outputs
    new cdk.CfnOutput(this, "StateMachineArn", {
      value: this.stateMachine.stateMachineArn,
    });
    new cdk.CfnOutput(this, "StateMachineName", {
      value: "ecoffsite-scaling-demo",
    });
  }
}
