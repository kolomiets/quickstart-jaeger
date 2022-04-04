import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as secrets from 'aws-cdk-lib/aws-secretsmanager';
import * as opensearch from 'aws-cdk-lib/aws-opensearchservice';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { RemovalPolicy } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { JaegerServiceProps, JaegerService } from './jaeger-service';


export interface JaegerElasticsearchServiceProps extends JaegerServiceProps {
  readonly version?: opensearch.EngineVersion;
  readonly capacity?: opensearch.CapacityConfig;
  readonly masterUserName?: string;

  readonly collectorCpu?: number;
  readonly collectorMemoryLimitMiB?: number;
  readonly collectorContainer?: string;
  readonly collectorDesiredCount?: number;

  readonly queryCpu?: number;
  readonly queryMemoryLimitMiB?: number;
  readonly queryContainer?: string;
  readonly queryDesiredCount?: number;
}

export class JaegerElasticsearchService extends JaegerService {
  constructor(scope: Construct, id: string, props: JaegerElasticsearchServiceProps) {
    super(scope, id, props);

    // apply defaults
    const mergedProps: Required<JaegerElasticsearchServiceProps> = {
      ...{
        version: opensearch.EngineVersion.ELASTICSEARCH_7_10,
        capacity: {
          // must be an even number since the default az count is 2.
          dataNodes: 2,
          dataNodeInstanceType: "t3.small.search"
        },
        masterUserName: "master-user",

        collectorCpu: 1024,
        collectorMemoryLimitMiB: 2048,
        collectorContainer: "jaegertracing/jaeger-collector:1.32",
        collectorDesiredCount: 2,

        queryCpu: 1024,
        queryMemoryLimitMiB: 2048,
        queryContainer: "jaegertracing/jaeger-query:1.32",
        queryDesiredCount: 2
      },
      ...props
    };

    this.searchDomain = this.createSearchDomain(mergedProps);

    const searchDomainConfiguration = this.createSearchDomainConfiguration(mergedProps);

    const collectorTaskDefinition = this.createCollectorTaskDefinition(searchDomainConfiguration, mergedProps);
    const collectorService = this.createCollectorService(collectorTaskDefinition, mergedProps);

    const queryTaskDefinition = this.createQueryTaskDefinition(searchDomainConfiguration, mergedProps);
    const queryService = this.createQueryService(queryTaskDefinition, mergedProps);

    this.createListeners(queryService, collectorService);

    this.metricsEndpoints = [
      `${this.loadBalancer.loadBalancerDnsName}:16687`, // query metrics
      `${this.loadBalancer.loadBalancerDnsName}:14269`  // collector metrics
    ];
  }

  readonly searchDomain: opensearch.Domain;
  readonly metricsEndpoints: string[];

  private createListeners(queryService: ecs.FargateService, collectorService: ecs.FargateService) {
    // ui listeners
    this.createListener(queryService, 16686, elbv2.Protocol.TCP); // UI
    this.createListener(queryService, 16687, elbv2.Protocol.TCP); // health check + metrics

    // collector listeners
    this.createListener(collectorService, 14250, elbv2.Protocol.TCP); // protobuf endpoint
    this.createListener(collectorService, 14268, elbv2.Protocol.TCP); // thrift endpoint
    this.createListener(collectorService, 14269, elbv2.Protocol.TCP); // health check + metrics
  }

  private createSearchDomainConfiguration(mergedProps: Required<JaegerElasticsearchServiceProps>) {
    return {
      environment: {
        SPAN_STORAGE_TYPE: "elasticsearch",
        ES_SERVER_URLS: `https://${this.searchDomain.domainEndpoint}`,
        ES_USERNAME: mergedProps.masterUserName
      },
      secrets: {
        ES_PASSWORD: ecs.Secret.fromSecretsManager(this.getMasterUserSecret(this.searchDomain), "password")
      }
    };
  }

  private createCollectorService(taskDefinition: ecs.FargateTaskDefinition, props: Required<JaegerElasticsearchServiceProps>) {
    return new ecs.FargateService(this, 'jaeger-collector-service', {
      cluster: this.cluster,
      taskDefinition,
      serviceName: "jaeger-collector",
      desiredCount: props.collectorDesiredCount
    });
  }

