'use strict';

const $ = (id) => document.getElementById(id);
const statusEl = $('status');
const setStatus = (text, error = false) => { statusEl.textContent = text; statusEl.className = `status${error ? ' error' : ''}`; };
const toBytes = (value) => {
  const s = String(value).replace(/-/g, '+').replace(/_/g, '/');
  const padded = s + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(padded);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};
const toB64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function api(path, body) {
  const res = await fetch(path, {
    method: 'POST', credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}
const supported = () => window.PublicKeyCredential && navigator.credentials;
let passkeyTimeout = null;
const browserName = () => {
  const ua = navigator.userAgent;
  if (/CriOS/i.test(ua)) return 'Chrome on iOS';
  if (/FxiOS/i.test(ua)) return 'Firefox on iOS';
  if (/EdgiOS/i.test(ua)) return 'Edge on iOS';
  if (/Safari/i.test(ua) && !/Chrome|Chromium|Edg/i.test(ua)) return 'Safari';
  if (/Chrome|Chromium|Edg/i.test(ua)) return 'Chrome/Edge';
  if (/Firefox/i.test(ua)) return 'Firefox';
  return 'this browser';
};
async function showPasskeySupport() {
  const el = $('support');
  if (!el) return;
  if (!supported()) { el.textContent = `Passkeys are not available in ${browserName()}. Use Safari or Chrome on a device with a platform passkey.`; return; }
  try {
    const uv = await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable?.();
    el.textContent = uv
      ? 'This device has a platform passkey authenticator (Touch ID, Face ID or Windows Hello).'
      : 'No platform passkey authenticator was found. You may still use a security key, or enable iCloud Keychain / Windows Hello.';
  } catch { el.textContent = 'Could not check passkey support in this browser.'; }
}

let registration = null;

async function loadRegistrationOptions() {
  const options = await api('/v1/passkeys/options', {});
  registration = options;
}

// Must be called directly from a click: navigator.credentials.create needs transient user activation.
async function createPasskey() {
  if (!registration) throw new Error('Registration options are missing. Reload and try again.');
  const pk = registration.options;
  const publicKey = {
    ...pk,
    challenge: toBytes(pk.challenge),
    user: { ...pk.user, id: toBytes(pk.user.id) },
    excludeCredentials: (pk.excludeCredentials || []).map((c) => ({ ...c, id: toBytes(c.id) })),
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  let credential;
  try {
    credential = await navigator.credentials.create({ publicKey, signal: controller.signal });
  } catch (e) {
    if (e && e.name === 'AbortError') {
      throw new Error(`No passkey prompt appeared in ${browserName()}. Use Safari or Chrome on this device, enable iCloud Keychain / Windows Hello, and avoid in-app browsers.`);
    }
    throw e;
  } finally { clearTimeout(timer); }
  const response = {
    id: credential.id, rawId: toB64(credential.rawId), type: credential.type,
    response: {
      clientDataJSON: toB64(credential.response.clientDataJSON),
      attestationObject: toB64(credential.response.attestationObject),
      transports: credential.response.getTransports ? credential.response.getTransports() : [],
    },
    clientExtensionResults: credential.getClientExtensionResults ? credential.getClientExtensionResults() : {},
  };
  await api('/v1/passkeys/verify', { ceremonyId: registration.ceremonyId, response, name: 'This device' });
}

async function signup(event) {
  event.preventDefault();
  if (!supported()) { setStatus('This browser cannot create a passkey.', true); return; }
  const button = $('submit'); button.disabled = true;
  setStatus('Creating your account…');
  try {
    await api('/v1/signup/direct', {
      email: $('email').value, displayName: $('display-name').value,
      language: $('language').value, timeZone: $('time-zone').value,
    });
    await loadRegistrationOptions();
    button.hidden = true;
    const register = $('register');
    register.hidden = false;
    register.focus();
    setStatus('Account created. Click “Register passkey” to add this device.');
  } catch (e) {
    // Direct sign-up answers the same for an existing address but opens no session for it.
    setStatus(e.message === 'unauthenticated'
      ? 'This address cannot be signed up here. If it already has an account, sign in with your passkey or use account recovery.'
      : e.message || String(e), true);
    button.disabled = false;
  }
}

// Must be called directly from a click (transient user activation). Rotates to a fresh full session.
async function passkeySignIn() {
  const options = await api('/v1/signin/options', {});
  const pk = options.options;
  const publicKey = { ...pk, challenge: toBytes(pk.challenge), allowCredentials: (pk.allowCredentials || []).map((c) => ({ ...c, id: toBytes(c.id) })) };
  const credential = await navigator.credentials.get({ publicKey });
  const response = {
    id: credential.id, rawId: toB64(credential.rawId), type: credential.type,
    response: {
      clientDataJSON: toB64(credential.response.clientDataJSON),
      authenticatorData: toB64(credential.response.authenticatorData),
      signature: toB64(credential.response.signature),
      userHandle: credential.response.userHandle ? toB64(credential.response.userHandle) : undefined,
    },
    clientExtensionResults: credential.getClientExtensionResults ? credential.getClientExtensionResults() : {},
  };
  await api('/v1/signin/verify', { ceremonyId: options.ceremonyId, response });
}

// Sign-in started by the desktop's authorize returns to its consent page; nothing else is followed.
const returnTo = () => {
  const target = new URLSearchParams(location.search).get('return');
  return target && target.startsWith('/consent.html?') ? target : '/account.html';
};

async function signin() {
  if (!supported()) { setStatus('This browser cannot use a passkey.', true); return; }
  const button = $('signin'); button.disabled = true;
  setStatus('Waiting for your passkey…');
  try {
    await passkeySignIn();
    location.href = returnTo();
  } catch (e) {
    setStatus(e.message || String(e), true);
    button.disabled = false;
  }
}

async function account() {
  try {
    const res = await fetch('/v1/account', { credentials: 'same-origin' });
    if (res.status === 401) { location.href = '/signin.html'; return; }
    const me = await res.json();
    $('who').textContent = `Signed in as ${me.displayName} (${me.email})`;
    $('details').innerHTML = `<p class="muted">Passkeys: ${me.passkeys.length}</p>`;
    $('signout').onclick = async () => {
      await api('/v1/signout', {}).catch(() => {});
      location.href = '/signin.html';
    };
    setupExportDelete(me);
  } catch (e) { $('who').textContent = e.message || String(e); }
}

function setupExportDelete(me) {
  $('export').onclick = async () => {
    const button = $('export'); button.disabled = true;
    try {
      const res = await fetch('/v1/account/export', { credentials: 'same-origin' });
      if (res.status === 401) { location.href = '/signin.html'; return; }
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Request failed (${res.status})`);
      const url = URL.createObjectURL(await res.blob());
      const link = document.createElement('a');
      link.href = url;
      link.download = `llm-ide-account-export-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.append(link); link.click(); link.remove();
      URL.revokeObjectURL(url);
      setStatus('Your data was downloaded.');
    } catch (e) { setStatus(e.message || String(e), true); }
    button.disabled = false;
    statusEl.tabIndex = -1; statusEl.focus();
  };
  const input = $('confirm-email');
  const matches = () => input.value.trim().toLowerCase() === me.email;
  input.addEventListener('input', () => { $('delete').disabled = !matches(); });
  $('delete-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!matches()) return;
    const button = $('delete'); button.disabled = true; input.disabled = true;
    try {
      // The passkey prompt needs this click's user activation; delete needs a fresh proof.
      if (!supported()) throw new Error('This browser cannot use a passkey.');
      setStatus('Waiting for your passkey…');
      await passkeySignIn();
      await api('/v1/account/delete', { confirmEmail: input.value });
      document.querySelector('main').replaceChildren();
      const h = document.createElement('h1'); h.textContent = 'Account deleted';
      const p = document.createElement('p'); p.className = 'muted';
      p.textContent = 'Your account was deleted and you are signed out. Backups age out within 7 days. Data stored by the desktop app on your computer was not deleted.';
      document.querySelector('main').append(h, p);
      h.tabIndex = -1; h.focus();
    } catch (e) {
      setStatus(e.message || String(e), true);
      button.disabled = false; input.disabled = false;
      statusEl.tabIndex = -1; statusEl.focus();
    }
  });
}

// Design 4.4 step 2. Only the POST issues a code; the page then navigates to the loopback redirect.
async function consentPage() {
  const request = location.search.slice(1);
  const res = await fetch('/v1/account', { credentials: 'same-origin' }).catch(() => null);
  if (!res || res.status === 401) { location.href = `/signin.html?return=${encodeURIComponent(`/consent.html?${request}`)}`; return; }
  const me = await res.json().catch(() => ({}));
  $('question').textContent = `Allow “LLM-IDE desktop” on this computer to sign in to ${me.email}?`;
  const buttons = [$('allow'), $('deny'), $('confirm')];
  const decide = async (decision) => {
    buttons.forEach((b) => { b.disabled = true; });
    try {
      const { redirect } = await api('/v1/oauth/consent', { request, decision });
      setStatus(decision === 'allow' ? 'Allowed. Returning to LLM-IDE…' : 'Denied. You can close this window.');
      location.href = redirect;
    } catch (e) {
      if (e.message === 'reauth_required') {
        // A fresh passkey proof is needed; the passkey prompt needs a click of its own.
        $('confirm').hidden = false;
        $('confirm').disabled = false;
        setStatus('Confirm it is you with your passkey, then allow.');
        return;
      }
      setStatus(e.message || String(e), true);
      buttons.forEach((b) => { b.disabled = false; });
    }
  };
  $('allow').addEventListener('click', () => decide('allow'));
  $('deny').addEventListener('click', () => decide('deny'));
  $('confirm').addEventListener('click', async () => {
    $('confirm').disabled = true;
    try {
      await passkeySignIn();
      $('confirm').hidden = true;
      await decide('allow');
    } catch (e) {
      setStatus(e.message || String(e), true);
      $('confirm').disabled = false;
    }
  });
  $('allow').disabled = false;
  $('deny').disabled = false;
}

const page = document.body.dataset.page;
if (page === 'signup') {
  void showPasskeySupport();
  $('signup-form').addEventListener('submit', signup);
  $('register').addEventListener('click', async () => {
    const button = $('register');
    button.disabled = true;
    setStatus('Waiting for your passkey…');
    try {
      await createPasskey();
      location.href = '/account.html';
    } catch (e) {
      setStatus(e.message || String(e), true);
      button.disabled = false;
    }
  });
}
if (page === 'signin') $('signin').addEventListener('click', signin);
if (page === 'account') account();
if (page === 'consent') void consentPage();
