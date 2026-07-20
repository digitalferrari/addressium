/**
 * Amazon EventBridge Scheduler implementation of the CampaignScheduler port
 * (docs/ARCHITECTURE.md §4.6, §4.16).
 *
 * One-off schedules target the SQS send queue directly and auto-delete after
 * firing (ActionAfterCompletion=DELETE). Recurring schedules target the launch
 * Lambda, which builds each edition and enqueues it. Timezone-aware cron is what
 * lets "daily 6am ET" track DST correctly.
 */
import {
  SchedulerClient,
  CreateScheduleCommand,
  DeleteScheduleCommand,
  FlexibleTimeWindowMode,
  ActionAfterCompletion,
} from "@aws-sdk/client-scheduler";
import type { CampaignScheduler, SendDescriptor } from "@addressium/domain";

export interface EventBridgeSchedulerConfig {
  /** IAM role EventBridge Scheduler assumes to invoke the target. */
  roleArn: string;
  /** Schedule group name. */
  groupName: string;
  /** ARN of the SQS send queue (one-off target). */
  queueArn: string;
  /** ARN of the launch Lambda (recurring target). */
  launchArn: string;
}

/** EventBridge Scheduler needs `at(YYYY-MM-DDTHH:MM:SS)` with no timezone suffix. */
function atExpression(date: Date): string {
  return `at(${date.toISOString().replace(/\.\d{3}Z$/, "")})`;
}

export class EventBridgeScheduler implements CampaignScheduler {
  private readonly client: SchedulerClient;

  constructor(
    private readonly cfg: EventBridgeSchedulerConfig,
    client?: SchedulerClient,
  ) {
    this.client = client ?? new SchedulerClient({});
  }

  async scheduleOneOff(input: { name: string; at: Date; descriptor: SendDescriptor }): Promise<void> {
    await this.client.send(
      new CreateScheduleCommand({
        Name: input.name,
        GroupName: this.cfg.groupName,
        FlexibleTimeWindow: { Mode: FlexibleTimeWindowMode.OFF },
        ScheduleExpression: atExpression(input.at),
        ActionAfterCompletion: ActionAfterCompletion.DELETE, // one-shot self-cleanup
        Target: {
          Arn: this.cfg.queueArn,
          RoleArn: this.cfg.roleArn,
          Input: JSON.stringify(input.descriptor),
        },
      }),
    );
  }

  async scheduleRecurring(input: {
    name: string;
    cron: string;
    timezone: string;
    payload: unknown;
  }): Promise<void> {
    await this.client.send(
      new CreateScheduleCommand({
        Name: input.name,
        GroupName: this.cfg.groupName,
        FlexibleTimeWindow: { Mode: FlexibleTimeWindowMode.OFF },
        ScheduleExpression: input.cron,
        ScheduleExpressionTimezone: input.timezone,
        Target: {
          Arn: this.cfg.launchArn,
          RoleArn: this.cfg.roleArn,
          Input: JSON.stringify(input.payload),
        },
      }),
    );
  }

  async cancel(name: string): Promise<void> {
    await this.client.send(
      new DeleteScheduleCommand({ Name: name, GroupName: this.cfg.groupName }),
    );
  }
}
