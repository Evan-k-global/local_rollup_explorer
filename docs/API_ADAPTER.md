# API Adapter Design (V1 -> V2)

This adapter sits between UI and chain data sources.

## Goals

- Keep frontend stable while backend evolves.
- Support lightweight direct GraphQL mode first.
- Allow V2 indexer mode without UI rewrites.

## V1 data sources

- Zeko sequencer GraphQL (`networkID`, `syncStatus`, `daemonStatus`, `stateHashes`, `account`, `actions`, `events`).
- Optional V2 tx lookup upstream.

## Endpoint contract

### `GET /api/v1/network/health`

Response:

```json
{
  "source": { "sequencerGraphqlUrl": "http://127.0.0.1:8080/graphql" },
  "network": "zeko:testnet",
  "syncStatus": "SYNCED",
  "daemonStatus": {
    "chainId": "69420",
    "consensusConfiguration": {
      "epochDuration": 0,
      "k": 0,
      "slotsPerEpoch": 0,
      "slotDuration": 0
    }
  },
  "stateHashes": {
    "provedLedgerHash": "...",
    "unprovedLedgerHash": "..."
  }
}
```

### `GET /api/v1/account/:publicKey?tokenId=<tokenId>`

Response:

```json
{
  "source": { "sequencerGraphqlUrl": "http://127.0.0.1:8080/graphql" },
  "account": {
    "publicKey": "B62...",
    "token": "1",
    "nonce": "4",
    "balance": { "total": "1000000000" }
  }
}
```

### `GET /api/v1/archive/events?publicKey=<pk>&tokenId=<tokenId>`

Response:

```json
{
  "source": { "sequencerGraphqlUrl": "http://127.0.0.1:8080/graphql" },
  "count": 2,
  "events": [
    {
      "blockInfo": { "height": 1234 },
      "transactionInfo": { "hash": "5J...", "status": "APPLIED" },
      "eventData": [{ "data": ["1", "2"] }]
    }
  ]
}
```

### `GET /api/v1/archive/actions?publicKey=<pk>&tokenId=<tokenId>&fromActionState=<field>&endActionState=<field>`

Response:

```json
{
  "source": { "sequencerGraphqlUrl": "http://127.0.0.1:8080/graphql" },
  "count": 1,
  "actions": [
    {
      "blockInfo": { "height": 1234 },
      "transactionInfo": { "hash": "5J...", "status": "APPLIED" },
      "actionState": {
        "actionStateOne": "...",
        "actionStateTwo": "..."
      },
      "actionData": [{ "data": ["3", "4"] }]
    }
  ]
}
```

### `GET /api/v1/tx/:hash`

V1 default response when no indexer configured:

```json
{
  "txHash": "5J...",
  "found": false,
  "mode": "v1",
  "note": "Set ZEKO_V2_INDEXER_URL to enable full tx hash lookups from your indexer adapter."
}
```

V2 adapter mode forwards to `GET /v2/tx/:hash` on your indexer service.

## V2 adapter recommendation

Implement an internal provider interface:

- `getNetworkHealth()`
- `getAccount(publicKey, tokenId)`
- `getEvents(publicKey, tokenId)`
- `getActions(publicKey, tokenId, fromActionState, endActionState)`
- `getTransaction(hash)`

Then provide implementations:

- `SequencerProvider` (existing V1 behavior).
- `IndexerProvider` (reads indexed DB/API).
- `HybridProvider` (reads sequencer for live state, indexer for historical tx/feed).

This keeps all frontend calls unchanged.
