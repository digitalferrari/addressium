/**
 * The merge-tag registry (§4.15) — what the console's Merge tags screen reads.
 *
 * A merge tag is a `{{name}}` placeholder a template writes and the send path
 * fills in. Two kinds exist and this module's whole job is keeping the line
 * between them honest:
 *
 *  - **Reserved** tags (`RESERVED_MERGE_TAGS` in `@addressium/core`) are
 *    supplied by the send path itself — the unsubscribe URL, the list's name and
 *    its CAN-SPAM footer and address. They are not stored per org, because they
 *    are not the operator's to define, and they are not the operator's to define
 *    because merge values start from `subscriber.attributes`, which anyone with
 *    a CSV can write. An imported column called `unsubscribe_url` that could win
 *    would replace the one link a recipient is legally entitled to.
 *
 *  - **Org-defined** tags are everything else: profile attributes, feed fields,
 *    token claims. They are stored, listed, and freely editable.
 *
 * PRECEDENCE IS ENFORCED TWICE, deliberately, because the two enforcements
 * protect against different failures:
 *
 *  1. At SEND time, in `mergeValues` (`send.ts`), reserved values are spread
 *     last so an attribute of the same name is overwritten. This is the one that
 *     actually protects the recipient, and it holds for attributes that were
 *     never registered as merge tags at all.
 *  2. At REGISTRATION time, here, `saveMergeTag` refuses a reserved name with an
 *     `InvalidInputError`. This is not redundant with (1) — without it the
 *     console would happily accept `unsubscribe_url`, store it, and display it
 *     in a list beside an example value that never renders, telling the operator
 *     their tag works when the send path silently ignores it.
 *
 * And `listMergeTags` merges the two, reserved winning, so the screen renders a
 * registry whose precedence was decided server-side rather than in a component.
 */
import {
  RESERVED_MERGE_TAGS,
  isReservedMergeTag,
  type MergeTag,
  type schemas,
} from "@addressium/core";
import { InvalidInputError, type Stores } from "./ports.js";

/**
 * One row of the merge-tag registry as the console renders it.
 *
 * `reserved` is computed here rather than inferred in the UI from
 * `source === "system"`: an org may legitimately register a tag whose source is
 * `system` without it being one of the four the send path resolves, and a screen
 * that guessed would mark it uneditable for no reason.
 */
export interface MergeTagEntry extends MergeTag {
  /** True for a send-path tag: the operator cannot edit or delete it. */
  reserved: boolean;
}

/**
 * The full registry for one org: reserved tags first, then the org's own.
 *
 * A stored tag whose name collides with a reserved one is DROPPED rather than
 * shown, because dropping it is what the send path does. Such a row can exist
 * from before `saveMergeTag` refused the name, and rendering both would show an
 * operator two rows for one `{{…}}` with no way to tell which one wins.
 */
export async function listMergeTags(stores: Stores, orgId: string): Promise<MergeTagEntry[]> {
  const reserved = RESERVED_MERGE_TAGS.map((t) => ({ ...t, orgId, reserved: true }));
  const stored = await stores.mergeTags.list(orgId);
  const own = stored
    .filter((t) => !isReservedMergeTag(t.name))
    .map((t) => ({ ...t, reserved: false }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return [...reserved, ...own];
}

/**
 * Register or update one org-defined merge tag.
 *
 * Throws `InvalidInputError` (→ 400 with this sentence, #265) for a reserved
 * name. The operator needs to read WHICH name and WHY, which a ZodError's
 * generic one-sentence reply cannot tell them — hence the check lives here and
 * not as a `.refine` on `saveMergeTagSchema`.
 */
export async function saveMergeTag(
  stores: Stores,
  input: schemas.SaveMergeTagInput,
): Promise<MergeTag> {
  if (isReservedMergeTag(input.name)) {
    throw new InvalidInputError(
      `"${input.name}" is reserved: the send path supplies it, and a tag of that name would never render. Choose another name.`,
    );
  }
  const tag: MergeTag = {
    orgId: input.orgId,
    name: input.name,
    source: input.source,
    scope: input.scope,
    ...(input.example === undefined ? {} : { example: input.example }),
    ...(input.fallback === undefined ? {} : { fallback: input.fallback }),
  };
  await stores.mergeTags.put(tag);
  return tag;
}

/**
 * The org's configured fallbacks, as a merge-value map the send path can spread
 * UNDER the real values (#266).
 *
 * The console has offered a "fallback when empty" field since the registry
 * shipped, and until now nothing read it: `applyMerge` resolved a missing
 * attribute to `""` unconditionally, so an operator who set `there` as the
 * fallback for `{{first_name}}` saw it saved, saw it in the table, and shipped a
 * campaign that greeted every attribute-less subscriber with "Hi ". A value that
 * round-trips is worse than a dead field, because it looks confirmed.
 *
 * Read ONCE per send (campaign slice or single recipient), not per recipient —
 * the registry is org-wide and does not change mid-send, and a store read inside
 * the recipient loop would be a query per subscriber on the hottest path.
 *
 * Reserved names are dropped, exactly as `listMergeTags` drops them: a stored
 * row under a reserved name can exist from before `saveMergeTag` refused one,
 * and letting it into this map would put an operator-chosen string where the
 * send path's own value belongs. (`mergeValues` spreads reserved last anyway —
 * this is the same belt-and-braces the module header describes.)
 */
export async function mergeTagFallbacks(
  stores: Stores,
  orgId: string,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const tag of await stores.mergeTags.list(orgId)) {
    if (tag.fallback === undefined || isReservedMergeTag(tag.name)) continue;
    out[tag.name] = tag.fallback;
  }
  return out;
}

/** Remove an org-defined merge tag. Reserved names are refused — there is nothing to remove. */
export async function deleteMergeTag(
  stores: Stores,
  orgId: string,
  name: string,
): Promise<void> {
  if (isReservedMergeTag(name)) {
    throw new InvalidInputError(`"${name}" is reserved by the send path and cannot be removed.`);
  }
  await stores.mergeTags.delete(orgId, name);
}
