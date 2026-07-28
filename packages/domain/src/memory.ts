/**
 * In-memory adapters for the ports. Used by tests and local dev; the DynamoDB /
 * SES implementations live in the services and satisfy the same interfaces.
 */
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
  AlertMessage,
  AlertPublisher,
  ArchiveStore,
  CampaignScheduler,
  CampaignSeriesStore,
  CampaignStore,
  DripSequenceStore,
  EmailSender,
  EntitlementStore,
  EventStore,
  ListStore,
  OrganizationStore,
  SegmentStore,
  SendClaimStore,
  SendDescriptor,
  SendScheduleStore,
  TemplateStore,
  SendQueue,
  SentMessage,
  Stores,
  SubscriberStore,
  SubscriptionStore,
  SuppressionStore,
  UsageStore,
  VersionStore,
  ImportBatchStore,
  ImportMappingStore,
} from "./ports.js";
import { ConcurrentModificationError } from "./ports.js";
import { ZERO_COUNTERS } from "./admin.js";

const subKey = (o: string, s: string) => `${o}#${s}`;
const subnKey = (o: string, s: string, l: string) => `${o}#${s}#${l}`;

export class MemOrganizations implements OrganizationStore {
  private map = new Map<string, Organization>();
  async get(orgId: string) {
    return this.map.get(orgId);
  }
  async put(org: Organization) {
    this.map.set(org.orgId, org);
  }
  async list() {
    return [...this.map.values()];
  }
}

export class MemSubscribers implements SubscriberStore {
  private byId = new Map<string, Subscriber>();
  /** email -> the sub that holds it, mirroring the Dynamo reservation item. */
  private emailOwner = new Map<string, string>();
  async get(orgId: string, sub: string) {
    return this.byId.get(subKey(orgId, sub));
  }
  async findByEmail(orgId: string, email: string) {
    for (const s of this.byId.values()) {
      if (s.orgId === orgId && s.email === email.toLowerCase()) return s;
    }
    return undefined;
  }
  async findByExternalId(orgId: string, externalId: string) {
    for (const s of this.byId.values()) {
      if (s.orgId === orgId && s.externalId === externalId) return s;
    }
    return undefined;
  }
  async put(sub: Subscriber, opts?: { ifRev?: number }) {
    const key = subKey(sub.orgId, sub.sub);
    if (opts && "ifRev" in opts) {
      const current = this.byId.get(key);
      // A missing record has no rev either, so `ifRev: undefined` on a record
      // that has since been deleted still passes — which is correct: there is
      // nothing to lose.
      if (current?.rev !== opts.ifRev) throw new ConcurrentModificationError("subscriber");
    }
    this.byId.set(key, { ...sub, rev: (sub.rev ?? 0) + 1 });
  }
  async reserveEmail(orgId: string, email: string, sub: string) {
    const key = subKey(orgId, email.toLowerCase());
    const held = this.emailOwner.get(key);
    if (held) return { sub: held };
    this.emailOwner.set(key, sub);
    return { sub };
  }
  async getConsistent(orgId: string, sub: string) {
    // A single map: every read here is already consistent.
    return this.byId.get(subKey(orgId, sub));
  }
  async list(orgId: string) {
    return [...this.byId.values()].filter((s) => s.orgId === orgId);
  }
  async *stream(orgId: string) {
    // A fake cannot demonstrate bounded memory, but it must expose the same
    // shape so export code paths are exercised by the unit suite.
    for (const s of this.byId.values()) if (s.orgId === orgId) yield s;
  }
  async markEngaged(orgId: string, sub: string, at: string) {
    const s = this.byId.get(subKey(orgId, sub));
    if (s && (!s.lastEngagedAt || s.lastEngagedAt < at)) {
      this.byId.set(subKey(orgId, sub), { ...s, lastEngagedAt: at });
    }
  }
}

export class MemSubscriptions implements SubscriptionStore {
  private map = new Map<string, Subscription>();
  async get(orgId: string, sub: string, listId: string) {
    return this.map.get(subnKey(orgId, sub, listId));
  }
  async put(s: Subscription) {
    this.map.set(subnKey(s.orgId, s.subscriberId, s.listId), s);
  }
  async listConfirmed(orgId: string, listId: string) {
    return (
      [...this.map.values()]
        .filter((s) => s.orgId === orgId && s.listId === listId && s.status === "confirmed")
        // Sorted by subscriberId, because that is what DynamoDB does (#171). The
        // real store ranges over `sk = SUBSCRIPTION#<subscriberId>`, so results
        // come back in lexicographic id order and a NEW signup lands at a random
        // position in the middle. Returning Map insertion order instead made a
        // new signup always append at the end, which is precisely the ordering
        // under which the old offset-based fan-out looked correct — the fake was
        // hiding the bug it was supposed to catch.
        .sort((a, b) => a.subscriberId.localeCompare(b.subscriberId))
    );
  }
  async listBySubscriber(orgId: string, subscriberId: string) {
    return [...this.map.values()].filter(
      (s) => s.orgId === orgId && s.subscriberId === subscriberId,
    );
  }
}

