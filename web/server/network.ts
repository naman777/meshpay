import { randomUUID } from "node:crypto";
import { advanceProof } from "./crypto";
import { failureSchema, signingText } from "../lib/protocol";
import type {
  Account,
  Device,
  Packet,
  MeshEvent,
  FailureConfig,
  SignedAuthorization,
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
export const SEED_ACCOUNTS: Account[] = [
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

export type NetworkSnapshot = {
  version: 1;
  devices: Device[];
  events: MeshEvent[];
  rounds: number;
  duplicates: number;
  transfers: number;
  failures: FailureConfig;
  randomState: number;
  dropped: number;
  delayed: { src: number; dst: number; packet: Packet; due: number }[];
  sent: [string, { sender: string; nonce: string; authorization: string }][];
};

export class MeshNetwork {
  devices: Device[] = [];
  events: MeshEvent[] = [];
  rounds = 0;
  duplicates = 0;
  transfers = 0;
  failures: FailureConfig = structuredClone(DEFAULT_FAILURES);
  protected randomState = 1;
  protected dropped = 0;
  protected delayed: {
    src: number;
    dst: number;
    packet: Packet;
    due: number;
  }[] = [];
  protected sent = new Map<
    string,
    { sender: string; nonce: string; authorization: string }
  >();

  constructor() {
    this.resetMesh();
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

  queuePacket(packet: Packet, authorizationValue: SignedAuthorization) {
    const { sender, receiver, amount, nonce } = authorizationValue.instruction;
    const authorization = signingText(authorizationValue);
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

  recordDuplicate(bridge: string) {
    this.duplicates++;
    this.log("duplicate", `${bridge}: duplicate delivery safely dropped.`);
  }
  recordSettlement(
    bridge: string,
    amount: number,
    status: "SETTLED" | "REJECTED",
    reason: string | null,
  ) {
    this.log(
      status === "SETTLED" ? "settled" : "rejected",
      `${bridge}: ₹${(amount / 100).toFixed(2)} ${status.toLowerCase()}${reason ? ` — ${reason}` : ". Balance updated once."}`,
    );
  }
  queuedInstructions() {
    return [...this.sent.values()];
  }
  describe(
    processed: number,
  ): Pick<
    State,
    | "devices"
    | "events"
    | "rounds"
    | "duplicates"
    | "transfers"
    | "failures"
    | "convergence"
  > {
    const bridgeReached = [...this.sent.keys()].filter((id) =>
      this.devices.slice(3).some((d) => d.packets.some((p) => p.id === id)),
    ).length;
    return {
      devices: this.devices,
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
  snapshot(): NetworkSnapshot {
    return structuredClone({
      version: 1,
      devices: this.devices,
      events: this.events,
      rounds: this.rounds,
      duplicates: this.duplicates,
      transfers: this.transfers,
      failures: this.failures,
      randomState: this.randomState,
      dropped: this.dropped,
      delayed: this.delayed,
      sent: [...this.sent.entries()],
    });
  }
  static restore(snapshot: NetworkSnapshot): MeshNetwork {
    if (snapshot.version !== 1)
      throw new Error("Unsupported persisted mesh state version");
    const network = new MeshNetwork();
    const value = structuredClone(snapshot);
    network.devices = value.devices;
    network.events = value.events;
    network.rounds = value.rounds;
    network.duplicates = value.duplicates;
    network.transfers = value.transfers;
    network.failures = value.failures;
    network.randomState = value.randomState;
    network.dropped = value.dropped;
    network.delayed = value.delayed;
    network.sent = new Map(value.sent);
    return network;
  }
}
