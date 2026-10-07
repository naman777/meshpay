# MeshPay

**An interactive payment mesh simulator built with Next.js, TypeScript, and SQLite.**

MeshPay demonstrates how encrypted payment instructions can travel through offline relays, reach internet-connected bridges, and settle once in a persistent ledger—even when multiple bridges deliver copies of the same payment.

The dashboard lets you compose payments, advance the mesh one hop at a time, upload packets, and inspect balances, transactions, and network activity.

> This is a local sandbox with demo balances. Bluetooth and device connectivity are simulated inside one server process. No real money moves, and there is no bank or UPI integration. Encryption is implemented; sender authentication is outside the current scope.

## Contents

- [Features](#features)
- [Screenshots](#screenshots)
- [Technology stack](#technology-stack)
- [Getting started](#getting-started)
- [Using the simulator](#using-the-simulator)
- [Architecture](#architecture)
- [Mesh topology and routing](#mesh-topology-and-routing)
- [Payment lifecycle](#payment-lifecycle)
- [Encryption and packet format](#encryption-and-packet-format)
- [Settlement and duplicate protection](#settlement-and-duplicate-protection)
- [Data model and persistence](#data-model-and-persistence)
- [API reference](#api-reference)
- [Dashboard behavior](#dashboard-behavior)
- [Repository structure](#repository-structure)
- [Development and testing](#development-and-testing)
- [Security and scope](#security-and-scope)
- [Deployment considerations](#deployment-considerations)
- [Troubleshooting](#troubleshooting)
- [Possible next steps](#possible-next-steps)

## Features

- Four demo accounts with balances represented as integer paise.
- Payment composition with account and amount validation.
- Hybrid RSA-OAEP-SHA256 and AES-256-GCM encryption.
- Five simulated devices on a fixed, bidirectional mesh.
- Manual gossip rounds with packet deduplication and hop limits.
- Two online bridges delivering packets to settlement.
- Transactional SQLite balance updates and ledger inserts.
- Persistent duplicate protection using ciphertext hashes and sender nonces.
- Settled, rejected, duplicate, and invalid delivery outcomes.
- Responsive dashboard with device inspection, ledger filters, and activity.
- One-click demo and mesh reset that preserves financial state.
- Automated encryption, routing, settlement, validation, and persistence tests.

## Screenshots

### Dashboard

![MeshPay desktop dashboard](screenshots/dashboard-desktop.jpg)

### Ledger

![MeshPay transaction ledger](screenshots/dashboard-ledger.jpg)

## Technology stack

Versions below reflect `package.json` declarations; `package-lock.json` records resolved versions.

| Layer        | Technology                     | Role                                      |
| ------------ | ------------------------------ | ----------------------------------------- |
| Framework    | Next.js 16.4.0, App Router     | Pages and HTTP route handlers             |
| Interface    | React 19.3.0                   | Client dashboard and interaction state    |
| Language     | TypeScript ^5.9.3              | Shared contracts and strict type checking |
| Runtime      | Node.js >=22.13.0              | Server, cryptography, built-in SQLite     |
| Database     | `node:sqlite` / `DatabaseSync` | Accounts, keys, ledger                    |
| Cryptography | `node:crypto`                  | Key generation, encryption, hashing       |
| Validation   | Zod ^4.3.6                     | Request and instruction validation        |
| Icons        | Lucide React ^0.577.0          | Dashboard iconography                     |
| Styling      | CSS                            | Responsive layout and mesh visualization  |
| Testing      | Node test runner via `tsx`     | TypeScript engine and route tests         |
| Formatting   | Prettier                       | Source formatting                         |

No external database service, ORM, or payment provider is required.

## Getting started

### Requirements

- Node.js **22.13.0 or newer**; Node 24 is recommended.
- npm.
- A writable project directory for the database.

### Install and run

```sh
git clone https://github.com/naman777/meshpay.git
cd meshpay
npm ci
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

No environment variables or external credentials are required. The engine creates `.data/meshpay.sqlite` when first used.

### Production build locally

```sh
npm run build
npm start
```

A production build serves the same simulator; it does not add authentication or real payment processing.

## Using the simulator

### Manual flow

1. Select different sender and receiver accounts.
2. Enter a positive rupee amount with at most two decimal places.
3. Click **Inject into mesh**. An encrypted packet enters the sender queue; balances remain unchanged.
4. Click **Run gossip round** once. Both relays receive the packet.
5. Run a second round. Both internet bridges receive copies.
6. Click **Upload via bridges**. The first valid delivery settles; the second is dropped as a duplicate.
7. Inspect balances, the ledger entry, and activity. Select devices to inspect their queue sizes.

With a fresh database, ₹500 Alice → Bob changes Alice from ₹5,000 to ₹4,500 and Bob from ₹1,000 to ₹1,500. The ledger contains one settled entry.

### One-click demo

**Run live demo** performs:

```text
Reset mesh → Queue ₹500 Alice → Bob → Gossip → Gossip → Upload
```

Each run creates a new payment and nonce. It transfers another ₹500 while Alice has sufficient funds; later runs can produce insufficient-funds rejections. There are no prepopulated fake ledger transactions.

### Reset

**Reset mesh** clears device queues, activity, gossip rounds, transfer counts, and the session duplicate counter. It preserves accounts, balances, keys, ledger entries, and persistent duplicate claims.

There is no dashboard control to reset balances or top up accounts. Seed accounts are inserted only if missing; existing balances survive restart. A fresh database is needed to restore the original seed state.

## Architecture

MeshPay consists of a browser dashboard, Next.js route handlers, an in-process mesh engine, cryptography helpers, and local SQLite storage.

```mermaid
flowchart TD
    Page[Next.js page and root layout] --> Browser[React dashboard]
    Browser -->|User actions| Actions[POST /api/actions]
    Browser -->|Poll every 3 seconds| State[GET /api/state]
    Actions --> Engine[MeshEngine]
    State --> Engine
    Key[GET /api/server-key] --> Engine
    Ingest[POST /api/bridge/ingest] --> Engine
    Engine --> Crypto[Node crypto helpers]
    Engine --> Memory[In-memory queues, events, counters]
    Engine --> DB[(SQLite: accounts, keys, ledger)]
```

### Browser and page layer

`src/app/page.tsx` renders `web/components/dashboard.tsx`, a client component. The root layout supplies metadata and global CSS. The browser reads state and sends JSON actions; it does not own the ledger or perform packet encryption.

### HTTP layer

Handlers under `src/app/api` validate requests and delegate to the engine. All API routes use the Node.js runtime. State and public-key routes are dynamic; state responses also set `Cache-Control: no-store`.

The dashboard uses `/api/actions` and `/api/state`. Public-key and ingestion endpoints provide programmatic access. The built-in bridge upload action calls the engine directly rather than making HTTP requests to `/api/bridge/ingest`.

### Engine layer

`web/server/engine.ts` owns topology, queues, routing, payment validation, logging, database initialization, and settlement.

`getEngine()` lazily creates a `MeshEngine` and caches it on `globalThis` for reuse within a server process. Requests in that process share the mesh. This is an in-process singleton, not distributed shared state.

### Cryptography and contracts

`web/server/crypto.ts` implements RSA key generation, AES encryption/decryption, envelope decoding, and ciphertext hashing. `web/lib/types.ts` defines shared account, instruction, packet, device, ledger, event, result, and state contracts.

### Storage

SQLite operations are synchronous. Accounts, keys, and ledger entries persist on disk; transport queues and session activity stay in memory.

## Mesh topology and routing

```mermaid
flowchart LR
    Sender[Sender phone] <--> R1[Relay 01]
    Sender <--> R2[Relay 02]
    R1 <--> R2
    R1 <--> B1[Bridge 01: online]
    R2 <--> B2[Bridge 02: online]
```

| Device ID  | Display name | Connectivity | Purpose                             |
| ---------- | ------------ | ------------ | ----------------------------------- |
| `alice`    | Sender phone | Offline      | Initial queue for composed payments |
| `relay-1`  | Relay 01     | Offline      | Relay toward Bridge 01              |
| `relay-2`  | Relay 02     | Offline      | Relay toward Bridge 02              |
| `bridge-1` | Bridge 01    | Online       | Delivery to settlement              |
| `bridge-2` | Bridge 02    | Online       | Delivery to settlement              |

The sender device ID remains `alice` regardless of the account selected in the form. Devices model transport roles; accounts identify whose funds move.

### Gossip rules

- Each round snapshots all device queues before copying packets.
- Packets present at the start can move one edge in either direction.
- Newly received packets can be forwarded only in the next round.
- Receivers skip packet IDs they already hold.
- New packets start with `ttl: 5`; forwarded copies decrement TTL by one.
- TTL-zero copies remain stored but cannot be forwarded further.
- Source devices retain copies; there is no automatic eviction.
- Routing advances manually, with no Bluetooth discovery or background transport.

Two rounds reach both bridges in this topology. Each round increments `rounds`; successful copies increment `transfers`.

Upload processes all packets held by online devices and retains them afterward. Repeated uploads therefore create further duplicate deliveries. TTL limits forwarding; settlement does not reject a packet solely because TTL is zero.

## Payment lifecycle

```mermaid
sequenceDiagram
    actor User
    participant UI as Dashboard
    participant API as Actions API
    participant Engine as MeshEngine
    participant DB as SQLite
    User->>UI: Send ₹500 Alice to Bob
    UI->>API: POST send, amount "500.00"
    API->>Engine: send(alice, bob, 50000)
    Engine->>Engine: Validate, encrypt, queue packet
    API-->>UI: Updated state; balances unchanged
    User->>UI: Run two gossip rounds
    UI->>API: POST gossip twice
    API->>Engine: Copy through relays to bridges
    User->>UI: Upload via bridges
    UI->>API: POST flush
    API->>Engine: flush()
    Engine->>Engine: Decrypt and validate first delivery
    Engine->>DB: Begin transaction; check duplicates
    Engine->>DB: Update balances and insert ledger row
    Engine->>DB: Commit
    Engine->>DB: Find existing entry for second delivery
    Engine->>Engine: Log dropped duplicate
    API-->>UI: Updated balances, ledger, activity
```

Queueing does not reserve funds. Balance is checked at settlement time. Two instructions may both enter the mesh, while only the first settles if there are insufficient funds for both.

## Encryption and packet format

### Plaintext instruction

Amounts inside the engine are integer paise; timestamps are Unix epoch milliseconds.

```json
{
  "sender": "alice@demo",
  "receiver": "bob@demo",
  "amount": 50000,
  "nonce": "a7e036e4-41bb-4c06-a4b1-bf98351b92db",
  "signedAt": 1791331200000
}
```

The timestamp illustrates the shape; new packets use current server time. `signedAt` is a timestamp field, not a digital signature.

### Encryption

1. Generate a fresh 32-byte AES key and 12-byte IV.
2. Encrypt the JSON instruction with AES-256-GCM.
3. Wrap the AES key using the server RSA-2048 public key, OAEP padding, and SHA-256.
4. Concatenate the wrapped key, IV, encrypted JSON, and 16-byte GCM tag.
5. Encode the envelope as Base64.

```text
RSA-wrapped AES key | IV       | Encrypted JSON | GCM tag
256 bytes          | 12 bytes | variable       | 16 bytes
```

### Transport packet

```json
{
  "id": "7b59a7f6-7ccf-4dc4-a5c4-88f41a3e50dd",
  "ttl": 5,
  "ciphertext": "<Base64 encrypted packet>"
}
```

Packet ID and TTL are outside the encrypted payload. Relays copy opaque ciphertext without decrypting it. SHA-256 hashing uses decoded ciphertext bytes, not the Base64 text.

Decoding rejects strings longer than 16,384 characters, characters outside the accepted Base64 pattern, and envelopes shorter than 284 bytes. Decryption verifies the GCM tag and parses JSON.

The server simulates sender encryption. Cryptography provides payload confidentiality and integrity within this simulated transport, but does not establish sender authorization.

## Settlement and duplicate protection

For each delivered packet, the engine:

1. Hashes decoded ciphertext, decrypts it, and validates the instruction schema.
2. Rejects timestamps older than 24 hours or more than five minutes ahead.
3. Rejects identical sender and receiver addresses.
4. Opens a SQLite `BEGIN IMMEDIATE` transaction.
5. Looks up the ciphertext hash or `(sender, nonce)` in the ledger.
6. Confirms both accounts exist and checks the current sender balance.
7. Updates balances if funds are sufficient.
8. Inserts a `SETTLED` or `REJECTED` row and commits.

SQLite uses WAL journaling and a 5,000 ms busy timeout. Balance updates and ledger insertion commit together. The accounts table prohibits negative balances; the ledger enforces unique hashes and sender/nonce pairs.

| Outcome             | Balance changes               | New ledger row | Meaning                                                        |
| ------------------- | ----------------------------- | -------------- | -------------------------------------------------------------- |
| `SETTLED`           | Debit sender, credit receiver | Yes            | Valid instruction with sufficient funds                        |
| `REJECTED`          | None                          | Yes            | Insufficient funds                                             |
| `DUPLICATE_DROPPED` | None                          | No             | Existing hash or sender nonce; returns original transaction ID |
| `INVALID`           | None                          | No             | Invalid encryption, payload, timestamp, or accounts            |

**Ciphertext hashes** stop the same encrypted payment being processed through another bridge or packet ID. **Sender nonces** stop the same instruction being processed after re-encryption creates different ciphertext.

Rejected rows also claim their hash and nonce. Retrying them after funding still produces a duplicate; a new instruction needs a new nonce. Invalid payloads create no permanent claim. Database failures roll back and propagate an error.

Timestamp validation precedes duplicate lookup: an old, previously settled packet can later return `INVALID` rather than `DUPLICATE_DROPPED`.

## Data model and persistence

### Seed accounts

| Name  | Address      | Initial balance | Stored paise |
| ----- | ------------ | --------------- | ------------ |
| Alice | `alice@demo` | ₹5,000.00       | 500000       |
| Bob   | `bob@demo`   | ₹1,000.00       | 100000       |
| Carol | `carol@demo` | ₹2,500.00       | 250000       |
| Dave  | `dave@demo`  | ₹500.00         | 50000        |

The total initial balance is ₹9,000. Settlement redistributes it; there is no deposit, withdrawal, or minting feature.

### SQLite tables

| Table      | Columns                                                                                          | Constraints and purpose                                   |
| ---------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| `accounts` | `vpa`, `name`, `balance`, `initials`, `color`                                                    | Primary `vpa`; nonnegative balance                        |
| `keys`     | `id`, `publicKey`, `privateKey`                                                                  | RSA key pair at ID 1                                      |
| `ledger`   | `id`, `sender`, `receiver`, `amount`, `status`, `createdAt`, `bridge`, `hash`, `nonce`, `reason` | Primary transaction ID; unique hash and `(sender, nonce)` |

Initialization uses `CREATE TABLE IF NOT EXISTS` and seeds missing accounts using `INSERT OR IGNORE`. There is no versioned migration system.

### Storage lifetime

| State                                | Storage | Survives mesh reset | Survives server restart |
| ------------------------------------ | ------- | ------------------- | ----------------------- |
| Accounts and balances                | SQLite  | Yes                 | Yes                     |
| RSA key pair                         | SQLite  | Yes                 | Yes                     |
| Ledger and duplicate claims          | SQLite  | Yes                 | Yes                     |
| Device queues                        | Memory  | No                  | No                      |
| Activity events                      | Memory  | No                  | No                      |
| Rounds, transfers, duplicate counter | Memory  | No                  | No                      |

The path is relative to the server working directory: `.data/meshpay.sqlite`. SQLite can create WAL and shared-memory sidecar files. Git ignores `.data/`, dependencies, build output, environment files, and TypeScript build caches.

The database retains older ledger rows, but the state API returns only the most recent 100. The engine retains 60 activity events; the dashboard displays the latest eight.

## API reference

Responses are JSON. Send `Content-Type: application/json` for POST requests.

| Method | Endpoint             | Purpose                                              |
| ------ | -------------------- | ---------------------------------------------------- |
| `GET`  | `/api/state`         | Accounts, devices, recent ledger, activity, counters |
| `POST` | `/api/actions`       | Simulator control and updated state                  |
| `POST` | `/api/bridge/ingest` | Deliver one encrypted packet                         |
| `GET`  | `/api/server-key`    | Public key and encryption algorithm                  |

### GET /api/state

| Field          | Type            | Meaning                                        |
| -------------- | --------------- | ---------------------------------------------- |
| `accounts`     | `Account[]`     | Identity, paise balance, display attributes    |
| `devices`      | `Device[]`      | IDs, names, connectivity, coordinates, packets |
| `transactions` | `LedgerEntry[]` | Latest 100 rows, newest first                  |
| `events`       | `MeshEvent[]`   | Latest 60 events, newest first                 |
| `rounds`       | `number`        | Rounds since mesh reset                        |
| `duplicates`   | `number`        | Duplicate deliveries dropped since reset       |
| `transfers`    | `number`        | Packet copies forwarded since reset            |

This unauthenticated endpoint exposes account data and device ciphertext. Ledger queries select all columns, so transaction objects also include `nonce`, beyond the shared `LedgerEntry` type's declared fields.

### POST /api/actions

#### Send

```json
{
  "action": "send",
  "sender": "alice@demo",
  "receiver": "bob@demo",
  "amount": "500.00"
}
```

The amount is a **rupee decimal string**, not a number or paise value. The route splits whole and fractional parts to obtain integer paise without floating-point currency multiplication.

- Syntax: one to six whole digits, optionally followed by one or two decimal digits.
- Accepted examples: `"100"`, `"100.5"`, `"100.50"`.
- Rejected examples: numeric `100`, `"0.001"`, `"-10"`, `"1e3"`, `"1,000"`.
- Converted amounts must be positive; accounts must exist and differ.
- The engine maximum is 100,000,000 paise (₹10,00,000); action syntax limits this endpoint to ₹9,99,999.99.

#### Controls

```json
{ "action": "gossip" }
```

| Action   | Behavior                                          |
| -------- | ------------------------------------------------- |
| `gossip` | Advance one routing round                         |
| `flush`  | Ingest all packets at both online bridges         |
| `reset`  | Clear mesh queues and session state               |
| `demo`   | Reset, send ₹500 Alice → Bob, gossip twice, flush |

Success returns HTTP `200` and the full updated state, not individual bridge results. An insufficient-funds rejection can be included in a successful action response.

Validation and action failures return HTTP `400` with `{ "error": "..." }`. When an Origin header is present, its protocol must be HTTP(S) and its host must match the request Host header. Invalid or mismatched origins return `403`. Missing Origin headers are accepted. This is not authentication; matching does not require equal schemes beyond HTTP(S).

#### PowerShell example

```powershell
$body = @{
    action = 'send'
    sender = 'alice@demo'
    receiver = 'bob@demo'
    amount = '500.00'
} | ConvertTo-Json

Invoke-RestMethod -Uri 'http://localhost:3000/api/actions' -Method Post -ContentType 'application/json' -Body $body
Invoke-RestMethod -Uri 'http://localhost:3000/api/actions' -Method Post -ContentType 'application/json' -Body '{"action":"gossip"}'
Invoke-RestMethod -Uri 'http://localhost:3000/api/actions' -Method Post -ContentType 'application/json' -Body '{"action":"gossip"}'
Invoke-RestMethod -Uri 'http://localhost:3000/api/actions' -Method Post -ContentType 'application/json' -Body '{"action":"flush"}'
```

This example changes demo balances when settlement succeeds.

### POST /api/bridge/ingest

Accepts the transport packet shape shown earlier. The ciphertext placeholder must be replaced with an actual encrypted instruction.

| Input                     | Constraint                                                                                   |
| ------------------------- | -------------------------------------------------------------------------------------------- |
| `id`                      | UUID                                                                                         |
| `ttl`                     | Integer from 0 to 5                                                                          |
| `ciphertext`              | String up to 16,384 characters; validated by decryption                                      |
| `X-Bridge-Node-Id` header | Optional label truncated to 100 characters; defaults to `external-bridge` if absent or empty |

Example response:

```json
{
  "outcome": "SETTLED",
  "transactionId": "c7d23f9a-80b9-4fe9-93a6-dbf994937d96"
}
```

| HTTP status | Response                                                               |
| ----------- | ---------------------------------------------------------------------- |
| `200`       | `SETTLED`, `REJECTED`, or `DUPLICATE_DROPPED`                          |
| `422`       | `INVALID` with a reason                                                |
| `400`       | Malformed request or caught settlement exception; error requests retry |

Results can include `transactionId` and `reason`. Ingestion does not require prior mesh traversal and does not authenticate the bridge label.

### GET /api/server-key

```json
{
  "publicKey": "<PEM-encoded RSA public key>",
  "algorithm": "RSA-OAEP-SHA256 + AES-256-GCM"
}
```

The private key is not returned. Preserving the database preserves the key pair across restarts.

## Dashboard behavior

- Sidebar navigation scrolls to sections of one dashboard page.
- Nodes support click, Enter, and Space selection; the inspection strip shows queue size and connectivity.
- Amount presets offer ₹100, ₹500, and ₹1,000.
- Ledger filters operate on the latest 100 returned entries.
- Settled volume is derived from those rows, not an all-time database aggregate.
- Payments in mesh counts unique packet IDs, including already settled payments whose copies remain queued.
- Duplicate count measures dropped delivery attempts in the session, not unique duplicate payments.
- State refreshes every three seconds and after successful actions; there are no WebSockets or server-sent events.
- Buttons are disabled while actions run. Errors appear in a dismissible banner; failed polling keeps retrying.
- CSS adapts to smaller screens and respects reduced-motion preferences.
- The help dialog supports Escape, focus cycling, and focus restoration.

## Repository structure

```text
meshpay/
├── src/app/
│   ├── api/
│   │   ├── actions/route.ts          # Simulator controls
│   │   ├── bridge/ingest/route.ts    # Direct packet ingestion
│   │   ├── server-key/route.ts       # Public key
│   │   └── state/route.ts            # Current state
│   ├── globals.css                  # Dashboard and responsive styles
│   ├── layout.tsx                   # Root layout and metadata
│   └── page.tsx                     # Dashboard page
├── web/
│   ├── components/dashboard.tsx     # Client interface
│   ├── lib/types.ts                 # Shared contracts
│   └── server/
│       ├── crypto.ts                # Encryption and hashing
│       └── engine.ts                # Mesh and SQLite settlement
├── tests/
│   ├── api.test.ts                  # Origin and validation tests
│   └── engine.test.ts               # Crypto, routing, persistence
├── screenshots/                     # Dashboard images
├── AGENTS.md                        # Agent guidance
├── next.config.ts                   # Framework configuration
├── next-env.d.ts                     # Generated Next.js type references
├── package.json                     # Scripts and dependencies
├── package-lock.json                # Dependency lockfile
├── tsconfig.json                    # Strict TypeScript configuration
├── TYPESCRIPT.md                    # Documentation pointer
└── README.md
```

Generated local directories are `.next/`, `node_modules/`, and `.data/`. The `@/*` TypeScript alias resolves to `web/*`. Next.js disables the `X-Powered-By` header.

## Development and testing

| Command             | Purpose                                              |
| ------------------- | ---------------------------------------------------- |
| `npm ci`            | Install locked dependencies                          |
| `npm run dev`       | Start development server                             |
| `npm run build`     | Build for production                                 |
| `npm start`         | Serve the production build                           |
| `npm run typecheck` | TypeScript checking without emitting files           |
| `npm test`          | Run `tests/*.test.ts` via `tsx` and Node test runner |
| `npm run format`    | Format configured sources and configuration          |

The format script includes `TYPESCRIPT.md` but excludes `README.md`.

### Verification

```sh
npm run typecheck
npm test
npm run build
```

The current suite contains 12 tests covering:

- Encryption round trip and tamper detection.
- Two-hop delivery to both bridges and one settlement.
- Repeated asynchronous deliveries producing one ledger entry.
- Insufficient funds without balance changes.
- Old/future timestamps and tampered packets.
- Re-encryption with a reused sender nonce.
- Competing payments without overdrafts and conservation of money.
- Fractional paise, nonpositive amounts, self-payments, and unknown accounts.
- Reset preserving balances, ledger, and duplicate protection.
- On-disk persistence of keys, balances, and duplicate claims.
- Same-origin loopback requests reaching amount validation.
- Malformed and cross-origin Origin rejection.

Most engine tests use in-memory SQLite; persistence uses a temporary disk database. The asynchronous delivery test runs synchronous engine operations in one Node process. It is not a multi-process concurrency or load test.

Browser end-to-end tests, full HTTP integration coverage for every route, and deployment/load tests are not included.

For Next.js changes, follow `AGENTS.md` and consult the version-specific guides in `node_modules/next/dist/docs/`.

## Security and scope

### Implemented safeguards

- AES-GCM detects encrypted payload modification.
- RSA-OAEP wraps a fresh AES key for each packet.
- Schema validation checks amounts, payloads, and UUID nonces.
- Timestamp bounds limit acceptance of old and far-future instructions.
- SQLite transactions and constraints prevent duplicate balance application.
- Integer paise avoid floating-point balance arithmetic.
- Action Origin checks reject the mismatched origins described above.

### Boundaries

- Senders are unauthenticated and instructions carry no sender signature.
- Anyone with API access can issue instructions for demo accounts. The public key also lets clients encrypt instructions naming those accounts.
- Bridges are unauthenticated; labels are caller-provided metadata.
- No physical Bluetooth, peer discovery, mobile wallet, or offline browser application is implemented. The browser still needs access to the server.
- There is no UPI PIN collection, bank integration, or real-money settlement.
- The RSA private key is stored unencrypted in SQLite for demo convenience.
- Packet ID and TTL are not cryptographically bound to the instruction.
- Queues lack durable storage, automatic expiry, acknowledgements, and capacity limits.
- Rate limiting, user-specific authorization, key rotation, operational monitoring, and migrations are not implemented.

This is **mesh-routed deferred settlement**. Queueing an instruction is not a guaranteed or final offline funds transfer.

## Deployment considerations

The intended environment is a local sandbox with one server process and persistent writable storage.

| Concern       | Requirement or behavior                                                                                               |
| ------------- | --------------------------------------------------------------------------------------------------------------------- |
| Runtime       | Node.js with built-in SQLite; API routes use Node, not Edge                                                           |
| Filesystem    | Writable `.data/` for the database and sidecar files                                                                  |
| Persistence   | Preserve SQLite to retain balances, ledger, and keys                                                                  |
| Restarts      | Pending in-memory packets and session activity are lost                                                               |
| Replicas      | Each process has independent mesh queues and counters                                                                 |
| Serverless    | Ephemeral disks and independent instances do not fit the current storage/session model                                |
| Backups       | Use SQLite-aware backups accounting for WAL; avoid copying only an actively written main database                     |
| Public access | Add authentication, authorization, request limits, and secure key custody before a deployment involving valuable data |

Static-only export cannot serve the required APIs and database. No hosted deployment configuration or multi-instance coordination layer is supplied.

## Troubleshooting

| Symptom                                      | Explanation or next step                                                                    |
| -------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `node:sqlite` unavailable                    | Check Node version; use 22.13.0+ or Node 24                                                 |
| SQLite experimental warning                  | Some supported versions mark the API experimental; inspect actual errors if execution fails |
| Upload leaves balances unchanged             | Run two gossip rounds; inspect ledger rejections                                            |
| Duplicate count increases on repeated upload | Bridge copies remain queued and are deduplicated again                                      |
| Reset does not restore seed balances         | Mesh reset preserves SQLite financial state                                                 |
| Restart loses pending payments               | Queues live in memory                                                                       |
| Live demo stops settling                     | Alice may have exhausted her balance                                                        |
| Timestamp rejection                          | Accepted window is at most 24 hours old or five minutes ahead                               |
| Database cannot open/write                   | Check directory permissions, writable disk, and working directory                           |
| Dashboard connection banner                  | Confirm server and `/api/state` availability; polling retries every three seconds           |
| Missing `.next` type files on fresh checkout | Run a build or start development to generate Next.js types, then retry type checking        |

To restore the original seed state, stop the server and use a fresh database. Back up existing data before replacing it. Replacing the database discards balances, history, and keys; old packets will not decrypt with a new key pair.

## Possible next steps

These are extension ideas, not implemented features:

- Authenticate users and verify sender signatures.
- Introduce real peer transport and authenticated device identities.
- Persist queues with acknowledgements, retries, expiry, and limits.
- Protect key custody and define rotation procedures.
- Add ledger pagination, all-time metrics, and transaction inspection.
- Add browser end-to-end, broader API, and multi-process tests.
- Define migrations, backups, monitoring, and deployment operations.
- Design payment-provider integration and authorization separately from this simulator.
