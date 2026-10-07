# MeshPay

A Next.js dashboard and TypeScript payment mesh simulator.

## Run

Use Node.js **22.13 or newer** (Node 24 recommended). The backend uses Node's built-in SQLite module; no external database installation is needed.

```powershell
npm install
npm run dev
```

Open http://localhost:3000. For a production build, run `npm run build` and `npm start`.

## Try the flow

1. Choose sender, receiver, and an amount; click **Inject into mesh**.
2. Run **two gossip rounds**. Alice's phone hands the packet to two relays, which forward it to two internet bridges.
3. Click **Upload via bridges**. The first delivery settles; the second is dropped as a duplicate.
4. Filter the ledger, select network devices, and inspect activity and balances.

**Run live demo** executes those steps with a ₹500 Alice → Bob payment. Each run creates a new payment and changes balances. **Reset mesh** clears queued packets, activity, and counters, while preserving balances and the ledger. There are no prepopulated fake transactions.

## Architecture

`src/app` contains Next.js App Router pages and route handlers. `web/components` contains the client dashboard. `web/lib/types.ts` defines the shared data contracts. `web/server/crypto.ts` handles RSA-OAEP-SHA256 and AES-256-GCM. `web/server/engine.ts` implements network topology, gossip, validation, and transactional SQLite settlement.

Money is stored as integer paise. API amount input is a decimal string parsed into paise without floating-point currency arithmetic. SQLite `BEGIN IMMEDIATE` serializes ledger writes; balance changes and the ledger insert commit together. Unique constraints on ciphertext hash and `(sender, nonce)` preserve duplicate protection across restarts. Hashes use decoded ciphertext bytes. Invalid payloads and failed database transactions do not create a permanent duplicate claim. Insufficient funds create a `REJECTED` ledger row and response.

Encryption uses a fresh 256-bit AES key and 12-byte IV for each packet, wraps the AES key with RSA-2048 OAEP using SHA-256, and appends a 16-byte GCM tag. Server keys, balances, and ledger entries persist in `.data/meshpay.sqlite`. Device queues, activity, and session counters are held in memory and reset on server restart.

## API

| Method | Path                 | Purpose                                                               |
| ------ | -------------------- | --------------------------------------------------------------------- |
| GET    | `/api/state`         | Accounts, recent 100 transactions, network state and events           |
| POST   | `/api/actions`       | `send`, `gossip`, `flush`, `reset`, or `demo`                         |
| POST   | `/api/bridge/ingest` | Deliver `{ id, ttl, ciphertext }`; optional `X-Bridge-Node-Id` header |
| GET    | `/api/server-key`    | PEM public key and encryption algorithm                               |

Example sender action: `{ "action": "send", "sender": "alice@demo", "receiver": "bob@demo", "amount": "500.00" }`.

## Checks

```powershell
npm run typecheck
npm test
npm run build
```

Tests cover encryption/tampering, multi-hop routing, repeated deliveries, insufficient funds, timestamps, nonce replay, competing payments, monetary conservation, validation, reset behavior, and persistence. The simultaneous delivery test exercises asynchronous calls in one Node process; it is not a multi-process load test.

## Demo boundary

This is **mesh-routed deferred settlement**, not a bank or real UPI integration. No physical Bluetooth is used. Senders and bridges are not authenticated. Anyone who can access the demo API can create instructions for demo accounts. AES-GCM provides payload integrity but does not prove sender authorization. No PIN is collected because this implementation cannot verify a real UPI PIN.

The private key is stored in the local SQLite database for demo convenience. Deployments handling valuable data need proper key custody, sender authentication, rate limiting, persistent queues, and operational controls. Run this as a local sandbox. Persistent disk is required; ephemeral/serverless instances and multiple independent replicas do not share mesh session state. Polling refreshes the dashboard every three seconds.
