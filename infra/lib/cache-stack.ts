import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as elasticache from "aws-cdk-lib/aws-elasticache";
import { Construct } from "constructs";

export interface CacheStackProps extends cdk.StackProps {
  vpc: ec2.IVpc;
  securityGroup: ec2.ISecurityGroup;
}

export class CacheStack extends cdk.Stack {
  public readonly cacheEndpoint: string;
  public readonly cachePort: number;

  constructor(scope: Construct, id: string, props: CacheStackProps) {
    super(scope, id, props);

    const subnetIds = props.vpc
      .selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_ISOLATED })
      .subnetIds;

    // ElastiCache Serverless cache (Valkey 8.0)
    const cache = new elasticache.CfnServerlessCache(this, "ServerlessCache", {
      serverlessCacheName: "ecoffsite-demo",
      engine: "valkey",
      majorEngineVersion: "8",
      description: "ElastiCache Serverless scaling demo",

      // Scaling limits — start low, set max high to observe full scaling range
      cacheUsageLimits: {
        dataStorage: {
          minimum: 1,
          maximum: 100,
          unit: "GB",
        },
        ecpuPerSecond: {
          minimum: 1000,
          maximum: 500000,
        },
      },

      securityGroupIds: [props.securityGroup.securityGroupId],
      subnetIds,
    });

    this.cacheEndpoint = cache.attrEndpointAddress;
    this.cachePort = 6379;

    new cdk.CfnOutput(this, "CacheEndpoint", {
      value: this.cacheEndpoint,
    });
    new cdk.CfnOutput(this, "CacheName", {
      value: "ecoffsite-demo",
    });
  }
}
