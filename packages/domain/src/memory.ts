/**
 * In-memory adapters for the ports. Used by tests and local dev; the DynamoDB /
 * SES implementations live in the services and satisfy the same interfaces.
 */
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
  CampaignScheduler,
  EmailSender,
  EntitlementStore,
  EventStore,
  ListStore,
  OrganizationStore,
  SendClaimStore,
  SendDescriptor,
  SendQueue,
  SentMessage,
  Stores,
  SubscriberStore,
  SubscriptionStore,
  SuppressionStore,
} from "./ports.js";

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
  async get(orgId: string, sub: string) {
    return this.byId.get(subKey(orgId, sub));
  }
  async findByEmail(orgId: string, email: string) {
    for (const s of this.byId.values()) {
      if (s.orgId === orgId && s.email === email.toLowerCase()) return s;
    }
    return undefined;
  }
  async put(sub: Subscriber) {
    this.byId.set(subKey(sub.orgId, sub.sub), sub);
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
    return [...this.map.values()].filter(
      (s) => s.orgId === orgId && s.listId === listId && s.status === "confirmed",
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
}

export class MemSuppression implements SuppressionStore {
  private set = new Set<string>();
  async isSuppressed(orgId: string, email: string) {
    return this.set.has(subKey(orgId, email.toLowerCase()));
  }
  async add(e: SuppressionEntry) {
    this.set.add(subKey(e.orgId, e.email.toLowerCase()));
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

export class MemEvents implements EventStore {
  private list: EngagementEvent[] = [];
  async append(e: EngagementEvent) {
    this.list.push(e);
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

export class MemSendClaims implements SendClaimStore {
  private set = new Set<string>();
  async claim(orgId: string, campaignId: string) {
    const k = `${orgId}#${campaignId}`;
    if (this.set.has(k)) return false;
    this.set.add(k);
    return true;
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

export function memStores(): Stores {
  return {
    organizations: new MemOrganizations(),
    subscribers: new MemSubscribers(),
    subscriptions: new MemSubscriptions(),
    lists: new MemLists(),
    suppression: new MemSuppression(),
    archive: new MemArchive(),
    events: new MemEvents(),
    entitlements: new MemEntitlements(),
    sendClaims: new MemSendClaims(),
  };
}
