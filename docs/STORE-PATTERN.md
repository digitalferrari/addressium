# Store pattern

Domain operations receive the `Stores` bundle from [ports.ts](../packages/domain/src/ports.ts). Each store interface defines persistence operations; domain functions own validation and business rules. Keep storage details behind these interfaces.

## Adding or extending a store

1. Define the entity and input schemas in `packages/core/src`. Validate external input at the API boundary; enforce domain rules in the domain operation.
2. Define the store contract and its property on `Stores` in [ports.ts](../packages/domain/src/ports.ts). Specify identity, organization scope, missing-record behavior, and any ordering or conditional-write guarantees callers require.
3. Implement the contract in [memory.ts](../packages/domain/src/memory.ts) and wire it into `memStores`. Implement the same contract in `DynamoStores` in [dynamo.ts](../packages/adapters-aws/src/dynamo.ts). Memory tests alone do not establish DynamoDB behavior.
4. Test persistence semantics and the domain operation that consumes the data. A successful save/read round trip does not prove the feature affects its intended output.

## Example: merge tags

`MergeTagStore` exposes `get`, `put`, `list`, and `delete`. Identity is `(orgId, name)`; saving the same name replaces its row. `MemMergeTags` uses `subKey` for its map key and filters `list` by organization. `DynamoStores.mergeTags` stores `{ pk, sk, data }` with partition key `ORG#<orgId>` and sort key `MERGETAG#<name>`. Its list operation uses a partition/prefix query through `DynamoStores.queryAll`, which follows `LastEvaluatedKey` until all pages are read.

`saveMergeTag` and `deleteMergeTag` reject reserved names. `listMergeTags` supplies reserved definitions from `RESERVED_MERGE_TAGS` and hides conflicting legacy rows. These rules live in [merge-tags.ts](../packages/domain/src/merge-tags.ts), rather than the adapters.

Persistence becomes behavior through `mergeTagFallbacks` in `merge-tags.ts` and `mergeValues` in [send.ts](../packages/domain/src/send.ts): `sendCampaign` loads fallbacks once per invocation/slice, and `sendToSubscriber` loads them for its recipient. Precedence is configured fallback → nonempty subscriber attribute → reserved send value. Empty means absent or `""`; whitespace remains a value. Rendering escapes resolved values, and the plain-text alternative derives from the rendered HTML.

[merge-tag-fallback.test.ts](../packages/domain/test/merge-tag-fallback.test.ts) checks captured messages through both send entry points, including block bodies, raw HTML, compiled MJML, and plain-text alternatives. MJML compilation happens before the domain send pipeline; stored MJML is not compiled by `emailTemplateFromStored`.

## Example: API keys — a store with a second access pattern

`ApiKeyStore` (#280) is the one registry here whose contract has a lookup that is
not org-scoped. Identity is `(orgId, keyId)` like every other store, but
`findByHash` resolves a SHA-256 digest **across orgs**, because a caller
presenting a credential is exactly the party that has not yet been placed in one.

`DynamoStores.apiKeys` satisfies that with a SECOND ITEM rather than an index:
`put` writes the registry row (`ORG#<orgId>` / `APIKEY#<keyId>`) and a lookup row
(`APIKEYHASH#<digest>` in both key positions) whose `data` is a pointer back to
`(orgId, keyId)` — never a copy of the record, so a revoke cannot update one half
and leave the other authenticating. `delete` reads the record first, because only
it knows the digest the lookup is addressed by. A GSI would express the same
access pattern and was not used: it would change the table in
[control-plane-stack.ts](../infra/cdk/lib/control-plane-stack.ts) and every table
definition standing in for it, for an exact-match read a primary key already
serves. `MemApiKeys` mirrors the pair with two Maps.

Step 3's warning is concrete here:
[api-keys-dynamo.integration.test.ts](../packages/integration-tests/test/api-keys-dynamo.integration.test.ts)
asserts that revoking through `put` is visible through `findByHash`, which a
memory double satisfying only `get`/`list` would never have caught.

Persistence becomes behavior in [api-keys.ts](../packages/domain/src/api-keys.ts).
Two rules there are load-bearing rather than stylistic. Revocation stamps
`revokedAt` and keeps the row, so "what could this credential do and when was it
cut off" stays answerable. And `lastUsedAt` is written by `authenticateApiKey`
and by nothing else — not by `listApiKeys`, not by the console opening the
screen — which is what lets the API keys screen render "Never" as a fact about
the key instead of an unfilled column.
