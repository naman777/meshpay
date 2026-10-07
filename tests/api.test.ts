import { test } from "node:test";
import assert from "node:assert/strict";
import { POST } from "../src/app/api/actions/route";
import { POST as ingest } from "../src/app/api/bridge/ingest/route";
import { GET as state } from "../src/app/api/state/route";
import { MeshEngine, DEFAULT_FAILURES } from "../web/server/engine";
import { provision, signedSend } from "./helpers/fixtures";
import {
  encrypt,
  generateSigningKeys,
  signAuthorization,
} from "../web/server/crypto";

function request(
  body: unknown,
  origin = "http://127.0.0.1:3000",
  host = "127.0.0.1:3000",
) {
  return new Request("http://localhost:3000/api/actions", {
    method: "POST",
    headers: { origin, host, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function withEngine(
  fn: (engine: MeshEngine, keys: ReturnType<typeof provision>) => Promise<void>,
) {
  const globalEngine = globalThis as typeof globalThis & {
    meshEngine?: MeshEngine;
  };
  const previous = globalEngine.meshEngine;
  const engine = new MeshEngine(":memory:");
  globalEngine.meshEngine = engine;
  try {
    await fn(engine, provision(engine));
  } finally {
    globalEngine.meshEngine = previous;
    engine.close();
  }
}

test("same-origin loopback reaches validation despite normalized request URL", async () => {
  const response = await POST(
    request({
      action: "send",
      sender: "alice@demo",
      receiver: "bob@demo",
      amount: "0.001",
    }),
  );
  assert.equal(response.status, 400);
  assert.doesNotMatch((await response.json()).error, /origin/i);
});

test("cross-origin and malformed origins are blocked before controls", async () => {
  for (const origin of [
    "https://another-site.example",
    "null",
    "file://localhost:3000",
  ])
    assert.equal(
      (await POST(request({ action: "reset" }, origin))).status,
      403,
    );
});

test("unsigned send and server-side demo signing bypass are unavailable", async () => {
  assert.equal(
    (
      await POST(
        request({
          action: "send",
          sender: "alice@demo",
          receiver: "bob@demo",
          amount: "500",
        }),
      )
    ).status,
    400,
  );
  assert.equal((await POST(request({ action: "demo" }))).status, 400);
});

test("signed controls settle, preserve keys, and expose failure convergence", async () =>
  withEngine(async (engine, keys) => {
    const input = signedSend(keys.get("alice@demo")!.privateKey);
    assert.equal(
      (await POST(request({ action: "send", ...input }))).status,
      200,
    );
    assert.equal(
      (
        await POST(
          request({
            action: "configure",
            failures: { ...DEFAULT_FAILURES, partitioned: true },
          }),
        )
      ).status,
      200,
    );
    await POST(request({ action: "gossip" }));
    await POST(request({ action: "gossip" }));
    const blocked = await (await POST(request({ action: "flush" }))).json();
    assert.equal(blocked.convergence.pending, 1);
    await POST(request({ action: "configure", failures: DEFAULT_FAILURES }));
    await POST(request({ action: "gossip" }));
    const healed = await (await POST(request({ action: "flush" }))).json();
    assert.equal(healed.convergence.converged, true);
    assert.equal(healed.transactions.length, 1);
    assert.equal(
      healed.accounts[0].signingPublicKey,
      keys.get("alice@demo")!.publicKey,
    );
    const stateResponse = await state();
    assert.equal(stateResponse.headers.get("Cache-Control"), "no-store");
    assert.doesNotMatch(
      JSON.stringify(await stateResponse.json()),
      /PRIVATE KEY/,
    );
    assert.equal(engine.state().accounts[0].balance, 450000);
  }));

test("invalid signed demo cannot reset an existing queue", async () =>
  withEngine(async (engine, keys) => {
    const input = signedSend(keys.get("alice@demo")!.privateKey);
    engine.send(input);
    const forged = {
      ...input,
      authorization: signAuthorization(
        input.authorization,
        generateSigningKeys().privateKey,
      ),
    };
    assert.equal(
      (await POST(request({ action: "demo", ...forged }))).status,
      400,
    );
    assert.equal(engine.state().convergence.queued, 1);
    assert.equal(engine.devices[0].packets.length, 1);
    assert.equal(
      (
        await POST(
          request({
            action: "demo",
            ...signedSend(keys.get("alice@demo")!.privateKey),
          }),
        )
      ).status,
      200,
    );
    assert.equal(engine.state().convergence.converged, true);
  }));

test("failure settings reject invalid ranges and device IDs", async () =>
  withEngine(async () => {
    for (const failures of [
      { ...DEFAULT_FAILURES, lossRate: 1.1 },
      { ...DEFAULT_FAILURES, delayRounds: -1 },
      { ...DEFAULT_FAILURES, offlineBridges: ["alice"] },
      { ...DEFAULT_FAILURES, seed: 0 },
    ])
      assert.equal(
        (await POST(request({ action: "configure", failures }))).status,
        400,
      );
  }));

test("ingestion rejects metadata/signature forgery and accepts valid duplicate deliveries", async () =>
  withEngine(async (engine, keys) => {
    const input = signedSend(keys.get("alice@demo")!.privateKey);
    const packet = engine.createPacket(input);
    const forged = {
      ...packet,
      ciphertext: encrypt(
        {
          ...input.authorization,
          signature: signAuthorization(
            input.authorization,
            generateSigningKeys().privateKey,
          ).signature,
        },
        engine.getPublicKey(),
      ),
    };
    assert.equal((await ingest(request(forged))).status, 422);
    assert.equal((await ingest(request({ ...packet, ttl: 4 }))).status, 422);
    assert.equal(
      (
        await ingest(
          request({ id: packet.id, ttl: 5, ciphertext: packet.ciphertext }),
        )
      ).status,
      400,
    );
    const settled = await ingest(request(packet));
    assert.equal(settled.status, 200);
    assert.equal((await settled.json()).outcome, "SETTLED");
    assert.equal(
      (await (await ingest(request(packet))).json()).outcome,
      "DUPLICATE_DROPPED",
    );
    assert.equal(engine.state().transactions.length, 1);
  }));
