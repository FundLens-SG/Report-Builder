/* CKG Tools — Google Drive save/load (Phase 9F)
 *
 * Reuses the hub Supabase session's provider_token (drive.file scope).
 * On 401, calls the hub's drive-auth-dev Edge Function (mode='refresh')
 * to mint a fresh access token from the server-side refresh_token.
 *
 * Saves never request broader scopes than drive.file. The user only
 * sees files this app created — no inbox-style folder browsing.
 *
 * Loads use Google Picker API filtered to images. Picker requires the
 * same drive.file token. Cancellation, missing tokens, or upload
 * failures all surface as toasts; nothing throws to the page.
 *
 * Exposes:
 *   window.ckgDriveSave(blob, meta)   — Promise<{id, webViewLink} | null>
 *   window.ckgDriveLoad(onPicked)     — onPicked({blob, name, id}) | null
 *   window.ckgDriveAvailable()        — true when both supabase + a hub
 *                                        session are present
 */
(function () {
  'use strict';

  function sb() {
    return window._ckgSupabase || null;
  }

  async function getProviderToken() {
    const s = sb();
    if (!s) return null;
    try {
      const { data } = await s.auth.getSession();
      return (data && data.session && data.session.provider_token) || null;
    } catch (_e) {
      return null;
    }
  }

  async function refreshTokenViaEdgeFn() {
    const s = sb();
    if (!s) return null;
    try {
      const { data, error } = await s.functions.invoke('drive-auth-dev', { body: { mode: 'refresh' } });
      if (error || !data || !data.access_token) {
        console.warn('[CkgDrive] refresh failed:', (error && error.message) || (data && data.error) || 'no token');
        return null;
      }
      return data.access_token;
    } catch (e) {
      console.warn('[CkgDrive] refresh threw:', (e && e.message) || e);
      return null;
    }
  }

  async function getValidToken() {
    let tok = await getProviderToken();
    if (tok) return tok;
    // No fast-path token — try refresh
    return await refreshTokenViaEdgeFn();
  }

  function buildFilename(meta) {
    var safeStr = function (s) { return String(s || '').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, ''); };
    var customer  = safeStr(meta && meta.clientName)  || '';
    var report    = safeStr(meta && meta.reportTitle) || '';
    var date      = (meta && meta.date) || new Date().toISOString().slice(0, 10);
    var ts        = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    if (customer || report) {
      return 'CKGTools_Report_' + [customer, report, date].filter(Boolean).join('_') + '.png';
    }
    return 'CKGTools_Report_' + ts + '.png';
  }

  // ── Save ────────────────────────────────────────────────────────
  window.ckgDriveSave = async function (blob, meta) {
    if (!blob) return null;
    var tok = await getValidToken();
    if (!tok) {
      console.warn('[CkgDrive] no Drive token available — sign into the hub at ckgtools.com first');
      return null;
    }
    // Wire the shared folder helper's token getter to our token source.
    // Idempotent — safe to set on every save.
    if (!window._ckgGetDriveToken) window._ckgGetDriveToken = getValidToken;
    var filename = buildFilename(meta || {});
    // Standardised destination: My Drive / CKGTools / ReportBuilder / Snapshots.
    // Falls back to root if the shared helper is unavailable for any reason.
    var parents = null;
    if (window.ckgDriveFolders && typeof window.ckgDriveFolders.ensureSubfolder === 'function') {
      try { parents = [await window.ckgDriveFolders.ensureSubfolder('report-builder', 'Snapshots')]; }
      catch (e) { console.warn('[CkgDrive] folder helper failed, saving to root:', e && e.message); }
    }
    var metadata = {
      name:        filename,
      mimeType:    blob.type || 'image/png',
      properties: {
        source:        'CKGTools',
        tool:          'Report Builder',
        clientName:    String((meta && meta.clientName)  || ''),
        reportTitle:   String((meta && meta.reportTitle) || ''),
        convertedAt:   new Date().toISOString(),
        reportId:      String((meta && meta.reportId)    || ''),
      },
    };
    if (parents) metadata.parents = parents;
    var boundary = '-------ckg' + Math.random().toString(36).slice(2);
    var delim    = '\r\n--' + boundary + '\r\n';
    var close    = '\r\n--' + boundary + '--';

    // Multipart body construction. Use a Blob to keep binary intact.
    var head =
      delim +
      'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
      JSON.stringify(metadata) +
      delim +
      'Content-Type: ' + (blob.type || 'image/png') + '\r\n\r\n';

    async function doUpload(token) {
      var body = new Blob([
        head,
        blob,
        close,
      ], { type: 'multipart/related; boundary=' + boundary });
      return fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink', {
        method:  'POST',
        headers: {
          'Authorization': 'Bearer ' + token,
          'Content-Type':  'multipart/related; boundary=' + boundary,
        },
        body: body,
      });
    }

    var resp = await doUpload(tok);
    if (resp.status === 401) {
      // Token expired between getValidToken and now (rare). Refresh + retry once.
      var fresh = await refreshTokenViaEdgeFn();
      if (!fresh) {
        console.warn('[CkgDrive] save 401, refresh failed');
        return null;
      }
      resp = await doUpload(fresh);
    }
    if (!resp.ok) {
      var txt = await resp.text().catch(function () { return ''; });
      console.warn('[CkgDrive] save failed', resp.status, txt.slice(0, 240));
      return null;
    }
    var json = await resp.json();
    // Track the save event to ckgtools.tool_activity_events
    try {
      var s = sb();
      if (s) {
        var u = (await s.auth.getUser()).data.user;
        if (u) {
          await s.from('tool_activity_events').insert({
            user_id: u.id,
            tool_id: 'report_builder',
            action: 'report_image_saved_to_google_drive',
            entity_type: 'client_report',
            entity_id: 'drive_' + json.id,
            entity_name: json.name,
            client_name: (meta && meta.clientName) || null,
            status: 'completed',
            actor_name: u.email || null,
            metadata: { drive_file_id: json.id, drive_link: json.webViewLink || null },
          });
        }
      }
    } catch (_e) { /* never block on tracking */ }
    return { id: json.id, name: json.name, webViewLink: json.webViewLink || null };
  };

  // ── Load via Picker ───────────────────────────────────────────────
  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.defer = true;
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error('script load failed: ' + src)); };
      document.head.appendChild(s);
    });
  }

  var gapiReady = null;
  var pickerReady = null;
  async function ensurePicker() {
    if (!gapiReady) gapiReady = loadScript('https://apis.google.com/js/api.js');
    await gapiReady;
    if (!pickerReady) {
      pickerReady = new Promise(function (resolve) {
        window.gapi.load('picker', { callback: resolve });
      });
    }
    await pickerReady;
  }

  // App ID is the Google Cloud project number for the OAuth client.
  // Embedded as a public configuration value (Picker requires it).
  // Project number for ckgtools-admin OAuth: derived from the client ID
  // ('502722318908-…apps.googleusercontent.com' → '502722318908').
  var APP_ID = '502722318908';

  window.ckgDriveLoad = async function (onPicked) {
    if (typeof onPicked !== 'function') return null;
    var tok = await getValidToken();
    if (!tok) {
      console.warn('[CkgDrive] no Drive token available — sign into the hub at ckgtools.com first');
      return null;
    }
    try {
      await ensurePicker();
    } catch (e) {
      console.warn('[CkgDrive] picker load failed:', (e && e.message) || e);
      return null;
    }
    // drive.file scope only sees files this app created (or files the
    // user picks). DocsView with view-id 'images' filters to image MIMEs.
    var view = new window.google.picker.DocsView(window.google.picker.ViewId.DOCS_IMAGES)
      .setIncludeFolders(false)
      .setSelectFolderEnabled(false);
    var picker = new window.google.picker.PickerBuilder()
      .setAppId(APP_ID)
      .setOAuthToken(tok)
      .addView(view)
      .setTitle('Choose a report image')
      .setCallback(async function (data) {
        if (!data || data.action !== window.google.picker.Action.PICKED) return;
        var doc = data.docs && data.docs[0];
        if (!doc || !doc.id) return;
        var refTok = await getValidToken();
        if (!refTok) return;
        var resp = await fetch('https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(doc.id) + '?alt=media', {
          headers: { 'Authorization': 'Bearer ' + refTok },
        });
        if (resp.status === 401) {
          var fresh = await refreshTokenViaEdgeFn();
          if (!fresh) return;
          resp = await fetch('https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(doc.id) + '?alt=media', {
            headers: { 'Authorization': 'Bearer ' + fresh },
          });
        }
        if (!resp.ok) {
          console.warn('[CkgDrive] download failed', resp.status);
          return;
        }
        var blob = await resp.blob();
        try { onPicked({ blob: blob, name: doc.name, id: doc.id }); } catch (_e) {}
        // Track the load event
        try {
          var s = sb();
          if (s) {
            var u = (await s.auth.getUser()).data.user;
            if (u) {
              await s.from('tool_activity_events').insert({
                user_id: u.id,
                tool_id: 'report_builder',
                action: 'report_image_loaded_from_google_drive',
                entity_type: 'client_report',
                entity_id: 'drive_load_' + doc.id,
                entity_name: doc.name,
                status: 'completed',
                actor_name: u.email || null,
                metadata: { drive_file_id: doc.id },
              });
            }
          }
        } catch (_e) {}
      })
      .build();
    picker.setVisible(true);
  };

  window.ckgDriveAvailable = function () {
    return Boolean(sb());
  };
})();
