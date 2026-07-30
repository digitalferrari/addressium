/**
 * SfnDripStarter at the CLIENT level, plus the wiring guards (#245).
 *
 * The drip feature was unreachable for a reason worth stating: every layer of it
 * had passing unit tests. The state machine had a CDK assertion, the step handler
 * had a domain test, `isEnrolledBySignup` had a domain test — and nothing
 * anywhere called `StartExecution`. Tests on pure functions are precisely what
 * hid it.
 *
 * So these assertions are made where the bug was. The command the SDK would
 * actually put on the wire is inspected field by field, and the last two tests
 * read the API service and the CDK stack as SOURCE and assert the call sites
 * exist at all — the genre of test (see route-parity.test.ts, dev-server.test.ts)
 * that would have failed on the commit this issue was filed against.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { SfnDripStarter } from "@addressium/adapters-aws";
import { dripExecutionName, type DripEnrollment } from "@addressium/domain";

const ARN = "arn:aws:states:us-east-1:111122223333:stateMachine:test-stack-DripStateMachine";

/**
 * Records the command names + inputs sent to a client, and can be told to throw
 * for one of them. A plain object rather than a real SFNClient: StartExecution
 * needs no presigner or middleware, so nothing is being bypassed.
 */
function fakeSfn(behavior: Record<string, () => unknown> = {}) {
  const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
  return {
    calls,
    send: async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
      const name = cmd.constructor.name;
      calls.push({ name, input: cmd.input });
      const b = behavior[name];
      if (b) return b();
      return {};
    },
  };
}

const enrollment: DripEnrollment = {
  orgId: "summit",
  sequenceId: "welcome",
  subscriberId: "9f1c1a3e-0000-4000-8000-0123456789ab",
  nextStepIndex: 0,
  nextWaitSeconds: 259_200,
  enrollmentId: "2027-03-01T09:00:00.000Z",
};

test("starting an enrollment sends StartExecution with the machine's exact input", async () => {
  const client = fakeSfn();
  await new SfnDripStarter({ stateMachineArn: ARN }, client as never).start(enrollment);

  assert.deepEqual(client.calls.map((c) => c.name), ["StartExecutionCommand"]);
  const input = client.calls[0]!.input;
  assert.equal(input.stateMachineArn, ARN);

  // Field for field, because the machine reads each one by JSONPath and a
  // JSONPath onto a field the starter omits is a States.Runtime failure at the
  // first transition — visible only as a failed execution, hours or days later.
  // `nextStepIndex: 0` and step 0's own `nextWaitSeconds` are what make the
  // machine's start-at-the-Wait shape (#201) behave: "three days after signup"
  // arrives three days later.
  assert.deepEqual(JSON.parse(input.input as string), {
    orgId: "summit",
    sequenceId: "welcome",
    subscriberId: "9f1c1a3e-0000-4000-8000-0123456789ab",
    nextStepIndex: 0,
    nextWaitSeconds: 259_200,
    enrollmentId: "2027-03-01T09:00:00.000Z",
  });

  // The name is the deduplication, so it is asserted here as a literal and not
  // merely as "some string": a name that quietly became random would pass every
  // other test in this file and enroll a double-clicking subscriber twice.
  assert.equal(input.name, "drip.summit.welcome.2db6ca9a22c96055ddb232939f1849d5");
  assert.equal(input.name, dripExecutionName(enrollment), "the adapter must not derive its own");
  assert.match(input.name as string, /^[0-9a-zA-Z._-]{1,80}$/, "80 chars, restricted charset");
});

/** What Step Functions answers for a name it is already holding. */
const alreadyExists = () => {
  throw Object.assign(new Error("Execution Already Exists: 'drip.summit.welcome.2db6'"), {
    name: "ExecutionAlreadyExists",
  });
};
const startsOf = (client: ReturnType<typeof fakeSfn>) =>
  client.calls.filter((c) => c.name === "StartExecutionCommand");

test("ExecutionAlreadyExists is success — the subscriber clicked twice", async () => {
  // Step Functions refuses a reused name for a running execution with a different
  // input, and for ANY name reused within the 90-day retention of closed ones.
  // A RUNNING execution means the enrollment is working, so throwing would turn a
  // successful double opt-in into an error on the landing page.
  const client = fakeSfn({
    StartExecutionCommand: alreadyExists,
    DescribeExecutionCommand: () => ({ status: "RUNNING" }),
  });
  const starter = new SfnDripStarter({ stateMachineArn: ARN }, client as never);
  await starter.start(enrollment);
  await starter.start(enrollment);
  assert.equal(startsOf(client).length, 2, "it really did call StartExecution both times");

  // A sequence that already ran to the end is the same answer: it happened.
  const finished = fakeSfn({
    StartExecutionCommand: alreadyExists,
    DescribeExecutionCommand: () => ({ status: "SUCCEEDED" }),
  });
  await new SfnDripStarter({ stateMachineArn: ARN }, finished as never).start(enrollment);
});

