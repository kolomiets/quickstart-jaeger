import { readFileSync } from 'fs';

import * as ecs from 'aws-cdk-lib/aws-ecs';
import { Construct } from 'constructs';
import { LogGroup } from 'aws-cdk-lib/aws-logs';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';

export interface PrometheusExportServiceProps {
  readonly region: string;
  readonly cluster: ecs.ICluster;

  readonly prometheusWorkspaceArn: string;
  readonly prometheusWriteUrl: string;

  readonly endpoints: string[];

  readonly cpu?: number;
  readonly memoryLimitMiB?: number;
  readonly desiredCount?: number;
  readonly collectorImage?: string;
}

export class PrometheusExportService extends Construct {
  constructor(scope: Construct, id: string, props: PrometheusExportServiceProps) {
    super(scope, id);

    const mergedProps: Required<PrometheusExportServiceProps> = {
      ...{
        cpu: 256,
        memoryLimitMiB: 512,
        desiredCount: 1,
        collectorImage: "public.ecr.aws/aws-observability/aws-otel-collector:latest"
      },
      ...props
    };

    const configurationParameter = this.createConfigurationParameter(mergedProps);
    this.taskDefinition = this.createTaskDefinition(mergedProps, configurationParameter);
    this.service = this.createService(mergedProps, this.taskDefinition);
  }

  readonly taskDefinition: ecs.TaskDefinition;
  readonly service: ecs.BaseService;

  private createConfigurationParameter(props: Required<PrometheusExportServiceProps>) {
    let configuration = readFileSync('./config/prometheus.config.yaml', 'utf-8');
    configuration = configuration.replace('{{endpoint}}', props.prometheusWriteUrl);
    configuration = configuration.replace('{{region}}', props.region);
    configuration = configuration.replace('{{targets}}', JSON.stringify(props.endpoints));

    const configurationParameter = new StringParameter(this, 'configuration-parameter', {
      description: 'AOT export configuration',
      parameterName: '/jaeger/prometheus-export-config',
      stringValue: configuration,
    });
    return configurationParameter;
  }

  private createTaskDefinition(props: Required<PrometheusExportServiceProps>, configurationParameter: StringParameter) {
    const taskDefinition = new ecs.FargateTaskDefinition(this, 'task-definition', {
      family: "prometheus-export-task-definition",
      memoryLimitMiB: props.memoryLimitMiB,
      cpu: props.cpu
    });
    taskDefinition.addContainer("container", {
      containerName: "prometheus-export",
      image: ecs.ContainerImage.fromRegistry(props.collectorImage),
      secrets: {
        AOT_CONFIG_CONTENT: ecs.Secret.fromSsmParameter(configurationParameter),
      },
      logging: ecs.LogDriver.awsLogs({
        streamPrefix: "ecs",
        logGroup: new LogGroup(this, "log-group")
      })
    });
    taskDefinition.addToTaskRolePolicy(new PolicyStatement({
      actions: ['aps:RemoteWrite'],
      resources: [props.prometheusWorkspaceArn]
    }));
    taskDefinition.addToTaskRolePolicy(new PolicyStatement({
      actions: [
        "logs:PutLogEvents",
        "logs:CreateLogGroup",
        "logs:CreateLogStream",
        "logs:DescribeLogStreams",
        "logs:DescribeLogGroups"
      ],
      resources: ['*']
    }));
    return taskDefinition;
  }

  private createService(props: Required<PrometheusExportServiceProps>, taskDefinition: ecs.TaskDefinition) {
    return new ecs.FargateService(this, 'service', {
      cluster: props.cluster,
      serviceName: "prometheus-export",
      taskDefinition: taskDefinition,
      desiredCount: props.desiredCount
    });
  }
}
