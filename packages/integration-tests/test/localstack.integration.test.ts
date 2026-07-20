/**
 * LocalStack integration (#19): exercises the SES-adjacent AWS adapters —
 * SQS enqueue, KMS asymmetric sign (magic-link mint), and EventBridge Scheduler
 * create/cancel — against emulated AWS, so the SQS/KMS/Scheduler adapters are
 * covered end-to-end (DynamoDB is already covered by dynalite).
 *
 * Requires a running LocalStack. Start it with `docker compose -f
 * docker-compose.localstack.yml up -d` (or set LOCALSTACK_ENDPOINT). When
 * LocalStack isn't reachable the whole suite SKIPS rather than fails, so `npm
 * test` stays green in environments without Docker.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { SQSClient, CreateQueueCommand, ReceiveMessageCommand, GetQueueAttributesCommand } from "@aws-sdk/client-sqs";
import { KMSClient, CreateKeyCommand, GetPublicKeyCommand } from "@aws-sdk/client-kms";
import { SchedulerClient, CreateScheduleGroupCommand } from "@aws-sdk/client-scheduler";
import { jwtVerify, createLocalJWKSet, type JSONWebKeySet } from "jose";
import {
  SqsSendQueue,
  KmsMagicLinkSigner,
  EventBridgeScheduler,
  spkiDerToJwk,
} from "@addressium/adapters-aws";
import { SystemClock, type SendDescriptor } from "@addressium/domain";

const ENDPOINT =
  process.env.LOCALSTACK_ENDPOINT ?? process.env.AWS_ENDPOINT_URL ?? "http://localhost:4566";
const REGION = process.env.AWS_REGION ?? "us-east-1";
const credentials = { accessKeyId: "test", secretAccessKey: "test" };
const clientConfig = { endpoint: ENDPOINT, region: REGION, credentials };

async function localstackUp(): Promise<boolean> {
  try {
    const res = await fetch(`${ENDPOINT}/_localstack/health`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

const up = await localstackUp();
if (!up) {
  test("LocalStack integration (skipped — LocalStack not reachable)", { skip: true }, () => {});
}

const descriptor: SendDescriptor = {
  orgId: "summit",
  campaignId: "c1",
  listId: "ledger",
  subject: "Hello",
  template: { blocks: [{ kind: "text", html: "hi" }] },
};

test("SQS adapter enqueues a send descriptor onto a real queue", { skip: !up }, async () => {
  const sqs = new SQSClient(clientConfig);
  const { QueueUrl } = await sqs.send(new CreateQueueCommand({ QueueName: "addressium-send-test" }));
  assert.ok(QueueUrl);

  await new SqsSendQueue(QueueUrl!, sqs).enqueue(descriptor);
  const received = await sqs.send(
    new ReceiveMessageCommand({ QueueUrl, WaitTimeSeconds: 1, MaxNumberOfMessages: 1 }),
  );
  const body = received.Messages?.[0]?.Body;
  assert.ok(body);
  assert.equal((JSON.parse(body!) as SendDescriptor).campaignId, "c1");
});

test("KMS adapter mints a magic-link token verifiable against the derived JWK", { skip: !up }, async () => {
  const kms = new KMSClient(clientConfig);
  const created = await kms.send(
    new CreateKeyCommand({ KeySpec: "ECC_NIST_P256", KeyUsage: "SIGN_VERIFY" }),
  );
  const keyId = created.KeyMetadata?.KeyId;
  assert.ok(keyId);

  const signer = new KmsMagicLinkSigner(
    { keyId: keyId!, kid: "kms-1", issuer: "iss", audience: "aud", ttlSeconds: 3600 },
    new SystemClock(),
    kms,
  );
  const token = await signer.mint({ orgId: "summit", sub: "s1", entitlement: "paid" });

  const pub = await kms.send(new GetPublicKeyCommand({ KeyId: keyId }));
  const jwk = spkiDerToJwk(pub.PublicKey!, "kms-1");
  const jwks: JSONWebKeySet = { keys: [jwk as unknown as JSONWebKeySet["keys"][number]] };
  const { payload } = await jwtVerify(token, createLocalJWKSet(jwks), {
    algorithms: ["ES256"],
    issuer: "iss",
    audience: "aud",
  });
  assert.equal(payload.sub, "s1");
  assert.equal(payload.entitlement, "paid");
  assert.deepEqual(payload.amr, ["magic_link"]); // lite scope only
});

test("EventBridge Scheduler adapter creates and cancels a one-off schedule", { skip: !up }, async () => {
  const scheduler = new SchedulerClient(clientConfig);
  const sqs = new SQSClient(clientConfig);
  const groupName = "addressium-test";
  await scheduler.send(new CreateScheduleGroupCommand({ Name: groupName })).catch((e: { name?: string }) => {
    if (e.name !== "ConflictException") throw e;
  });
  const { QueueUrl } = await sqs.send(new CreateQueueCommand({ QueueName: "addressium-sched-test" }));
  const attrs = await sqs.send(
    new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ["QueueArn"] }),
  );
  const queueArn = attrs.Attributes?.QueueArn;
  assert.ok(queueArn);

  const eb = new EventBridgeScheduler(
    {
      roleArn: "arn:aws:iam::000000000000:role/addressium-scheduler",
      groupName,
      queueArn: queueArn!,
      launchArn: "arn:aws:lambda:us-east-1:000000000000:function:launch",
    },
    scheduler,
  );
  const name = "one-off-c1";
  // create + cancel should both succeed without throwing.
  await eb.scheduleOneOff({ name, at: new Date(Date.now() + 10 * 60_000), descriptor });
  await eb.cancel(name);
});
