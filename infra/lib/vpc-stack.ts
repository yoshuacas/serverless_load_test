import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import { Construct } from "constructs";

export class VpcStack extends cdk.Stack {
  public readonly vpc: ec2.IVpc;
  public readonly cacheSecurityGroup: ec2.ISecurityGroup;
  public readonly lambdaSecurityGroup: ec2.ISecurityGroup;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // VPC with private subnets (Lambda + ElastiCache) and no NAT for cost savings.
    // Lambdas access ElastiCache via VPC-internal networking.
    this.vpc = new ec2.Vpc(this, "Vpc", {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        {
          name: "Private",
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: 24,
        },
      ],
    });

    // Security group for Lambda functions
    this.lambdaSecurityGroup = new ec2.SecurityGroup(this, "LambdaSg", {
      vpc: this.vpc,
      description: "Security group for load generator Lambdas",
      allowAllOutbound: true,
    });

    // Security group for ElastiCache
    this.cacheSecurityGroup = new ec2.SecurityGroup(this, "CacheSg", {
      vpc: this.vpc,
      description: "Security group for ElastiCache Serverless",
      allowAllOutbound: false,
    });

    // Allow Lambda -> ElastiCache on port 6379 (TLS)
    this.cacheSecurityGroup.addIngressRule(
      this.lambdaSecurityGroup,
      ec2.Port.tcp(6379),
      "Allow Lambda to connect to ElastiCache"
    );

    // VPC endpoint for S3 (so Lambda in isolated subnet can write results)
    this.vpc.addGatewayEndpoint("S3Endpoint", {
      service: ec2.GatewayVpcEndpointAwsService.S3,
    });

    // Outputs
    new cdk.CfnOutput(this, "VpcId", { value: this.vpc.vpcId });
  }
}
