const PROFILE_STORAGE_KEY = 'app3Explorer.networkProfiles';
const ACTIVE_PROFILE_ID_KEY = 'app3Explorer.activeProfileId';
const HEALTH_DETAILS_VISIBLE_KEY = 'app3Explorer.healthDetailsVisible';
const DEFAULT_PROFILE = {
  id: 'local-default',
  name: 'Local Default',
  url: 'http://127.0.0.1:8080/graphql',
};

const state = {
  profiles: [],
  activeProfileId: '',
};

function loadProfiles() {
  const raw = window.localStorage.getItem(PROFILE_STORAGE_KEY);
  if (!raw) return [DEFAULT_PROFILE];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) return [DEFAULT_PROFILE];
    const filtered = parsed.filter((p) => p && p.id && p.name && p.url);
    return filtered.length > 0 ? filtered : [DEFAULT_PROFILE];
  } catch {
    return [DEFAULT_PROFILE];
  }
}

function persistProfiles() {
  window.localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(state.profiles));
}

function loadActiveProfileId() {
  return window.localStorage.getItem(ACTIVE_PROFILE_ID_KEY) || DEFAULT_PROFILE.id;
}

function persistActiveProfileId() {
  window.localStorage.setItem(ACTIVE_PROFILE_ID_KEY, state.activeProfileId);
}

function getActiveProfile() {
  return state.profiles.find((p) => p.id === state.activeProfileId) || state.profiles[0];
}

function validateUrl(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Sequencer URL must start with http:// or https://');
  }
  return parsed.toString();
}

function renderProfileControls() {
  const select = document.getElementById('profileSelect');
  const summary = document.getElementById('activeProfileSummary');
  const nameInput = document.getElementById('profileName');
  const urlInput = document.getElementById('profileUrl');

  select.innerHTML = '';
  for (const profile of state.profiles) {
    const opt = document.createElement('option');
    opt.value = profile.id;
    opt.textContent = `${profile.name} (${profile.url})`;
    if (profile.id === state.activeProfileId) opt.selected = true;
    select.appendChild(opt);
  }

  const active = getActiveProfile();
  if (active) {
    summary.classList.remove('error');
    summary.textContent = `Active profile: ${active.name} -> ${active.url}`;
    nameInput.value = active.name;
    urlInput.value = active.url;
  }
}

