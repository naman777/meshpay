import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  decrypt,
  encrypt,
  generateKeys,
  hash,
  advanceProof,
  proofRoot,
  normalizeSigningKey,
  verifyAuthorization,
} from "./crypto";
import {
  authorizationSchema,
  signedSendSchema,
  packetSchema,
  failureSchema,
  signingText,
} from "../lib/protocol";
import type {
  Account,
  Device,
  SignedAuthorization,
  SignedSend,
  FailureConfig,
  LedgerEntry,
  MeshEvent,
  Packet,
  Result,
  State,
} from "../lib/types";

export const DEFAULT_FAILURES: FailureConfig = {
  lossRate: 0,
  delayRounds: 0,
  partitioned: false,
  offlineBridges: [],
  seed: 1,
};
const EDGES = [
  [0, 1],
  [0, 2],
  [1, 3],
  [2, 4],
  [1, 2],
];
const seeds: Account[] = [
  {
    vpa: "alice@demo",
    name: "Alice",
    balance: 500000,
    initials: "AL",
    color: "purple",
  },
  {
    vpa: "bob@demo",
    name: "Bob",
    balance: 100000,
    initials: "BO",
    color: "orange",
  },
  {
    vpa: "carol@demo",
    name: "Carol",
    balance: 250000,
    initials: "CA",
    color: "green",
  },
  {
    vpa: "dave@demo",
    name: "Dave",
    balance: 50000,
    initials: "DA",
    color: "blue",
  },
];
export class MeshEngine {
  private db: DatabaseSync;
  private keys: { publicKey: string; privateKey: string };
  devices: Device[] = [];
  events: MeshEvent[] = [];
  rounds = 0;
  duplicates = 0;
  transfers = 0;
  failures: FailureConfig = structuredClone(DEFAULT_FAILURES);
  private randomState = 1;
  private dropped = 0;
  private delayed: { src: number; dst: number; packet: Packet; due: number }[] =
    [];
  private sent = new Map<
    string,
    { sender: string; nonce: string; authorization: string }
  >();
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (vpa TEXT PRIMARY KEY, name TEXT NOT NULL, balance INTEGER NOT NULL CHECK(balance >= 0), initials TEXT NOT NULL, color TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS keys (id INTEGER PRIMARY KEY, publicKey TEXT NOT NULL, privateKey TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ledger (id TEXT PRIMARY KEY, sender TEXT NOT NULL, receiver TEXT NOT NULL, amount INTEGER NOT NULL, status TEXT NOT NULL, createdAt INTEGER NOT NULL, bridge TEXT NOT NULL, hash TEXT UNIQUE NOT NULL, nonce TEXT NOT NULL, reason TEXT, UNIQUE(sender, nonce));
      CREATE TABLE IF NOT EXISTS signing_keys (sender TEXT PRIMARY KEY, publicKey TEXT NOT NULL);`);
      const existing = this.db
        .prepare("SELECT publicKey, privateKey FROM keys WHERE id=1")
        .get();
      this.keys = existing ? (existing as typeof this.keys) : generateKeys();
      if (!existing)
        this.db
          .prepare("INSERT INTO keys VALUES (1, ?, ?)")
          .run(this.keys.publicKey, this.keys.privateKey);
      const insert = this.db.prepare(
        "INSERT OR IGNORE INTO accounts VALUES (?, ?, ?, ?, ?)",
      );
      seeds.forEach((a) =>
        insert.run(a.vpa, a.name, a.balance, a.initials, a.color),
      );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      this.db.close();
      throw error;
    }
    this.resetMesh();
  }
  // Trusted local provisioning only. No HTTP route can enroll or replace a key.
  registerPublicKey(sender: string, publicKey: string) {
    if (!this.db.prepare("SELECT vpa FROM accounts WHERE vpa=?").get(sender))
      throw new Error("Unknown account");
    const normalized = normalizeSigningKey(publicKey);
    this.db
      .prepare("INSERT OR IGNORE INTO signing_keys VALUES (?, ?)")
      .run(sender, normalized);
    if (
      this.db
        .prepare("SELECT publicKey FROM signing_keys WHERE sender=?")
        .get(sender)?.publicKey !== normalized
    ) {
      throw new Error(
        "Account already has a different registered key; key replacement is not allowed",
      );
    }
  }
  log(kind: MeshEvent["kind"], message: string) {
    this.events.unshift({ id: randomUUID(), time: Date.now(), kind, message });
    this.events = this.events.slice(0, 60);
  }
  resetMesh() {
    this.failures = structuredClone(DEFAULT_FAILURES);
    this.randomState = this.failures.seed;
    this.dropped = 0;
    this.delayed = [];
    this.sent.clear();
    this.devices = [
      {
        id: "alice",
        name: "Sender phone",
        owner: "Sender",
        online: false,
        x: 105,
        y: 165,
        packets: [],
      },
      {
        id: "relay-1",
        name: "Relay 01",
        owner: "Offline relay",
        online: false,
        x: 280,
        y: 85,
        packets: [],
      },
      {
        id: "relay-2",
        name: "Relay 02",
        owner: "Offline relay",
        online: false,
        x: 280,
        y: 245,
        packets: [],
      },
      {
        id: "bridge-1",
        name: "Bridge 01",
        owner: "Internet available",
        online: true,
        x: 455,
        y: 85,
        packets: [],
      },
      {
        id: "bridge-2",
        name: "Bridge 02",
        owner: "Internet available",
        online: true,
        x: 455,
        y: 245,
        packets: [],
      },
    ];
    this.rounds = 0;
    this.duplicates = 0;
    this.transfers = 0;
    this.events = [];
    this.log("system", "Mesh ready. Five devices, two internet bridges.");
  }
  state(): State {
    let processed = 0;
    for (const { sender, nonce } of this.sent.values()) {
      if (
        this.db
          .prepare("SELECT id FROM ledger WHERE sender=? AND nonce=?")
          .get(sender, nonce)
      )
        processed++;
    }
    const bridgeReached = [...this.sent.keys()].filter((id) =>
      this.devices.slice(3).some((d) => d.packets.some((p) => p.id === id)),
    ).length;
    return {
      accounts: this.db
        .prepare(
          "SELECT a.*, k.publicKey AS signingPublicKey FROM accounts a LEFT JOIN signing_keys k ON k.sender=a.vpa ORDER BY a.rowid",
        )
        .all() as Account[],
      devices: this.devices,
      transactions: this.db
        .prepare(
          "SELECT * FROM ledger ORDER BY createdAt DESC, rowid DESC LIMIT 100",
        )
        .all() as LedgerEntry[],
      events: this.events,
      rounds: this.rounds,
      duplicates: this.duplicates,
      transfers: this.transfers,
      failures: structuredClone(this.failures),
      convergence: {
        queued: this.sent.size,
        processed,
        pending: this.sent.size - processed,
        bridgeReached,
        delayed: this.delayed.length,
        dropped: this.dropped,
        converged: this.sent.size > 0 && processed === this.sent.size,
      },
    };
  }
  private validateAuthorization(
    auth: SignedAuthorization,
    packetId: string,
    ttl: number,
    hopProof: string,
  ) {
    const { sender, receiver, signedAt } = auth.instruction;
    const registered = this.db
      .prepare("SELECT publicKey FROM signing_keys WHERE sender=?")
      .get(sender);
    if (
      !registered ||
      !verifyAuthorization(auth, registered.publicKey as string)
    )
      throw new Error("Invalid sender signature or unregistered sender key");
    if (
      auth.packetId !== packetId ||
      ttl > auth.maxTtl ||
      proofRoot(hopProof, ttl) !== auth.hopRoot
    )
      throw new Error(
        "Packet ID or TTL proof does not match signed authorization",
      );
    const age = Date.now() - signedAt;
    if (age > 86_400_000 || age < -300_000)
      throw new Error("Payment timestamp outside accepted window");
    if (sender === receiver) throw new Error("Choose a different receiver");
    for (const vpa of [sender, receiver])
      if (!this.db.prepare("SELECT vpa FROM accounts WHERE vpa=?").get(vpa))
        throw new Error("Unknown account");
  }
  createPacket(input: SignedSend): Packet {
    const { authorization: auth, hopProof } = signedSendSchema.parse(input);
    this.validateAuthorization(auth, auth.packetId, auth.maxTtl, hopProof);
    return {
      id: auth.packetId,
      ttl: auth.maxTtl,
      hopProof,
      ciphertext: encrypt(auth, this.keys.publicKey),
    };
  }
  send(input: SignedSend) {
    const packet = this.createPacket(input);
    const { sender, receiver, amount, nonce } = input.authorization.instruction;
    const authorization = signingText(input.authorization);
    if (
      this.sent.has(packet.id) &&
      this.sent.get(packet.id)!.authorization !== authorization
    )
      throw new Error(
        "Packet ID is already queued with a different authorization",
      );
    if (!this.devices[0].packets.some((p) => p.id === packet.id))
      this.devices[0].packets.push(packet);
    this.sent.set(packet.id, { sender, nonce, authorization });
    this.log(
      "payment",
      `₹${(amount / 100).toFixed(2)} from ${sender.split("@")[0]} to ${receiver.split("@")[0]} signature verified, encrypted and queued.`,
    );
    return packet;
  }
  configureFailures(config: FailureConfig) {
    const parsed = failureSchema.parse(config);
    if (parsed.seed !== this.failures.seed) this.randomState = parsed.seed;
    this.failures = parsed;
    for (const device of this.devices.slice(3))
      device.online = !this.failures.offlineBridges.includes(device.id);
    this.log(
      "system",
      `Network configured: ${Math.round(parsed.lossRate * 100)}% loss, ${parsed.delayRounds} rounds delay, partition ${parsed.partitioned ? "on" : "off"}, ${parsed.offlineBridges.length} offline bridges.`,
    );
  }
  private random() {
    let x = this.randomState;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.randomState = x >>> 0;
    return this.randomState / 0x100000000;
  }
  private linkOpen(src: number, dst: number) {
    return !this.failures.partitioned || (src < 3 && dst < 3);
  }
  // A sparse topology makes every round an actual hop, instead of a complete graph.
  gossip() {
    const snapshot = this.devices.map((d) => [...d.packets]);
    this.rounds++;
    let count = 0;
    this.delayed = this.delayed.filter((transfer) => {
      if (
        transfer.due > this.rounds ||
        !this.linkOpen(transfer.src, transfer.dst)
      )
        return true;
      if (
        !this.devices[transfer.dst].packets.some(
          (p) => p.id === transfer.packet.id,
        )
      ) {
        this.devices[transfer.dst].packets.push(transfer.packet);
        count++;
      }
      return false;
    });
    let dropped = 0;
    for (const [a, b] of EDGES)
      for (const [src, dst] of [
        [a, b],
        [b, a],
      ]) {
        for (const packet of snapshot[src]) {
          if (
            packet.ttl <= 0 ||
            !this.linkOpen(src, dst) ||
            this.devices[dst].packets.some((p) => p.id === packet.id) ||
            this.delayed.some((t) => t.dst === dst && t.packet.id === packet.id)
          )
            continue;
          if (this.random() < this.failures.lossRate) {
            dropped++;
            continue;
          }
          const forwarded = {
            ...packet,
            ttl: packet.ttl - 1,
            hopProof: advanceProof(packet.hopProof),
          };
          if (this.failures.delayRounds > 0) {
            this.delayed.push({
              src,
              dst,
              packet: forwarded,
              due: this.rounds + this.failures.delayRounds,
            });
          } else {
            this.devices[dst].packets.push(forwarded);
            count++;
          }
        }
      }
    this.dropped += dropped;
    this.transfers += count;
    this.log(
      "gossip",
      `Round ${this.rounds}: ${count} transfers, ${dropped} lost attempts, ${this.delayed.length} delayed copies.`,
    );
    return count;
  }
  ingest(packet: Packet, bridge: string): Result {
    let auth: SignedAuthorization, packetHash: string;
    try {
      packet = packetSchema.parse(packet);
      packetHash = hash(packet.ciphertext);
      auth = authorizationSchema.parse(
        decrypt(packet.ciphertext, this.keys.privateKey),
      );
      this.validateAuthorization(auth, packet.id, packet.ttl, packet.hopProof);
    } catch {
      return {
        outcome: "INVALID",
        reason:
          "Invalid payload, sender signature, timestamp, or packet metadata",
      };
    }
    const instruction = auth.instruction;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const previous = this.db
        .prepare("SELECT id FROM ledger WHERE hash=? OR (sender=? AND nonce=?)")
        .get(packetHash, instruction.sender, instruction.nonce);
      if (previous) {
        this.db.exec("COMMIT");
        this.duplicates++;
        this.log("duplicate", `${bridge}: duplicate delivery safely dropped.`);
        return {
          outcome: "DUPLICATE_DROPPED",
          transactionId: previous.id as string,
        };
      }
      const sender = this.db
        .prepare("SELECT balance FROM accounts WHERE vpa=?")
        .get(instruction.sender);
      const receiver = this.db
        .prepare("SELECT balance FROM accounts WHERE vpa=?")
        .get(instruction.receiver);
      if (!sender || !receiver) {
        this.db.exec("ROLLBACK");
        return { outcome: "INVALID", reason: "Unknown account" };
      }
      const status =
        Number(sender.balance) < instruction.amount ? "REJECTED" : "SETTLED";
      const reason = status === "REJECTED" ? "Insufficient balance" : null;
      if (status === "SETTLED") {
        this.db
          .prepare("UPDATE accounts SET balance=balance-? WHERE vpa=?")
          .run(instruction.amount, instruction.sender);
        this.db
          .prepare("UPDATE accounts SET balance=balance+? WHERE vpa=?")
          .run(instruction.amount, instruction.receiver);
      }
      const id = randomUUID();
      this.db
        .prepare("INSERT INTO ledger VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(
          id,
          instruction.sender,
          instruction.receiver,
          instruction.amount,
          status,
          Date.now(),
          bridge,
          packetHash,
          instruction.nonce,
          reason,
        );
      this.db.exec("COMMIT");
      this.log(
        status === "SETTLED" ? "settled" : "rejected",
        `${bridge}: ₹${(instruction.amount / 100).toFixed(2)} ${status.toLowerCase()}${reason ? ` — ${reason}` : ". Balance updated once."}`,
      );
      return {
        outcome: status,
        transactionId: id,
        ...(reason ? { reason } : {}),
      };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  flush() {
    const results: Result[] = [];
    for (const device of this.devices.slice(3).filter((d) => d.online))
      for (const packet of device.packets)
        results.push(this.ingest(packet, device.name));
    if (!results.length)
      this.log(
        "system",
        "No packets at an online bridge. Advance gossip or restore bridge connectivity.",
      );
    return results;
  }
  getPublicKey() {
    return this.keys.publicKey;
  }
  close() {
    this.db.close();
  }
}
const globalEngine = globalThis as typeof globalThis & {
  meshEngine?: MeshEngine;
};
export function getEngine() {
  if (!globalEngine.meshEngine) {
    const dir = join(process.cwd(), ".data");
    mkdirSync(dir, { recursive: true });
    globalEngine.meshEngine = new MeshEngine(join(dir, "meshpay.sqlite"));
  }
  return globalEngine.meshEngine;
}
