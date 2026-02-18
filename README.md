# local_rollup_explorer

A lightweight Zeko explorer for developers launching their own rollup.

## Prerequisites

- Node.js 20+ (required for V1 and indexer API)
- Docker Desktop (optional, for Compose-based V2 stack)

If you see `zsh: command not found: docker`, Docker is not installed/running yet.
Install Docker Desktop, start it, then re-run the V2 compose command.

## What this V1 does

- Connects to one Zeko sequencer GraphQL endpoint.
- Supports network profile switching in the UI with `localStorage` persistence.
- Shows network health and rollup state hashes.
- Shows a simple sync pill (`Synced` / `Unsynced`).
  - Full health payload is available behind a collapsible details toggle (persisted per browser).
- Lets you query one account/contract at a time.
- Account/contract output includes zkApp fields when present (URI, state, action state, verification key, permissions).
- Shows account-scoped history summary (recent transaction hashes from events/actions).
- Lets you inspect archive-backed actions/events (with action state window filters).
- Provides transaction lookup:
  - V1: account-scoped lookup by hash when `publicKey` is provided (limited to txs visible in that account's events/actions history).
  - V2: global lookup by hash via `ZEKO_V2_INDEXER_URL`.

## Quick start

1. Set your sequencer GraphQL URL.
2. Run the local adapter/server.
3. Open the UI in your browser.

```bash
cd /Users/evankereiakes/Documents/Codex/local_rollup_explorer
ZEKO_SEQUENCER_URL="http://127.0.0.1:8080/graphql" node server.mjs
```

Then open [http://localhost:4173](http://localhost:4173).

You can change networks live in the **Network Profiles** section without restarting.

## V1 run command

```bash
cd /Users/evankereiakes/Documents/Codex/local_rollup_explorer
ZEKO_SEQUENCER_URL="https://testnet.zeko.io/graphql" node server.mjs
```

V1 lookup capabilities:

- account/contract lookup
- account-scoped events/actions
- account-scoped tx hash lookup from those events/actions

V1 limitations:

- no full-chain/global tx hash resolution
- no guaranteed plain-payment history feed

## Optional V2 transaction lookup

If you have an indexer service, set `ZEKO_V2_INDEXER_URL`.

```bash
ZEKO_SEQUENCER_URL="http://127.0.0.1:8080/graphql" \
ZEKO_V2_INDEXER_URL="http://127.0.0.1:8787" \
node server.mjs
```

The server will call `GET /v2/tx/:hash` on that service for tx hash lookups.

## Docker Compose (local V2 infra starter)

This stack gives you:

- explorer UI + adapter
- Postgres for indexer data
- Adminer DB UI
- `indexer-api` service with:
  - default mode: `START_MODE=latest` (progressive ingest from current head)
  - optional mode: `START_MODE=backfill` (requires `BACKFILL_ACK=true`)
  - `POST /v2/track/account`
  - `POST /v2/sync/account`
  - `GET /v2/tx/:hash`
  - `GET /v2/account/:publicKey/transactions`
  - `GET /v2/tracked/accounts`

```bash
cd /Users/evankereiakes/Documents/Codex/local_rollup_explorer
docker compose -f docker-compose.v2-indexer.yml up --build
```

Endpoints:

- Explorer: [http://localhost:4173](http://localhost:4173)
- Postgres: `localhost:5432` (`zeko/zeko`, DB `zeko_indexer`)
- Adminer: [http://localhost:8081](http://localhost:8081)
- Indexer API: [http://localhost:8787](http://localhost:8787)

## V2 migration path (from V1)

1. Start the V2 stack with Docker Compose.
2. Sync a tracked account:

```bash
curl -X POST http://localhost:8787/v2/sync/account \
  -H 'content-type: application/json' \
  -d '{"publicKey":"B62...","tokenId":"1","sequencerUrl":"https://testnet.zeko.io/graphql"}'
```

3. Use global tx lookup:

```bash
curl http://localhost:8787/v2/tx/<tx-hash>
```

4. Optional: list tracked accounts:

```bash
curl http://localhost:8787/v2/tracked/accounts
```

5. Explorer automatically attempts V2 tx lookup when `ZEKO_V2_INDEXER_URL` is set.

## Ingestion modes

- Default: `START_MODE=latest`
  - first sync primes cursor at current head
  - subsequent loops ingest forward
  - recommended for local/dev chains and lightweight setups
- Optional: `START_MODE=backfill`
  - ingests historical account-scoped actions/events
  - requires `BACKFILL_ACK=true`

Backfill warning:

- For larger chains such as zeko testnet, backfill can require significant CPU/RAM/disk and sustained I/O.
- Enable backfill only when your compute and infra are sized appropriately.

## API adapter contract

V1 UI talks only to local adapter endpoints:

- `GET /api/v1/network/health`
- `GET /api/v1/account/:publicKey?tokenId=<token>`
- `GET /api/v1/archive/events?publicKey=<pk>&tokenId=<token>`
- `GET /api/v1/archive/actions?publicKey=<pk>&tokenId=<token>&fromActionState=<f>&endActionState=<f>`
- `GET /api/v1/tx/:hash` (optional V2 upstream)

See:

- `/Users/evankereiakes/Documents/Codex/local_rollup_explorer/docs/API_ADAPTER.md`
- `/Users/evankereiakes/Documents/Codex/local_rollup_explorer/docs/HOSTING_V2_INFRA.md`

## Notes

- This UI does not persist chain history.
- It is intentionally lightweight for rollup launch validation and debugging.
- V2 can keep the same UI and replace only adapter internals with indexed storage.
