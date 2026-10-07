import {
  createCipheriv,
  createDecipheriv,
  createHash,
  generateKeyPairSync,
  privateDecrypt,
  publicEncrypt,
  randomBytes,
  constants,
  createPublicKey,
  sign,
  verify,
} from "node:crypto";
import type { Authorization, SignedAuthorization } from "../lib/types";
import { signingText } from "../lib/protocol";

export function generateSigningKeys() {
  return generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
}
export function signAuthorization(
  auth: Authorization,
  privateKey: string,
): SignedAuthorization {
  return {
    ...auth,
    signature: sign(null, Buffer.from(signingText(auth)), privateKey).toString(
      "base64",
    ),
  };
}
export function normalizeSigningKey(publicKey: string): string {
  const key = createPublicKey(publicKey);
  if (key.asymmetricKeyType !== "ed25519")
    throw new Error("An Ed25519 public key is required");
  return key.export({ type: "spki", format: "pem" }).toString();
}
export function verifyAuthorization(
  auth: SignedAuthorization,
  publicKey: string,
): boolean {
  return verify(
    null,
    Buffer.from(signingText(auth)),
    publicKey,
    Buffer.from(auth.signature, "base64"),
  );
}
export function advanceProof(proof: string): string {
  return createHash("sha256").update(Buffer.from(proof, "hex")).digest("hex");
}
export function proofRoot(proof: string, ttl: number): string {
  for (let i = 0; i < ttl; i++) proof = advanceProof(proof);
  return proof;
}

export function generateKeys() {
  return generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
}
export function encrypt(payloadValue: unknown, publicKey: string): string {
  const key = randomBytes(32),
    iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const payload = Buffer.concat([
    cipher.update(JSON.stringify(payloadValue), "utf8"),
    cipher.final(),
  ]);
  const wrapped = publicEncrypt(
    {
      key: publicKey,
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256",
    },
    key,
  );
  return Buffer.concat([wrapped, iv, payload, cipher.getAuthTag()]).toString(
    "base64",
  );
}
export function decode(ciphertext: string) {
  if (ciphertext.length > 16_384 || !/^[A-Za-z0-9+/]+={0,2}$/.test(ciphertext))
    throw new Error("Invalid ciphertext");
  const bytes = Buffer.from(ciphertext, "base64");
  if (bytes.length < 284) throw new Error("Truncated ciphertext");
  return bytes;
}
export function hash(ciphertext: string) {
  return createHash("sha256").update(decode(ciphertext)).digest("hex");
}
export function decrypt(ciphertext: string, privateKey: string): unknown {
  const bytes = decode(ciphertext);
  const key = privateDecrypt(
    {
      key: privateKey,
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256",
    },
    bytes.subarray(0, 256),
  );
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    bytes.subarray(256, 268),
  );
  decipher.setAuthTag(bytes.subarray(-16));
  return JSON.parse(
    Buffer.concat([
      decipher.update(bytes.subarray(268, -16)),
      decipher.final(),
    ]).toString("utf8"),
  );
}
