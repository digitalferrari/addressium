/**
 * Derived system health (#229, compendium #29).
 *
 * Alarms are operational and belong to the engineer: CloudWatch dashboard plus
 * the external SNS topic. The console gets a single derived **OK / degraded**
 * badge and never raw alarm state.
 *
 * That split is why this composition happens here rather than in the browser.
 * Giving the SPA `cloudwatch:DescribeAlarms` would hand a marketing console a
 * read view of the whole account's alarm state — the opposite of the separation
 * #29 draws — and an operator reading `SendDlqNotEmptyAlarm` in a campaign tool
 * learns nothing they can act on anyway. The detail lives on the dashboard,
 * where the runbook is.
 */
import { CloudWatchClient, DescribeAlarmsCommand } from "@aws-sdk/client-cloudwatch";

export type HealthStatus = "ok" | "degraded" | "unknown";

export interface HealthReport {
  status: HealthStatus;
  /** How many of this deployment's alarms are currently firing. */
  alarmsInAlarm: number;
  /**
   * Why the status could not be determined. Present only when `unknown` — a
   * health check that cannot run is NOT the same as a degraded system, and
   * conflating them sends someone to debug the mail pipeline when the real
   * problem is a missing IAM permission.
   */
  reason?: string;
}

export class CloudWatchHealth {
  constructor(
    private readonly alarmPrefix: string,
    private readonly cw = new CloudWatchClient({}),
  ) {}

  async check(): Promise<HealthReport> {
    try {
      const res = await this.cw.send(
        new DescribeAlarmsCommand({
          // Scoped to this deployment's alarms. Without the prefix a shared
          // account's unrelated alarms would show the product as degraded.
          AlarmNamePrefix: this.alarmPrefix,
          StateValue: "ALARM",
          MaxRecords: 100,
        }),
      );
      const inAlarm = res.MetricAlarms?.length ?? 0;
      return { status: inAlarm === 0 ? "ok" : "degraded", alarmsInAlarm: inAlarm };
    } catch (e) {
      return { status: "unknown", alarmsInAlarm: 0, reason: (e as Error).message };
    }
  }
}
