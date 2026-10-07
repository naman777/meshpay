import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { decrypt, encrypt, generateKeys, hash } from "./crypto";
import type {
  Account,
  Device,
  Instruction,
  LedgerEntry,
  MeshEvent,
  Packet,
  Result,
  State,
} from "../lib/types";

const instructionSchema = z.object({
  sender: z.string().min(1),
  receiver: z.string().min(1),
  amount: z.number().int().positive().max(100_000_000),
  nonce: z.uuid(),
  signedAt: z.number().int().nonnegative(),
});
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
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS accounts (vpa TEXT PRIMARY KEY, name TEXT NOT NULL, balance INTEGER NOT NULL CHECK(balance >= 0), initials TEXT NOT NULL, color TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS keys (id INTEGER PRIMARY KEY, publicKey TEXT NOT NULL, privateKey TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ledger (id TEXT PRIMARY KEY, sender TEXT NOT NULL, receiver TEXT NOT NULL, amount INTEGER NOT NULL, status TEXT NOT NULL, createdAt INTEGER NOT NULL, bridge TEXT NOT NULL, hash TEXT UNIQUE NOT NULL, nonce TEXT NOT NULL, reason TEXT, UNIQUE(sender, nonce));`);
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
    this.resetMesh();
  }
  log(kind: MeshEvent["kind"], message: string) {
    this.events.unshift({ id: randomUUID(), time: Date.now(), kind, message });
    this.events = this.events.slice(0, 60);
  }
  resetMesh() {
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
    return {
      accounts: this.db
        .prepare("SELECT * FROM accounts ORDER BY rowid")
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
    };
  }
  createPacket(sender: string, receiver: string, amount: number): Packet {
    const instruction = instructionSchema.parse({
      sender,
      receiver,
      amount,
      nonce: randomUUID(),
      signedAt: Date.now(),
    });
    if (sender === receiver) throw new Error("Choose a different receiver");
    for (const vpa of [sender, receiver])
      if (!this.db.prepare("SELECT vpa FROM accounts WHERE vpa=?").get(vpa))
        throw new Error("Unknown account");
    return {
      id: randomUUID(),
      ttl: 5,
      ciphertext: encrypt(instruction, this.keys.publicKey),
    };
  }
  send(sender: string, receiver: string, amount: number) {
    const packet = this.createPacket(sender, receiver, amount);
    this.devices[0].packets.push(packet);
    this.log(
      "payment",
      `₹${(amount / 100).toFixed(2)} from ${sender.split("@")[0]} to ${receiver.split("@")[0]} encrypted and queued.`,
    );
    return packet;
  }
  // A sparse topology makes every round an actual hop, instead of a complete graph.
  gossip() {
    const edges = [
      [0, 1],
      [0, 2],
      [1, 3],
      [2, 4],
      [1, 2],
    ];
    const snapshot = this.devices.map((d) => [...d.packets]);
    let count = 0;
    for (const [a, b] of edges)
      for (const [src, dst] of [
        [a, b],
        [b, a],
      ]) {
        for (const packet of snapshot[src]) {
          if (
            packet.ttl <= 0 ||
            this.devices[dst].packets.some((p) => p.id === packet.id)
          )
            continue;
          this.devices[dst].packets.push({ ...packet, ttl: packet.ttl - 1 });
          count++;
        }
      }
    this.rounds++;
    this.transfers += count;
    this.log(
      "gossip",
      `Round ${this.rounds}: ${count} packet transfers across nearby devices.`,
    );
    return count;
  }
  ingest(packet: Packet, bridge: string): Result {
    let instruction: Instruction, packetHash: string;
    try {
      packetHash = hash(packet.ciphertext);
      instruction = instructionSchema.parse(
        decrypt(packet.ciphertext, this.keys.privateKey),
      );
    } catch {
      return {
        outcome: "INVALID",
        reason: "Invalid or tampered encrypted payload",
      };
    }
    const age = Date.now() - instruction.signedAt;
    if (age > 86_400_000 || age < -300_000)
      return {
        outcome: "INVALID",
        reason: "Payment timestamp outside accepted window",
      };
    if (instruction.sender === instruction.receiver)
      return { outcome: "INVALID", reason: "Sender and receiver must differ" };
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
    for (const device of this.devices.filter((d) => d.online))
      for (const packet of device.packets)
        results.push(this.ingest(packet, device.name));
    if (!results.length)
      this.log(
        "system",
        "No packets at the bridges yet. Run another gossip round.",
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
