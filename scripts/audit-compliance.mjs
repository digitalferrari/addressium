#!/usr/bin/env node
/**
 * Read-only audit for the two defects fixed in this session that code CANNOT
 * fix retroactively (#293).
 *
 *   AWS_REGION=us-east-1 ADDRESSIUM_TABLE=addressium-dev-Table... \
 *     node scripts/audit-compliance.mjs
 *
 * NOT as `AWS_PROFILE=addressium-deploy`. The table is encrypted with a
 * customer-managed KMS key and the deploy role has no `kms:Decrypt` — correct
 * least privilege (a deploy identity has no business reading subscriber rows),
 * but it means this needs an identity that can. Run it as one that can decrypt
 * the table key, and prefer a read-only one.
 *
 * 1. ERASURE GAPS. `deleteForSubscriber` used to walk only `CAMPAIGNREC#` rows,
 *    so events under drip, re-engagement and pre-record edition ids survived a
 *    subject's erasure request. Any erasure processed BEFORE that fix may have
 *    left data behind. This finds send ids holding events whose campaign record
 *    does not exist and which carry no `SENDID#` marker — the rows the old
 *    erasure could not reach.
 *
 * 2. RESURRECTED UNSUBSCRIBES. An import used to overwrite an `unsubscribed`
 *    row back to `pending`/`confirmed`, so someone who opted out resumed
 *    receiving mail. This finds subscriptions that are currently mailable while
 *    carrying import provenance, whose subscriber is ALSO on the suppression
 *    list — the signature of an unsubscribe that was overwritten.
 *
 * WRITES NOTHING. It prints what to look at; acting on it is a human decision,
 * because re-suppressing an address that was legitimately re-opted-in would be
 * its own defect.
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";

const TABLE = process.env.ADDRESSIUM_TABLE;
if (!TABLE) {
  console.error("set ADDRESSIUM_TABLE (find it with: aws dynamodb list-tables)");
  process.exit(1);
}
const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION ?? "us-east-1" }));

async function scanAll(params) {
  const items = [];
  let ExclusiveStartKey;
  do {
    const res = await doc.send(new ScanCommand({ ...params, ExclusiveStartKey }));
    items.push(...(res.Items ?? []));
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

async function queryAll(params) {
  const items = [];
  let ExclusiveStartKey;
  do {
    const res = await doc.send(new QueryCommand({ ...params, ExclusiveStartKey }));
    items.push(...(res.Items ?? []));
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

console.log(`auditing ${TABLE}\n`);

// ---- 1. erasure reachability ------------------------------------------------
// Every campaign partition that holds events, and whether anything can find it.
const eventPartitions = new Map(); // campaignPk -> count
for (const it of await scanAll({
  TableName: TABLE,
  FilterExpression: "begins_with(sk, :e)",
  ExpressionAttributeValues: { ":e": "EVENT#" },
  ProjectionExpression: "pk",
})) {
  eventPartitions.set(it.pk, (eventPartitions.get(it.pk) ?? 0) + 1);
}

const orgs = new Set([...eventPartitions.keys()].map((pk) => pk.split("#CAMPAIGN#")[0]));
const reachable = new Set();
for (const orgPk of orgs) {
  for (const r of await queryAll({
    TableName: TABLE,
    KeyConditionExpression: "pk = :p AND begins_with(sk, :s)",
    ExpressionAttributeValues: { ":p": orgPk, ":s": "CAMPAIGNREC#" },
    ProjectionExpression: "sk",
  })) reachable.add(`${orgPk}#CAMPAIGN#${r.sk.slice("CAMPAIGNREC#".length)}`);
  for (const r of await queryAll({
    TableName: TABLE,
    KeyConditionExpression: "pk = :p AND begins_with(sk, :s)",
    ExpressionAttributeValues: { ":p": orgPk, ":s": "SENDID#" },
    ProjectionExpression: "sk",
  })) reachable.add(`${orgPk}#CAMPAIGN#${r.sk.slice("SENDID#".length)}`);
}

const unreachable = [...eventPartitions].filter(([pk]) => !reachable.has(pk));
console.log("== 1. events an erasure request could not reach ==");
if (unreachable.length === 0) {
  console.log("   none — every send id holding events is listed or marked\n");
} else {
  console.log(`   ${unreachable.length} send id(s), ${unreachable.reduce((n, [, c]) => n + c, 0)} events:`);
  for (const [pk, count] of unreachable) console.log(`   ${pk}  (${count} events)`);
  console.log("   These predate the SENDID# index. If an erasure was processed for");
  console.log("   any subscriber in this org, re-run it — the fix is not retroactive.\n");
}

// ---- 2. resurrected unsubscribes -------------------------------------------
const suppressed = new Map(); // orgPk -> Set(email)
for (const it of await scanAll({
  TableName: TABLE,
  FilterExpression: "begins_with(sk, :s)",
  ExpressionAttributeValues: { ":s": "SUPPRESSION#" },
  ProjectionExpression: "pk, sk",
})) {
  const set = suppressed.get(it.pk) ?? new Set();
  set.add(it.sk.slice("SUPPRESSION#".length).toLowerCase());
  suppressed.set(it.pk, set);
}

const subscribers = new Map(); // "<orgPk>|<sub>" -> email
for (const it of await scanAll({
  TableName: TABLE,
  FilterExpression: "begins_with(sk, :s)",
  ExpressionAttributeValues: { ":s": "SUBSCRIBER#" },
  ProjectionExpression: "pk, sk, #d.email",
  ExpressionAttributeNames: { "#d": "data" },
})) {
  if (it.data?.email) subscribers.set(`${it.pk}|${it.sk.slice("SUBSCRIBER#".length)}`, it.data.email.toLowerCase());
}

const suspects = [];
for (const it of await scanAll({
  TableName: TABLE,
  FilterExpression: "begins_with(sk, :s)",
  ExpressionAttributeValues: { ":s": "SUBSCRIPTION#" },
  ProjectionExpression: "pk, sk, #d",
  ExpressionAttributeNames: { "#d": "data" },
})) {
  const s = it.data;
  if (!s || s.status === "unsubscribed") continue;
  const orgPk = String(it.pk).split("#LIST#")[0];
  const email = subscribers.get(`${orgPk}|${s.subscriberId}`);
  if (!email) continue;
  // Currently mailable, but the address is suppressed: the signature of an
  // unsubscribe that a later write overwrote.
  if (suppressed.get(orgPk)?.has(email)) {
    suspects.push({ org: orgPk, email, list: s.listId, status: s.status, source: s.consent?.importBatchId ? "import" : "unknown" });
  }
}

console.log("== 2. mailable subscriptions whose address is suppressed ==");
if (suspects.length === 0) {
  console.log("   none — no unsubscribe appears to have been overwritten\n");
} else {
  console.log(`   ${suspects.length} subscription(s):`);
  for (const s of suspects) console.log(`   ${s.org}  ${s.email}  list=${s.list}  status=${s.status}  via=${s.source}`);
  console.log("\n   Each of these is someone the suppression list says opted out while");
  console.log("   their subscription says they are mailable. Review before the next send.");
}