test("a previous execution that FAILED is not reported as an enrollment", async () => {
  // The two meanings of ExecutionAlreadyExists are not the same fact. A closed
  // execution may have ended in failure — a step referencing a template that did
  // not exist, say — in which case that enrollment delivered NOTHING, and because
  // the name is retained for 90 days it cannot be started again. Swallowing it
  // reports success for mail nobody will ever receive, which is #245's failure
  // mode wearing this diff's clothes.
  for (const status of ["FAILED", "TIMED_OUT", "ABORTED"]) {
    const client = fakeSfn({
      StartExecutionCommand: alreadyExists,
      DescribeExecutionCommand: () => ({ status }),
    });
    await assert.rejects(
      new SfnDripStarter({ stateMachineArn: ARN }, client as never).start(enrollment),
      new RegExp(`already ran and ended ${status}`),
      `${status} must not be reported as enrolled`,
    );
    // And it asked about THIS machine's execution, by the name it just tried.
    const describe = client.calls.find((c) => c.name === "DescribeExecutionCommand");
    assert.equal(
      describe?.input.executionArn,
      "arn:aws:states:us-east-1:111122223333:execution:" +
        "test-stack-DripStateMachine:drip.summit.welcome.2db6ca9a22c96055ddb232939f1849d5",
    );
  }
});

test("an unanswerable DescribeExecution degrades to the swallow", async () => {
  // The status read is best-effort by construction: a stage deployed before the
  // DescribeExecution grant existed, a throttle, or an ARN shape we declined to
  // guess. None of those is worth failing a confirmation that already succeeded,
  // so an unknown status keeps the old behaviour.
  const denied = fakeSfn({
    StartExecutionCommand: alreadyExists,
    DescribeExecutionCommand: () => {
      throw Object.assign(new Error("AccessDeniedException"), { name: "AccessDeniedException" });
    },
  });
  await new SfnDripStarter({ stateMachineArn: ARN }, denied as never).start(enrollment);

  // An ARN that is not an unqualified state-machine ARN is not guessed at all —
  // no DescribeExecution is attempted.
  const odd = fakeSfn({ StartExecutionCommand: alreadyExists });
  await new SfnDripStarter({ stateMachineArn: "not-an-arn" }, odd as never).start(enrollment);
  assert.deepEqual(odd.calls.map((c) => c.name), ["StartExecutionCommand"]);
});

test("every other failure propagates", async () => {
  // AccessDeniedException is the exact shape of a missing grantStartExecution,
  // and StateMachineDoesNotExist of a wrong ARN. Swallowing either would recreate
  // #245 with a green deploy: enrollment silently doing nothing, forever.
  for (const name of ["AccessDeniedException", "StateMachineDoesNotExist", "ThrottlingException"]) {
    const client = fakeSfn({
      StartExecutionCommand: () => {
        throw Object.assign(new Error(name), { name });
      },
    });
    await assert.rejects(
      new SfnDripStarter({ stateMachineArn: ARN }, client as never).start(enrollment),
      new RegExp(name),
      `${name} must not be swallowed`,
    );
  }
});

// ---------------------------------------------------------------------------
// The wiring itself. The only genre of test here that would have failed on HEAD.
// ---------------------------------------------------------------------------

function workspaceRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(resolve(dir, "infra/cdk/lib/control-plane-stack.ts"))) return dir;
    dir = resolve(dir, "..");
  }
  throw new Error("could not locate workspace root");
}
const ROOT = workspaceRoot();
const API = readFileSync(resolve(ROOT, "services/api/src/index.ts"), "utf8");
const STACK = readFileSync(resolve(ROOT, "infra/cdk/lib/control-plane-stack.ts"), "utf8");
const DEV = readFileSync(resolve(ROOT, "scripts/dev-server.mjs"), "utf8");

