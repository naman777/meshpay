import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { MeshEngine, DEFAULT_FAILURES } from "../web/server/engine";
import {
  encrypt,
  decrypt,
  generateKeys,
  generateSigningKeys,
  signAuthorization,
  advanceProof,
} from "../web/server/crypto";
import { importWallet, createSignedSend, parseAmount } from "../web/lib/wallet";
import { provision, signedSend } from "./helpers/fixtures";
import type { Packet, SignedSend } from "../web/lib/types";

function engineTest(
  name: string,
  fn: (
    engine: MeshEngine,
    send: (
      sender?: string,
      receiver?: string,
      amount?: number,
      overrides?: Record<string, unknown>,
    ) => SignedSend,
  ) => void | Promise<void>,
) {
  test(name, async () => {
    const engine = new MeshEngine(":memory:");
    try {
      const keys = provision(engine);
      await fn(
        engine,
        (
          sender = "alice@demo",
          receiver = "bob@demo",
          amount = 50000,
          overrides = {},
        ) =>
          signedSend(
            keys.get(sender)?.privateKey ?? keys.get("alice@demo")!.privateKey,
            sender,
            receiver,
            amount,
            overrides,
          ),
      );
    } finally {
      engine.close();
    }
  });
}

test("hybrid encryption round trip and tamper detection", () => {
  const keys = generateKeys();
  const instruction = {
    sender: "alice@demo",
    receiver: "bob@demo",
    amount: 12345,
    nonce: randomUUID(),
    signedAt: Date.now(),
  };
  const ciphertext = encrypt(instruction, keys.publicKey);
  assert.deepEqual(decrypt(ciphertext, keys.privateKey), instruction);
  const bytes = Buffer.from(ciphertext, "base64");
  bytes[280] ^= 1;
  assert.throws(() => decrypt(bytes.toString("base64"), keys.privateKey));
});

test("a signed packet ID cannot replace a different queued authorization", () => {
  const engine = new MeshEngine(":memory:");
  try {
    const keys = generateSigningKeys();
    engine.registerPublicKey("alice@demo", keys.publicKey);
    const original = signedSend(keys.privateKey);
    engine.send(original);
    const collision = signedSend(keys.privateKey);
    collision.authorization = signAuthorization(
      { ...collision.authorization, packetId: original.authorization.packetId },
      keys.privateKey,
    );
    assert.throws(() => engine.send(collision), /already queued/);
    assert.equal(engine.state().convergence.queued, 1);
  } finally {
    engine.close();
  }
});

engineTest(
  "two gossip rounds authenticate forwarded TTL and settle once",
  (engine, send) => {
    engine.send(send());
    engine.gossip();
    assert.equal(engine.devices.slice(3).flatMap((d) => d.packets).length, 0);
    engine.gossip();
    assert.equal(engine.devices[3].packets[0].ttl, 3);
    assert.deepEqual(
      engine.flush().map((r) => r.outcome),
      ["SETTLED", "DUPLICATE_DROPPED"],
    );
    assert.equal(engine.state().accounts[0].balance, 450000);
    assert.equal(engine.state().accounts[1].balance, 150000);
    assert.equal(engine.state().transactions.length, 1);
    assert.equal(engine.state().convergence.converged, true);
  },
);

engineTest(
  "forged instructions, wrong signer, and unsigned legacy payloads cannot settle",
  (engine, send) => {
    const valid = send();
    const attacker = generateSigningKeys();
    const forged = structuredClone(valid);
    forged.authorization = signAuthorization(
      valid.authorization,
      attacker.privateKey,
    );
    const tampered = structuredClone(valid);
    tampered.authorization.instruction.amount = 1;
    const relabelled = structuredClone(valid);
    relabelled.authorization.instruction.sender = "carol@demo";
    for (const value of [forged, tampered, relabelled]) {
      assert.throws(() => engine.send(value), /signature/);
      const packet: Packet = {
        id: value.authorization.packetId,
        ttl: 5,
        hopProof: value.hopProof,
        ciphertext: encrypt(value.authorization, engine.getPublicKey()),
      };
      assert.equal(
        engine.ingest(packet, "malicious-bridge").outcome,
        "INVALID",
      );
    }
    const legacy = {
      id: valid.authorization.packetId,
      ttl: 5,
      hopProof: valid.hopProof,
      ciphertext: encrypt(
        valid.authorization.instruction,
        engine.getPublicKey(),
      ),
    };
    assert.equal(engine.ingest(legacy, "legacy").outcome, "INVALID");
    assert.equal(engine.state().transactions.length, 0);
    assert.equal(engine.state().accounts[0].balance, 500000);
  },
);

