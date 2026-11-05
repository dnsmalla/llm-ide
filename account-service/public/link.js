const $ = (id) => document.getElementById(id);
const enc = new TextEncoder();
const b64 = (bytes) => {
  let out = '';
  for (const b of bytes) out += String.fromCharCode(b);
  return btoa(out).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const bytes = (buffer) => new Uint8Array(buffer);
const concat = (...parts) => {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};
const api = async (path, body) => {
  const res = await fetch(path, {
    method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error === 'unauthenticated' ? 'Sign in to your LLM-IDE account first.' : (data.error || `Request failed (${res.status})`));
  return data;
};
const get = async (path) => {
  const res = await fetch(path, { credentials: 'same-origin' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
};

let state = null;
let poll = null;

async function makeCommitment() {
  const signing = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const ecdh = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey']);
  const signingSpki = new Uint8Array(await crypto.subtle.exportKey('spki', signing.publicKey));
  const ecdhSpki = new Uint8Array(await crypto.subtle.exportKey('spki', ecdh.publicKey));
  const nonce = crypto.getRandomValues(new Uint8Array(32));
  const token = crypto.getRandomValues(new Uint8Array(32));
  const tokenHash = b64(new Uint8Array(await crypto.subtle.digest('SHA-256', token)));
  const digest = await crypto.subtle.digest('SHA-256', concat(enc.encode('llmide/link/commit/v1'), signingSpki, ecdhSpki, nonce));
  return {
    signing, ecdh, signingSpki, ecdhSpki, nonce, token,
    tokenHashHex: [...new Uint8Array(await crypto.subtle.digest('SHA-256', token))].map((b) => b.toString(16).padStart(2, '0')).join(''),
    commitment: b64(new Uint8Array(digest)),
  };
}

async function revealKeys() {
  const d = state;
  const signingKey = b64(d.signingSpki);
  const ecdhKey = b64(d.ecdhSpki);
  await api('/v1/link/requests/keys', {
    requestId: d.requestId,
    signingKey,
    ecdhKey,
    nonce: b64(d.nonce),
    tokenHash: d.tokenHashHex,
  });
  localStorage.setItem('llmide.device-token', b64(d.token));
}

async function tick() {
  if (!state?.requestId) return;
  try {
    const status = await get(`/v1/link/requests/status?requestId=${encodeURIComponent(state.requestId)}`);
    $('link-label').textContent = `Request ${state.requestId.slice(0, 8)}… · ${status.state}`;
    if (status.state === 'approved' && !state.revealed) {
      await revealKeys();
      state.revealed = true;
      $('link-status').textContent = 'Keys shared. Waiting for the desktop approval.';
    } else if (status.state === 'keys') {
      $('link-code').hidden = false;
      $('link-code').textContent = status.sas ? status.sas.slice(0, 3) + ' ' + status.sas.slice(3) : '';
      $('link-status').textContent = 'Compare this code with the desktop. Confirm there only if they match.';
    } else if (status.state === 'linked') {
      clearInterval(poll);
      $('link-code').hidden = true;
      $('link-status').textContent = 'This browser is linked. You can close this page.';
      localStorage.setItem('llmide.device-linked', '1');
    } else if (status.state === 'unlinked') {
      clearInterval(poll);
      $('link-status').textContent = 'This request was denied or expired. Start again from the desktop.';
    }
  } catch (e) {
    $('error').textContent = e.message;
  }
}

$('start').addEventListener('click', async () => {
  $('error').textContent = '';
  $('start').disabled = true;
  try {
    if (!window.crypto?.subtle) throw new Error('This browser cannot create the link keys.');
    state = await makeCommitment();
    const created = await api('/v1/link/requests', { kind: 'web', label: 'This browser', commitment: state.commitment });
    state.requestId = created.requestId;
    $('link-state').hidden = false;
    $('link-status').textContent = 'Waiting for the desktop to allow this browser…';
    poll = setInterval(() => void tick(), 1500);
    await tick();
  } catch (e) {
    $('error').textContent = e.message;
    $('start').disabled = false;
  }
});
