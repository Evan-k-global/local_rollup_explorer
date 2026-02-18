# Hosting V2 Infra (Indexer-backed)

This doc outlines a practical V2 stack for full-history exploration.

## Target architecture

1. Zeko sequencer + archive relay produce canonical data.
2. Indexer ingests chain/transaction/event/action data into Postgres.
3. Adapter API reads from Postgres (or indexer API) and serves `/api/v1/*` + richer `/v2/*`.
4. UI stays unchanged for existing panels, with optional V2 panels later.

## Recommended components

- `postgres`: persistent store for indexed entities.
- `indexer-worker`: pulls from archive relay outputs and/or GraphQL, normalizes into DB.
- `adapter-api`: exposes stable HTTP contract to UI.
- `ui`: static app3-explorer frontend.
- `redis` (optional): caching and queueing for high-throughput indexing.

## Data model (minimum)

- `blocks`
  - `height`, `state_hash`, `parent_hash`, `timestamp`, `global_slot`, `ledger_hash`
- `transactions`
  - `hash`, `status`, `memo`, `sequence_no`, `block_height`, `applied_at`
- `account_events`
  - `id`, `public_key`, `token_id`, `tx_hash`, `block_height`, `payload_json`
- `account_actions`
  - `id`, `public_key`, `token_id`, `tx_hash`, `block_height`, `action_state_before`, `action_state_after`, `payload_json`
- `sync_cursor`
  - `source`, `last_height`, `last_hash`, `updated_at`

## Operational guidance

- Start with append-only ingestion; handle corrections with compensating updates.
- Persist a cursor each successful chunk to support restart.
- Use idempotent upserts on `hash`/`(tx_hash, index)` keys.
- Keep a short hot cache for common account queries.

## Sizing for early devnet-like workloads

- CPU: 2-4 vCPU for indexer + API.
- Memory: 4-8 GB total.
- Postgres: 20-100 GB initial disk.
- Backups: daily snapshots + WAL archiving if available.

## Deployment options

- Small teams: single VM + Docker Compose.
- Managed: container service + managed Postgres.
- Higher scale: Kubernetes with dedicated worker deployment and HPA.

## Local starter in this repo

Use `/Users/evankereiakes/Documents/Codex/app3-explorer/docker-compose.v2-indexer.yml` as a base stack.

- `explorer` (current UI/adapter)
- `postgres` (with starter schema under `/Users/evankereiakes/Documents/Codex/app3-explorer/docker/initdb/001_v2_schema.sql`)
- `indexer-api` (Postgres-backed service with `/v2/sync/account`, `/v2/tx/:hash`, `/v2/account/:publicKey/transactions`)
- `adminer` for DB inspection

Indexer mode defaults:

- `START_MODE=latest` (default): progressive ingest from latest head.
- `START_MODE=backfill` (optional): historical ingest; requires `BACKFILL_ACK=true`.

Backfill warning:

- On larger chains (e.g., zeko testnet), backfill may require substantial CPU/RAM/storage and sustained I/O.

## Security baseline

- Put adapter + indexer behind TLS.
- Restrict DB access to private network.
- Add request-level auth/rate limits for public explorer deployments.
- Log all upstream fetch failures and cursor rewinds.

## Migration path from V1

1. Keep UI unchanged.
2. Implement `GET /v2/tx/:hash` first.
3. Move `events/actions/account` to indexer-backed provider.
4. Add new V2 endpoints for global feed and advanced filtering.
