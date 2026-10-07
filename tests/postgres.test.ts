import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fork, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { Pool } from "pg";
import { PostgresEngine } from "../web/server/postgres-engine";
import { postgresConfig } from "../web/server/postgres-config";
import { generateSigningKeys } from "../web/server/crypto";
import { DEFAULT_FAILURES } from "../web/server/network";
import { signedSend } from "./helpers/fixtures";
import type { Result } from "../web/lib/types";
import { POST as action } from "../src/app/api/actions/route";
import { GET as stateRoute } from "../src/app/api/state/route";
import { GET as keyRoute } from "../src/app/api/server-key/route";

function receive<T>(child: ChildProcess, key: string): Promise<T> {
  return new Promise((done, fail) => {
    const timer = setTimeout(() => {
      cleanup();
      fail(new Error(`Worker timeout: ${key}`));
    }, 20000);
    const message = (value: Record<string, unknown>) => {
      if (value.error) {
        cleanup();
        fail(new Error(String(value.error)));
      } else if (key in value) {
        cleanup();
        done(value[key] as T);
      }
    };
    const exit = () => {
      cleanup();
      fail(new Error(`Worker exited before ${key}`));
    };
    function cleanup() {
      clearTimeout(timer);
      child.off("message", message);
      child.off("exit", exit);
    }
    child.on("message", message);
    child.once("exit", exit);
  });
}
test(
  "PostgreSQL persists mesh recovery and serializes six independent settlement processes",
  { skip: !process.env.POSTGRES_TEST_URL, timeout: 120000 },
  async () => {
    const root = new Pool(postgresConfig(process.env.POSTGRES_TEST_URL!));
    const schema = "meshpay_test_" + randomUUID().replaceAll("-", "");
    await root.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(process.env.POSTGRES_TEST_URL!);
    const previousSchema = process.env.DATABASE_SCHEMA;
    process.env.DATABASE_SCHEMA = schema;
    const engines: PostgresEngine[] = [];
    const children: ChildProcess[] = [];
    try {
      const a = new PostgresEngine(url.toString()),
        b = new PostgresEngine(url.toString());
      engines.push(a, b);
      const keys = generateSigningKeys();
      await a.registerPublicKey("alice@demo", keys.publicKey);
      await assert.rejects(
        b.registerPublicKey("alice@demo", generateSigningKeys().publicKey),
        /different registered key/,
      );
      await a.configureFailures({ ...DEFAULT_FAILURES, lossRate: 1 });
      const input = signedSend(keys.privateKey);
      await a.send(input);
      await b.gossip();
      assert.equal((await a.state()).convergence.pending, 1);
      assert.ok((await b.state()).convergence.dropped > 0);
      await a.close();
      engines.splice(engines.indexOf(a), 1);
      const c = new PostgresEngine(url.toString());
      engines.push(c);
      assert.equal((await c.state()).failures.lossRate, 1);
      await c.configureFailures(DEFAULT_FAILURES);
      await b.gossip();
      await c.gossip();
      await b.flush();
      assert.equal((await c.state()).convergence.converged, true);
      for (const reencrypted of [false, true]) {
        const payment = signedSend(
          keys.privateKey,
          "alice@demo",
          "bob@demo",
          10000,
        );
        const packet = await c.createPacket(payment);
        const packets = await Promise.all(
          Array.from({ length: 6 }, () =>
            reencrypted
              ? c.createPacket(
                  signedSend(keys.privateKey, "alice@demo", "bob@demo", 10000, {
                    nonce: payment.authorization.instruction.nonce,
                  }),
                )
              : Promise.resolve(packet),
          ),
        );
        const before = await c.state();
        const workers = packets.map(() =>
          fork(resolve("tests/helpers/postgres-worker.ts"), [], {
            execArgv: ["--import", "tsx"],
            env: { ...process.env, POSTGRES_TEST_URL: url.toString() },
            stdio: ["ignore", "ignore", "ignore", "ipc"],
          }),
        );
        children.push(...workers);
        const results = workers.map((w) => receive<Result>(w, "result"));
        results.forEach((p) => void p.catch(() => {}));
        await Promise.all(workers.map((w) => receive(w, "ready")));
        const lock = await root.connect();
        try {
          await lock.query("BEGIN");
          await lock.query(
            `SELECT id FROM ${schema}.mesh_session WHERE id=1 FOR UPDATE`,
          );
          const attempting = workers.map((w) => receive(w, "attempting"));
          workers.forEach((w, i) => w.send(packets[i]));
          await Promise.all(attempting);
          await lock.query("COMMIT");
        } finally {
          lock.release();
        }
        const values = await Promise.all(results);
        assert.equal(values.filter((v) => v.outcome === "SETTLED").length, 1);
        assert.equal(
          values.filter((v) => v.outcome === "DUPLICATE_DROPPED").length,
          5,
        );
        assert.equal(new Set(values.map((v) => v.transactionId)).size, 1);
        const after = await c.state();
        assert.equal(after.transactions.length, before.transactions.length + 1);
        assert.equal(
          after.accounts.find((a) => a.vpa === "alice@demo")!.balance,
          before.accounts.find((a) => a.vpa === "alice@demo")!.balance - 10000,
        );
        assert.equal(
          after.accounts.reduce((s, a) => s + a.balance, 0),
          900000,
        );
      }
      const invalid = await c.createPacket(signedSend(keys.privateKey));
      invalid.id = randomUUID();
      assert.equal((await c.ingest(invalid, "tampering")).outcome, "INVALID");
      const rejected = await c.createPacket(
        signedSend(keys.privateKey, "alice@demo", "bob@demo", 1000000),
      );
      assert.equal((await c.ingest(rejected, "bridge")).outcome, "REJECTED");
      const state = await c.state();
      await c.resetMesh();
      assert.deepEqual((await b.state()).accounts, state.accounts);
      assert.equal((await b.state()).convergence.queued, 0);
      const shared = globalThis as typeof globalThis & { meshEngine?: unknown };
      const previousEngine = shared.meshEngine;
      shared.meshEngine = c;
      try {
        assert.equal((await stateRoute()).status, 200);
        assert.equal((await keyRoute()).status, 200);
        const request = (input: ReturnType<typeof signedSend>) =>
          new Request("http://localhost/api/actions", {
            method: "POST",
            headers: {
              host: "localhost",
              origin: "http://localhost",
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ action: "demo", ...input }),
          });
        await c.send(
          signedSend(keys.privateKey, "alice@demo", "bob@demo", 100),
        );
        const beforeInvalid = await c.state();
        assert.equal(
          (
            await action(
              request(
                signedSend(keys.privateKey, "alice@demo", "bob@demo", 101),
              ),
            )
          ).status,
          400,
        );
        assert.deepEqual(await c.state(), beforeInvalid);
        const response = await action(request(signedSend(keys.privateKey)));
        assert.equal(response.status, 200);
        assert.equal((await response.json()).convergence.converged, true);
      } finally {
        shared.meshEngine = previousEngine;
      }
    } finally {
      children.forEach((c) => {
        if (c.connected) c.kill();
      });
      await Promise.all(engines.map((e) => e.close()));
      await root.query(`DROP SCHEMA ${schema} CASCADE`);
      await root.end();
      if (previousSchema === undefined) delete process.env.DATABASE_SCHEMA;
      else process.env.DATABASE_SCHEMA = previousSchema;
    }
  },
);