export class MemLists implements ListStore {
  private map = new Map<string, List>();
  async get(orgId: string, listId: string) {
    return this.map.get(subKey(orgId, listId));
  }
  async put(l: List) {
    this.map.set(subKey(l.orgId, l.listId), l);
  }
  async list(orgId: string) {
    return [...this.map.values()].filter((l) => l.orgId === orgId);
  }
}

export class MemSegments implements SegmentStore {
  private map = new Map<string, Segment>();
  async get(orgId: string, segmentId: string) {
    return this.map.get(subKey(orgId, segmentId));
  }
  async put(s: Segment) {
    this.map.set(subKey(s.orgId, s.segmentId), s);
  }
  async list(orgId: string) {
    return [...this.map.values()].filter((s) => s.orgId === orgId);
  }
}

export class MemSuppression implements SuppressionStore {
  private orgScoped = new Map<string, SuppressionEntry>();
  private global = new Map<string, SuppressionEntry>();
  async isSuppressed(orgId: string, email: string) {
    const e = email.toLowerCase();
    // Global entries (hard bounces / complaints) suppress across every org.
    return this.orgScoped.has(subKey(orgId, e)) || this.global.has(e);
  }
  async add(e: SuppressionEntry) {
    const email = e.email.toLowerCase();
    const entry = { ...e, email };
    if (e.scope === "global") this.global.set(email, entry);
    else this.orgScoped.set(subKey(e.orgId, email), entry);
  }
  async entriesFor(orgId: string, email: string) {
    const e = email.toLowerCase();
    const out: SuppressionEntry[] = [];
    const o = this.orgScoped.get(subKey(orgId, e));
    if (o) out.push(o);
    const g = this.global.get(e);
    if (g) out.push(g);
    return out;
  }
  async remove(orgId: string, email: string, scope: SuppressionEntry["scope"]) {
    const e = email.toLowerCase();
    if (scope === "global") this.global.delete(e);
    else this.orgScoped.delete(subKey(orgId, e));
  }
  async list(orgId: string) {
    return [...this.orgScoped.values()].filter((e) => e.orgId === orgId);
  }
}

export class MemArchive implements ArchiveStore {
  private map = new Map<string, EmailArchive>();
  async get(orgId: string, campaignId: string) {
    return this.map.get(subKey(orgId, campaignId));
  }
  async put(a: EmailArchive) {
    this.map.set(subKey(a.orgId, a.campaignId), a);
  }
}

/**
 * Mirrors the DynamoDB adapter's transactional append (#221): the event row and
 * the campaign counter move together, made exactly-once by the deterministic
 * `eventId`, and `opens`/`clicks` count PEOPLE rather than events.
 *
 * The parity matters — a fake that merely appends would let every counter test
 * pass while the real adapter double-counted under redelivery, which since #218
 * is guaranteed rather than incidental.
 */
export class MemEvents implements EventStore {
  private list: EngagementEvent[] = [];
  private seen = new Set<string>();
  private unique = new Set<string>();
  /** Set by memStores so an append can move the campaign's counters. */
  campaigns?: CampaignStore;

  private static readonly FIELD: Record<EngagementEvent["type"], keyof HotCounters> = {
    sent: "sent",
    delivered: "delivered",
    open: "opens",
    click: "clicks",
    bounce: "bounces",
    complaint: "complaints",
    unsubscribe: "unsubscribes",
  };

  async append(e: EngagementEvent) {
    const id = `${e.orgId}#${e.campaignId}#${e.at}#${e.eventId ?? ""}`;
    // Exact redelivery of the same source event: already recorded, already counted.
    if (e.eventId && this.seen.has(id)) return;
    this.seen.add(id);
    this.list.push(e);

    const isUnique = e.type === "open" || e.type === "click";
    if (isUnique) {
      const key = `${e.orgId}#${e.campaignId}#${e.type}#${e.subscriberId}`;
      // A genuine repeat open by the same person is real history, but it must
      // not move a counter whose unit is people.
      if (this.unique.has(key)) return;
      this.unique.add(key);
    }

    const campaign = await this.campaigns?.get(e.orgId, e.campaignId);
    if (!campaign) return; // never resurrect a campaign that does not exist
    const field = MemEvents.FIELD[e.type];
    const counters = { ...ZERO_COUNTERS, ...(campaign.counters ?? {}) };
    counters[field] += 1;
    await this.campaigns?.put({ ...campaign, counters });
  }

