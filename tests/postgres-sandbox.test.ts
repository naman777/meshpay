import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fork, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { Pool } from "pg";
import { postgresConfig } from "../web/server/postgres-config";
import { SandboxStore } from "../web/server/sandbox-store";
import { createDemoWallets, createSignedSend } from "../web/lib/wallet";

function receive<T>(child: ChildProcess, key: string): Promise<T> {
  return new Promise((done, fail) => {
    const timer = setTimeout(() => {
      cleanup();
      fail(new Error(`Worker timeout: ${key}`));
    }, 25000);
    const message = (v: Record<string, unknown>) => {
      if (v.error) {
        cleanup();
        fail(new Error(String(v.error)));
      } else if (key in v) {
        cleanup();
        done(v[key] as T);
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
  "visitor snapshots persist across instances and six processes flush one settlement",
  { skip: !process.env.POSTGRES_TEST_URL, timeout: 120000 },
  async () => {
    const root = new Pool(postgresConfig(process.env.POSTGRES_TEST_URL!));
    const schema = "meshpay_visitor_test_" + randomUUID().replaceAll("-", "");
    const previousSchema = process.env.DATABASE_SCHEMA;
    await root.query(`CREATE SCHEMA ${schema}`);
    process.env.DATABASE_SCHEMA = schema;
    const a = new SandboxStore(process.env.POSTGRES_TEST_URL),
      b = new SandboxStore(process.env.POSTGRES_TEST_URL);
    const workers: ChildProcess[] = [];
    try {
      const wallets = await createDemoWallets();
      const keys = Object.fromEntries(
        Object.values(wallets).map((w) => [w.sender, w.publicKey]),
      );
      const first = await a.create(keys),
        other = await b.create(keys);
      const payment = await createSignedSend(
        wallets["alice@demo"],
        "bob@demo",
        "500",
      );
      await a.run(first.session, (e) => {
        e.send(payment);
        e.configureFailures({
          lossRate: 0,
          delayRounds: 2,
          partitioned: true,
          offlineBridges: ["bridge-1"],
          seed: 1,
        });
        e.gossip();
        return e.state();
      });
      await a.close();
      const persisted = await b.run(first.session, (e) => e.state());
      assert.equal(persisted.convergence.queued, 1);
      assert.equal(persisted.failures.partitioned, true);
      assert.equal(persisted.failures.delayRounds, 2);
      await b.run(first.session, (e) => {
        e.configureFailures({
          lossRate: 0,
          delayRounds: 0,
          partitioned: false,
          offlineBridges: [],
          seed: 1,
        });
        for (let i = 0; i < 5; i++) e.gossip();
        return e.state();
      });
      for (let i = 0; i < 6; i++)
        workers.push(
          fork(resolve("tests/helpers/sandbox-worker.ts"), [], {
            execArgv: ["--import", "tsx"],
            env: { ...process.env, POSTGRES_SANDBOX_SESSION: first.session },
            stdio: ["ignore", "ignore", "ignore", "ipc"],
          }),
        );
      const results = workers.map((w) =>
        receive<{ transactions: number; duplicates: number }>(w, "result"),
      );
      results.forEach((p) => void p.catch(() => {}));
      await Promise.all(workers.map((w) => receive(w, "ready")));
      const lock = await root.connect();
      try {
        await lock.query("BEGIN");
        await lock.query(
          `SELECT id FROM ${schema}.visitor_sandboxes WHERE id=$1 FOR UPDATE`,
          [first.session],
        );
        const attempting = workers.map((w) => receive(w, "attempting"));
        workers.forEach((w) => w.send({ flush: true }));
        await Promise.all(attempting);
        await lock.query("COMMIT");
      } finally {
        lock.release();
      }
      const replies = await Promise.all(results);
      assert.ok(replies.every((v) => v.transactions === 1));
      assert.equal(Math.max(...replies.map((v) => v.duplicates)), 11);
      const settled = await b.run(first.session, (e) => e.state());
      assert.equal(settled.accounts[0].balance, 450000);
      assert.equal(settled.accounts[1].balance, 150000);
      assert.equal(settled.convergence.converged, true);
      await b.run(first.session, (e) => {
        e.resetSandbox();
        return e.state();
      });
      const fresh = await b.run(first.session, (e) => e.state());
      assert.equal(fresh.accounts[0].balance, 500000);
      assert.equal(fresh.transactions.length, 0);
      const untouched = await b.run(other.session, (e) => e.state());
      assert.equal(untouched.accounts[0].balance, 500000);
      assert.equal(untouched.convergence.queued, 0);
    } finally {
      workers.forEach((w) => {
        if (w.connected) w.kill();
      });
      await b.close();
      await a.close();
      await root.query(`DROP SCHEMA ${schema} CASCADE`);
      await root.end();
      if (previousSchema === undefined) delete process.env.DATABASE_SCHEMA;
      else process.env.DATABASE_SCHEMA = previousSchema;
    }
  },
);
