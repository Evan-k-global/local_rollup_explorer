import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const uiDir = join(__dirname, 'ui');

const PORT = Number(process.env.PORT || 4173);
const DEFAULT_SEQUENCER_GRAPHQL_URL =
  process.env.ZEKO_SEQUENCER_URL || 'http://127.0.0.1:8080/graphql';
const V2_INDEXER_BASE_URL = process.env.ZEKO_V2_INDEXER_URL || '';

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

const q = {
  health: `
    query {
      networkID
      syncStatus
      daemonStatus {
        chainId
        consensusConfiguration {
          epochDuration
          k
          slotsPerEpoch
          slotDuration
        }
      }
      stateHashes {
        provedLedgerHash
        unprovedLedgerHash
      }
    }
  `,
  account: `
    query Account($publicKey: PublicKey!, $token: TokenId) {
      account(publicKey: $publicKey, token: $token) {
        publicKey
        token
        tokenId
        nonce
        balance {
          total
        }
        delegate
        receiptChainHash
        tokenSymbol
        zkappUri
        zkappState
        provedState
        actionState
        verificationKey {
          hash
          verificationKey
        }
        permissions {
          editState
          send
          receive
          access
          setDelegate
          setPermissions
          setZkappUri
          editActionState
          setTokenSymbol
          incrementNonce
          setVotingFor
          setTiming
          setVerificationKey {
            auth
            txnVersion
          }
        }
      }
    }
  `,
  events: `
    query Events($input: EventFilterOptionsInput!) {
      events(input: $input) {
        blockInfo {
          height
          stateHash
          parentHash
          timestamp
          globalSlotSinceGenesis
          distanceFromMaxBlockHeight
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
          distanceFromMaxBlockHeight
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

function parseSequencerUrlFromRequest(req) {
  const raw = req.headers['x-sequencer-url'];
  if (typeof raw !== 'string' || raw.trim() === '') {
    return DEFAULT_SEQUENCER_GRAPHQL_URL;
  }

  const candidate = raw.trim();
  const parsed = new URL(candidate);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('x-sequencer-url must use http or https');
  }
  return parsed.toString();
}

async function gql(sequencerUrl, query, variables = {}) {
  const res = await fetch(sequencerUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.errors) {
    const message = body.errors ? JSON.stringify(body.errors) : JSON.stringify(body);
    throw new Error(`GraphQL query failed (${res.status}): ${message}`);
  }
  return body.data;
}

function sendJson(res, code, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}

function notFound(res) {
  sendJson(res, 404, { error: 'Not found' });
}

function badRequest(res, message) {
  sendJson(res, 400, { error: message });
}

function normalizeTxHash(hash) {
  return String(hash || '').trim();
}

function findTxInArchive(hash, events = [], actions = []) {
  const target = normalizeTxHash(hash);
  if (!target) return null;

  for (const ev of events) {
    if (normalizeTxHash(ev?.transactionInfo?.hash) === target) {
      return { foundIn: 'events', item: ev };
    }
  }
  for (const action of actions) {
    if (normalizeTxHash(action?.transactionInfo?.hash) === target) {
      return { foundIn: 'actions', item: action };
    }
  }
  return null;
}

async function serveStatic(req, res, pathname) {
  const safePath = pathname === '/' ? '/index.html' : pathname;
  const fullPath = join(uiDir, safePath);
  try {
    const file = await readFile(fullPath);
    const mime = mimeTypes[extname(fullPath)] || 'application/octet-stream';
    res.writeHead(200, { 'content-type': mime });
    res.end(file);
  } catch {
    notFound(res);
  }
}

async function handleApi(req, res, url) {
  try {
    const sequencerUrl = parseSequencerUrlFromRequest(req);

    if (url.pathname === '/api/v1/network/health') {
      const data = await gql(sequencerUrl, q.health);
      return sendJson(res, 200, {
        source: { sequencerGraphqlUrl: sequencerUrl },
        network: data.networkID,
        syncStatus: data.syncStatus,
        daemonStatus: data.daemonStatus,
        stateHashes: data.stateHashes,
      });
    }

    if (url.pathname.startsWith('/api/v1/account/')) {
      const publicKey = decodeURIComponent(url.pathname.replace('/api/v1/account/', ''));
      if (!publicKey) return badRequest(res, 'Missing public key');
      const tokenId = url.searchParams.get('tokenId') || null;
      const data = await gql(sequencerUrl, q.account, { publicKey, token: tokenId });
      return sendJson(res, 200, {
        source: { sequencerGraphqlUrl: sequencerUrl },
        account: data.account,
      });
    }

    if (url.pathname === '/api/v1/archive/events') {
      const publicKey = url.searchParams.get('publicKey');
      if (!publicKey) return badRequest(res, 'Missing publicKey');
      const tokenId = url.searchParams.get('tokenId') || null;
      const input = { address: publicKey, tokenId };
      const data = await gql(sequencerUrl, q.events, { input });
      return sendJson(res, 200, {
        source: { sequencerGraphqlUrl: sequencerUrl },
        count: data.events.length,
        events: data.events,
      });
    }

    if (url.pathname === '/api/v1/archive/actions') {
      const publicKey = url.searchParams.get('publicKey');
      if (!publicKey) return badRequest(res, 'Missing publicKey');
      const tokenId = url.searchParams.get('tokenId') || null;
      const fromActionState = url.searchParams.get('fromActionState') || null;
      const endActionState = url.searchParams.get('endActionState') || null;
      const input = { address: publicKey, tokenId, fromActionState, endActionState };
      const data = await gql(sequencerUrl, q.actions, { input });
      return sendJson(res, 200, {
        source: { sequencerGraphqlUrl: sequencerUrl },
        count: data.actions.length,
        actions: data.actions,
      });
    }

    if (url.pathname.startsWith('/api/v1/tx/')) {
      const hash = decodeURIComponent(url.pathname.replace('/api/v1/tx/', ''));
      if (!hash) return badRequest(res, 'Missing tx hash');

      const publicKey = url.searchParams.get('publicKey');
      const tokenId = url.searchParams.get('tokenId') || null;
      if (publicKey) {
        const [eventsData, actionsData] = await Promise.all([
          gql(sequencerUrl, q.events, { input: { address: publicKey, tokenId } }),
          gql(sequencerUrl, q.actions, {
            input: { address: publicKey, tokenId, fromActionState: null, endActionState: null },
          }),
        ]);
        const match = findTxInArchive(hash, eventsData.events || [], actionsData.actions || []);
        const eventCount = (eventsData.events || []).length;
        const actionCount = (actionsData.actions || []).length;
        if (!match && V2_INDEXER_BASE_URL) {
          const syncUrl = new URL('/v2/sync/account', V2_INDEXER_BASE_URL);
          await fetch(syncUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ publicKey, tokenId, sequencerUrl }),
          }).catch(() => null);

          const lookupUrl = new URL(`/v2/tx/${encodeURIComponent(hash)}`, V2_INDEXER_BASE_URL);
          const v2Res = await fetch(lookupUrl).catch(() => null);
          if (v2Res && v2Res.ok) {
            const v2Body = await v2Res.json().catch(() => ({}));
            return sendJson(res, 200, {
              txHash: hash,
              mode: 'v2-after-account-sync',
              scanned: { publicKey, tokenId, events: eventCount, actions: actionCount },
              found: true,
              v2: v2Body,
              note: 'Found in V2 indexer after account sync.',
            });
          }
        }
        return sendJson(res, 200, {
          txHash: hash,
          mode: 'v1-account-scan',
          scanned: {
            publicKey,
            tokenId,
            events: eventCount,
            actions: actionCount,
          },
          found: Boolean(match),
          match: match
            ? {
                foundIn: match.foundIn,
                transactionInfo: match.item.transactionInfo || null,
                blockInfo: match.item.blockInfo || null,
              }
            : null,
          note: match
            ? 'Found by scanning account-scoped archive history.'
            : 'Not found in this account action/event history. Many tx hashes (for example plain payments or txs without emitted events/actions on this account) cannot be resolved in V1. Use V2 indexer for global hash lookup.',
        });
      }

      if (!V2_INDEXER_BASE_URL) {
        return sendJson(res, 200, {
          txHash: hash,
          found: false,
          mode: 'v1',
          note: 'Provide publicKey for account-scoped V1 lookup, or set ZEKO_V2_INDEXER_URL for global hash lookup.',
        });
      }

      const lookupUrl = new URL(`/v2/tx/${encodeURIComponent(hash)}`, V2_INDEXER_BASE_URL);
      const upRes = await fetch(lookupUrl);
      const upBody = await upRes.json().catch(() => ({}));
      return sendJson(res, upRes.ok ? 200 : 502, {
        txHash: hash,
        upstream: lookupUrl.toString(),
        ...(typeof upBody === 'object' && upBody ? upBody : { raw: upBody }),
      });
    }

    return notFound(res);
  } catch (err) {
    return sendJson(res, 502, {
      error: 'Upstream request failed',
      details: err instanceof Error ? err.message : String(err),
    });
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || `localhost:${PORT}`}`);

  if (url.pathname.startsWith('/api/')) {
    return handleApi(req, res, url);
  }

  return serveStatic(req, res, url.pathname);
});

server.listen(PORT, () => {
  console.log(`app3-explorer running at http://localhost:${PORT}`);
  console.log(`Default sequencer GraphQL: ${DEFAULT_SEQUENCER_GRAPHQL_URL}`);
  if (V2_INDEXER_BASE_URL) {
    console.log(`Using V2 indexer adapter: ${V2_INDEXER_BASE_URL}`);
  }
});
