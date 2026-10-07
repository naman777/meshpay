import { test } from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { MeshEngine } from "../web/server/sqlite-engine";
import { provision, signedSend } from "./helpers/fixtures";
import type { Result } from "../web/lib/types";

function worker(path: string) {
  const child = fork(resolve("tests/helpers/ingest-worker.ts"), [path], {
    execArgv: ["--import", "tsx"],
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  function message<T>(key: string) {
    return new Promise<T>((resolveMessage, reject) => {
      const onMessage = (value: Record<string, unknown>) => {
        if (value.error) {
          cleanup();
          reject(new Error(String(value.error)));
        } else if (key in value) {
          cleanup();
          resolveMessage(value[key] as T);
        }
      };
      const onExit = (code: number | null) => {
        cleanup();
        reject(new Error(`Worker exited ${code} before ${key}: ${stderr}`));
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      function cleanup() {
        child.off("message", onMessage);
        child.off("exit", onExit);
        child.off("error", onError);
      }
      child.on("message", onMessage);
      child.once("exit", onExit);
      child.once("error", onError);
    });
  }
  const ready = message<boolean>("ready"),
    attempting = message<boolean>("attempting"),
    result = message<Result>("result");
  // Attach rejection handlers immediately, including on failure paths before the barrier.
  for (const pending of [ready, attempting, result])
    void pending.catch(() => {});
  const exited = new Promise<number | null>((resolveExit) =>
    child.once("exit", resolveExit),
  );
  return { child, ready, attempting, result, exited };
}

for (const reencrypted of [false, true]) {
  test(
    `six independent processes settle once under SQLite write contention (${reencrypted ? "same nonce, different ciphertext" : "identical packet"})`,
    { timeout: 30_000 },
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "meshpay-concurrent-")),
        path = join(dir, "ledger.sqlite");
      const engine = new MeshEngine(path);
      const processes: ReturnType<typeof worker>[] = [];
      let lock: DatabaseSync | undefined;
      let locked = false;
      const watchdog = setTimeout(
        () => processes.forEach((w) => w.child.kill()),
        25_000,
      );
      try {
        const keys = provision(engine);
        const input = signedSend(
          keys.get("alice@demo")!.privateKey,
          "alice@demo",
          "bob@demo",
          10000,
        );
        const packet = engine.createPacket(input);
        const packets = Array.from({ length: 6 }, () =>
          reencrypted
            ? engine.createPacket(
                signedSend(
                  keys.get("alice@demo")!.privateKey,
                  "alice@demo",
                  "bob@demo",
                  10000,
                  { nonce: input.authorization.instruction.nonce },
                ),
              )
            : packet,
        );
        for (let i = 0; i < packets.length; i++) processes.push(worker(path));
        await Promise.all(processes.map((w) => w.ready));
        // Force competing writers to wait on the same file, rather than merely
        // launching processes whose ingest calls could happen sequentially.
        lock = new DatabaseSync(path);
        lock.exec("BEGIN IMMEDIATE");
        locked = true;
        processes.forEach((w, i) => w.child.send(packets[i]));
        await Promise.all(processes.map((w) => w.attempting));
        await delay(100);
        lock.exec("COMMIT");
        locked = false;
        const results = await Promise.all(processes.map((w) => w.result));
        assert.equal(results.filter((r) => r.outcome === "SETTLED").length, 1);
        assert.equal(
          results.filter((r) => r.outcome === "DUPLICATE_DROPPED").length,
          5,
        );
        assert.equal(new Set(results.map((r) => r.transactionId)).size, 1);
        assert.deepEqual(
          await Promise.all(processes.map((w) => w.exited)),
          [0, 0, 0, 0, 0, 0],
        );
        assert.equal(engine.state().transactions.length, 1);
        assert.equal(engine.state().accounts[0].balance, 490000);
        assert.equal(engine.state().accounts[1].balance, 110000);
        assert.equal(
          engine.state().accounts.reduce((sum, a) => sum + a.balance, 0),
          900000,
        );
        assert.equal(
          lock.prepare("SELECT COUNT(*) AS count FROM ledger").get()?.count,
          1,
        );
      } finally {
        clearTimeout(watchdog);
        if (locked) lock?.exec("ROLLBACK");
        lock?.close();
        for (const w of processes)
          if (w.child.exitCode === null && w.child.signalCode === null)
            w.child.kill();
        await Promise.all(processes.map((w) => w.exited));
        engine.close();
        // This verified temporary directory is the only recursive deletion target.
        assert.equal(resolve(dir).startsWith(resolve(tmpdir()) + sep), true);
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
}
