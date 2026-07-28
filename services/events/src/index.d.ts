/** Our internal, already-resolved shape (direct invoke and tests). */
export interface Notification {
    eventType: "Open" | "Click" | "Bounce" | "Complaint";
    orgId: string;
    campaignId: string;
    subscriberId: string;
    /** Full clicked URL (token in fragment) for Click events. */
    link?: string;
    /** Present for Bounce/Complaint. */
    email?: string;
    listId?: string;
    /** SES bounce classification; only `Permanent` may suppress. */
    bounceType?: string;
    /** SES message id, used to make at-least-once delivery idempotent. */
    messageId?: string;
}
/**
 * Peel the SNS (or SQS) envelope. Returns the inner payloads; a record whose
 * body isn't JSON is skipped rather than failing its batch peers.
 */
export declare function unwrap(event: unknown): unknown[];
/**
 * Normalize one payload into a `Notification`, or return undefined when it
 * can't be resolved to a subscriber.
 */
export declare function normalize(input: unknown): Notification | undefined;
export declare function handler(event: unknown): Promise<{
    ok: boolean;
    processed: number;
    unresolved: number;
}>;
