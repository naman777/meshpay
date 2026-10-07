import { Pool, type PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { postgresConfig, postgresSchema } from "./postgres-config";
import { MeshNetwork, SEED_ACCOUNTS, type NetworkSnapshot } from "./network";
import {
  generateKeys,
  normalizeSigningKey,
  verifyAuthorization,
  proofRoot,
  encrypt,
  decrypt,
  hash,
} from "./crypto";
import {
  signedSendSchema,
  authorizationSchema,
  packetSchema,
} from "../lib/protocol";
import type {
  Account,
  State,
  SignedSend,
  SignedAuthorization,
  Packet,
  Result,
  FailureConfig,
} from "../lib/types";

class InvalidInstruction extends Error {}
export class PostgresEngine {
  private pool: Pool;
  private ready?: Promise<void>;
  constructor(connectionString: string) {
    this.pool = new Pool({
      ...postgresConfig(connectionString),
      max: 3,
      connectionTimeoutMillis: 10000,
      idleTimeoutMillis: 10000,
    });
    this.pool.on("error", () =>
      console.error("PostgreSQL idle connection failed"),
    );
  }
  private async ensureReady() {
    this.ready ??= this.initialize();
    try {
      await this.ready;
    } catch (error) {
      this.ready = undefined;
      throw error;
    }
  }
  private async initialize() {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(778812, 1)");
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${postgresSchema()}`);
      await client.query(`
        CREATE TABLE IF NOT EXISTS accounts (vpa TEXT PRIMARY KEY, name TEXT NOT NULL, balance BIGINT NOT NULL CHECK(balance >= 0), initials TEXT NOT NULL, color TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS server_keys (id INTEGER PRIMARY KEY, public_key TEXT NOT NULL, private_key TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS signing_keys (sender TEXT PRIMARY KEY REFERENCES accounts(vpa), public_key TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS ledger (id TEXT PRIMARY KEY, sender TEXT NOT NULL REFERENCES accounts(vpa), receiver TEXT NOT NULL REFERENCES accounts(vpa), amount BIGINT NOT NULL CHECK(amount > 0), status TEXT NOT NULL, created_at BIGINT NOT NULL, bridge TEXT NOT NULL, hash TEXT UNIQUE NOT NULL, nonce TEXT NOT NULL, reason TEXT, UNIQUE(sender, nonce));
        CREATE TABLE IF NOT EXISTS mesh_session (id INTEGER PRIMARY KEY CHECK(id=1), snapshot JSONB NOT NULL);
      `);
      for (const a of SEED_ACCOUNTS)
        await client.query(
          "INSERT INTO accounts VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
          [a.vpa, a.name, a.balance, a.initials, a.color],
        );
      if (
        !(await client.query("SELECT id FROM server_keys WHERE id=1")).rowCount
      ) {
        const keys = generateKeys();
        await client.query("INSERT INTO server_keys VALUES (1,$1,$2)", [
          keys.publicKey,
          keys.privateKey,
        ]);
      }
      await client.query(
        "INSERT INTO mesh_session VALUES (1,$1) ON CONFLICT DO NOTHING",
        [JSON.stringify(new MeshNetwork().snapshot())],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  private async transaction<T>(
    work: (client: PoolClient, network: MeshNetwork) => Promise<T>,
  ): Promise<T> {
    await this.ensureReady();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const row = (
        await client.query(
          "SELECT snapshot FROM mesh_session WHERE id=1 FOR UPDATE",
        )
      ).rows[0];
      const network = MeshNetwork.restore(row.snapshot as NetworkSnapshot);
      const value = await work(client, network);
      await client.query("UPDATE mesh_session SET snapshot=$1 WHERE id=1", [
        JSON.stringify(network.snapshot()),
      ]);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  private async validate(
    client: PoolClient,
    auth: SignedAuthorization,
    id: string,
    ttl: number,
    proof: string,
  ) {
    const { sender, receiver, signedAt } = auth.instruction;
    const registered = (
      await client.query(
        "SELECT public_key FROM signing_keys WHERE sender=$1",
        [sender],
      )
    ).rows[0];
    if (!registered || !verifyAuthorization(auth, registered.public_key))
      throw new InvalidInstruction(
        "Invalid sender signature or unregistered sender key",
      );
    if (
      auth.packetId !== id ||
      ttl > auth.maxTtl ||
      proofRoot(proof, ttl) !== auth.hopRoot
    )
      throw new InvalidInstruction(
        "Packet ID or TTL proof does not match signed authorization",
      );
    const age = Date.now() - signedAt;
    if (age > 86400000 || age < -300000)
      throw new InvalidInstruction("Payment timestamp outside accepted window");
    if (sender === receiver)
      throw new InvalidInstruction("Choose a different receiver");
    if (
      (
        await client.query(
          "SELECT vpa FROM accounts WHERE vpa=ANY($1::text[])",
          [[sender, receiver]],
        )
      ).rowCount !== 2
    )
      throw new InvalidInstruction("Unknown account");
  }
  private async packet(client: PoolClient, input: SignedSend): Promise<Packet> {
    const { authorization: auth, hopProof } = signedSendSchema.parse(input);
    await this.validate(client, auth, auth.packetId, auth.maxTtl, hopProof);
    const keys = (
      await client.query("SELECT public_key FROM server_keys WHERE id=1")
    ).rows[0];
    return {
      id: auth.packetId,
      ttl: auth.maxTtl,
      hopProof,
      ciphertext: encrypt(auth, keys.public_key),
    };
  }
  private async settle(
    client: PoolClient,
    network: MeshNetwork,
    input: Packet,
    bridge: string,
  ): Promise<Result> {
    const keys = (
      await client.query("SELECT private_key FROM server_keys WHERE id=1")
    ).rows[0];
    let packet: Packet, auth: SignedAuthorization;
    try {
      packet = packetSchema.parse(input);
      auth = authorizationSchema.parse(
        decrypt(packet.ciphertext, keys.private_key),
      );
    } catch {
      return {
        outcome: "INVALID",
        reason:
          "Invalid payload, sender signature, timestamp, or packet metadata",
      };
    }
    // Database failures propagate; only validation errors are invalid instructions.
    try {
      await this.validate(client, auth, packet.id, packet.ttl, packet.hopProof);
    } catch (error) {
      if (!(error instanceof InvalidInstruction)) throw error;
      return {
        outcome: "INVALID",
        reason:
          "Invalid payload, sender signature, timestamp, or packet metadata",
      };
    }
    const i = auth.instruction,
      digest = hash(packet.ciphertext);
    const previous = (
      await client.query(
        "SELECT id FROM ledger WHERE hash=$1 OR (sender=$2 AND nonce=$3)",
        [digest, i.sender, i.nonce],
      )
    ).rows[0];
    if (previous) {
      network.recordDuplicate(bridge);
      return { outcome: "DUPLICATE_DROPPED", transactionId: previous.id };
    }
    const sender = (
      await client.query(
        "SELECT balance FROM accounts WHERE vpa=$1 FOR UPDATE",
        [i.sender],
      )
    ).rows[0];
    const status = Number(sender.balance) < i.amount ? "REJECTED" : "SETTLED";
    const reason = status === "REJECTED" ? "Insufficient balance" : null;
    if (status === "SETTLED") {
      await client.query(
        "UPDATE accounts SET balance=balance-$1 WHERE vpa=$2",
        [i.amount, i.sender],
      );
      await client.query(
        "UPDATE accounts SET balance=balance+$1 WHERE vpa=$2",
        [i.amount, i.receiver],
      );
    }
    const id = randomUUID();
    await client.query(
      "INSERT INTO ledger VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
      [
        id,
        i.sender,
        i.receiver,
        i.amount,
        status,
        Date.now(),
        bridge,
        digest,
        i.nonce,
        reason,
      ],
    );
    network.recordSettlement(bridge, i.amount, status, reason);
    return {
      outcome: status,
      transactionId: id,
      ...(reason ? { reason } : {}),
    };
  }
  private async flushNetwork(client: PoolClient, network: MeshNetwork) {
    const results: Result[] = [];
    for (const d of network
      .describe(0)
      .devices.slice(3)
      .filter((d) => d.online))
      for (const p of d.packets)
        results.push(await this.settle(client, network, p, d.name));
    if (!results.length)
      network.log(
        "system",
        "No packets at an online bridge. Advance gossip or restore bridge connectivity.",
      );
    return results;
  }
  registerPublicKey(sender: string, publicKey: string) {
    return this.transaction(async (client) => {
      const normalized = normalizeSigningKey(publicKey);
      if (
        !(await client.query("SELECT vpa FROM accounts WHERE vpa=$1", [sender]))
          .rowCount
      )
        throw new Error("Unknown account");
      await client.query(
        "INSERT INTO signing_keys VALUES ($1,$2) ON CONFLICT DO NOTHING",
        [sender, normalized],
      );
      if (
        (
          await client.query(
            "SELECT public_key FROM signing_keys WHERE sender=$1",
            [sender],
          )
        ).rows[0].public_key !== normalized
      )
        throw new Error(
          "Account already has a different registered key; key replacement is not allowed",
        );
    });
  }
  state(): Promise<State> {
    return this.transaction(async (client, network) => {
      const accounts = (
        await client.query(
          'SELECT a.*, k.public_key AS "signingPublicKey" FROM accounts a LEFT JOIN signing_keys k ON k.sender=a.vpa ORDER BY a.vpa',
        )
      ).rows.map((a) => ({ ...a, balance: Number(a.balance) })) as Account[];
      const transactions = (
        await client.query(
          'SELECT id,sender,receiver,amount,status,created_at AS "createdAt",bridge,hash,nonce,reason FROM ledger ORDER BY created_at DESC,id DESC LIMIT 100',
        )
      ).rows.map((t) => ({
        ...t,
        amount: Number(t.amount),
        createdAt: Number(t.createdAt),
      }));
      let processed = 0;
      for (const i of network.queuedInstructions())
        if (
          (
            await client.query(
              "SELECT id FROM ledger WHERE sender=$1 AND nonce=$2",
              [i.sender, i.nonce],
            )
          ).rowCount
        )
          processed++;
      return { accounts, transactions, ...network.describe(processed) };
    });
  }
  createPacket(input: SignedSend) {
    return this.transaction((client) => this.packet(client, input));
  }
  send(input: SignedSend) {
    return this.transaction(async (client, network) => {
      const packet = await this.packet(client, input);
      network.queuePacket(packet, input.authorization);
      return packet;
    });
  }
  ingest(packet: Packet, bridge: string) {
    return this.transaction((client, network) =>
      this.settle(client, network, packet, bridge),
    );
  }
  gossip() {
    return this.transaction(async (_client, network) => network.gossip());
  }
  resetMesh() {
    return this.transaction(async (_client, network) => network.resetMesh());
  }
  configureFailures(failures: FailureConfig) {
    return this.transaction(async (_client, network) =>
      network.configureFailures(failures),
    );
  }
  flush() {
    return this.transaction((client, network) =>
      this.flushNetwork(client, network),
    );
  }
  demo(input: SignedSend) {
    return this.transaction(async (client, network) => {
      const packet = await this.packet(client, input);
      const i = input.authorization.instruction;
      if (
        i.sender !== "alice@demo" ||
        i.receiver !== "bob@demo" ||
        i.amount !== 50000
      )
        throw new Error("Demo requires a signed ₹500 Alice to Bob instruction");
      network.resetMesh();
      network.queuePacket(packet, input.authorization);
      network.gossip();
      network.gossip();
      await this.flushNetwork(client, network);
    });
  }
  async getPublicKey() {
    await this.ensureReady();
    return (
      await this.pool.query("SELECT public_key FROM server_keys WHERE id=1")
    ).rows[0].public_key as string;
  }
  async close() {
    try {
      await this.ready;
    } finally {
      await this.pool.end();
    }
  }
}
