import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';

import { Construct } from 'constructs';

export interface JaegerServiceProps {
  readonly vpc: ec2.Vpc;

  readonly internetFacing: boolean;
  readonly containerInsights: boolean;
}

export abstract class JaegerService extends Construct {
  constructor(scope: Construct, id: string, props: JaegerServiceProps) {
    super(scope, id);

    this.cluster = new ecs.Cluster(this, "jaeger-cluster", {
      vpc: props.vpc,
      clusterName: "jaeger-cluster",
      containerInsights: props.containerInsights
    });

    this.loadBalancer = new elbv2.NetworkLoadBalancer(this, 'jaeger-nlb', {
      vpc: props.vpc,
      internetFacing: props.internetFacing,
      loadBalancerName: "jaeger-nlb"
    });
  }

  readonly cluster: ecs.ICluster;
  readonly loadBalancer: elbv2.NetworkLoadBalancer;
  readonly abstract metricsEndpoints: string[];

  protected createListener(service: ecs.FargateService, port: number, protocol: elbv2.Protocol) {
    const listener = this.loadBalancer.addListener(`jaeger-${port}`, {
      protocol,
      port
    });

    listener.addTargets(`jaeger-${port}`, {
      targetGroupName: `jaeger-${port}`,
      targets: [
        service.loadBalancerTarget({
          containerName: service.taskDefinition.defaultContainer!.containerName,
          containerPort: port,
          protocol: (protocol == elbv2.Protocol.TCP) ? ecs.Protocol.TCP : ecs.Protocol.UDP
        })
      ],
      protocol,
      port
    });
  }

  protected enableIngress(service: ecs.FargateService, props: JaegerServiceProps) {
    // enable access from the load balancer
    service.connections.allowFrom(
      ec2.Peer.ipv4(props.vpc.vpcCidrBlock),
      ec2.Port.allTcp(),
      "Allow ECS Service access from within VPC"
    );
  }
}