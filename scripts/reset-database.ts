import { loadEnvConfig } from "@next/env";
import { Pool } from "pg";
import { postgresConfig, postgresSchema } from "../web/server/postgres-config";
loadEnvConfig(process.cwd());
async function main() {
  if (!process.argv.includes("--confirm-reset"))
    throw new Error(
      "This deletes MeshPay data. Run with --confirm-reset to proceed.",
    );
  if (!process.env.DATABASE_URL)
    throw new Error("Set DATABASE_URL before resetting PostgreSQL.");
  const pool = new Pool({
    ...postgresConfig(process.env.DATABASE_URL),
    connectionTimeoutMillis: 10000,
  });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(778812, 1)");
    await client.query(`DROP SCHEMA IF EXISTS ${postgresSchema()} CASCADE`);
    await client.query("COMMIT");
    console.log(
      "MeshPay tables reset. Run npm run wallets:create to initialize and register demo wallets.",
    );
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}
main().catch((error) => {
  console.error(
    error instanceof Error && !("code" in error)
      ? error.message
      : "Database reset failed. Check database connectivity and table dependencies.",
  );
  process.exitCode = 1;
});
