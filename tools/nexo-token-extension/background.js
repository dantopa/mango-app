// Background service worker — captures Bancolombia Bearer token from requests
// When the user is logged into svpersonas.apps.bancolombia.com, any API call
// to canalpersonas-ext.apps.bancolombia.com includes the Bearer token.
// We capture it here and store it for the popup to use.

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