engineTest(
  "unregistered keys and replacement enrollment are rejected",
  (engine, send) => {
    assert.throws(
      () =>
        engine.registerPublicKey("alice@demo", generateSigningKeys().publicKey),
      /different registered key/,
    );
    assert.throws(
      () =>
        engine.registerPublicKey(
          "unknown@demo",
          generateSigningKeys().publicKey,
        ),
      /Unknown account/,
    );
    assert.throws(
      () => engine.registerPublicKey("alice@demo", engine.getPublicKey()),
      /Ed25519/,
    );
    assert.throws(
      () => engine.createPacket(send("unknown@demo")),
      /unregistered/,
    );
  },
);

engineTest(
  "packet ID, TTL, hop proof, root and signed budget cannot be tampered",
  (engine, send) => {
    const input = send();
    const original = engine.createPacket(input);
    for (const changed of [
      { ...original, id: randomUUID() },
      { ...original, ttl: 4 },
      { ...original, ttl: 6 },
      { ...original, ttl: -1 },
      { ...original, hopProof: "0".repeat(64) },
    ])
      assert.equal(engine.ingest(changed, "tampered").outcome, "INVALID");
    const forwarded = {
      ...original,
      ttl: 4,
      hopProof: advanceProof(original.hopProof),
    };
    assert.equal(
      engine.ingest({ ...forwarded, ttl: 5 }, "raised-ttl").outcome,
      "INVALID",
    );
    for (const field of ["maxTtl", "hopRoot", "packetId"] as const) {
      const forged = structuredClone(input);
      if (field === "maxTtl") forged.authorization.maxTtl = 4;
      if (field === "hopRoot") forged.authorization.hopRoot = "0".repeat(64);
      if (field === "packetId") forged.authorization.packetId = randomUUID();
      const packet = {
        ...original,
        id: forged.authorization.packetId,
        ciphertext: encrypt(forged.authorization, engine.getPublicKey()),
      };
      assert.equal(
        engine.ingest(packet, "altered-signature-data").outcome,
        "INVALID",
      );
    }
    assert.equal(engine.state().transactions.length, 0);
    assert.equal(engine.ingest(forwarded, "honest").outcome, "SETTLED");
  },
);

engineTest(
  "same sender nonce is deduplicated after re-encryption and new packet metadata",
  (engine, send) => {
    const first = send();
    const nonce = first.authorization.instruction.nonce;
    const second = send("alice@demo", "bob@demo", 50000, { nonce });
    const one = engine.createPacket(first),
      two = engine.createPacket(second);
    assert.notEqual(one.ciphertext, two.ciphertext);
    assert.notEqual(one.id, two.id);
    assert.equal(engine.ingest(one, "one").outcome, "SETTLED");
    assert.equal(engine.ingest(two, "two").outcome, "DUPLICATE_DROPPED");
  },
);

engineTest(
  "insufficient funds record rejection and preserve balances",
  (engine, send) => {
    const before = engine.state().accounts;
    const packet = engine.createPacket(send("dave@demo", "bob@demo", 60000));
    assert.equal(engine.ingest(packet, "bridge").outcome, "REJECTED");
    assert.deepEqual(engine.state().accounts, before);
    assert.equal(engine.state().transactions[0].reason, "Insufficient balance");
    assert.equal(engine.ingest(packet, "retry").outcome, "DUPLICATE_DROPPED");
  },
);

engineTest(
  "stale, future and ciphertext-tampered packets do not create claims",
  (engine, send) => {
    for (const signedAt of [Date.now() - 86_401_000, Date.now() + 301_000]) {
      const input = send("alice@demo", "bob@demo", 100, { signedAt });
      const packet = {
        id: input.authorization.packetId,
        ttl: 5,
        hopProof: input.hopProof,
        ciphertext: encrypt(input.authorization, engine.getPublicKey()),
      };
      assert.equal(engine.ingest(packet, "bridge").outcome, "INVALID");
    }
    const packet = engine.createPacket(send());
    const bytes = Buffer.from(packet.ciphertext, "base64");
    bytes[280] ^= 1;
    assert.equal(
      engine.ingest(
        { ...packet, ciphertext: bytes.toString("base64") },
        "bridge",
      ).outcome,
      "INVALID",
    );
    assert.equal(engine.state().transactions.length, 0);
    assert.equal(engine.ingest(packet, "valid-retry").outcome, "SETTLED");
  },
);

