import { RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { LogGroup } from 'aws-cdk-lib/aws-logs';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { readFileSync } from 'fs';
import * as opensearch from 'aws-cdk-lib/aws-opensearchservice'
import * as secrets from 'aws-cdk-lib/aws-secretsmanager'

import { JaegerInMemoryService } from './jaeger-inmemory-service'
import { JaegerElasticsearchService } from './jaeger-elasticsearch-service' 
import { PrometheusExportService } from './prometheus-export-service'

// TODO
const PrometheusWorkstaceArn = 'arn:aws:aps:eu-west-1:367215520538:workspace/ws-04b56509-26d8-40e1-9191-4b08d52340f2'
const PrometheusWorkspaceRemoteWriteUrl = 'https://aps-workspaces.eu-west-1.amazonaws.com/workspaces/ws-04b56509-26d8-40e1-9191-4b08d52340f2/api/v1/remote_write'

export enum JaegerBackend {
  InMemory,
  Elasticsearch
}

export interface QuickstartJaegerStackProps extends StackProps {
  readonly storageBackend: JaegerBackend
}

export class QuickstartJaegerStack extends Stack {
  constructor(scope: Construct, id: string, props?: QuickstartJaegerStackProps) {
    super(scope, id, props);

    const vpc = new ec2.Vpc(this, "jaeger-vpc", {
      maxAzs: 2 
    });

    // const jaeger = new JaegerInMemoryService(this, 'jaeger', {
    //   vpc,
    //   internetFacing: true,
    //   containerInsights: true
    // })

    const jaeger = new JaegerElasticsearchService(this, 'jaeger', {
      vpc,
      internetFacing: true,
      containerInsights: true,
    })

    const prometheus = new PrometheusExportService(this, 'prometheus-export', {
      cluster: jaeger.cluster,
      prometheusWorkspaceArn: PrometheusWorkstaceArn,
      prometheusWriteUrl: PrometheusWorkspaceRemoteWriteUrl,
      region: this.region,
      endpoints: jaeger.metricsEndpoints
    })

    return

    const esDomain = new opensearch.Domain(this, 'Domain', {
      domainName: "jaeger-traces",
      removalPolicy: RemovalPolicy.DESTROY,

      version: opensearch.EngineVersion.ELASTICSEARCH_7_10,
      enableVersionUpgrade: true,

      vpc,
      
      // must be enabled since our VPC contains multiple private subnets.
      zoneAwareness: {
        enabled: true,
      },
      capacity: {
        // must be an even number since the default az count is 2.
        dataNodes: 2,
        dataNodeInstanceType: "t3.small.search"
      },

      // security
      useUnsignedBasicAuth: true, // we rely on fine-grained access control instead

      enforceHttps: true,
      nodeToNodeEncryption: true,
      encryptionAtRest: {
        enabled: true,
      },

      fineGrainedAccessControl: {
        masterUserName: 'master-user',

      }
    });

    // a small hack as CDK does not provide access to the generated secret through API
    const masterUserSecret = esDomain.node.findChild('MasterUser') as secrets.ISecret

    esDomain.connections.allowFrom(ec2.Peer.ipv4(vpc.vpcCidrBlock), ec2.Port.tcp(443), "Allow ES domain access from within VPC")

    const cluster = new ecs.Cluster(this, "jaeger-cluster", {
      vpc: vpc,
      clusterName: "jaeger-cluster",
      containerInsights: false
    });

    const metricsEndpoint = this.createJaegerService(cluster, esDomain, vpc, masterUserSecret);
    this.createAotService(cluster, [ metricsEndpoint ]);    
  }

  private createJaegerService(cluster: ecs.Cluster, esDomain: opensearch.Domain, vpc: ec2.Vpc, masterUserSecret: secrets.ISecret) {
    const fargateTaskDefinition = new ecs.FargateTaskDefinition(this, 'jaeger-all-in-one-task-definition', {
      family: "jaeger-task-definition",
      memoryLimitMiB: 2048,
      cpu: 1024
    });

    // enable ES access for the task
    esDomain.grantReadWrite(fargateTaskDefinition.taskRole)

    const container = fargateTaskDefinition.addContainer("jaeger-all-in-one-container", {
      containerName: "jaeger-all-in-one",
      image: ecs.ContainerImage.fromRegistry("jaegertracing/all-in-one:1.32"),
      portMappings: [
        // Jaeger UI ports
        { protocol: ecs.Protocol.TCP, containerPort: 16685 },
        { protocol: ecs.Protocol.TCP, containerPort: 16686 },
        // Jaeger Collector ports
        { protocol: ecs.Protocol.TCP, containerPort: 9411 },
        { protocol: ecs.Protocol.TCP, containerPort: 14250 },
        { protocol: ecs.Protocol.TCP, containerPort: 14268 },
        { protocol: ecs.Protocol.TCP, containerPort: 14269 },
      ],
      logging: ecs.LogDriver.awsLogs({
        streamPrefix: "jaeger-all-in-one"
      }),

      environment: {
        SPAN_STORAGE_TYPE: "elasticsearch",
        ES_SERVER_URLS: `https://${esDomain.domainEndpoint}`,
        ES_USERNAME: "master-user",
      },

      secrets: {
        ES_PASSWORD: ecs.Secret.fromSecretsManager(masterUserSecret, "password"),
      }
      
      // All-in-one mode

      // environment: {
      //   SPAN_STORAGE_TYPE: "memory"
      // },
      
    });

    const jaegerService = new ecs.FargateService(this, 'jaeger-all-in-one-service', {
      cluster,
      serviceName: "jaeger-all-in-one",
      taskDefinition: fargateTaskDefinition,
      desiredCount: 1
    });

    jaegerService.connections.allowFrom(ec2.Peer.ipv4(vpc.vpcCidrBlock), ec2.Port.allTcp(), "Allow ECS Service access from within VPC")

    const jaegerLoadBalancer = new elbv2.NetworkLoadBalancer(this, 'jaeger-nlb', {
      vpc,
      internetFacing: true,
      loadBalancerName: "jaeger-nlb"
    });

    // ui listeners
    this.createListener(jaegerLoadBalancer, jaegerService, 16686, elbv2.Protocol.TCP);

    // collector listeners
    this.createListener(jaegerLoadBalancer, jaegerService, 14250, elbv2.Protocol.TCP);
    this.createListener(jaegerLoadBalancer, jaegerService, 14268, elbv2.Protocol.TCP);
    this.createListener(jaegerLoadBalancer, jaegerService, 14269, elbv2.Protocol.TCP);

    return `${jaegerLoadBalancer.loadBalancerDnsName}:14269`
  }

  private createAotService(cluster: ecs.Cluster, metricsEndpoints: string[]) {
    let aotConfiguration = readFileSync('./config/aot.config.yaml', 'utf-8');
    aotConfiguration = aotConfiguration.replace('{{endpoint}}', PrometheusWorkspaceRemoteWriteUrl);
    aotConfiguration = aotConfiguration.replace('{{region}}', this.region);
    aotConfiguration = aotConfiguration.replace('{{targets}}', JSON.stringify(metricsEndpoints))

    const aotConfigurationParameter = new ssm.StringParameter(this, 'aot-configuration-parameter', {
      description: 'AOT export configuration',
      parameterName: '/jaeger/aot-export-config',
      stringValue: aotConfiguration,
    });

    const ampExportTaskDefinition = new ecs.FargateTaskDefinition(this, 'amp-export-task-definition', {
      family: "amp-export-task-definition",
      memoryLimitMiB: 512,
      cpu: 256
    });
    const exportContainer = ampExportTaskDefinition.addContainer("amp-export-container", {
      containerName: "amp-export",
      image: ecs.ContainerImage.fromRegistry("public.ecr.aws/aws-observability/aws-otel-collector:latest"),
      secrets: {
        AOT_CONFIG_CONTENT: ecs.Secret.fromSsmParameter(aotConfigurationParameter),
      },
      logging: ecs.LogDriver.awsLogs({
        streamPrefix: "ecs",
        logGroup: new LogGroup(this, "amp-export-log-group")
      })
    });
    ampExportTaskDefinition.addToTaskRolePolicy(new PolicyStatement({
      actions: ['aps:RemoteWrite'],
      resources: [PrometheusWorkstaceArn]
    }));
    ampExportTaskDefinition.addToTaskRolePolicy(new PolicyStatement({
      actions: [
        "logs:PutLogEvents",
        "logs:CreateLogGroup",
        "logs:CreateLogStream",
        "logs:DescribeLogStreams",
        "logs:DescribeLogGroups"
      ],
      resources: ['*']
    }));

    const ampExportService = new ecs.FargateService(this, 'amp-export-service', {
      cluster,
      serviceName: "amp-export",
      taskDefinition: ampExportTaskDefinition,
      desiredCount: 1
    });
  }

  private createListener(jaegerNetworkLoadBalancer: elbv2.NetworkLoadBalancer, jaegerService: ecs.FargateService, port: number, protocol: elbv2.Protocol) {
    const listener = jaegerNetworkLoadBalancer.addListener(`jaeger-${port}`, {
      protocol,
      port
    });

    listener.addTargets(`jaeger-${port}`, {
      targetGroupName: `jaeger-${port}`,
      targets: [
        jaegerService.loadBalancerTarget({
          containerName: 'jaeger-all-in-one',
          containerPort: port,
          protocol: (protocol == elbv2.Protocol.TCP) ? ecs.Protocol.TCP : ecs.Protocol.UDP
        })
      ],
      protocol,
      port
    });
  }
}
