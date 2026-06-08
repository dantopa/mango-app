document.addEventListener('DOMContentLoaded', async () => {
  const status = document.getElementById('status');
  const pushNexo = document.getElementById('push-nexo');
  const pushBancolombia = document.getElementById('push-bancolombia');
  const saveBtn = document.getElementById('save-btn');
  const urlInput = document.getElementById('url');
  const secretInput = document.getElementById('secret');

  // Load config
  try {
    const config = await chrome.storage.local.get(['refreshUrl', 'refreshSecret']);
    if (config.refreshUrl) urlInput.value = config.refreshUrl;
    if (config.refreshSecret) secretInput.value = config.refreshSecret;
    if (config.refreshUrl && config.refreshSecret) {
      setStatus('idle', '✓ Configurado. Elegí un provider.');
    } else {
      setStatus('error', '⚠️ Configurá URL + Secret primero');
    }
  } catch (e) {
    setStatus('error', 'Error: ' + e.message);
  }

  saveBtn.addEventListener('click', async () => {
    const url = urlInput.value.trim();
    const secret = secretInput.value.trim();
    if (!url || !secret) { setStatus('error', '⚠️ Completá ambos campos'); return; }
    await chrome.storage.local.set({ refreshUrl: url, refreshSecret: secret });
    setStatus('success', '✓ Guardado!');
  });

  pushNexo.addEventListener('click', () => pushToken('nexo'));
  pushBancolombia.addEventListener('click', () => pushToken('bancolombia'));

  async function pushToken(provider) {
    pushNexo.disabled = true;
    pushBancolombia.disabled = true;

    try {
      const config = await chrome.storage.local.get(['refreshUrl', 'refreshSecret']);
      if (!config.refreshUrl || !config.refreshSecret) {
        setStatus('error', '⚠️ Falta configuración');
        return;
      }

      setStatus('loading', `Extrayendo token de ${provider}...`);

      let token;
      if (provider === 'nexo') {
        token = await extractNexoToken();
      } else if (provider === 'bancolombia') {
        token = await extractBancolombiaToken();
      }

      if (!token) return; // error already shown

      setStatus('loading', `Enviando token de ${provider}...`);

      const res = await fetch(config.refreshUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + config.refreshSecret
        },
        body: JSON.stringify({ provider, token })
      });

      const text = await res.text();
      if (res.ok) {
        let data = {};
        try { data = JSON.parse(text); } catch(e) { /* */ }
        setStatus('success', `✅ ${provider} OK! ${data.updated_at ? new Date(data.updated_at).toLocaleTimeString() : ''}`);
      } else {
        setStatus('error', `❌ HTTP ${res.status}: ${text.substring(0, 80)}`);
      }
    } catch (err) {
      setStatus('error', '❌ ' + err.message);
    }

    pushNexo.disabled = false;
    pushBancolombia.disabled = false;
  }

  async function extractNexoToken() {
    const jsessionid = await getCookie('platform.nexo.com', 'JSESSIONID');
    const nsi = await getCookie('platform.nexo.com', 'nsi');
    const esi = await getCookie('platform.nexo.com', 'esi');
    const installationId = await getCookie('platform.nexo.com', 'nexo_installation_id');

    if (!jsessionid) {
      setStatus('error', '❌ JSESSIONID no encontrado. ¿Logueado en platform.nexo.com?');
      return null;
    }
    if (!nsi || !esi) {
      setStatus('error', '❌ Faltan cookies nsi/esi de Nexo');
      return null;
    }

    return JSON.stringify({
      jsessionid, nsi, esi,
      installation_id: installationId || 'unknown'
    });
  }

  async function extractBancolombiaToken() {
    const stored = await chrome.storage.local.get(['bancolombia_bearer', 'bancolombia_session_tracker', 'bancolombia_device_id', 'bancolombia_ip']);

    if (!stored.bancolombia_bearer) {
      setStatus('error', '❌ Token de Bancolombia no capturado. Logueate en svpersonas.apps.bancolombia.com y volvé a intentar.');
      return null;
    }

    return JSON.stringify({
      bearer: stored.bancolombia_bearer,
      session_tracker: stored.bancolombia_session_tracker || crypto.randomUUID(),
      device_id: stored.bancolombia_device_id || crypto.randomUUID(),
      ip: stored.bancolombia_ip || ""
    });
  }

  function setStatus(cls, msg) {
    status.className = 'status ' + cls;
    status.textContent = msg;
  }
});

async function getCookie(domain, name) {
  try {
    const cookie = await chrome.cookies.get({ url: `https://${domain}`, name });
    return cookie ? cookie.value : null;
  } catch (e) { return null; }
}
