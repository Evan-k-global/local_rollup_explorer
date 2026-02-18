import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { Pool } from 'pg';

const PORT = Number(process.env.PORT || 8787);
const DEFAULT_SEQUENCER_URL = process.env.DEFAULT_SEQUENCER_URL || 'https://testnet.zeko.io/graphql';
const START_MODE = (process.env.START_MODE || 'latest').toLowerCase();
const BACKFILL_ACK = String(process.env.BACKFILL_ACK || '').toLowerCase() === 'true';
const INGEST_ENABLED = String(process.env.INGEST_ENABLED || 'true').toLowerCase() !== 'false';
const INGEST_INTERVAL_SEC = Number(process.env.INGEST_INTERVAL_SEC || 30);

if (!['latest', 'backfill'].includes(START_MODE)) {
  throw new Error('Invalid START_MODE. Expected latest or backfill.');
}

if (START_MODE === 'backfill' && !BACKFILL_ACK) {
  throw new Error(
    [
      'Backfill mode requested without BACKFILL_ACK=true.',
      'Backfill on larger chains (for example zeko testnet) can require significant CPU/RAM/disk and sustained I/O.',
      'Set BACKFILL_ACK=true after confirming your infra sizing.',
    ].join(' ')
  );
}

const pool = new Pool({
  host: process.env.PGHOST || 'postgres',
  port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || 'zeko',
  password: process.env.PGPASSWORD || 'zeko',
  database: process.env.PGDATABASE || 'zeko_indexer',
});

const gqlQueries = {
  events: `
    query Events($input: EventFilterOptionsInput!) {
      events(input: $input) {
        blockInfo {
          height
          stateHash
          parentHash
          timestamp
          globalSlotSinceGenesis
        }
        transactionInfo {
          hash
          memo
          status
          sequenceNo
          zkappAccountUpdateIds
        }
        eventData {
          data
        }
      }
    }
  `,
  actions: `
    query Actions($input: ActionFilterOptionsInput!) {
      actions(input: $input) {
        blockInfo {
          height
          stateHash
          parentHash
          timestamp
          globalSlotSinceGenesis
        }
        transactionInfo {
          hash
          memo
          status
          sequenceNo
          zkappAccountUpdateIds
        }
        actionState {
          actionStateOne
          actionStateTwo
        }
        actionData {
          data
        }
      }
    }
  `,
};

function sendJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload, null, 2));
}

function parseLimit(url) {
  const raw = url.searchParams.get('limit');
  const parsed = Number(raw || 50);
  if (!Number.isFinite(parsed) || parsed <= 0) return 50;
  return Math.min(parsed, 500);
}

async function readJsonBody(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  if (!body) return {};
  return JSON.parse(body);
}

function safeUrl(input, fallback) {
  const raw = (input || '').trim() || fallback;
  const parsed = new URL(raw);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Invalid sequencer URL protocol');
  }
  return parsed.toString();
}

function payloadHash(payload) {
  return createHash('sha256').update(JSON.stringify(payload || {})).digest('hex');
}

function asNullableString(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s === '' ? null : s;
}

function boolOrDefault(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  const s = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'y'].includes(s)) return true;
  if (['false', '0', 'no', 'n'].includes(s)) return false;
  return fallback;
}

async function gql(sequencerUrl, query, variables) {
  const res = await fetch(sequencerUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.errors) {
    throw new Error(`GraphQL request failed (${res.status}): ${JSON.stringify(body.errors || body)}`);
  }
  return body.data;
}

async function upsertTx(client, txHash, txKind, txInfo, blockInfo, publicKey, tokenId, payload) {
  if (!txHash) return;
  await client.query(
    `
      INSERT INTO transactions (
        tx_hash, tx_kind, status, memo, sequence_no, block_height, public_key, token_id, payload_json
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
      ON CONFLICT (tx_hash)
      DO UPDATE SET
        tx_kind = COALESCE(EXCLUDED.tx_kind, transactions.tx_kind),
        status = COALESCE(EXCLUDED.status, transactions.status),
        memo = COALESCE(EXCLUDED.memo, transactions.memo),
        sequence_no = COALESCE(EXCLUDED.sequence_no, transactions.sequence_no),
        block_height = GREATEST(COALESCE(transactions.block_height, 0), COALESCE(EXCLUDED.block_height, 0)),
        public_key = COALESCE(EXCLUDED.public_key, transactions.public_key),
        token_id = COALESCE(EXCLUDED.token_id, transactions.token_id),
        payload_json = COALESCE(EXCLUDED.payload_json, transactions.payload_json)
    `,
    [
      txHash,
      txKind,
      txInfo?.status || null,
      txInfo?.memo || null,
      txInfo?.sequenceNo ? Number(txInfo.sequenceNo) : null,
      blockInfo?.height ? Number(blockInfo.height) : null,
      publicKey || null,
      tokenId || null,
      JSON.stringify(payload || {}),
    ]
  );
}

