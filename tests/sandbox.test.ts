import { test } from "node:test";
import assert from "node:assert/strict";
import { createDemoWallets, createSignedSend } from "../web/lib/wallet";
import { SandboxStore } from "../web/server/sandbox-store";
import { POST, GET } from "../src/app/api/sandbox/route";
import { DEFAULT_FAILURES } from "../web/server/network";
import type { State } from "../web/lib/types";

function request(body: unknown, session = "", origin = "http://localhost") {
  return new Request("http://localhost/api/sandbox", {
    method: "POST",
    headers: {
      origin,
      host: "localhost",
      "Content-Type": "application/json",
      "X-MeshPay-Session": session,
    },
    body: JSON.stringify(body),
  });
}
test("automatic browser keys stay non-extractable and visitors can repeatedly run a fresh signed demo", async () => {
  const shared = globalThis as typeof globalThis & {
    meshSandboxStore?: SandboxStore;
  };
  const previous = shared.meshSandboxStore;
  const store = new SandboxStore();
  shared.meshSandboxStore = store;
  try {
    const wallets = await createDemoWallets();
    for (const wallet of Object.values(wallets)) {
      assert.equal(wallet.key.extractable, false);
      await assert.rejects(crypto.subtle.exportKey("pkcs8", wallet.key));
    }
    const keys = Object.fromEntries(
      Object.values(wallets).map((w) => [w.sender, w.publicKey]),
    );
    const created = await POST(request({ action: "start", publicKeys: keys }));
    assert.equal(created.status, 201);
    const { session, state } = await created.json();
    assert.equal(state.accounts.length, 4);
    assert.doesNotMatch(JSON.stringify({ session, state }), /PRIVATE KEY/);
    const otherWallets = await createDemoWallets();
    const other = await POST(
      request({
        action: "start",
        publicKeys: Object.fromEntries(
          Object.values(otherWallets).map((w) => [w.sender, w.publicKey]),
        ),
      }),
    );
    const otherSession = (await other.json()).session;
    for (let i = 0; i < 12; i++) {
      const payment = await createSignedSend(
        wallets["alice@demo"],
        "bob@demo",
        "500",
      );
      const response = await POST(
        request({ action: "demo", ...payment }, session),
      );
      assert.equal(response.status, 200);
      const s = (await response.json()) as State;
      assert.equal(s.accounts[0].balance, 450000);
      assert.equal(s.accounts[1].balance, 150000);
      assert.equal(s.transactions.length, 1);
      assert.equal(s.convergence.converged, true);
      assert.equal(s.duplicates, 1);
    }
    const untouched = await GET(
      new Request("http://localhost/api/sandbox", {
        headers: { "X-MeshPay-Session": otherSession },
      }),
    );
    const untouchedState = (await untouched.json()) as State;
    assert.equal(untouchedState.transactions.length, 0);
    assert.equal(untouchedState.accounts[0].balance, 500000);
    const forged = await createSignedSend(
      otherWallets["alice@demo"],
      "bob@demo",
      "500",
    );
    assert.equal(
      (await POST(request({ action: "send", ...forged }, session))).status,
      400,
    );
    assert.equal(
      (
        await POST(
          request(
            {
              action: "demo",
              sender: "alice@demo",
              receiver: "bob@demo",
              amount: 50000,
            },
            session,
          ),
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await POST(
          request({
            action: "start",
            publicKeys: keys,
            privateKey: "do not accept private keys",
          }),
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await POST(
          request({ action: "reset" }, session, "https://attacker.example"),
        )
      ).status,
      403,
    );
    const reset = await POST(request({ action: "reset" }, session));
    assert.equal(reset.status, 200);
    const fresh = (await reset.json()) as State;
    assert.equal(fresh.transactions.length, 0);
    assert.equal(fresh.accounts[0].balance, 500000);
    assert.equal(fresh.convergence.queued, 0);
    assert.equal(fresh.accounts[0].signingPublicKey, keys["alice@demo"]);
    const queued = await createSignedSend(
      wallets["alice@demo"],
      "bob@demo",
      "100",
    );
    await POST(
      request(
        { action: "configure", failures: { ...DEFAULT_FAILURES, lossRate: 1 } },
        session,
      ),
    );
    await POST(request({ action: "send", ...queued }, session));
    await POST(request({ action: "gossip" }, session));
    await POST(
      request({ action: "configure", failures: DEFAULT_FAILURES }, session),
    );
    await POST(request({ action: "gossip" }, session));
    await POST(request({ action: "gossip" }, session));
    const flushed = await POST(request({ action: "flush" }, session));
    assert.equal((await flushed.json()).convergence.converged, true);
    const invalid = await GET(
      new Request("http://localhost/api/sandbox", {
        headers: { "X-MeshPay-Session": "0".repeat(64) },
      }),
    );
    assert.equal(invalid.status, 410);
  } finally {
    shared.meshSandboxStore = previous;
    await store.close();
  }
});
