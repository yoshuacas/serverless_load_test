import * as cdk from "aws-cdk-lib";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import * as sfn from "aws-cdk-lib/aws-stepfunctions";
import * as path from "path";
import { Construct } from "constructs";

export interface WebsiteStackProps extends cdk.StackProps {
  stateMachine: sfn.IStateMachine;
  resultsBucket: s3.IBucket;
  cacheEndpoint: string;
  cachePort: number;
}

export class WebsiteStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: WebsiteStackProps) {
    super(scope, id, props);

    // --- S3 bucket for static website files ---
    const websiteBucket = new s3.Bucket(this, "WebsiteBucket", {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    });

    // --- API Lambda ---
    const apiFn = new lambda.Function(this, "ApiFn", {
      functionName: "ecoffsite-api",
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: "handler.handler",
      code: lambda.Code.fromAsset(
        path.join(__dirname, "../../lambda/api")
      ),
      memorySize: 256,
      timeout: cdk.Duration.seconds(30),
      environment: {
        STATE_MACHINE_ARN: props.stateMachine.stateMachineArn,
        RESULTS_BUCKET: props.resultsBucket.bucketName,
        CACHE_ENDPOINT: props.cacheEndpoint,
        CACHE_PORT: String(props.cachePort),
      },
    });

    // Grant API Lambda permissions
    props.stateMachine.grantStartExecution(apiFn);
    props.stateMachine.grantRead(apiFn);
    props.resultsBucket.grantRead(apiFn);

    // Also need sfn:DescribeExecution
    apiFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["states:DescribeExecution"],
        resources: [
          props.stateMachine.stateMachineArn.replace(
            ":stateMachine:",
            ":execution:"
          ) + ":*",
        ],
      })
    );

    // --- API Gateway ---
    const api = new apigateway.RestApi(this, "Api", {
      restApiName: "ecoffsite-api",
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: ["Content-Type"],
      },
    });

    const apiIntegration = new apigateway.LambdaIntegration(apiFn);

    // POST /api/executions
    const apiResource = api.root.addResource("api");
    const executions = apiResource.addResource("executions");
    executions.addMethod("POST", apiIntegration);

    // GET /api/executions/{id}
    const executionById = executions.addResource("{id}");
    executionById.addMethod("GET", apiIntegration);

    // GET /api/scenarios
    const scenarios = apiResource.addResource("scenarios");
    scenarios.addMethod("GET", apiIntegration);

    // GET /api/results/{scenario}
    const results = apiResource.addResource("results");
    const resultByScenario = results.addResource("{scenario}");
    resultByScenario.addMethod("GET", apiIntegration);

    // --- CloudFront Distribution ---
    const distribution = new cloudfront.Distribution(this, "Distribution", {
      defaultBehavior: {
        origin:
          origins.S3BucketOrigin.withOriginAccessControl(websiteBucket),
        viewerProtocolPolicy:
          cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      },
      additionalBehaviors: {
        "/api/*": {
          origin: new origins.RestApiOrigin(api),
          viewerProtocolPolicy:
            cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          originRequestPolicy:
            cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        },
      },
      defaultRootObject: "index.html",
    });

    // --- Deploy website files to S3 ---
    new s3deploy.BucketDeployment(this, "DeployWebsite", {
      sources: [
        s3deploy.Source.asset(path.join(__dirname, "../../website"), {
          exclude: ["data/*"],
        }),
      ],
      destinationBucket: websiteBucket,
      distribution,
      distributionPaths: ["/*"],
    });

    // --- Outputs ---
    new cdk.CfnOutput(this, "WebsiteUrl", {
      value: `https://${distribution.distributionDomainName}`,
    });
    new cdk.CfnOutput(this, "ApiUrl", {
      value: api.url,
    });
    new cdk.CfnOutput(this, "DistributionId", {
      value: distribution.distributionId,
    });
  }
}
