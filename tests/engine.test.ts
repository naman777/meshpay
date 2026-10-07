import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { MeshEngine } from "../web/server/engine";
import { encrypt, decrypt, generateKeys } from "../web/server/crypto";
import type { Instruction } from "../web/lib/types";

function engineTest(
  name: string,
  fn: (engine: MeshEngine) => void | Promise<void>,
) {
  test(name, async () => {
    const engine = new MeshEngine(":memory:");
    try {
      await fn(engine);
    } finally {
      engine.close();
    }
  });
}
test("hybrid encryption round trip and tamper detection", () => {
  const keys = generateKeys();
  const instruction: Instruction = {
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
engineTest(
  "two gossip rounds reach both bridges and settle one delivery",
  (engine) => {
    engine.send("alice@demo", "bob@demo", 50000);
    engine.gossip();
    assert.equal(
      engine.devices.filter((d) => d.online).flatMap((d) => d.packets).length,
      0,
    );
    engine.gossip();
    assert.deepEqual(
      engine.flush().map((r) => r.outcome),
      ["SETTLED", "DUPLICATE_DROPPED"],
    );
    const state = engine.state();
    assert.equal(state.accounts[0].balance, 450000);
    assert.equal(state.accounts[1].balance, 150000);
    assert.equal(state.transactions.length, 1);
  },
);
engineTest(
  "simultaneous deliveries produce one ledger entry",
  async (engine) => {
    const packet = engine.createPacket("alice@demo", "bob@demo", 10000);
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        Promise.resolve().then(() => engine.ingest(packet, `bridge-${i}`)),
      ),
    );
    assert.equal(results.filter((r) => r.outcome === "SETTLED").length, 1);
    assert.equal(
      results.filter((r) => r.outcome === "DUPLICATE_DROPPED").length,
      19,
    );
    assert.equal(engine.state().accounts[0].balance, 490000);
  },
);
engineTest(
  "insufficient funds report rejected without changing balances",
  (engine) => {
    const before = engine.state().accounts;
    const result = engine.ingest(
      engine.createPacket("dave@demo", "bob@demo", 60000),
      "bridge",
    );
    assert.equal(result.outcome, "REJECTED");
    assert.equal(result.reason, "Insufficient balance");
    assert.deepEqual(engine.state().accounts, before);
    assert.equal(engine.state().transactions[0].status, "REJECTED");
  },
);
engineTest(
  "stale, future, and tampered packets never reach the ledger",
  (engine) => {
    for (const signedAt of [Date.now() - 86_401_000, Date.now() + 301_000]) {
      const ciphertext = encrypt(
        {
          sender: "alice@demo",
          receiver: "bob@demo",
          amount: 100,
          nonce: randomUUID(),
          signedAt,
        },
        engine.getPublicKey(),
      );
      assert.equal(
        engine.ingest({ id: randomUUID(), ttl: 5, ciphertext }, "bridge")
          .outcome,
        "INVALID",
      );
    }
    const packet = engine.createPacket("alice@demo", "bob@demo", 100);
    const bytes = Buffer.from(packet.ciphertext, "base64");
    bytes[280] ^= 1;
    packet.ciphertext = bytes.toString("base64");
    assert.equal(engine.ingest(packet, "bridge").outcome, "INVALID");
    assert.equal(engine.state().transactions.length, 0);
  },
);
engineTest(
  "reencrypting the same payment nonce cannot settle twice",
  (engine) => {
    const instruction = {
      sender: "alice@demo",
      receiver: "bob@demo",
      amount: 10000,
      nonce: randomUUID(),
      signedAt: Date.now(),
    };
    const first = {
      id: randomUUID(),
      ttl: 5,
      ciphertext: encrypt(instruction, engine.getPublicKey()),
    };
    const second = {
      id: randomUUID(),
      ttl: 5,
      ciphertext: encrypt(instruction, engine.getPublicKey()),
    };
    assert.notEqual(first.ciphertext, second.ciphertext);
    assert.equal(engine.ingest(first, "one").outcome, "SETTLED");
    assert.equal(engine.ingest(second, "two").outcome, "DUPLICATE_DROPPED");
  },
);
engineTest("distinct payments cannot overdraw an account", (engine) => {
  const one = engine.createPacket("dave@demo", "bob@demo", 40000),
    two = engine.createPacket("dave@demo", "carol@demo", 40000);
  assert.equal(engine.ingest(one, "one").outcome, "SETTLED");
  assert.equal(engine.ingest(two, "two").outcome, "REJECTED");
  assert.equal(engine.state().accounts[3].balance, 10000);
  assert.equal(
    engine.state().accounts.reduce((sum, a) => sum + a.balance, 0),
    900000,
  );
});
engineTest(
  "validation rejects fractional paise, nonpositive amounts and self-payments",
  (engine) => {
    for (const amount of [0, -1, 1.5])
      assert.throws(() =>
        engine.createPacket("alice@demo", "bob@demo", amount),
      );
    assert.throws(() => engine.createPacket("alice@demo", "alice@demo", 100));
    assert.throws(() => engine.createPacket("unknown", "bob@demo", 100));
  },
);
engineTest(
  "reset clears the mesh but preserves money, ledger, and deduplication",
  (engine) => {
    const packet = engine.send("alice@demo", "bob@demo", 100);
    engine.gossip();
    engine.gossip();
    engine.flush();
    const before = engine.state();
    engine.resetMesh();
    assert.equal(engine.state().devices.flatMap((d) => d.packets).length, 0);
    assert.deepEqual(engine.state().accounts, before.accounts);
    assert.deepEqual(engine.state().transactions, before.transactions);
    assert.equal(engine.ingest(packet, "retry").outcome, "DUPLICATE_DROPPED");
  },
);
test("balances, keys and duplicate protection survive server restarts", () => {
  const dir = mkdtempSync(join(tmpdir(), "meshpay-test-")),
    path = join(dir, "ledger.sqlite");
  let engine = new MeshEngine(path);
  try {
    const key = engine.getPublicKey(),
      packet = engine.createPacket("alice@demo", "bob@demo", 10000);
    engine.ingest(packet, "bridge");
    engine.close();
    engine = new MeshEngine(path);
    assert.equal(engine.getPublicKey(), key);
    assert.equal(engine.state().accounts[0].balance, 490000);
    assert.equal(engine.ingest(packet, "retry").outcome, "DUPLICATE_DROPPED");
  } finally {
    engine.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
