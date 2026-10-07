export type Account = {
  vpa: string;
  name: string;
  balance: number;
  initials: string;
  color: string;
  signingPublicKey?: string | null;
};
export type Instruction = {
  sender: string;
  receiver: string;
  amount: number;
  nonce: string;
  signedAt: number;
};
export type Authorization = {
  version: 1;
  instruction: Instruction;
  packetId: string;
  maxTtl: number;
  hopRoot: string;
};
export type SignedAuthorization = Authorization & { signature: string };
export type SignedSend = {
  authorization: SignedAuthorization;
  hopProof: string;
};
export type Packet = {
  id: string;
  ttl: number;
  hopProof: string;
  ciphertext: string;
};
export type Wallet = {
  version: 1;
  sender: string;
  publicKey: string;
  privateKey: string;
};
export type FailureConfig = {
  lossRate: number;
  delayRounds: number;
  partitioned: boolean;
  offlineBridges: string[];
  seed: number;
};
export type Convergence = {
  queued: number;
  processed: number;
  pending: number;
  bridgeReached: number;
  delayed: number;
  dropped: number;
  converged: boolean;
};
export type Device = {
  id: string;
  name: string;
  owner: string;
  online: boolean;
  x: number;
  y: number;
  packets: Packet[];
};
export type LedgerEntry = {
  id: string;
  sender: string;
  receiver: string;
  amount: number;
  status: "SETTLED" | "REJECTED";
  createdAt: number;
  bridge: string;
  hash: string;
  reason: string | null;
};
export type MeshEvent = {
  id: string;
  time: number;
  kind: "payment" | "gossip" | "settled" | "duplicate" | "rejected" | "system";
  message: string;
};
export type Result = {
  outcome: "SETTLED" | "REJECTED" | "DUPLICATE_DROPPED" | "INVALID";
  reason?: string;
  transactionId?: string;
};
export type State = {
  accounts: Account[];
  devices: Device[];
  transactions: LedgerEntry[];
  events: MeshEvent[];
  rounds: number;
  duplicates: number;
  transfers: number;
  failures: FailureConfig;
  convergence: Convergence;
};