async function upsertTrackedAccount({ publicKey, tokenId, sequencerUrl, backfill = false }) {
  const row = await pool.query(
    `
      INSERT INTO tracked_accounts (public_key, token_id, sequencer_url, backfill, enabled, initialized)
      VALUES ($1,$2,$3,$4,TRUE,FALSE)
      ON CONFLICT (public_key, token_id)
      DO UPDATE SET
        sequencer_url = EXCLUDED.sequencer_url,
        backfill = EXCLUDED.backfill,
        enabled = TRUE,
        updated_at = NOW()
      RETURNING *
    `,
    [publicKey, tokenId, sequencerUrl, backfill]
  );
  return row.rows[0];
}

async function fetchAccountArchive({ sequencerUrl, publicKey, tokenId }) {
  const [eventsRes, actionsRes] = await Promise.all([
    gql(sequencerUrl, gqlQueries.events, { input: { address: publicKey, tokenId } }),
    gql(sequencerUrl, gqlQueries.actions, {
      input: { address: publicKey, tokenId, fromActionState: null, endActionState: null },
    }),
  ]);
  return {
    events: eventsRes.events || [],
    actions: actionsRes.actions || [],
  };
}

function maxHeight(events, actions) {
  return Math.max(
    0,
    ...events.map((e) => Number(e?.blockInfo?.height || 0)),
    ...actions.map((a) => Number(a?.blockInfo?.height || 0))
  );
}

