/**
 * Deployed application version.
 *
 * Written to a `SCHEMA#VERSION` marker item on deploy and surfaced at
 * `GET /version`, so an operator can tell what is actually running without
 * reading CloudFormation. The migration runner (#213) reads the same marker to
 * decide which migrations are pending, which is why this is a real artifact
 * rather than a cosmetic string.
 */

/** Kept in step with the root package.json version. */
export const APP_VERSION = "0.1.0";

/** Sort key of the singleton marker item. Partition key is the org-less `SCHEMA`. */
export const VERSION_ITEM = { pk: "SCHEMA", sk: "VERSION" } as const;

export interface DeployedVersion {
  /** Application version last deployed. */
  version: string;
  /** Data-shape version. Bumped only by a migration, never by a code release. */
  schemaVersion: number;
  /** ISO timestamp of the last successful deploy that touched this marker. */
  deployedAt: string;
}

/**
 * The schema version this build EXPECTS. A deploy whose expected version is
 * ahead of the stored one has migrations pending; more than one major ahead is
 * refused rather than run, so data cannot be skipped past a migration.
 */
export const EXPECTED_SCHEMA_VERSION = 1;
