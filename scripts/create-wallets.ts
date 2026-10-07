import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createPublicKey } from "node:crypto";
import { MeshEngine } from "../web/server/engine";
import { generateSigningKeys, normalizeSigningKey } from "../web/server/crypto";
import type { Wallet } from "../web/lib/types";

// Local administrator operation. Private keys never enter an HTTP handler.
const args = process.argv.slice(2);
let dataDir = resolve(".data");
const index = args.indexOf("--data-dir");
if (index !== -1) {
  if (!args[index + 1]) throw new Error("--data-dir needs a path");
  dataDir = resolve(args[index + 1]);
  args.splice(index, 2);
}
mkdirSync(join(dataDir, "wallets"), { recursive: true });
const engine = new MeshEngine(join(dataDir, "meshpay.sqlite"));
try {
  const accounts = engine.state().accounts;
  for (const sender of args.length ? args : accounts.map((a) => a.vpa)) {
    if (!accounts.some((a) => a.vpa === sender))
      throw new Error(`Unknown account: ${sender}`);
    const path = join(
      dataDir,
      "wallets",
      `${sender.replace(/[^a-z0-9-]/gi, "-")}.json`,
    );
    let wallet: Wallet;
    if (existsSync(path)) {
      wallet = JSON.parse(readFileSync(path, "utf8")) as Wallet;
      if (
        wallet.version !== 1 ||
        wallet.sender !== sender ||
        normalizeSigningKey(wallet.publicKey) !==
          createPublicKey(wallet.privateKey)
            .export({ type: "spki", format: "pem" })
            .toString()
      )
        throw new Error(`Invalid existing wallet: ${path}`);
    } else {
      if (accounts.find((a) => a.vpa === sender)?.signingPublicKey)
        throw new Error(
          `The public key for ${sender} is already registered but its wallet file is missing. Restore the original wallet; automatic key replacement is disabled.`,
        );
      const keys = generateSigningKeys();
      wallet = { version: 1, sender, ...keys };
      // Exclusive creation preserves existing wallets. A crash before registration can be retried.
      writeFileSync(path, JSON.stringify(wallet, null, 2) + "\n", {
        flag: "wx",
        mode: 0o600,
      });
    }
    engine.registerPublicKey(sender, wallet.publicKey);
    console.log(
      `${sender}: public key registered; import ${path} in the dashboard`,
    );
  }
} finally {
  engine.close();
}
