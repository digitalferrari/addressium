/**
 * DynamoDB implementation of the domain Stores (single-table, orgId-scoped).
 *
 * Every item is `{ pk, sk, gsi1pk?, gsi1sk?, data }` where `data` is the domain
 * entity. Keys are prefixed with the org so silos never intermix
 * (docs/ARCHITECTURE.md §4.11, §5). Unbounded reads go through `queryAll`, which
 * follows `LastEvaluatedKey` so large result sets aren't truncated at the ~1MB
 * single-page cap (see the pagination integration test, #97).
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  type QueryCommandInput,
} from "@aws-sdk/lib-dynamodb";
import { TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import { VERSION_ITEM } from "@addressium/core";
import type {
  AlertConfig,
  HotCounters,
  Campaign,
  CampaignSeries,
  DripSequence,
  EmailArchive,
  EngagementEvent,
  EntitlementSync,
  ImportBatch,
  ImportMapping,
  List,
  Organization,
  Segment,
  SendScheduleState,
  Subscriber,
  Subscription,
  SuppressionEntry,
  Template,
  UsageRecord,
  DeployedVersion,
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
  ImportBatchStore,
  ImportMappingStore,
  SegmentStore,
  SendClaimStore,
  SendScheduleStore,
  Stores,
  TemplateStore,
  SubscriberStore,
  SubscriptionStore,
  SuppressionStore,
  UsageStore,
  VersionStore,
} from "@addressium/domain";
import { ConcurrentModificationError } from "@addressium/domain";
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

  /**
   * TEST-ONLY escape hatch. `dynalite` — the pure-JS DynamoDB used by the
   * integration suite — implements no `TransactWriteItems` action at all, so the
   * transactional counter append (#221) cannot run against it. Setting this
   * degrades that one write to sequential puts, which is NOT exactly-once.
   *
   * Deliberately a constructor option rather than error-detection: a silent
   * fallback would mean a production misconfiguration quietly losing the
   * exactly-once guarantee, which is the whole point of the transaction. Every
   * service constructs `new DynamoStores(env("TABLE_NAME"))`, so production
   * cannot reach this path.
   */
  private readonly nonTransactionalCounters: boolean;

  constructor(
    private readonly tableName: string,
    client?: DynamoDBClient,
    opts?: { nonTransactionalCountersForTests?: boolean },
  ) {
    this.nonTransactionalCounters = opts?.nonTransactionalCountersForTests ?? false;
    this.doc = DynamoDBDocumentClient.from(client ?? new DynamoDBClient({}), {
      // Optional entity fields (consent, entitlementAsof, …) may be undefined.
      marshallOptions: { removeUndefinedValues: true },
    });
  }

  private async put(item: Item<unknown>): Promise<void> {
    await this.doc.send(new PutCommand({ TableName: this.tableName, Item: item }));
  }

  /**
   * Optimistic-concurrency write (#194). A failed condition becomes a domain
   * error rather than an AWS one, so the caller can act on it without importing
   * the SDK — and so a lost race is never mistaken for a successful write, which
   * is how a concurrent upsert used to un-erase a subscriber while the caller
   * was told the erasure succeeded.
   */
  private async putConditional(
    item: Item<unknown>,
    condition: { ConditionExpression: string; ExpressionAttributeValues?: Record<string, unknown> },
    what: string,
  ): Promise<void> {
    // Only the aliases the expression actually mentions. DynamoDB rejects the
    // whole request with a ValidationException if any declared name goes unused,
    // so a fixed map here silently works in the fake and fails in production —
    // which is how a guard ends up never rejecting anything. Caught by the
    // dynalite integration test rather than by review.
    const ALIASES: Record<string, string> = { "#d": "data", "#r": "rev", "#v": "version" };
    const names = Object.fromEntries(
      Object.entries(ALIASES).filter(([alias]) => condition.ConditionExpression.includes(alias)),
    );
    try {
      await this.doc.send(
        new PutCommand({
          TableName: this.tableName,
          Item: item,
          ...condition,
          ...(Object.keys(names).length > 0 ? { ExpressionAttributeNames: names } : {}),
        }),
      );
    } catch (e) {
      if ((e as Error).name === "ConditionalCheckFailedException") {
        throw new ConcurrentModificationError(what);
      }
      throw e;
    }
  }

  private async get<T>(pk: string, sk: string): Promise<T | undefined> {
    const res = await this.doc.send(
      new GetCommand({ TableName: this.tableName, Key: { pk, sk } }),
    );
    return (res.Item as Item<T> | undefined)?.data;
  }

  /**
   * The same pagination as `queryAll`, yielding each item as it arrives rather
   * than accumulating them (#224). One page — at most ~1MB — is resident at a
   * time, so an export's memory ceiling is the page size instead of the org.
   */
  private async *queryPages<T>(params: QueryCommandInput): AsyncGenerator<T> {
    let ExclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const res = await this.doc.send(new QueryCommand({ ...params, ExclusiveStartKey }));
      for (const it of res.Items ?? []) yield (it as Item<T>).data;
      ExclusiveStartKey = res.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (ExclusiveStartKey);
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
    put: async (s, opts) => {
      const item = {
        pk: org(s.orgId),
        sk: `SUBSCRIBER#${s.sub}`,
        gsi1pk: `${org(s.orgId)}#EMAIL`,
        gsi1sk: s.email.toLowerCase(),
        // The store owns the counter, so a caller cannot forge a rev to win a
        // race it lost.
        data: { ...s, rev: (s.rev ?? 0) + 1 },
      };
      if (opts && "ifRev" in opts) {
        // `ifRev: undefined` means "this must still be a record written before
        // `rev` existed" — expressed as attribute_not_exists, not as an equality
        // against a value that isn't there.
        await this.putConditional(
          item,
          opts.ifRev === undefined
            ? { ConditionExpression: "attribute_not_exists(#d.#r)" }
            : {
                ConditionExpression: "#d.#r = :r",
                ExpressionAttributeValues: { ":r": opts.ifRev },
              },
          "subscriber",
        );
      } else {
        await this.put(item);
      }
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
    // A single item whose existence decides the race — see the port doc. Kept in
    // its own partition so it never shows up in a subscriber listing.
    reserveEmail: async (orgId, email, sub) => {
      const key = { pk: `${org(orgId)}#EMAILRESV`, sk: `EMAIL#${email.toLowerCase()}` };
      try {
        await this.doc.send(
          new PutCommand({
            TableName: this.tableName,
            Item: { ...key, data: { sub } },
            ConditionExpression: "attribute_not_exists(pk)",
          }),
        );
        return { sub };
      } catch (e) {
        if ((e as Error).name !== "ConditionalCheckFailedException") throw e;
        // Lost the race. ConsistentRead, because the winner's write is at most
        // milliseconds old and an eventually-consistent read here would return
        // "nothing" and send us straight back to creating a duplicate.
        const res = await this.doc.send(
          new GetCommand({ TableName: this.tableName, Key: key, ConsistentRead: true }),
        );
        const holder = (res.Item as Item<{ sub: string }> | undefined)?.data.sub;
        if (!holder) throw new Error(`email reservation for ${email} vanished mid-race`);
        return { sub: holder };
      }
    },
    getConsistent: async (orgId, sub) => {
      const res = await this.doc.send(
        new GetCommand({
          TableName: this.tableName,
          Key: { pk: org(orgId), sk: `SUBSCRIBER#${sub}` },
          ConsistentRead: true,
        }),
      );
      return (res.Item as Item<Subscriber> | undefined)?.data;
    },
    stream: (orgId) =>
      this.queryPages<Subscriber>({
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

  /**
   * Saved import mappings (#216). Listed per org and filtered by fingerprint in
   * memory: an org has a handful of these, so a GSI would cost more than the
   * scan it saves.
   */
  importMappings: ImportMappingStore = {
    list: (orgId) =>
      this.queryAll<ImportMapping>({
        TableName: this.tableName,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :s)",
        ExpressionAttributeValues: { ":pk": org(orgId), ":s": "IMPMAP#" },
      }),
    findByFingerprint: async (orgId, fingerprint) =>
      (await this.importMappings.list(orgId)).filter((m) => m.fingerprint === fingerprint),
    put: (m) => this.put({ pk: org(m.orgId), sk: `IMPMAP#${m.mappingId}`, data: m }),
    remove: async (orgId, mappingId) => {
      await this.doc.send(
        new DeleteCommand({
          TableName: this.tableName,
          Key: { pk: org(orgId), sk: `IMPMAP#${mappingId}` },
        }),
      );
    },
  };

  /**
   * Import batches (#223). The batch record sits in the org partition; its rows
   * get a partition of their own (`ORG#x#IMPBATCH#<id>`) rather than sharing it.
   *
   * That split is the point. A 200k-row import in the org partition would make
   * every `subscribers.list` / `lists.list` query page through import history to
   * reach its own prefix, and would push one org partition toward the 10GB item
   * -collection limit that a table with a GSI enforces. Rows are written once
   * and read only when someone reverses a batch, so they belong off to the side.
   */
  importBatches: ImportBatchStore = {
    get: (orgId, batchId) => this.get<ImportBatch>(org(orgId), `IMPBATCH#${batchId}`),
    list: async (orgId) =>
      (
        await this.queryAll<ImportBatch>({
          TableName: this.tableName,
          KeyConditionExpression: "pk = :pk AND begins_with(sk, :s)",
          ExpressionAttributeValues: { ":pk": org(orgId), ":s": "IMPBATCH#" },
        })
      ).sort((a, b) => b.startedAt.localeCompare(a.startedAt)),
    put: (b) => this.put({ pk: org(b.orgId), sk: `IMPBATCH#${b.batchId}`, data: b }),
    // Idempotent by key: a retried import row overwrites its own pointer instead
    // of adding a second one, so rowCount and listRows cannot drift apart.
    addRow: (orgId, batchId, subscriberId, listId) =>
      this.put({
        pk: `${org(orgId)}#IMPBATCH#${batchId}`,
        sk: `ROW#${subscriberId}#${listId}`,
        data: { subscriberId, listId },
      }),
    listRows: (orgId, batchId) =>
      this.queryAll<{ subscriberId: string; listId: string }>({
        TableName: this.tableName,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :s)",
        ExpressionAttributeValues: {
          ":pk": `${org(orgId)}#IMPBATCH#${batchId}`,
          ":s": "ROW#",
        },
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
    list: (orgId) =>
      this.queryAll<SuppressionEntry>({
        TableName: this.tableName,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :s)",
        ExpressionAttributeValues: { ":pk": `${org(orgId)}#SUPPRESSION`, ":s": "EMAIL#" },
      }),
  };

  archive: ArchiveStore = {
    get: (orgId, campaignId) =>
      this.get<EmailArchive>(`${org(orgId)}#CAMPAIGN#${campaignId}`, "ARCHIVE"),
    put: (a) =>
      this.put({ pk: `${org(a.orgId)}#CAMPAIGN#${a.campaignId}`, sk: "ARCHIVE", data: a }),
  };

  /** event.type -> the HotCounters field it increments. */
  private static readonly COUNTER_FIELD: Record<EngagementEvent["type"], keyof HotCounters> = {
    sent: "sent",
    delivered: "delivered",
    open: "opens",
    click: "clicks",
    bounce: "bounces",
    complaint: "complaints",
    unsubscribe: "unsubscribes",
  };

  /**
   * Append an engagement event and increment its campaign counter atomically.
   *
   * `opens` and `clicks` are UNIQUE per subscriber (see deriveCounters), which a
   * plain increment cannot express — so those carry an extra uniqueness marker
   * in the same transaction. Three outcomes:
   *
   *   - transaction succeeds        -> new event, counter moved
   *   - the EVENT row already exists-> exact redelivery; nothing to do
   *   - only the MARKER exists      -> a genuine repeat open/click by the same
   *                                    subscriber: record the event, but do not
   *                                    move a counter that counts people
   */
  private async appendEvent(e: EngagementEvent): Promise<void> {
    const field = DynamoStores.COUNTER_FIELD[e.type];
    const eventItem = {
      pk: `${org(e.orgId)}#CAMPAIGN#${e.campaignId}`,
      sk: `EVENT#${e.at}#${e.eventId ?? randomUUID()}`,
      data: e,
    };
    const bumpCounter = {
      Update: {
        TableName: this.tableName,
        Key: { pk: org(e.orgId), sk: `CAMPAIGN#${e.campaignId}` },
        // if_not_exists covers campaigns written before counters were
        // maintained, and rows where the map is absent entirely.
        UpdateExpression:
          "SET #c = if_not_exists(#c, :empty), #c.#f = if_not_exists(#c.#f, :zero) + :one",
        ExpressionAttributeNames: { "#c": "data", "#f": field },
        ExpressionAttributeValues: { ":empty": {}, ":zero": 0, ":one": 1 },
        // Do not resurrect a campaign that does not exist.
        ConditionExpression: "attribute_exists(pk)",
      },
    };
    const putEvent = {
      Put: {
        TableName: this.tableName,
        Item: eventItem,
        ConditionExpression: "attribute_not_exists(sk)",
      },
    };
    const unique = e.type === "open" || e.type === "click";
    const items: Record<string, unknown>[] = [putEvent, bumpCounter];
    if (unique) {
      items.push({
        Put: {
          TableName: this.tableName,
          Item: {
            pk: `${org(e.orgId)}#CAMPAIGN#${e.campaignId}`,
            sk: `UNIQ#${e.type}#${e.subscriberId}`,
            data: { at: e.at },
          },
          ConditionExpression: "attribute_not_exists(sk)",
        },
      });
    }

    if (this.nonTransactionalCounters) {
      // Degraded path — see the constructor. Ordering matters even here: write
      // the event first so a crash loses a count rather than an event.
      await this.put(eventItem);
      return;
    }
    try {
      await this.doc.send(new TransactWriteCommand({ TransactItems: items as never }));
    } catch (err) {
      if (!(err instanceof TransactionCanceledException)) throw err;
      const reasons = err.CancellationReasons ?? [];
      const eventExists = reasons[0]?.Code === "ConditionalCheckFailed";
      // An exact redelivery: the row is already there, counters already moved.
      if (eventExists) return;
      const markerExists = unique && reasons[2]?.Code === "ConditionalCheckFailed";
      if (markerExists) {
        // A real second open by the same person. Keep the event — it is genuine
        // history, and #183 deliberately made repeats distinguishable — but do
        // not move a counter whose unit is people, not events.
        await this.put(eventItem);
        return;
      }
      throw err;
    }
  }

  events: EventStore = {
    // The sort key carries the event's stable id, so re-writing the same source
    // event overwrites its own row instead of appending a duplicate. It used to
    // be a fresh randomUUID() per call, which made every at-least-once
    // redelivery a permanent phantom open/click/bounce with no way to tell them
    // apart after the fact (#183).
    //
    // The append and the campaign counter increment happen in ONE
    // TransactWriteItems, made exactly-once by that id (#221, compendium #57).
    // A bare ADD would double-count under redelivery, and since the event plane
    // moved to SQS (#218) redelivery is guaranteed rather than incidental — an
    // inflated bounce count halts a healthy campaign, a lost one lets a bad
    // campaign run.
    append: (e) => this.appendEvent(e),
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
    list: (orgId) =>
      this.queryAll<Campaign>({
        TableName: this.tableName,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :s)",
        ExpressionAttributeValues: { ":pk": org(orgId), ":s": "CAMPAIGNREC#" },
      }),
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

  templates: TemplateStore = {
    get: (orgId, templateId) => this.get<Template>(org(orgId), `TEMPLATE#${templateId}`),
    put: async (t, opts) => {
      const item = { pk: org(t.orgId), sk: `TEMPLATE#${t.templateId}`, data: t };
      if (!opts || !("ifVersion" in opts)) return this.put(item);
      // `version` IS the revision here, so no second counter is needed: two
      // concurrent saves both compute N+1 and the second one's condition fails.
      await this.putConditional(
        item,
        opts.ifVersion === undefined
          ? { ConditionExpression: "attribute_not_exists(pk)" }
          : {
              ConditionExpression: "#d.#v = :v",
              ExpressionAttributeValues: { ":v": opts.ifVersion },
            },
        "template",
      );
    },
    list: (orgId) =>
      this.queryAll<Template>({
        TableName: this.tableName,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :s)",
        ExpressionAttributeValues: { ":pk": org(orgId), ":s": "TEMPLATE#" },
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

  /**
   * Deployed-version marker (#213). A singleton item outside any org partition —
   * it describes the installation, not a tenant. The migration runner reads it
   * to decide which migrations are pending.
   */
  version: VersionStore = {
    get: async () => {
      const res = await this.doc.send(
        new GetCommand({ TableName: this.tableName, Key: VERSION_ITEM }),
      );
      return res.Item?.data as DeployedVersion | undefined;
    },
    put: async (v) => {
      await this.put({ ...VERSION_ITEM, data: v });
    },
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
    release: async (orgId, campaignId) => {
      await this.doc.send(
        new DeleteCommand({
          TableName: this.tableName,
          Key: { pk: `${org(orgId)}#CAMPAIGN#${campaignId}`, sk: "SENDCLAIM" },
        }),
      );
    },
  };
}