test("something in the product actually starts an execution (#245)", () => {
  // The absence this issue was: `StartExecution`, `SFNClient` and
  // `@aws-sdk/client-sfn` appeared nowhere in packages/ or services/, so the
  // state machine's only consumer was a CfnOutput.
  assert.match(
    readFileSync(resolve(ROOT, "packages/adapters-aws/src/sfn.ts"), "utf8"),
    /new StartExecutionCommand\(/,
    "the adapter no longer issues StartExecution",
  );
  assert.match(API, /new SfnDripStarter\(/, "the API constructs no drip starter");
  assert.match(API, /enrollOnConfirmation\(/, "the confirm path enrolls nobody");
  assert.match(API, /enrollManually\(/, "there is no manual enrollment path");
  // ...and the confirmation must be told the ARN lazily, never at module scope:
  // this file is one bundle for fifteen Lambdas, so a module-scope env() read
  // would take /unsubscribe down with it.
  assert.match(API, /_dripStarter \?\?= new SfnDripStarter/, "the starter is not memoized lazily");
});

test("enrollment cannot fail the confirmation it follows", () => {
  // The confirmation is already durable in DynamoDB by the time enrollment runs,
  // and `confirmHandler`'s catch-all turns anything thrown into a 400 — so an
  // unguarded starter call answers "missing env DRIP_STATE_MACHINE_ARN" on the
  // page that was supposed to say "you're subscribed", with no way to retry.
  const block = API.slice(API.indexOf("export async function enrollConfirmed"));
  assert.match(block.slice(0, 1200), /try \{[\s\S]*catch \(e\)[\s\S]*console\.error/, "the swallow is gone");
  assert.match(API, /await enrollConfirmed\(subs, injected\)/, "confirmHandler does not enroll");
});

test("the two functions that can start an execution both have the ARN and the grant", () => {
  // Asserted in the template test too, against the synthesized CloudFormation.
  // Here for the pairing: a function with the env var and no grant fails at
  // runtime with AccessDenied, and one with the grant and no var throws
  // `missing env` — both look configured from one side.
  for (const fn of ["confirmFn", "adminApiFn"]) {
    assert.ok(
      new RegExp(`DRIP_STATE_MACHINE_ARN`).test(STACK) &&
        new RegExp(`grantStartExecution\\(${fn}\\)`).test(STACK),
      `${fn} is missing its env var or its grant`,
    );
  }
  // The step function is the machine's TARGET. A step that can start executions
  // is a step that can start itself.
  assert.doesNotMatch(STACK, /grantStartExecution\(dripStepFn\)/);
  // And `npm run dev` must not answer `missing env` on confirm (#232, #238).
  assert.match(DEV, /DRIP_STATE_MACHINE_ARN \?\?=/, "the dev server cannot reach the starter");
});

test("the starter can read the status of the execution already holding a name", () => {
  // Without DescribeExecution the adapter cannot tell "already running" from "ran
  // and FAILED", and it defaults to the optimistic reading — reporting an
  // enrollment that delivered nothing, and that the 90-day name retention makes
  // unrepeatable. The grant is scoped to this machine's executions by
  // `grantExecution`, not to `states:*`.
  assert.match(
    readFileSync(resolve(ROOT, "packages/adapters-aws/src/sfn.ts"), "utf8"),
    /new DescribeExecutionCommand\(/,
    "the adapter cannot check what it collided with",
  );
  for (const fn of ["confirmFn", "adminApiFn"]) {
    assert.match(
      STACK,
      new RegExp(`grantExecution\\(${fn}, "states:DescribeExecution"\\)`),
      `${fn} would get AccessDenied asking about the execution it collided with`,
    );
  }
});

test("a swallowed enrollment failure is still visible from outside the logs", () => {
  // Enrollment on the confirm path is best-effort ON PURPOSE, and the cost of that
  // decision is that a broken deploy — a lost grant, a missing ARN — returns 200 to
  // every subscriber while sending no drip mail at all. `console.error` does not
  // move the Lambda Errors metric the ConfirmErrorsAlarm watches, so without a
  // metric filter over the log line this reproduces #245 behind a green dashboard.
  //
  // The literal is shared between the producer and the filter, so it is asserted on
  // both sides: a reworded log message with no matching filter change is a silently
  // dead alarm.
  const LINE = "confirm: drip enrollment failed";
  assert.ok(API.includes(`console.error("${LINE}"`), "the log line moved without its filter");
  assert.ok(STACK.includes(`FilterPattern.literal('"${LINE}"')`), "the filter no longer matches the log line");
  assert.match(STACK, /new MetricFilter\(this, "ConfirmDripEnrollFailureFilter"/);
  assert.match(STACK, /alarm\("ConfirmDripEnrollFailureAlarm"/, "the metric has no alarm on it");
});