engineTest(
  "competing payments cannot overdraw and preserve total money",
  (engine, send) => {
    const one = engine.createPacket(send("dave@demo", "bob@demo", 40000));
    const two = engine.createPacket(send("dave@demo", "carol@demo", 40000));
    assert.equal(engine.ingest(one, "one").outcome, "SETTLED");
    assert.equal(engine.ingest(two, "two").outcome, "REJECTED");
    assert.equal(engine.state().accounts[3].balance, 10000);
    assert.equal(
      engine.state().accounts.reduce((sum, a) => sum + a.balance, 0),
      900000,
    );
  },
);

engineTest(
  "invalid amounts, self-payments and unknown accounts are rejected",
  (engine, send) => {
    for (const amount of [0, -1, 1.5, 100000001])
      assert.throws(() =>
        engine.createPacket(send("alice@demo", "bob@demo", amount)),
      );
    assert.throws(
      () => engine.createPacket(send("alice@demo", "alice@demo", 100)),
      /different receiver/,
    );
    assert.throws(
      () => engine.createPacket(send("alice@demo", "unknown@demo", 100)),
      /Unknown account/,
    );
  },
);

engineTest(
  "reset clears failures and queues while preserving balances and claims",
  (engine, send) => {
    const packet = engine.send(send());
    engine.gossip();
    engine.gossip();
    engine.flush();
    engine.configureFailures({
      ...DEFAULT_FAILURES,
      lossRate: 1,
      delayRounds: 2,
      partitioned: true,
      offlineBridges: ["bridge-1"],
    });
    const before = engine.state();
    engine.resetMesh();
    assert.equal(engine.state().devices.flatMap((d) => d.packets).length, 0);
    assert.deepEqual(engine.state().accounts, before.accounts);
    assert.deepEqual(engine.state().transactions, before.transactions);
    assert.deepEqual(engine.state().failures, DEFAULT_FAILURES);
    assert.equal(engine.state().convergence.queued, 0);
    assert.equal(engine.ingest(packet, "retry").outcome, "DUPLICATE_DROPPED");
  },
);

engineTest(
  "100% packet loss retries and converges after healing",
  (engine, send) => {
    engine.configureFailures({ ...DEFAULT_FAILURES, lossRate: 1 });
    engine.send(send());
    engine.gossip();
    engine.gossip();
    assert.equal(engine.state().convergence.dropped, 4);
    assert.equal(engine.flush().length, 0);
    assert.equal(engine.state().convergence.pending, 1);
    engine.configureFailures({ ...DEFAULT_FAILURES });
    engine.gossip();
    engine.gossip();
    engine.flush();
    assert.equal(engine.state().convergence.converged, true);
    assert.equal(engine.state().transactions.length, 1);
  },
);

engineTest(
  "partition blocks bridge links then the queued payment converges after healing",
  (engine, send) => {
    engine.configureFailures({ ...DEFAULT_FAILURES, partitioned: true });
    engine.send(send());
    for (let i = 0; i < 4; i++) engine.gossip();
    assert.equal(engine.state().convergence.bridgeReached, 0);
    assert.equal(engine.flush().length, 0);
    engine.configureFailures({ ...DEFAULT_FAILURES });
    engine.gossip();
    assert.equal(engine.state().convergence.bridgeReached, 1);
    engine.flush();
    assert.equal(engine.state().convergence.converged, true);
  },
);

engineTest(
  "offline bridges retain copies and settle once when internet returns",
  (engine, send) => {
    engine.configureFailures({
      ...DEFAULT_FAILURES,
      offlineBridges: ["bridge-1", "bridge-2"],
    });
    engine.send(send());
    engine.gossip();
    engine.gossip();
    assert.equal(engine.state().convergence.bridgeReached, 1);
    assert.equal(engine.flush().length, 0);
    engine.configureFailures({
      ...DEFAULT_FAILURES,
      offlineBridges: ["bridge-2"],
    });
    assert.deepEqual(
      engine.flush().map((r) => r.outcome),
      ["SETTLED"],
    );
    engine.configureFailures({ ...DEFAULT_FAILURES });
    engine.flush();
    assert.equal(engine.state().transactions.length, 1);
    assert.equal(engine.state().convergence.converged, true);
  },
);