  async all(orgId: string, campaignId: string) {
    return this.list.filter((e) => e.orgId === orgId && e.campaignId === campaignId);
  }
}

export class MemEntitlements implements EntitlementStore {
  private map = new Map<string, EntitlementSync>();
  async put(e: EntitlementSync) {
    this.map.set(subKey(e.orgId, e.subscriberId), e);
  }
  async latest(orgId: string, subscriberId: string) {
    return this.map.get(subKey(orgId, subscriberId));
  }
}

export class MemCampaigns implements CampaignStore {
  private map = new Map<string, Campaign>();
  async get(orgId: string, campaignId: string) {
    return this.map.get(subKey(orgId, campaignId));
  }
  async put(c: Campaign) {
    this.map.set(subKey(c.orgId, c.campaignId), c);
  }
  async list(orgId: string) {
    return [...this.map.values()].filter((c) => c.orgId === orgId);
  }
}

export class MemCampaignSeries implements CampaignSeriesStore {
  private map = new Map<string, CampaignSeries>();
  async get(orgId: string, seriesId: string) {
    return this.map.get(subKey(orgId, seriesId));
  }
  async put(s: CampaignSeries) {
    this.map.set(subKey(s.orgId, s.seriesId), s);
  }
}

export class MemTemplates implements TemplateStore {
  private map = new Map<string, Template>();
  async get(orgId: string, templateId: string) {
    return this.map.get(subKey(orgId, templateId));
  }
  async put(t: Template, opts?: { ifVersion?: number }) {
    const key = subKey(t.orgId, t.templateId);
    if (opts && "ifVersion" in opts) {
      const current = this.map.get(key);
      if (current?.version !== opts.ifVersion) throw new ConcurrentModificationError("template");
    }
    this.map.set(key, t);
  }
  async list(orgId: string) {
    return [...this.map.values()].filter((t) => t.orgId === orgId);
  }
}

export class MemSendSchedules implements SendScheduleStore {
  private map = new Map<string, SendScheduleState>();
  async get(orgId: string, scheduleId: string) {
    return this.map.get(subKey(orgId, scheduleId));
  }
  async put(s: SendScheduleState) {
    this.map.set(subKey(s.orgId, s.scheduleId), s);
  }
  async list(orgId: string) {
    return [...this.map.values()].filter((s) => s.orgId === orgId);
  }
}

export class MemDripSequences implements DripSequenceStore {
  private map = new Map<string, DripSequence>();
  async get(orgId: string, sequenceId: string) {
    return this.map.get(subKey(orgId, sequenceId));
  }
  async put(s: DripSequence) {
    this.map.set(subKey(s.orgId, s.sequenceId), s);
  }
  async list(orgId: string) {
    return [...this.map.values()].filter((s) => s.orgId === orgId);
  }
}

export class MemAlertConfigs implements AlertConfigStore {
  private map = new Map<string, AlertConfig>();
  async get(orgId: string) {
    return this.map.get(orgId);
  }
  async put(config: AlertConfig) {
    this.map.set(config.orgId, config);
  }
}

export class MemUsage implements UsageStore {
  private map = new Map<string, UsageRecord>();
  private key = (o: string, p: string) => `${o}#${p}`;
  async get(orgId: string, period: string) {
    return this.map.get(this.key(orgId, period));
  }
  async put(record: UsageRecord) {
    this.map.set(this.key(record.orgId, record.period), record);
  }
  async listByOrg(orgId: string) {
    return [...this.map.values()].filter((r) => r.orgId === orgId);
  }
}

/** Captures published alerts so tests can assert on breach payloads. */
export class CaptureAlertPublisher implements AlertPublisher {
  public published: Array<{ topicArn: string; message: AlertMessage }> = [];
  async publish(topicArn: string, message: AlertMessage) {
    this.published.push({ topicArn, message });
  }
}

export class MemVersion implements VersionStore {
  private v: DeployedVersion | undefined;
  async get() { return this.v; }
  async put(v: DeployedVersion) { this.v = v; }
}

export class MemSendClaims implements SendClaimStore {
  private set = new Set<string>();
  async claim(orgId: string, campaignId: string) {
    const k = `${orgId}#${campaignId}`;
    if (this.set.has(k)) return false;
    this.set.add(k);
    return true;
  }
  async release(orgId: string, campaignId: string) {
    this.set.delete(`${orgId}#${campaignId}`);
  }
}

