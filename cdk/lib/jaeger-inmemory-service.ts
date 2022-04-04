import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Construct } from 'constructs';
import { JaegerServiceProps, JaegerService } from './jaeger-service';


export interface JaegerInMemoryServiceProps extends JaegerServiceProps {
  readonly cpu?: number;
  readonly memoryLimitMiB?: number;

  readonly container?: string;
}

export class JaegerInMemoryService extends JaegerService {
  constructor(scope: Construct, id: string, props: JaegerInMemoryServiceProps) {
    super(scope, id, props);

    const mergedProps: Required<JaegerInMemoryServiceProps> = {
      ...{
        cpu: 1024,
        memoryLimitMiB: 2048,

        container: "jaegertracing/all-in-one:1.32"
      },
      ...props
    };

    const taskDefinition = this.createTaskDefinition(mergedProps);
    const service = this.createService(taskDefinition);

    this.createListeners(service);
    this.enableIngress(service, mergedProps);

    // all-in-one container exposes all metrics at 14269 port
    this.metricsEndpoints = [`${this.loadBalancer.loadBalancerDnsName}:14269`];
  }

  readonly metricsEndpoints: string[];

  private createListeners(service: ecs.FargateService) {
    // ui listeners
    this.createListener(service, 16686, elbv2.Protocol.TCP);
    // collector listeners
    this.createListener(service, 14250, elbv2.Protocol.TCP);
    this.createListener(service, 14268, elbv2.Protocol.TCP);
    this.createListener(service, 14269, elbv2.Protocol.TCP);
  }

  private createService(taskDefinition: ecs.FargateTaskDefinition) {
    return new ecs.FargateService(this, 'jaeger-all-in-one-service', {
      cluster: this.cluster,
      serviceName: "jaeger-all-in-one",
      taskDefinition: taskDefinition,
      desiredCount: 1
    });
  }

  private createTaskDefinition(props: Required<JaegerInMemoryServiceProps>) {
    const fargateTaskDefinition = new ecs.FargateTaskDefinition(this, 'jaeger-all-in-one-task-definition', {
      family: "jaeger-all-in-one-task-definition",
      memoryLimitMiB: props.memoryLimitMiB,
      cpu: props.cpu
    });

    fargateTaskDefinition.addContainer("jaeger-all-in-one-container", {
      containerName: "jaeger-all-in-one",
      image: ecs.ContainerImage.fromRegistry(props.container),
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
      environment: {
        SPAN_STORAGE_TYPE: "memory"
      },
      logging: ecs.LogDriver.awsLogs({
        streamPrefix: "jaeger-all-in-one"
      })
    });

    return fargateTaskDefinition;
  }
}
