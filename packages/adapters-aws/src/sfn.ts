/**
 * AWS Step Functions implementation of the DripStarter port
 * (docs/ARCHITECTURE.md §4.6, #245).
 *
 * This is the call that was missing. The drip state machine, its step handler,
 * the sequence store and the console CRUD all shipped; nothing anywhere in
 * `packages/` or `services/` ever called `StartExecution`, so every drip sequence
 * an operator could author sat inert and the only thing that ran the machine was
 * a CDK assertion about its definition.
 *
 * Deliberately thin: the execution input shape and the execution NAME are pure
 * functions in `@addressium/domain` (see `dripExecutionName`), because the name is
 * the idempotency mechanism and a mechanism that can only be checked by starting
 * a real execution is a mechanism nobody checks.
 */
import {
  SFNClient,
  StartExecutionCommand,
  DescribeExecutionCommand,
  ExecutionAlreadyExists,
} from "@aws-sdk/client-sfn";
import { dripExecutionName, type DripEnrollment, type DripStarter } from "@addressium/domain";

export interface SfnDripStarterConfig {
  /** ARN of the drip state machine (CDK: `DripStateMachine`). */
  stateMachineArn: string;
}

/**
 * Execution statuses that mean the previous run of this enrollment did NOT get
 * to deliver the sequence. `SUCCEEDED` and `RUNNING` (and `PENDING_REDRIVE`,
 * which is on its way back to running) are the enrollment working; these are not.
 */
const DID_NOT_RUN = new Set(["FAILED", "TIMED_OUT", "ABORTED"]);

export class SfnDripStarter implements DripStarter {
  private readonly client: SFNClient;

  constructor(
    private readonly cfg: SfnDripStarterConfig,
    client?: SFNClient,
  ) {
    this.client = client ?? new SFNClient({});
  }

  async start(enrollment: DripEnrollment): Promise<void> {
    const name = dripExecutionName(enrollment);
    try {
      await this.client.send(
        new StartExecutionCommand({
          stateMachineArn: this.cfg.stateMachineArn,
          // Derived from the enrollment, never random — this name IS the
          // deduplication. Step Functions caps it at 80 characters and rejects
          // whitespace, control characters and `: / ? * " < > { } [ ] | ^ ~ $ #
          // % & , ;`, so raw ids cannot be interpolated: an ISO timestamp's
          // colons alone would make every call a 400. `dripExecutionName` folds
          // the whole tuple into a digest for exactly that reason.
          name,
          // The machine starts at its WAIT and reads every one of these fields
          // by JSONPath, so all of them must always be present — a JSONPath onto
          // a missing field is a States.Runtime failure at the first transition,
          // which surfaces as a failed execution rather than a bad request.
          input: JSON.stringify({
            orgId: enrollment.orgId,
            sequenceId: enrollment.sequenceId,
            subscriberId: enrollment.subscriberId,
            nextStepIndex: enrollment.nextStepIndex,
            nextWaitSeconds: enrollment.nextWaitSeconds,
            enrollmentId: enrollment.enrollmentId,
          }),
        }),
      );
    } catch (e) {
      // Usually not an error — this is the guarantee working. A subscriber who
      // clicks the confirmation link three times, or a redelivered confirmation,
      // computes the same name and gets refused; surfacing that would turn a
      // successful double opt-in into a 400 on the landing page.
      //
      // Checked by NAME as well as by class: Step Functions returns this for a
      // name that matches a RUNNING execution with a different input, and for any
      // name reused within the 90-day retention of CLOSED executions. Nothing
      // else is swallowed — AccessDenied and StateMachineDoesNotExist are
      // configuration bugs and must stay loud.
      //
      // But those two cases are not the same fact, and treating them as one was
      // its own silent failure: a closed execution may have ENDED IN FAILURE (a
      // step referencing a template that did not exist, say). Swallowing that
      // reports "enrolled" for an enrollment that delivered nothing and, because
      // the name is retained for 90 days, cannot be started again. So ask.
      if (e instanceof ExecutionAlreadyExists || (e as Error)?.name === "ExecutionAlreadyExists") {
        const status = await this.previousStatus(name);
        if (status && DID_NOT_RUN.has(status)) {
          throw new Error(
            `drip enrollment ${name} already ran and ended ${status}; Step Functions keeps the name ` +
              `for 90 days, so this enrollment cannot be restarted under the same identity`,
          );
        }
        return;
      }
      throw e;
    }
  }

  /**
   * The status of the execution that already owns `name`, or undefined if we
   * cannot tell.
   *
   * Best-effort by construction. `DescribeExecution` may be denied (a stage
   * deployed before this grant existed), throttled, or answered for an ARN we
   * guessed wrong — and none of those are worth failing a confirmation over. When
   * it cannot answer, the caller falls back to the old behaviour: treat the
   * duplicate as success.
   */
  private async previousStatus(name: string): Promise<string | undefined> {
    const executionArn = this.executionArn(name);
    if (!executionArn) return undefined;
    try {
      return (await this.client.send(new DescribeExecutionCommand({ executionArn })))?.status;
    } catch {
      return undefined;
    }
  }

  /**
   * The execution ARN for a name under this machine.
   *
   * `arn:<partition>:states:<region>:<account>:stateMachine:<Machine>` becomes
   * `arn:<partition>:states:<region>:<account>:execution:<Machine>:<name>`. Only
   * the resource segment changes, so this holds in every partition. Anything not
   * shaped like an unqualified state-machine ARN returns undefined rather than a
   * guess — a wrong ARN would answer `ExecutionDoesNotExist`, which we would then
   * have to interpret, and interpreting a guess is how this class of bug starts.
   */
  private executionArn(name: string): string | undefined {
    const parts = this.cfg.stateMachineArn.split(":");
    if (parts.length !== 7 || parts[5] !== "stateMachine") return undefined;
    return [...parts.slice(0, 5), "execution", parts[6], name].join(":");
  }
}
