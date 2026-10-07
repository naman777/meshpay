import { z } from "zod";
import { MAX_TTL, signingText } from "./protocol";
import type { Authorization, SignedSend } from "./types";

export type BrowserWallet = {
  sender: string;
  publicKey: string;
  key: CryptoKey;
};
export const DEMO_SENDERS = [
  "alice@demo",
  "bob@demo",
  "carol@demo",
  "dave@demo",
] as const;
export async function createDemoWallets(): Promise<
  Record<string, BrowserWallet>
> {
  if (!globalThis.crypto?.subtle)
    throw new Error(
      "Open MeshPay over HTTPS in a current browser to start the demo.",
    );
  const wallets: Record<string, BrowserWallet> = {};
  for (const sender of DEMO_SENDERS) {
    const pair = await crypto.subtle.generateKey("Ed25519", false, [
      "sign",
      "verify",
    ]);
    const encoded = base64(
      await crypto.subtle.exportKey("spki", pair.publicKey),
    );
    const publicKey = `-----BEGIN PUBLIC KEY-----\n${encoded.match(/.{1,64}/g)!.join("\n")}\n-----END PUBLIC KEY-----\n`;
    wallets[sender] = { sender, publicKey, key: pair.privateKey };
  }
  return wallets;
}
const walletSchema = z.strictObject({
  version: z.literal(1),
  sender: z.string().min(1),
  publicKey: z.string().max(2000),
  privateKey: z.string().max(2000),
});
function pemBytes(pem: string): Uint8Array<ArrayBuffer> {
  const text = pem.replace(/-----[^-]+-----/g, "").replace(/\s/g, "");
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}
function base64(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)));
}
function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}
export async function importWallet(value: unknown): Promise<BrowserWallet> {
  if (!globalThis.crypto?.subtle)
    throw new Error(
      "Wallet signing requires localhost or HTTPS and WebCrypto support",
    );
  const wallet = walletSchema.parse(value);
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemBytes(wallet.privateKey),
    "Ed25519",
    false,
    ["sign"],
  );
  const publicKey = await crypto.subtle.importKey(
    "spki",
    pemBytes(wallet.publicKey),
    "Ed25519",
    false,
    ["verify"],
  );
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const signature = await crypto.subtle.sign("Ed25519", key, challenge);
  if (!(await crypto.subtle.verify("Ed25519", publicKey, signature, challenge)))
    throw new Error("Wallet public and private keys do not match");
  return { sender: wallet.sender, publicKey: wallet.publicKey, key };
}
export function parseAmount(amount: string): number {
  if (!/^\d{1,6}(\.\d{1,2})?$/.test(amount))
    throw new Error("Enter an amount with at most two decimal places");
  const [whole, fraction = ""] = amount.split(".");
  const paise = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (paise <= 0) throw new Error("Amount must be positive");
  return paise;
}
export async function createSignedSend(
  wallet: BrowserWallet,
  receiver: string,
  amount: string,
): Promise<SignedSend> {
  if (wallet.sender === receiver)
    throw new Error("Choose a different receiver");
  const seed = crypto.getRandomValues(new Uint8Array(32));
  let root: Uint8Array<ArrayBuffer> = seed;
  for (let i = 0; i < MAX_TTL; i++)
    root = new Uint8Array(await crypto.subtle.digest("SHA-256", root));
  const authorization: Authorization = {
    version: 1,
    packetId: crypto.randomUUID(),
    maxTtl: MAX_TTL,
    hopRoot: hex(root),
    instruction: {
      sender: wallet.sender,
      receiver,
      amount: parseAmount(amount),
      nonce: crypto.randomUUID(),
      signedAt: Date.now(),
    },
  };
  const signature = await crypto.subtle.sign(
    "Ed25519",
    wallet.key,
    new TextEncoder().encode(signingText(authorization)),
  );
  return {
    authorization: { ...authorization, signature: base64(signature) },
    hopProof: hex(seed),
  };
}