  private createCollectorTaskDefinition(searchDomainConfiguration: any, props: Required<JaegerElasticsearchServiceProps>) {
    const taskDefinition = new ecs.FargateTaskDefinition(this, 'jaeger-collector-definition', {
      family: "jaeger-collector-task-definition",
      memoryLimitMiB: props.collectorMemoryLimitMiB,
      cpu: props.collectorCpu
    });
    taskDefinition.addContainer("jaeger-collector-container", {
      containerName: "jaeger-collector",
      image: ecs.ContainerImage.fromRegistry(props.collectorContainer),
      portMappings: [
        // see https://www.jaegertracing.io/docs/1.32/deployment/#collector
        { protocol: ecs.Protocol.TCP, containerPort: 9411 },
        { protocol: ecs.Protocol.TCP, containerPort: 14250 },
        { protocol: ecs.Protocol.TCP, containerPort: 14268 },
        { protocol: ecs.Protocol.TCP, containerPort: 14269 },
      ],
      logging: ecs.LogDriver.awsLogs({
        streamPrefix: "jaeger-collector"
      }),

      ...searchDomainConfiguration
    });

    // enable ES access for the task
    this.searchDomain.grantReadWrite(taskDefinition.taskRole);

    return taskDefinition;
  }

  private createQueryService(taskDefinition: ecs.FargateTaskDefinition, props: Required<JaegerElasticsearchServiceProps>) {
    return new ecs.FargateService(this, 'jaeger-query-service', {
      cluster: this.cluster,
      taskDefinition,
      serviceName: "jaeger-query",
      desiredCount: props.queryDesiredCount
    });
  }

  private createQueryTaskDefinition(searchDomainConfiguration: any, props: Required<JaegerElasticsearchServiceProps>) {
    const taskDefinition = new ecs.FargateTaskDefinition(this, 'jaeger-query-definition', {
      family: "jaeger-query-task-definition",
      memoryLimitMiB: props.queryMemoryLimitMiB,
      cpu: props.queryCpu
    });
    taskDefinition.addContainer("jaeger-query-container", {
      containerName: "jaeger-query",
      image: ecs.ContainerImage.fromRegistry(props.queryContainer),
      portMappings: [
        // see https://www.jaegertracing.io/docs/1.32/deployment/#query-service--ui
        { protocol: ecs.Protocol.TCP, containerPort: 16685 },
        { protocol: ecs.Protocol.TCP, containerPort: 16686 },
        { protocol: ecs.Protocol.TCP, containerPort: 16687 }
      ],
      logging: ecs.LogDriver.awsLogs({
        streamPrefix: "jaeger-query"
      }),

      ...searchDomainConfiguration
    });
    return taskDefinition;
  }

  private getMasterUserSecret(domain: opensearch.Domain) {
    // a small hack as CDK does not provide access to the generated secret through API
    return domain.node.findChild('MasterUser') as secrets.ISecret;
  }

  private createSearchDomain(props: Required<JaegerElasticsearchServiceProps>) {
    const esDomain = new opensearch.Domain(this, 'domain', {
      domainName: "jaeger-traces",
      removalPolicy: RemovalPolicy.DESTROY,

      version: props.version,
      enableVersionUpgrade: true,

      vpc: props.vpc,

      // must be enabled since our VPC contains multiple private subnets.
      zoneAwareness: {
        enabled: true,
      },

      capacity: props.capacity,

      // security
      useUnsignedBasicAuth: true,
      enforceHttps: true,
      nodeToNodeEncryption: true,
      encryptionAtRest: {
        enabled: true
      },

      fineGrainedAccessControl: {
        masterUserName: props.masterUserName
      }
    });

    esDomain.connections.allowFrom(
      ec2.Peer.ipv4(props.vpc.vpcCidrBlock),
      ec2.Port.tcp(443),
      "Allow ES domain access from within VPC"
    );

    return esDomain;
  }
}
