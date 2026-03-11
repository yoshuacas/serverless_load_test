#!/usr/bin/env node
import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import { VpcStack } from "../lib/vpc-stack";
import { CacheStack } from "../lib/cache-stack";
import { StorageStack } from "../lib/storage-stack";
import { LambdaStack } from "../lib/lambda-stack";
import { StepFunctionsStack } from "../lib/step-functions-stack";
import { WebsiteStack } from "../lib/website-stack";

const app = new cdk.App();

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION ?? "us-east-1",
};

const vpc = new VpcStack(app, "EcoffsiteVpc", { env });

const cache = new CacheStack(app, "EcoffsiteCache", {
  env,
  vpc: vpc.vpc,
  securityGroup: vpc.cacheSecurityGroup,
});

const storage = new StorageStack(app, "EcoffsiteStorage", { env });

const lambdas = new LambdaStack(app, "EcoffsiteLambda", {
  env,
  vpc: vpc.vpc,
  lambdaSecurityGroup: vpc.lambdaSecurityGroup,
  resultsBucket: storage.resultsBucket,
  cacheEndpoint: cache.cacheEndpoint,
  cachePort: cache.cachePort,
});

const stepFunctions = new StepFunctionsStack(app, "EcoffsiteStepFunctions", {
  env,
  loadGeneratorFn: lambdas.loadGeneratorFn,
  aggregatorFn: lambdas.aggregatorFn,
  resultsBucket: storage.resultsBucket,
  scenariosBucket: storage.scenariosBucket,
});

new WebsiteStack(app, "EcoffsiteWebsite", {
  env,
  stateMachine: stepFunctions.stateMachine,
  resultsBucket: storage.resultsBucket,
  cacheEndpoint: cache.cacheEndpoint,
  cachePort: cache.cachePort,
});

app.synth();