engineTest(
  "delayed packets advance by rounds, survive partitions, and converge",
  (engine, send) => {
    engine.configureFailures({ ...DEFAULT_FAILURES, delayRounds: 2 });
    engine.send(send());
    engine.gossip();
    engine.gossip();
    assert.equal(engine.state().convergence.delayed, 2);
    assert.equal(engine.state().convergence.bridgeReached, 0);
    engine.gossip();
    engine.gossip();
    engine.configureFailures({
      ...DEFAULT_FAILURES,
      delayRounds: 2,
      partitioned: true,
    });
    for (let i = 0; i < 3; i++) engine.gossip();
    assert.equal(engine.state().convergence.bridgeReached, 0);
    engine.configureFailures({ ...DEFAULT_FAILURES });
    for (let i = 0; i < 3; i++) engine.gossip();
    engine.flush();
    assert.equal(engine.state().convergence.converged, true);
  },
);

engineTest(
  "seeded partial loss is reproducible and converges through retries",
  (engine, send) => {
    const second = new MeshEngine(":memory:");
    try {
      const keys = provision(second);
      const config = { ...DEFAULT_FAILURES, lossRate: 0.5, seed: 12345 };
      engine.configureFailures(config);
      second.configureFailures(config);
      engine.send(send());
      second.send(signedSend(keys.get("alice@demo")!.privateKey));
      for (let i = 0; i < 30; i++) {
        engine.gossip();
        second.gossip();
      }
      assert.deepEqual(
        engine.devices.map((d) => d.packets.map((p) => p.ttl)),
        second.devices.map((d) => d.packets.map((p) => p.ttl)),
      );
      assert.equal(
        engine.state().convergence.dropped,
        second.state().convergence.dropped,
      );
      assert.equal(engine.state().convergence.bridgeReached, 1);
      engine.flush();
      assert.equal(engine.state().convergence.converged, true);
    } finally {
      second.close();
    }
  },
);

test("browser WebCrypto signs interoperable instructions and validates wallet keys", async () => {
  const engine = new MeshEngine(":memory:");
  try {
    const keys = generateSigningKeys();
    engine.registerPublicKey("alice@demo", keys.publicKey);
    const wallet = await importWallet({
      version: 1,
      sender: "alice@demo",
      ...keys,
    });
    const input = await createSignedSend(wallet, "bob@demo", "100.50");
    assert.equal(input.authorization.instruction.amount, 10050);
    assert.equal(
      engine.ingest(engine.createPacket(input), "browser").outcome,
      "SETTLED",
    );
    assert.equal(wallet.key.extractable, false);
    await assert.rejects(
      importWallet({
        version: 1,
        sender: "alice@demo",
        publicKey: keys.publicKey,
        privateKey: generateSigningKeys().privateKey,
      }),
      /do not match/,
    );
    for (const value of ["0", "0.001", "-10", "1e3", "1,000"])
      assert.throws(() => parseAmount(value));
  } finally {
    engine.close();
  }
});

test("keys, balances, registered signers and claims persist across restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "meshpay-test-")),
    path = join(dir, "ledger.sqlite");
  let engine = new MeshEngine(path);
  try {
    const keys = provision(engine),
      publicKey = engine.getPublicKey();
    const packet = engine.createPacket(
      signedSend(
        keys.get("alice@demo")!.privateKey,
        "alice@demo",
        "bob@demo",
        10000,
      ),
    );
    engine.ingest(packet, "bridge");
    engine.close();
    engine = new MeshEngine(path);
    assert.equal(engine.getPublicKey(), publicKey);
    assert.equal(
      engine.state().accounts[0].signingPublicKey,
      keys.get("alice@demo")!.publicKey,
    );
    assert.equal(engine.state().accounts[0].balance, 490000);
    assert.equal(engine.ingest(packet, "retry").outcome, "DUPLICATE_DROPPED");
  } finally {
    engine.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
