/**
 * DynamoDB implementation of the domain Stores (single-table, orgId-scoped).
 *
 * Every item is `{ pk, sk, gsi1pk?, gsi1sk?, data }` where `data` is the domain
 * entity. Keys are prefixed with the org so silos never intermix
 * (docs/ARCHITECTURE.md §4.11, §5). Pagination is elided in this slice (TODO).
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  type QueryCommandInput,
} from "@aws-sdk/lib-dynamodb";
import type {
  AlertConfig,
  Campaign,
  CampaignSeries,
  DripSequence,
  EmailArchive,
  EngagementEvent,
  EntitlementSync,
  List,
  Organization,
  Segment,
  SendScheduleState,
  Subscriber,
  Subscription,
  SuppressionEntry,
  UsageRecord,
} from "@addressium/core";
import type {
  AlertConfigStore,
  ArchiveStore,
  CampaignSeriesStore,
  CampaignStore,
  DripSequenceStore,
  EntitlementStore,
  EventStore,
  ListStore,
  OrganizationStore,
  SegmentStore,
  SendClaimStore,
  SendScheduleStore,
  Stores,
  SubscriberStore,
  SubscriptionStore,
  SuppressionStore,
  UsageStore,
} from "@addressium/domain";
import { randomUUID } from "node:crypto";

const org = (o: string) => `ORG#${o}`;

interface Item<T> {
  pk: string;
  sk: string;
  gsi1pk?: string;
  gsi1sk?: string;
  gsi2pk?: string;
  gsi2sk?: string;
  /** Denormalized top-level attribute for filtering/indexing (e.g. subscription status). */
  status?: string;
  data: T;
}

export class DynamoStores implements Stores {
  private readonly doc: DynamoDBDocumentClient;

  constructor(
    private readonly tableName: string,
    client?: DynamoDBClient,
  ) {
    this.doc = DynamoDBDocumentClient.from(client ?? new DynamoDBClient({}), {
      // Optional entity fields (consent, entitlementAsof, …) may be undefined.
      marshallOptions: { removeUndefinedValues: true },
    });
  }

  private async put(item: Item<unknown>): Promise<void> {
    await this.doc.send(new PutCommand({ TableName: this.tableName, Item: item }));
  }

  private async get<T>(pk: string, sk: string): Promise<T | undefined> {
    const res = await this.doc.send(
      new GetCommand({ TableName: this.tableName, Key: { pk, sk } }),
    );
    return (res.Item as Item<T> | undefined)?.data;
  }

  /** Query following LastEvaluatedKey so large result sets aren't truncated. */
  private async queryAll<T>(params: QueryCommandInput): Promise<T[]> {
    const items: T[] = [];
    let ExclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const res = await this.doc.send(new QueryCommand({ ...params, ExclusiveStartKey }));
      for (const it of res.Items ?? []) items.push((it as Item<T>).data);
      ExclusiveStartKey = res.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (ExclusiveStartKey);
    return items;
  }

  organizations: OrganizationStore = {
    get: (orgId) => this.get<Organization>(org(orgId), "#META"),
    put: (o) =>
      this.put({
        pk: org(o.orgId),
        sk: "#META",
        gsi1pk: "ORGS", // list all orgs via gsi1
        gsi1sk: o.orgId,
        data: o,
      }),
    list: () =>
      this.queryAll<Organization>({
        TableName: this.tableName,
        IndexName: "gsi1",
        KeyConditionExpression: "gsi1pk = :p",
        ExpressionAttributeValues: { ":p": "ORGS" },
      }),
  };

