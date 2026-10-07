import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { MeshEngine } from "./sqlite-engine";
import { PostgresEngine } from "./postgres-engine";
export class StorageConfigurationError extends Error {}
const shared = globalThis as typeof globalThis & {
  meshEngine?: MeshEngine | PostgresEngine;
  meshEngineCreation?: Promise<MeshEngine | PostgresEngine>;
};
export async function getEngine() {
  if (shared.meshEngine) return shared.meshEngine;
  shared.meshEngineCreation ??= (async () => {
    if (process.env.DATABASE_URL)
      return new PostgresEngine(process.env.DATABASE_URL);
    else {
      if (process.env.VERCEL)
        throw new StorageConfigurationError(
          "Set DATABASE_URL in Vercel to connect PostgreSQL, then redeploy.",
        );
      const { MeshEngine } = await import("./sqlite-engine");
      const dir = join(process.cwd(), ".data");
      mkdirSync(dir, { recursive: true });
      return new MeshEngine(join(dir, "meshpay.sqlite"));
    }
  })();
  try {
    shared.meshEngine = await shared.meshEngineCreation;
    return shared.meshEngine;
  } finally {
    shared.meshEngineCreation = undefined;
  }
}
export function storageFailure(error: unknown) {
  if (error instanceof StorageConfigurationError)
    return Response.json({ error: error.message }, { status: 503 });
  if (
    error instanceof Error &&
    "code" in error &&
    [
      "SELF_SIGNED_CERT_IN_CHAIN",
      "DEPTH_ZERO_SELF_SIGNED_CERT",
      "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    ].includes(String(error.code))
  )
    return Response.json(
      {
        error:
          "Database certificate verification failed. Set DATABASE_CA_CERT to the CA certificate from your database provider.",
      },
      { status: 503 },
    );
  if (error instanceof Error && "code" in error)
    return Response.json(
      {
        error:
          "Database unavailable. Check DATABASE_URL and database connectivity.",
      },
      { status: 503 },
    );
  return null;
}
