import { z } from "zod";
import type { Authorization } from "./types";

export const MAX_TTL = 5;
export const instructionSchema = z.strictObject({
  sender: z.string().min(1).max(100),
  receiver: z.string().min(1).max(100),
  amount: z.number().int().positive().max(100_000_000),
  nonce: z.uuid(),
  signedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
export const hexSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const authorizationSchema = z.strictObject({
  version: z.literal(1),
  instruction: instructionSchema,
  packetId: z.uuid(),
  maxTtl: z.number().int().min(1).max(MAX_TTL),
  hopRoot: hexSchema,
  signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/),
});
export const signedSendSchema = z.strictObject({
  authorization: authorizationSchema,
  hopProof: hexSchema,
});
export const packetSchema = z.strictObject({
  id: z.uuid(),
  ttl: z.number().int().min(0).max(MAX_TTL),
  hopProof: hexSchema,
  ciphertext: z.string().min(1).max(16_384),
});
export const failureSchema = z.strictObject({
  lossRate: z.number().min(0).max(1),
  delayRounds: z.number().int().min(0).max(10),
  partitioned: z.boolean(),
  offlineBridges: z.array(z.enum(["bridge-1", "bridge-2"])).max(2),
  seed: z.number().int().min(1).max(0xffffffff),
});

// Fixed field order, a version, and a domain separate payments from other signatures.
export function signingText(auth: Authorization): string {
  const i = auth.instruction;
  return JSON.stringify([
    "meshpay:payment:v1",
    auth.version,
    auth.packetId,
    auth.maxTtl,
    auth.hopRoot,
    i.sender,
    i.receiver,
    i.amount,
    i.nonce,
    i.signedAt,
  ]);
}
