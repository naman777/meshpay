export type Account = {
  vpa: string;
  name: string;
  balance: number;
  initials: string;
  color: string;
};
export type Instruction = {
  sender: string;
  receiver: string;
  amount: number;
  nonce: string;
  signedAt: number;
};
export type Packet = { id: string; ttl: number; ciphertext: string };
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
};