async function requestJson(path) {
  const active = getActiveProfile();
  const res = await fetch(path, {
    headers: {
      'x-sequencer-url': active.url,
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const details = typeof data === 'object' ? JSON.stringify(data) : String(data);
    throw new Error(`Request failed (${res.status}): ${details}`);
  }
  return data;
}

function render(el, data) {
  el.textContent = JSON.stringify(data, null, 2);
  el.classList.remove('error');
}

function renderError(el, err) {
  el.textContent = err instanceof Error ? err.message : String(err);
  el.classList.add('error');
}

function loadHealthDetailsVisible() {
  return window.localStorage.getItem(HEALTH_DETAILS_VISIBLE_KEY) === 'true';
}

function setHealthDetailsVisible(visible) {
  const details = document.getElementById('healthDetails');
  const btn = document.getElementById('toggleHealthDetailsBtn');
  if (visible) {
    details.classList.remove('hidden');
    btn.textContent = 'Hide Full Details';
  } else {
    details.classList.add('hidden');
    btn.textContent = 'Show Full Details';
  }
  window.localStorage.setItem(HEALTH_DETAILS_VISIBLE_KEY, String(Boolean(visible)));
}

async function refreshHealth() {
  const pill = document.getElementById('healthPill');
  const meta = document.getElementById('healthMeta');
  const details = document.getElementById('healthDetails');
  pill.textContent = 'Loading';
  pill.classList.remove('good', 'bad');
  meta.textContent = '';
  details.textContent = '';
  try {
    const data = await requestJson('/api/v1/network/health');
    const status = String(data.syncStatus || '').toUpperCase();
    const isSynced = status === 'SYNCED';
    pill.textContent = isSynced ? 'Synced' : 'Unsynced';
    pill.classList.add(isSynced ? 'good' : 'bad');
    meta.textContent = `network: ${data.network || 'unknown'} | unprovedLedgerHash: ${data.stateHashes?.unprovedLedgerHash || 'n/a'}`;
    details.textContent = JSON.stringify(data, null, 2);
    details.classList.remove('error');
  } catch (err) {
    pill.textContent = 'Unsynced';
    pill.classList.add('bad');
    meta.textContent = err instanceof Error ? err.message : String(err);
    details.textContent = meta.textContent;
    details.classList.add('error');
  }
}

document.getElementById('saveProfileBtn').addEventListener('click', () => {
  const select = document.getElementById('profileSelect');
  const name = document.getElementById('profileName').value.trim();
  const rawUrl = document.getElementById('profileUrl').value.trim();
  const selectedId = select.value;
  const summary = document.getElementById('activeProfileSummary');

  try {
    if (!name) throw new Error('Profile name is required');
    const url = validateUrl(rawUrl);
    const idx = state.profiles.findIndex((p) => p.id === selectedId);
    if (idx >= 0) {
      state.profiles[idx] = { ...state.profiles[idx], name, url };
      state.activeProfileId = state.profiles[idx].id;
    } else {
      const id = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
      state.profiles.push({ id, name, url });
      state.activeProfileId = id;
    }
    persistProfiles();
    persistActiveProfileId();
    renderProfileControls();
    refreshHealth();
  } catch (err) {
    summary.textContent = err instanceof Error ? err.message : String(err);
    summary.classList.add('error');
  }
});

document.getElementById('useProfileBtn').addEventListener('click', () => {
  const select = document.getElementById('profileSelect');
  if (!select.value) return;
  state.activeProfileId = select.value;
  persistActiveProfileId();
  renderProfileControls();
  refreshHealth();
});

document.getElementById('deleteProfileBtn').addEventListener('click', () => {
  const select = document.getElementById('profileSelect');
  const targetId = select.value;
  if (!targetId) return;

  state.profiles = state.profiles.filter((p) => p.id !== targetId);
  if (state.profiles.length === 0) {
    state.profiles = [DEFAULT_PROFILE];
  }

  if (!state.profiles.find((p) => p.id === state.activeProfileId)) {
    state.activeProfileId = state.profiles[0].id;
  }

  persistProfiles();
  persistActiveProfileId();
  renderProfileControls();
  refreshHealth();
});

document.getElementById('profileSelect').addEventListener('change', () => {
  const id = document.getElementById('profileSelect').value;
  const p = state.profiles.find((x) => x.id === id);
  if (!p) return;
  document.getElementById('profileName').value = p.name;
  document.getElementById('profileUrl').value = p.url;
});

document.getElementById('refreshHealth').addEventListener('click', refreshHealth);
document.getElementById('toggleHealthDetailsBtn').addEventListener('click', () => {
  const details = document.getElementById('healthDetails');
  setHealthDetailsVisible(details.classList.contains('hidden'));
});

document.getElementById('accountForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const pk = document.getElementById('accountPublicKey').value.trim();
  const tokenId = document.getElementById('accountTokenId').value.trim();
  const out = document.getElementById('accountOutput');
  out.textContent = 'Loading...';

  const accountPath = tokenId
    ? `/api/v1/account/${encodeURIComponent(pk)}?tokenId=${encodeURIComponent(tokenId)}`
    : `/api/v1/account/${encodeURIComponent(pk)}`;
  const qs = new URLSearchParams({ publicKey: pk });
  if (tokenId) qs.set('tokenId', tokenId);

  try {
    const [accountData, eventsData, actionsData] = await Promise.all([
      requestJson(accountPath),
      requestJson(`/api/v1/archive/events?${qs.toString()}`),
      requestJson(`/api/v1/archive/actions?${qs.toString()}`),
    ]);
    const txMap = new Map();
    for (const ev of eventsData.events || []) {
      const h = ev?.transactionInfo?.hash;
      if (!h) continue;
      if (!txMap.has(h)) txMap.set(h, { hash: h, status: ev.transactionInfo.status, memo: ev.transactionInfo.memo });
    }
    for (const action of actionsData.actions || []) {
      const h = action?.transactionInfo?.hash;
      if (!h) continue;
      if (!txMap.has(h)) txMap.set(h, { hash: h, status: action.transactionInfo.status, memo: action.transactionInfo.memo });
    }
    const history = Array.from(txMap.values()).slice(0, 25);
    render(out, {
      account: accountData.account,
      historySummary: {
        txCountApprox: txMap.size,
        events: eventsData.count || 0,
        actions: actionsData.count || 0,
      },
      recentTransactions: history,
    });
  } catch (err) {
    renderError(out, err);
  }
});

document.getElementById('eventsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const pk = document.getElementById('eventsPublicKey').value.trim();
  const tokenId = document.getElementById('eventsTokenId').value.trim();
  const out = document.getElementById('eventsOutput');
  out.textContent = 'Loading...';

  const qs = new URLSearchParams({ publicKey: pk });
  if (tokenId) qs.set('tokenId', tokenId);

  try {
    render(out, await requestJson(`/api/v1/archive/events?${qs.toString()}`));
  } catch (err) {
    renderError(out, err);
  }
});

document.getElementById('actionsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const pk = document.getElementById('actionsPublicKey').value.trim();
  const tokenId = document.getElementById('actionsTokenId').value.trim();
  const fromActionState = document.getElementById('actionsFrom').value.trim();
  const endActionState = document.getElementById('actionsTo').value.trim();
  const out = document.getElementById('actionsOutput');
  out.textContent = 'Loading...';

  const qs = new URLSearchParams({ publicKey: pk });
  if (tokenId) qs.set('tokenId', tokenId);
  if (fromActionState) qs.set('fromActionState', fromActionState);
  if (endActionState) qs.set('endActionState', endActionState);

  try {
    render(out, await requestJson(`/api/v1/archive/actions?${qs.toString()}`));
  } catch (err) {
    renderError(out, err);
  }
});

document.getElementById('txForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const hash = document.getElementById('txHash').value.trim();
  const publicKey = document.getElementById('txPublicKey').value.trim();
  const tokenId = document.getElementById('txTokenId').value.trim();
  const out = document.getElementById('txOutput');
  out.textContent = 'Loading...';

  const qs = new URLSearchParams();
  if (publicKey) qs.set('publicKey', publicKey);
  if (tokenId) qs.set('tokenId', tokenId);
  const path = qs.toString()
    ? `/api/v1/tx/${encodeURIComponent(hash)}?${qs.toString()}`
    : `/api/v1/tx/${encodeURIComponent(hash)}`;

  try {
    render(out, await requestJson(path));
  } catch (err) {
    renderError(out, err);
  }
});

state.profiles = loadProfiles();
state.activeProfileId = loadActiveProfileId();
if (!state.profiles.find((p) => p.id === state.activeProfileId)) {
  state.activeProfileId = state.profiles[0].id;
}
persistProfiles();
persistActiveProfileId();
renderProfileControls();
setHealthDetailsVisible(loadHealthDetailsVisible());
refreshHealth();
