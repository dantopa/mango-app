// Background service worker — captures Bancolombia Bearer token and BBVA tsec from requests
// When the user is logged into svpersonas.apps.bancolombia.com, any API call
// to canalpersonas-ext.apps.bancolombia.com includes the Bearer token.
// When the user is logged into online.bbva.com.ar, XHR calls include the tsec header.
// We capture them here and store for the popup to use.

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    const authHeader = details.requestHeaders?.find(
      (h) => h.name.toLowerCase() === 'authorization'
    );
    const sessionHeader = details.requestHeaders?.find(
      (h) => h.name.toLowerCase() === 'session-tracker'
    );
    const deviceHeader = details.requestHeaders?.find(
      (h) => h.name.toLowerCase() === 'device-id'
    );
    const ipHeader = details.requestHeaders?.find(
      (h) => h.name.toLowerCase() === 'ip'
    );

    if (authHeader && authHeader.value?.startsWith('Bearer ')) {
      const bearer = authHeader.value.slice(7);
      const updates = { bancolombia_bearer: bearer };

      if (sessionHeader?.value) {
        updates.bancolombia_session_tracker = sessionHeader.value;
      }
      if (deviceHeader?.value) {
        updates.bancolombia_device_id = deviceHeader.value;
      }
      if (ipHeader?.value) {
        updates.bancolombia_ip = ipHeader.value;
      }

      chrome.storage.local.set(updates);
    }
  },
  { urls: ['https://canalpersonas-ext.apps.bancolombia.com/*'] },
  ['requestHeaders']
);

// BBVA: capture tsec, uid, and x-xsrf-token.
// tsec rotates per request/response, so we capture from both sides.
// The user should push the token immediately after navigating in BBVA.
chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    const tsecHeader = details.requestHeaders?.find(
      (h) => h.name.toLowerCase() === 'tsec'
    );
    const uidHeader = details.requestHeaders?.find(
      (h) => h.name.toLowerCase() === 'uid'
    );
    const xsrfHeader = details.requestHeaders?.find(
      (h) => h.name.toLowerCase() === 'x-xsrf-token'
    );

    const updates = {};
    if (tsecHeader?.value) updates.bbva_tsec = tsecHeader.value;
    if (uidHeader?.value) updates.bbva_uid = uidHeader.value;
    if (xsrfHeader?.value) updates.bbva_xsrf_token = xsrfHeader.value;

    if (Object.keys(updates).length > 0) {
      updates.bbva_captured_at = Date.now();
      chrome.storage.local.set(updates);
    }
  },
  { urls: ['https://online.bbva.com.ar/*'] },
  ['requestHeaders']
);

// Also try to capture tsec from response headers (BBVA may rotate it there)
chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    const tsecHeader = details.responseHeaders?.find(
      (h) => h.name.toLowerCase() === 'tsec'
    );
    if (tsecHeader?.value) {
      chrome.storage.local.set({
        bbva_tsec: tsecHeader.value,
        bbva_captured_at: Date.now()
      });
    }
  },
  { urls: ['https://online.bbva.com.ar/*'] },
  ['responseHeaders']
);
