/**
 * CloudFormation custom-resource handler for install/upgrade migrations.
 *
 * Migrations run before the application Lambdas which depend on the custom
 * resource. The marker is written only after every ordered migration completes,
 * so `/version` never reports an upgrade that has not actually finished.
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { VERSION_ITEM, type DeployedVersion } from "@addressium/core";

interface CustomResourceEvent {
  RequestType: "Create" | "Update" | "Delete";
  PhysicalResourceId?: string;
  ResourceProperties: { ApplicationVersion: string; SchemaVersion: number | string };
}

interface DocumentClient {
  send(command: GetCommand | PutCommand): Promise<{ Item?: { data?: DeployedVersion } }>;
}

export interface Migration {
  /** The schema version after this idempotent migration has completed. */
  toVersion: number;
  apply(client: DocumentClient): Promise<void>;
}

/** Add a migration here when EXPECTED_SCHEMA_VERSION is increased. */
export const MIGRATIONS: readonly Migration[] = [];

export async function applyMigrations(
  client: DocumentClient,
  stored: DeployedVersion | undefined,
  targetSchemaVersion: number,
  migrations: readonly Migration[] = MIGRATIONS,
): Promise<void> {
  // Schema 1 is the original table shape. A pre-marker install already has it;
  // first deployment writes its marker without pretending a data rewrite ran.
  const current = stored?.schemaVersion ?? targetSchemaVersion;
  if (!Number.isInteger(targetSchemaVersion) || targetSchemaVersion < 1) {
    throw new Error(`invalid target schema version ${targetSchemaVersion}`);
  }
  if (current > targetSchemaVersion) {
    throw new Error(`refusing to deploy schema ${targetSchemaVersion} over newer installed schema ${current}`);
  }
  for (let version = current + 1; version <= targetSchemaVersion; version++) {
    const migration = migrations.find((candidate) => candidate.toVersion === version);
    if (!migration) throw new Error(`missing migration to schema ${version}`);
    await migration.apply(client);
  }
}

const document = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export async function migrationHandler(event: CustomResourceEvent) {
  // Stack removal must never delete history or mutate application data.
  if (event.RequestType === "Delete") {
    return { PhysicalResourceId: event.PhysicalResourceId ?? "addressium-schema" };
  }
  const tableName = process.env.TABLE_NAME;
  if (!tableName) throw new Error("missing env TABLE_NAME");
  const applicationVersion = event.ResourceProperties.ApplicationVersion;
  const schemaVersion = Number(event.ResourceProperties.SchemaVersion);
  if (!applicationVersion) throw new Error("missing ApplicationVersion");

  const existing = await document.send(new GetCommand({ TableName: tableName, Key: VERSION_ITEM }));
  await applyMigrations(document, existing.Item?.data, schemaVersion);
  const marker: DeployedVersion = {
    version: applicationVersion,
    schemaVersion,
    deployedAt: new Date().toISOString(),
  };
  await document.send(new PutCommand({ TableName: tableName, Item: { ...VERSION_ITEM, data: marker } }));
  return {
    PhysicalResourceId: "addressium-schema",
    Data: { version: marker.version, schemaVersion: marker.schemaVersion, deployedAt: marker.deployedAt },
  };
}
