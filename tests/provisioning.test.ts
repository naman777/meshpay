import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { MeshEngine } from "../web/server/sqlite-engine";
import { importWallet, createSignedSend } from "../web/lib/wallet";

const run = promisify(execFile);
test("local provisioning is idempotent and never replaces a registered key after wallet loss", async () => {
  const dir = mkdtempSync(join(tmpdir(), "meshpay-wallets-"));
  try {
    const args = [
      "--import",
      "tsx",
      resolve("scripts/create-wallets.ts"),
      "--data-dir",
      dir,
    ];
    await run(process.execPath, args);
    const files = readdirSync(join(dir, "wallets"));
    assert.equal(files.length, 4);
    const walletPath = join(dir, "wallets", "alice-demo.json");
    const original = readFileSync(walletPath, "utf8");
    await run(process.execPath, args);
    assert.equal(readFileSync(walletPath, "utf8"), original);
    const engine = new MeshEngine(join(dir, "meshpay.sqlite"));
    try {
      assert.equal(
        engine.state().accounts.filter((a) => a.signingPublicKey).length,
        4,
      );
      const wallet = await importWallet(JSON.parse(original));
      assert.equal(
        engine.ingest(
          engine.createPacket(
            await createSignedSend(wallet, "bob@demo", "1.00"),
          ),
          "local-provision-test",
        ).outcome,
        "SETTLED",
      );
    } finally {
      engine.close();
    }
    renameSync(walletPath, walletPath + ".backup");
    await assert.rejects(
      run(process.execPath, [...args, "alice@demo"]),
      /already registered but its wallet file is missing/,
    );
    assert.equal(
      readdirSync(join(dir, "wallets")).includes("alice-demo.json"),
      false,
    );
    assert.equal(readFileSync(walletPath + ".backup", "utf8"), original);
  } finally {
    assert.equal(resolve(dir).startsWith(resolve(tmpdir()) + sep), true);
    rmSync(dir, { recursive: true, force: true });
  }
});