/** Captures "sent" mail so tests can inspect exactly what would go out. */
export class CaptureSender implements EmailSender {
  public sent: SentMessage[] = [];
  async send(msg: SentMessage) {
    this.sent.push(msg);
  }
}

/** In-memory queue + scheduler for tests. */
export class MemSendQueue implements SendQueue {
  public enqueued: SendDescriptor[] = [];
  async enqueue(descriptor: SendDescriptor) {
    this.enqueued.push(descriptor);
  }
}

export class MemScheduler implements CampaignScheduler {
  public oneOff = new Map<string, { at: Date; descriptor: SendDescriptor }>();
  public recurring = new Map<string, { cron: string; timezone: string; payload: unknown }>();
  async scheduleOneOff(input: { name: string; at: Date; descriptor: SendDescriptor }) {
    this.oneOff.set(input.name, { at: input.at, descriptor: input.descriptor });
  }
  async scheduleRecurring(input: { name: string; cron: string; timezone: string; payload: unknown }) {
    this.recurring.set(input.name, { cron: input.cron, timezone: input.timezone, payload: input.payload });
  }
  async cancel(name: string) {
    this.oneOff.delete(name);
    this.recurring.delete(name);
  }
}

export class MemImportMappings implements ImportMappingStore {
  private map = new Map<string, ImportMapping>();
  private key = (orgId: string, id: string) => `${orgId}#${id}`;
  async list(orgId: string) {
    return [...this.map.values()].filter((m) => m.orgId === orgId);
  }
  async findByFingerprint(orgId: string, fingerprint: string) {
    return (await this.list(orgId)).filter((m) => m.fingerprint === fingerprint);
  }
  async put(m: ImportMapping) {
    this.map.set(this.key(m.orgId, m.mappingId), m);
  }
  async remove(orgId: string, mappingId: string) {
    this.map.delete(this.key(orgId, mappingId));
  }
}

/**
 * Import batches (#223). Rows are held in a keyed list rather than folded into
 * the batch record, mirroring the pointer items the Dynamo adapter writes: a
 * batch that imported 200k rows must not have to be loaded whole to be counted.
 */
export class MemImportBatches implements ImportBatchStore {
  private map = new Map<string, ImportBatch>();
  private rows = new Map<string, { subscriberId: string; listId: string }[]>();
  private key = (orgId: string, batchId: string) => `${orgId}#${batchId}`;
  async get(orgId: string, batchId: string) {
    return this.map.get(this.key(orgId, batchId));
  }
  async list(orgId: string) {
    return [...this.map.values()]
      .filter((b) => b.orgId === orgId)
      // Newest first: an operator reversing a bad upload wants the last one.
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }
  async put(b: ImportBatch) {
    this.map.set(this.key(b.orgId, b.batchId), b);
  }
  async addRow(orgId: string, batchId: string, subscriberId: string, listId: string) {
    const k = this.key(orgId, batchId);
    const existing = this.rows.get(k) ?? [];
    // Idempotent, like the Dynamo put it stands in for: re-running an import row
    // must not inflate the batch's membership.
    if (!existing.some((r) => r.subscriberId === subscriberId && r.listId === listId)) {
      existing.push({ subscriberId, listId });
    }
    this.rows.set(k, existing);
  }
  async listRows(orgId: string, batchId: string) {
    return [...(this.rows.get(this.key(orgId, batchId)) ?? [])];
  }
}

export function memStores(): Stores {
  const events = new MemEvents();
  const campaigns = new MemCampaigns();
  // The counter increment lives with the append, so the fake needs the campaign
  // store the way the real adapter needs the same table.
  events.campaigns = campaigns;
  return {
    organizations: new MemOrganizations(),
    subscribers: new MemSubscribers(),
    subscriptions: new MemSubscriptions(),
    lists: new MemLists(),
    suppression: new MemSuppression(),
    archive: new MemArchive(),
    events,
    entitlements: new MemEntitlements(),
    sendClaims: new MemSendClaims(),
    version: new MemVersion(),
    campaigns,
    series: new MemCampaignSeries(),
    schedules: new MemSendSchedules(),
    templates: new MemTemplates(),
    alerts: new MemAlertConfigs(),
    usage: new MemUsage(),
    segments: new MemSegments(),
    importMappings: new MemImportMappings(),
    importBatches: new MemImportBatches(),
    dripSequences: new MemDripSequences(),
  };
}