  subscribers: SubscriberStore = {
    get: (orgId, sub) => this.get<Subscriber>(org(orgId), `SUBSCRIBER#${sub}`),
    findByEmail: async (orgId, email) => {
      const res = await this.doc.send(
        new QueryCommand({
          TableName: this.tableName,
          IndexName: "gsi1",
          KeyConditionExpression: "gsi1pk = :p AND gsi1sk = :e",
          ExpressionAttributeValues: {
            ":p": `${org(orgId)}#EMAIL`,
            ":e": email.toLowerCase(),
          },
          Limit: 1,
        }),
      );
      const item = res.Items?.[0] as Item<Subscriber> | undefined;
      return item?.data;
    },
    // externalId (Cognito sub) is stable, so a small pointer item resolves it in
    // one extra get — no new GSI. Written by put() whenever externalId is set.
    findByExternalId: async (orgId, externalId) => {
      const ptr = await this.get<{ sub: string }>(`${org(orgId)}#EXTID`, `EXTID#${externalId}`);
      if (!ptr) return undefined;
      return this.get<Subscriber>(org(orgId), `SUBSCRIBER#${ptr.sub}`);
    },
    put: async (s) => {
      await this.put({
        pk: org(s.orgId),
        sk: `SUBSCRIBER#${s.sub}`,
        gsi1pk: `${org(s.orgId)}#EMAIL`,
        gsi1sk: s.email.toLowerCase(),
        data: s,
      });
      if (s.externalId) {
        await this.put({ pk: `${org(s.orgId)}#EXTID`, sk: `EXTID#${s.externalId}`, data: { sub: s.sub } });
      }
    },
    // Subscriber items share the org partition; range over the SUBSCRIBER# sort
    // prefix so #META / LIST# / SEGMENT# siblings are excluded. Paginated.
    list: (orgId) =>
      this.queryAll<Subscriber>({
        TableName: this.tableName,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :s)",
        ExpressionAttributeValues: { ":pk": org(orgId), ":s": "SUBSCRIBER#" },
      }),
    // O(1) monotonic bump of a nested attribute — only advances, never rewinds,
    // and the attribute_exists guard makes an unknown subscriber a silent no-op.
    markEngaged: async (orgId, sub, at) => {
      try {
        await this.doc.send(
          new UpdateCommand({
            TableName: this.tableName,
            Key: { pk: org(orgId), sk: `SUBSCRIBER#${sub}` },
            UpdateExpression: "SET #d.#l = :at",
            ConditionExpression:
              "attribute_exists(pk) AND (attribute_not_exists(#d.#l) OR #d.#l < :at)",
            ExpressionAttributeNames: { "#d": "data", "#l": "lastEngagedAt" },
            ExpressionAttributeValues: { ":at": at },
          }),
        );
      } catch (e) {
        // ConditionalCheckFailed = unknown subscriber or a newer stamp already
        // present; both are expected and safe to ignore.
        if ((e as { name?: string }).name !== "ConditionalCheckFailedException") throw e;
      }
    },
  };

  subscriptions: SubscriptionStore = {
    get: (orgId, sub, listId) =>
      this.get<Subscription>(`${org(orgId)}#LIST#${listId}`, `SUBSCRIPTION#${sub}`),
    put: (s) =>
      this.put({
        pk: `${org(s.orgId)}#LIST#${s.listId}`,
        sk: `SUBSCRIPTION#${s.subscriberId}`,
        gsi2pk: `${org(s.orgId)}#SUB#${s.subscriberId}`,
        gsi2sk: `LIST#${s.listId}`,
        status: s.status, // denormalized for the confirmed filter
        data: s,
      }),
    listConfirmed: (orgId, listId) =>
      this.queryAll<Subscription>({
        TableName: this.tableName,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :s)",
        FilterExpression: "#st = :c",
        ExpressionAttributeNames: { "#st": "status" },
        ExpressionAttributeValues: {
          ":pk": `${org(orgId)}#LIST#${listId}`,
          ":s": "SUBSCRIPTION#",
          ":c": "confirmed",
        },
      }),
    listBySubscriber: (orgId, subscriberId) =>
      this.queryAll<Subscription>({
        TableName: this.tableName,
        IndexName: "gsi2",
        KeyConditionExpression: "gsi2pk = :p",
        ExpressionAttributeValues: { ":p": `${org(orgId)}#SUB#${subscriberId}` },
      }),
  };

  lists: ListStore = {
    get: (orgId, listId) => this.get<List>(org(orgId), `LIST#${listId}`),
    put: (l) => this.put({ pk: org(l.orgId), sk: `LIST#${l.listId}`, data: l }),
    list: (orgId) =>
      this.queryAll<List>({
        TableName: this.tableName,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :s)",
        ExpressionAttributeValues: { ":pk": org(orgId), ":s": "LIST#" },
      }),
  };

  segments: SegmentStore = {
    get: (orgId, segmentId) => this.get<Segment>(org(orgId), `SEGMENT#${segmentId}`),
    put: (s) => this.put({ pk: org(s.orgId), sk: `SEGMENT#${s.segmentId}`, data: s }),
    list: (orgId) =>
      this.queryAll<Segment>({
        TableName: this.tableName,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :s)",
        ExpressionAttributeValues: { ":pk": org(orgId), ":s": "SEGMENT#" },
      }),
  };

  suppression: SuppressionStore = {
    isSuppressed: async (orgId, email) => {
      const e = email.toLowerCase();
      const [orgHit, globalHit] = await Promise.all([
        this.get<SuppressionEntry>(`${org(orgId)}#SUPPRESSION`, `EMAIL#${e}`),
        this.get<SuppressionEntry>("GLOBAL#SUPPRESSION", `EMAIL#${e}`),
      ]);
      return orgHit !== undefined || globalHit !== undefined;
    },
    add: (e) =>
      this.put({
        // Global entries (bounces/complaints) live in a cross-org partition (§4.13).
        pk: e.scope === "global" ? "GLOBAL#SUPPRESSION" : `${org(e.orgId)}#SUPPRESSION`,
        sk: `EMAIL#${e.email.toLowerCase()}`,
        data: e,
      }),
    entriesFor: async (orgId, email) => {
      const e = email.toLowerCase();
      const [orgHit, globalHit] = await Promise.all([
        this.get<SuppressionEntry>(`${org(orgId)}#SUPPRESSION`, `EMAIL#${e}`),
        this.get<SuppressionEntry>("GLOBAL#SUPPRESSION", `EMAIL#${e}`),
      ]);
      return [orgHit, globalHit].filter((x): x is SuppressionEntry => x !== undefined);
    },
    remove: async (orgId, email, scope) => {
      await this.doc.send(
        new DeleteCommand({
          TableName: this.tableName,
          Key: {
            pk: scope === "global" ? "GLOBAL#SUPPRESSION" : `${org(orgId)}#SUPPRESSION`,
            sk: `EMAIL#${email.toLowerCase()}`,
          },
        }),
      );
    },
  };

  archive: ArchiveStore = {
    get: (orgId, campaignId) =>
      this.get<EmailArchive>(`${org(orgId)}#CAMPAIGN#${campaignId}`, "ARCHIVE"),
    put: (a) =>
      this.put({ pk: `${org(a.orgId)}#CAMPAIGN#${a.campaignId}`, sk: "ARCHIVE", data: a }),
  };

  events: EventStore = {
    append: (e) =>
      this.put({
        pk: `${org(e.orgId)}#CAMPAIGN#${e.campaignId}`,
        sk: `EVENT#${e.at}#${randomUUID()}`,
        data: e,
      }),
    all: (orgId, campaignId) =>
      this.queryAll<EngagementEvent>({
        TableName: this.tableName,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :s)",
        ExpressionAttributeValues: {
          ":pk": `${org(orgId)}#CAMPAIGN#${campaignId}`,
          ":s": "EVENT#",
        },
      }),
  };

  entitlements: EntitlementStore = {
    put: (e) =>
      this.put({ pk: org(e.orgId), sk: `ENTITLEMENT#${e.subscriberId}`, data: e }),
    latest: (orgId, subscriberId) =>
      this.get<EntitlementSync>(org(orgId), `ENTITLEMENT#${subscriberId}`),
  };

  campaigns: CampaignStore = {
    get: (orgId, campaignId) =>
      this.get<Campaign>(org(orgId), `CAMPAIGNREC#${campaignId}`),
    put: (c) => this.put({ pk: org(c.orgId), sk: `CAMPAIGNREC#${c.campaignId}`, data: c }),
  };

  series: CampaignSeriesStore = {
    get: (orgId, seriesId) => this.get<CampaignSeries>(org(orgId), `SERIES#${seriesId}`),
    put: (s) => this.put({ pk: org(s.orgId), sk: `SERIES#${s.seriesId}`, data: s }),
  };

  schedules: SendScheduleStore = {
    get: (orgId, scheduleId) =>
      this.get<SendScheduleState>(org(orgId), `SCHEDULE#${scheduleId}`),
    put: (s) => this.put({ pk: org(s.orgId), sk: `SCHEDULE#${s.scheduleId}`, data: s }),
    list: (orgId) =>
      this.queryAll<SendScheduleState>({
        TableName: this.tableName,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :s)",
        ExpressionAttributeValues: { ":pk": org(orgId), ":s": "SCHEDULE#" },
      }),
  };

  alerts: AlertConfigStore = {
    get: (orgId) => this.get<AlertConfig>(org(orgId), "#ALERTS"),
    put: (c) => this.put({ pk: org(c.orgId), sk: "#ALERTS", data: c }),
  };

  dripSequences: DripSequenceStore = {
    get: (orgId, sequenceId) => this.get<DripSequence>(org(orgId), `DRIP#${sequenceId}`),
    put: (s) => this.put({ pk: org(s.orgId), sk: `DRIP#${s.sequenceId}`, data: s }),
    list: (orgId) =>
      this.queryAll<DripSequence>({
        TableName: this.tableName,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :s)",
        ExpressionAttributeValues: { ":pk": org(orgId), ":s": "DRIP#" },
      }),
  };

  usage: UsageStore = {
    get: (orgId, period) => this.get<UsageRecord>(org(orgId), `USAGE#${period}`),
    put: (r) => this.put({ pk: org(r.orgId), sk: `USAGE#${r.period}`, data: r }),
    listByOrg: (orgId) =>
      this.queryAll<UsageRecord>({
        TableName: this.tableName,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :s)",
        ExpressionAttributeValues: { ":pk": org(orgId), ":s": "USAGE#" },
      }),
  };

  sendClaims: SendClaimStore = {
    claim: async (orgId, campaignId) => {
      try {
        await this.doc.send(
          new PutCommand({
            TableName: this.tableName,
            Item: { pk: `${org(orgId)}#CAMPAIGN#${campaignId}`, sk: "SENDCLAIM", data: { claimed: true } },
            ConditionExpression: "attribute_not_exists(pk)",
          }),
        );
        return true;
      } catch (e) {
        if ((e as { name?: string }).name === "ConditionalCheckFailedException") return false;
        throw e;
      }
    },
  };
}
