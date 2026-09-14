import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import { Platform } from "aws-cdk-lib/aws-ecr-assets";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as path from "path";
import { Construct } from "constructs";

export interface LambdaStackProps extends cdk.StackProps {
  vpc: ec2.IVpc;
  lambdaSecurityGroup: ec2.ISecurityGroup;
  resultsBucket: s3.IBucket;
  cacheEndpoint: string;
  cachePort: number;
}

export class LambdaStack extends cdk.Stack {
  public readonly loadGeneratorFn: lambda.IFunction;
  public readonly aggregatorFn: lambda.IFunction;
  public readonly liveReaderFn: lambda.IFunction;

  constructor(scope: Construct, id: string, props: LambdaStackProps) {
    super(scope, id, props);

    const privateSubnets = props.vpc.selectSubnets({
      subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
    });

    // --- Load Generator Lambda ---
    // Uses valkey-glide which includes a Rust binary.
    // Package as a Docker image to handle native dependencies.
    this.loadGeneratorFn = new lambda.DockerImageFunction(
      this,
      "LoadGeneratorFn",
      {
        functionName: "ecoffsite-load-generator",
        code: lambda.DockerImageCode.fromImageAsset(
          path.join(__dirname, "../../lambda/load-generator"),
          { platform: Platform.LINUX_ARM64 }
        ),
        architecture: lambda.Architecture.ARM_64,
        memorySize: 1024,
        timeout: cdk.Duration.minutes(15),
        vpc: props.vpc,
        vpcSubnets: privateSubnets,
        securityGroups: [props.lambdaSecurityGroup],
        environment: {
          CACHE_ENDPOINT: props.cacheEndpoint,
          CACHE_PORT: String(props.cachePort),
        },
        // Allow up to 200 concurrent invocations for large fan-outs
        reservedConcurrentExecutions: 200,
      }
    );

    // --- Aggregator Lambda ---
    // Pure Python, no native deps. Use standard runtime.
    this.aggregatorFn = new lambda.Function(this, "AggregatorFn", {
      functionName: "ecoffsite-aggregator",
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: "handler.handler",
      code: lambda.Code.fromAsset(
        path.join(__dirname, "../../lambda/aggregator")
      ),
      memorySize: 512,
      timeout: cdk.Duration.minutes(5),
      environment: {
        RESULTS_BUCKET: props.resultsBucket.bucketName,
      },
    });

    // Grant aggregator write access to results bucket
    props.resultsBucket.grantWrite(this.aggregatorFn);

    // --- Live Reader Lambda ---
    // Reads live progress data from ElastiCache. Uses redis-py (pure Python).
    // VPC-attached to reach the cache.
    this.liveReaderFn = new lambda.Function(this, "LiveReaderFn", {
      functionName: "ecoffsite-live",
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: "handler.handler",
      code: lambda.Code.fromAsset(
        path.join(__dirname, "../../lambda/live")
      ),
      memorySize: 256,
      timeout: cdk.Duration.seconds(15),
      vpc: props.vpc,
      vpcSubnets: privateSubnets,
      securityGroups: [props.lambdaSecurityGroup],
      environment: {
        CACHE_ENDPOINT: props.cacheEndpoint,
        CACHE_PORT: String(props.cachePort),
      },
    });

    // Outputs
    new cdk.CfnOutput(this, "LoadGeneratorFnArn", {
      value: this.loadGeneratorFn.functionArn,
    });
    new cdk.CfnOutput(this, "AggregatorFnArn", {
      value: this.aggregatorFn.functionArn,
    });
    new cdk.CfnOutput(this, "LiveReaderFnArn", {
      value: this.liveReaderFn.functionArn,
    });
  }
}
