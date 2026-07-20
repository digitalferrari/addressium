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
  GetCommand,
  PutCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import type {
  EmailArchive,
  EngagementEvent,
  EntitlementSync,
  List,
  Organization,
  Subscriber,
  Subscription,
  SuppressionEntry,
} from "@addressium/core";
import type {
  ArchiveStore,
  EntitlementStore,
  EventStore,
  ListStore,
  OrganizationStore,
  Stores,
  SubscriberStore,
  SubscriptionStore,
  SuppressionStore,
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
    list: async () => {
      const res = await this.doc.send(
        new QueryCommand({
          TableName: this.tableName,
          IndexName: "gsi1",
          KeyConditionExpression: "gsi1pk = :p",
          ExpressionAttributeValues: { ":p": "ORGS" },
        }),
      );
      return (res.Items ?? []).map((i) => (i as Item<Organization>).data);
    },
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
    put: (s) =>
      this.put({
        pk: org(s.orgId),
        sk: `SUBSCRIBER#${s.sub}`,
        gsi1pk: `${org(s.orgId)}#EMAIL`,
        gsi1sk: s.email.toLowerCase(),
        data: s,
      }),
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
    listConfirmed: async (orgId, listId) => {
      const res = await this.doc.send(
        new QueryCommand({
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
      );
      return (res.Items ?? []).map((i) => (i as Item<Subscription>).data);
    },
    listBySubscriber: async (orgId, subscriberId) => {
      const res = await this.doc.send(
        new QueryCommand({
          TableName: this.tableName,
          IndexName: "gsi2",
          KeyConditionExpression: "gsi2pk = :p",
          ExpressionAttributeValues: { ":p": `${org(orgId)}#SUB#${subscriberId}` },
        }),
      );
      return (res.Items ?? []).map((i) => (i as Item<Subscription>).data);
    },
  };

  lists: ListStore = {
    get: (orgId, listId) => this.get<List>(org(orgId), `LIST#${listId}`),
    put: (l) => this.put({ pk: org(l.orgId), sk: `LIST#${l.listId}`, data: l }),
  };

  suppression: SuppressionStore = {
    isSuppressed: async (orgId, email) => {
      const hit = await this.get<SuppressionEntry>(
        `${org(orgId)}#SUPPRESSION`,
        `EMAIL#${email.toLowerCase()}`,
      );
      return hit !== undefined;
    },
    add: (e) =>
      this.put({
        pk: `${org(e.orgId)}#SUPPRESSION`,
        sk: `EMAIL#${e.email.toLowerCase()}`,
        data: e,
      }),
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
    all: async (orgId, campaignId) => {
      const res = await this.doc.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: "pk = :pk AND begins_with(sk, :s)",
          ExpressionAttributeValues: {
            ":pk": `${org(orgId)}#CAMPAIGN#${campaignId}`,
            ":s": "EVENT#",
          },
        }),
      );
      return (res.Items ?? []).map((i) => (i as Item<EngagementEvent>).data);
    },
  };

  entitlements: EntitlementStore = {
    put: (e) =>
      this.put({ pk: org(e.orgId), sk: `ENTITLEMENT#${e.subscriberId}`, data: e }),
    latest: (orgId, subscriberId) =>
      this.get<EntitlementSync>(org(orgId), `ENTITLEMENT#${subscriberId}`),
  };
}
