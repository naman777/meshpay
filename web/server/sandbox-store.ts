import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { MeshEngine, type SandboxSnapshot } from "./sqlite-engine";
import { postgresConfig, postgresSchema } from "./postgres-config";
import { DEMO_SENDERS } from "../lib/wallet";
import type { State } from "../lib/types";

const LIFETIME = 60 * 60 * 1000;
const MAX_SESSIONS = 1000;
export class SandboxExpired extends Error {}
export class SandboxStore {
  private pool?: Pool;
  private ready?: Promise<void>;
  private closing?: Promise<void>;
  private memory = new Map<
    string,
    { snapshot: SandboxSnapshot; expires: number }
  >();
  constructor(connectionString?: string) {
    if (connectionString) {
      this.pool = new Pool({
        ...postgresConfig(connectionString),
        max: 3,
        connectionTimeoutMillis: 10000,
        idleTimeoutMillis: 10000,
      });
      this.pool.on("error", () =>
        console.error("Sandbox database idle connection failed"),
      );
    }
  }
  private async initialize() {
    if (!this.pool) return;
    this.ready ??= (async () => {
      const client = await this.pool!.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(778812, 2)");
        await client.query(`CREATE SCHEMA IF NOT EXISTS ${postgresSchema()}`);
        await client.query(
          "CREATE TABLE IF NOT EXISTS visitor_sandboxes (id TEXT PRIMARY KEY, snapshot JSONB NOT NULL, expires_at TIMESTAMPTZ NOT NULL)",
        );
        await client.query(
          "CREATE INDEX IF NOT EXISTS visitor_sandboxes_expiry ON visitor_sandboxes(expires_at)",
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    })();
    try {
      await this.ready;
    } catch (error) {
      this.ready = undefined;
      throw error;
    }
  }
  async create(
    publicKeys: Record<string, string>,
  ): Promise<{ session: string; state: State }> {
    const engine = new MeshEngine(":memory:");
    let snapshot: SandboxSnapshot, state: State;
    try {
      for (const sender of DEMO_SENDERS)
        engine.registerPublicKey(sender, publicKeys[sender]);
      snapshot = engine.exportSandbox();
      state = engine.state();
    } finally {
      engine.close();
    }
    const session = randomBytes(32).toString("hex");
    if (this.pool) {
      await this.initialize();
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(778812, 2)");
        await client.query(
          "DELETE FROM visitor_sandboxes WHERE expires_at <= NOW()",
        );
        if (
          Number(
            (
              await client.query(
                "SELECT COUNT(*) AS count FROM visitor_sandboxes",
              )
            ).rows[0].count,
          ) >= MAX_SESSIONS
        )
          throw new Error("The demo is busy. Please try again shortly.");
        await client.query(
          "INSERT INTO visitor_sandboxes VALUES ($1,$2,NOW()+INTERVAL '1 hour')",
          [session, JSON.stringify(snapshot)],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    } else {
      for (const [id, value] of this.memory)
        if (value.expires <= Date.now()) this.memory.delete(id);
      if (this.memory.size >= MAX_SESSIONS)
        throw new Error("The demo is busy. Please try again shortly.");
      this.memory.set(session, { snapshot, expires: Date.now() + LIFETIME });
    }
    return { session, state };
  }
  async run(
    session: string,
    work: (engine: MeshEngine) => State,
  ): Promise<State> {
    if (!/^[a-f0-9]{64}$/.test(session))
      throw new SandboxExpired("Start a fresh demo to continue.");
    if (!this.pool) {
      const value = this.memory.get(session);
      if (!value || value.expires <= Date.now())
        throw new SandboxExpired("Your demo expired. Start fresh to continue.");
      const engine = MeshEngine.importSandbox(value.snapshot);
      try {
        const state = work(engine);
        const snapshot = engine.exportSandbox();
        this.checkSize(snapshot);
        this.memory.set(session, { snapshot, expires: Date.now() + LIFETIME });
        return state;
      } finally {
        engine.close();
      }
    }
    await this.initialize();
    const client = await this.pool.connect();
    let engine: MeshEngine | undefined;
    try {
      await client.query("BEGIN");
      const row = (
        await client.query(
          "SELECT snapshot FROM visitor_sandboxes WHERE id=$1 AND expires_at>NOW() FOR UPDATE",
          [session],
        )
      ).rows[0];
      if (!row)
        throw new SandboxExpired("Your demo expired. Start fresh to continue.");
      engine = MeshEngine.importSandbox(row.snapshot as SandboxSnapshot);
      const state = work(engine),
        snapshot = engine.exportSandbox();
      this.checkSize(snapshot);
      await client.query(
        "UPDATE visitor_sandboxes SET snapshot=$1, expires_at=NOW()+INTERVAL '1 hour' WHERE id=$2",
        [JSON.stringify(snapshot), session],
      );
      await client.query("COMMIT");
      return state;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      engine?.close();
      client.release();
    }
  }
  private checkSize(snapshot: SandboxSnapshot) {
    if (Buffer.byteLength(JSON.stringify(snapshot)) > 1000000)
      throw new Error("This demo is full. Start fresh to continue testing.");
  }
  async close() {
    this.closing ??= this.pool?.end() ?? Promise.resolve();
    await this.closing;
  }
}
const shared = globalThis as typeof globalThis & {
  meshSandboxStore?: SandboxStore;
};
export function getSandboxStore() {
  if (!shared.meshSandboxStore) {
    if (process.env.VERCEL && !process.env.DATABASE_URL)
      throw new Error("Set DATABASE_URL in Vercel before starting the demo.");
    shared.meshSandboxStore = new SandboxStore(process.env.DATABASE_URL);
  }
  return shared.meshSandboxStore;
}