async function syncTrackedAccount(row, { reason = 'manual' } = {}) {
  const publicKey = row.public_key;
  const tokenId = row.token_id;
  const sequencerUrl = row.sequencer_url;
  const backfill = Boolean(row.backfill);

  const { events, actions } = await fetchAccountArchive({ sequencerUrl, publicKey, tokenId });
  const latestHeight = maxHeight(events, actions);
  const currentCursor = row.cursor_height === null ? null : Number(row.cursor_height);

  if (!row.initialized && START_MODE === 'latest' && !backfill) {
    await pool.query(
      `
        UPDATE tracked_accounts
        SET initialized = TRUE,
            cursor_height = $3,
            last_sync_at = NOW(),
            updated_at = NOW()
        WHERE public_key = $1 AND token_id IS NOT DISTINCT FROM $2
      `,
      [publicKey, tokenId, latestHeight]
    );
    return {
      mode: 'latest-prime',
      reason,
      ingested: { events: 0, actions: 0 },
      latestHeight,
      cursorHeight: latestHeight,
      note: 'Primed cursor at latest height; older history intentionally skipped in START_MODE=latest.',
    };
  }

  const eventsToIngest = currentCursor === null ? events : events.filter((e) => Number(e?.blockInfo?.height || 0) > currentCursor);
  const actionsToIngest = currentCursor === null ? actions : actions.filter((a) => Number(a?.blockInfo?.height || 0) > currentCursor);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let eventInserts = 0;
    let actionInserts = 0;

    for (const ev of eventsToIngest) {
      const txHash = ev?.transactionInfo?.hash || null;
      const pHash = payloadHash(ev);
      const insert = await client.query(
        `
          INSERT INTO account_events (tx_hash, payload_hash, public_key, token_id, block_height, payload_json)
          VALUES ($1,$2,$3,$4,$5,$6::jsonb)
          ON CONFLICT (payload_hash) DO NOTHING
        `,
        [txHash, pHash, publicKey, tokenId || null, ev?.blockInfo?.height || null, JSON.stringify(ev)]
      );
      eventInserts += insert.rowCount;
      await upsertTx(client, txHash, 'zkapp_event', ev.transactionInfo, ev.blockInfo, publicKey, tokenId, ev);
    }

    for (const action of actionsToIngest) {
      const txHash = action?.transactionInfo?.hash || null;
      const pHash = payloadHash(action);
      const insert = await client.query(
        `
          INSERT INTO account_actions (
            tx_hash, payload_hash, public_key, token_id, block_height, action_state_before, action_state_after, payload_json
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
          ON CONFLICT (payload_hash) DO NOTHING
        `,
        [
          txHash,
          pHash,
          publicKey,
          tokenId || null,
          action?.blockInfo?.height || null,
          action?.actionState?.actionStateOne || null,
          action?.actionState?.actionStateTwo || null,
          JSON.stringify(action),
        ]
      );
      actionInserts += insert.rowCount;
      await upsertTx(client, txHash, 'zkapp_action', action.transactionInfo, action.blockInfo, publicKey, tokenId, action);
    }

    const nextCursor = currentCursor === null ? latestHeight : Math.max(currentCursor, latestHeight);
    await client.query(
      `
        UPDATE tracked_accounts
        SET initialized = TRUE,
            cursor_height = $3,
            last_sync_at = NOW(),
            updated_at = NOW()
        WHERE public_key = $1 AND token_id IS NOT DISTINCT FROM $2
      `,
      [publicKey, tokenId, nextCursor]
    );

    await client.query(
      `
        INSERT INTO sync_cursor (id, source, last_height, last_state_hash, updated_at)
        VALUES (1, $1, $2, NULL, NOW())
        ON CONFLICT (id)
        DO UPDATE SET
          source = EXCLUDED.source,
          last_height = GREATEST(COALESCE(sync_cursor.last_height, 0), COALESCE(EXCLUDED.last_height, 0)),
          updated_at = NOW()
      `,
      [`account:${publicKey}:${tokenId || ''}`, nextCursor]
    );

    await client.query('COMMIT');
    return {
      mode: backfill ? 'backfill' : START_MODE,
      reason,
      ingested: { events: eventInserts, actions: actionInserts },
      latestHeight,
      cursorHeight: nextCursor,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function getTxByHash(hash) {
  const tx = await pool.query('SELECT * FROM transactions WHERE tx_hash = $1 LIMIT 1', [hash]);
  if (tx.rowCount > 0) return tx.rows[0];

  const fallback = await pool.query(
    `
      SELECT tx_hash, block_height, public_key, token_id, payload_json, 'account_events' AS source
      FROM account_events WHERE tx_hash = $1
      UNION ALL
      SELECT tx_hash, block_height, public_key, token_id, payload_json, 'account_actions' AS source
      FROM account_actions WHERE tx_hash = $1
      LIMIT 1
    `,
    [hash]
  );
  return fallback.rowCount > 0 ? fallback.rows[0] : null;
}

let ingestLoopBusy = false;
async function runIngestLoop() {
  if (ingestLoopBusy || !INGEST_ENABLED) return;
  ingestLoopBusy = true;
  try {
    const tracked = await pool.query(
      `
        SELECT *
        FROM tracked_accounts
        WHERE enabled = TRUE
        ORDER BY updated_at ASC
      `
    );

    for (const row of tracked.rows) {
      try {
        const result = await syncTrackedAccount(row, { reason: 'loop' });
        if ((result.ingested.events + result.ingested.actions) > 0 || result.mode === 'latest-prime') {
          console.log(
            `[ingest] ${row.public_key} token=${row.token_id || 'default'} mode=${result.mode} events=${result.ingested.events} actions=${result.ingested.actions} cursor=${result.cursorHeight}`
          );
        }
      } catch (err) {
        console.error(`[ingest] failed for ${row.public_key}:`, err instanceof Error ? err.message : String(err));
      }
    }
  } finally {
    ingestLoopBusy = false;
  }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || `localhost:${PORT}`}`);

    if (req.method === 'GET' && url.pathname === '/health') {
      await pool.query('SELECT 1');
      const tracked = await pool.query('SELECT COUNT(*)::int AS n FROM tracked_accounts WHERE enabled = TRUE');
      return sendJson(res, 200, {
        ok: true,
        startMode: START_MODE,
        ingestEnabled: INGEST_ENABLED,
        ingestIntervalSec: INGEST_INTERVAL_SEC,
        trackedAccounts: tracked.rows[0]?.n || 0,
      });
    }

    if (req.method === 'GET' && url.pathname.startsWith('/v2/tx/')) {
      const hash = decodeURIComponent(url.pathname.replace('/v2/tx/', '')).trim();
      if (!hash) return sendJson(res, 400, { error: 'Missing tx hash' });

      const tx = await getTxByHash(hash);
      if (!tx) return sendJson(res, 404, { found: false, txHash: hash });
      return sendJson(res, 200, { found: true, txHash: hash, transaction: tx });
    }

    if (req.method === 'GET' && url.pathname.startsWith('/v2/account/')) {
      const publicKey = decodeURIComponent(url.pathname.replace('/v2/account/', '').replace('/transactions', '')).trim();
      if (!publicKey || !url.pathname.endsWith('/transactions')) {
        return sendJson(res, 404, { error: 'Not found' });
      }
      const limit = parseLimit(url);
      const tokenId = asNullableString(url.searchParams.get('tokenId'));
      const rows = await pool.query(
        `
          SELECT tx_hash, tx_kind, status, memo, sequence_no, block_height, public_key, token_id, created_at
          FROM transactions
          WHERE public_key = $1 AND ($2::text IS NULL OR token_id = $2)
          ORDER BY block_height DESC NULLS LAST, created_at DESC
          LIMIT $3
        `,
        [publicKey, tokenId, limit]
      );
      return sendJson(res, 200, {
        publicKey,
        tokenId,
        count: rows.rowCount,
        transactions: rows.rows,
      });
    }

    if (req.method === 'GET' && url.pathname === '/v2/tracked/accounts') {
      const rows = await pool.query(
        `
          SELECT public_key, token_id, sequencer_url, backfill, enabled, initialized, cursor_height, last_sync_at, updated_at
          FROM tracked_accounts
          ORDER BY updated_at DESC
          LIMIT 500
        `
      );
      return sendJson(res, 200, { count: rows.rowCount, accounts: rows.rows });
    }

    if (req.method === 'POST' && url.pathname === '/v2/track/account') {
      const body = await readJsonBody(req);
      const publicKey = String(body.publicKey || '').trim();
      const tokenId = asNullableString(body.tokenId);
      const sequencerUrl = safeUrl(body.sequencerUrl, DEFAULT_SEQUENCER_URL);
      const backfill = boolOrDefault(body.backfill, START_MODE === 'backfill');
      if (!publicKey) return sendJson(res, 400, { error: 'publicKey is required' });

      const tracked = await upsertTrackedAccount({ publicKey, tokenId, sequencerUrl, backfill });
      return sendJson(res, 200, {
        ok: true,
        tracked,
        note:
          START_MODE === 'latest' && !backfill
            ? 'Account is tracked in progressive mode from latest cursor forward.'
            : 'Account is tracked with backfill enabled.',
      });
    }

    if (req.method === 'POST' && url.pathname === '/v2/sync/account') {
      const body = await readJsonBody(req);
      const publicKey = String(body.publicKey || '').trim();
      const tokenId = asNullableString(body.tokenId);
      const sequencerUrl = safeUrl(body.sequencerUrl, DEFAULT_SEQUENCER_URL);
      const backfill = boolOrDefault(body.backfill, START_MODE === 'backfill');
      if (!publicKey) return sendJson(res, 400, { error: 'publicKey is required' });

      const tracked = await upsertTrackedAccount({ publicKey, tokenId, sequencerUrl, backfill });
      const synced = await syncTrackedAccount(tracked, { reason: 'manual' });
      return sendJson(res, 200, {
        ok: true,
        publicKey,
        tokenId,
        sequencerUrl,
        startMode: START_MODE,
        backfill,
        synced,
        note:
          START_MODE === 'latest' && !backfill
            ? 'In latest mode, first sync primes cursor at current head and skips historical data.'
            : 'Backfill mode ingests historical account-scoped actions/events and can be resource intensive on large chains.',
      });
    }

    return sendJson(res, 404, { error: 'Not found' });
  } catch (err) {
    return sendJson(res, 500, {
      error: 'Internal error',
      details: err instanceof Error ? err.message : String(err),
    });
  }
});

server.listen(PORT, () => {
  console.log(`indexer-api listening on http://0.0.0.0:${PORT}`);
  console.log(`default sequencer: ${DEFAULT_SEQUENCER_URL}`);
  console.log(`START_MODE=${START_MODE}, INGEST_ENABLED=${INGEST_ENABLED}, INGEST_INTERVAL_SEC=${INGEST_INTERVAL_SEC}`);
  if (START_MODE === 'backfill') {
    console.warn(
      'WARNING: backfill mode is enabled. On larger chains (for example zeko testnet), ensure sufficient CPU/RAM/disk and sustained I/O capacity.'
    );
  }

  if (INGEST_ENABLED) {
    setInterval(() => {
      runIngestLoop().catch((err) => {
        console.error('[ingest] loop failed:', err instanceof Error ? err.message : String(err));
      });
    }, Math.max(5, INGEST_INTERVAL_SEC) * 1000);
    runIngestLoop().catch((err) => {
      console.error('[ingest] initial run failed:', err instanceof Error ? err.message : String(err));
    });
  }
});
