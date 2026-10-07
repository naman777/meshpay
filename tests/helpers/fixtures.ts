import { randomBytes, randomUUID } from "node:crypto";
import {
  generateSigningKeys,
  signAuthorization,
  proofRoot,
} from "../../web/server/crypto";
import { MeshEngine } from "../../web/server/sqlite-engine";
import type {
  Authorization,
  Instruction,
  SignedSend,
} from "../../web/lib/types";

export function provision(engine: MeshEngine) {
  const keys = new Map<string, ReturnType<typeof generateSigningKeys>>();
  for (const account of engine.state().accounts) {
    const pair = generateSigningKeys();
    engine.registerPublicKey(account.vpa, pair.publicKey);
    keys.set(account.vpa, pair);
  }
  return keys;
}
export function signedSend(
  privateKey: string,
  sender = "alice@demo",
  receiver = "bob@demo",
  amount = 50000,
  overrides: Partial<Instruction> = {},
): SignedSend {
  const hopProof = randomBytes(32).toString("hex");
  const auth: Authorization = {
    version: 1,
    packetId: randomUUID(),
    maxTtl: 5,
    hopRoot: proofRoot(hopProof, 5),
    instruction: {
      sender,
      receiver,
      amount,
      nonce: randomUUID(),
      signedAt: Date.now(),
      ...overrides,
    },
  };
  return { authorization: signAuthorization(auth, privateKey), hopProof };
}
