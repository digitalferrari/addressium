/**
 * addressium service: sender — drives a campaign send over SES.
 *
 * Builds DynamoDB stores + the SES sender + the KMS magic-link signer from env
 * (once per cold start), then calls the pure sendCampaign() domain function.
 * See docs/ARCHITECTURE.md §4.4.
 */
import { depsFromEnv, type Deps } from "@addressium/adapters-aws";
import { sendCampaign, type EmailTemplate } from "@addressium/domain";

export interface SendEvent {
  orgId: string;
  campaignId: string;
  listId: string;
  subject: string;
  template: EmailTemplate;
}

let _deps: Deps | undefined;
const deps = () => (_deps ??= depsFromEnv());

export async function handler(event: SendEvent) {
  const d = deps();
  // TODO: load subject/template from the campaign/series record instead of the
  // event once the campaign store lands; token-bucket throttle across batches.
  return sendCampaign(d.stores, d.sender, d.magic, d.clock, event);
}
