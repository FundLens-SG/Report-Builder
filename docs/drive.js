/* CKG Tools — Google Drive save/load (Phase 9F)
 *
 * Reuses the suite Google Core broker first (server-side refresh_token,
 * acting-as aware). In standalone/offline contexts it falls back to the
 * hub Supabase session's provider_token and then drive-auth-dev refresh.
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

  function surfaceGoogleCoreMismatch(status) {
    if (!status || !status.mismatch) return;
    var googleEmail = status.googleEmail || status.google_email || 'unknown Google account';
    var hubEmail = status.hubEmail || status.hub_email || 'your CKGTools account';
    var msg = 'Drive is connected to ' + googleEmail + ', but CKGTools is signed in as ' + hubEmail + '. Reconnect Google Drive from Account settings.';
    console.warn('[CkgDrive] account mismatch:', msg);
    try {
      var saveBtn = document.getElementById('drive-save-btn');
      if (saveBtn) saveBtn.title = msg;
      var loadBtn = document.getElementById('drive-load-btn');
      if (loadBtn) loadBtn.title = msg;
    } catch (_) {}
  }

  function bindGoogleCoreStatus() {
    if (window.__ckgReportBuilderGoogleCoreBound) return;
    if (!window.ckgGoogle || typeof window.ckgGoogle.on !== 'function') {
      setTimeout(bindGoogleCoreStatus, 200);
      return;
    }
    window.__ckgReportBuilderGoogleCoreBound = true;
    window.ckgGoogle.on('mismatch', surfaceGoogleCoreMismatch);
    if (typeof window.ckgGoogle.status === 'function') {
      window.ckgGoogle.status().then(surfaceGoogleCoreMismatch).catch(function () {});
    }
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
    if (window.ckgGoogle && typeof window.ckgGoogle.getAccessToken === 'function') {
      try {
        return await window.ckgGoogle.getAccessToken();
      } catch (e) {
        console.warn('[CkgDrive] Google Core token failed, using legacy refresh:', (e && e.message) || e);
      }
    }

    const s = sb();
    if (!s) return null;
    try {
      const { data, error } = await s.functions.invoke('drive-auth-dev', { body: { mode: 'refresh' } });
      surfaceGoogleCoreMismatch(data);
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
    if (window.ckgGoogle && typeof window.ckgGoogle.getAccessToken === 'function') {
      try {
        return await window.ckgGoogle.getAccessToken();
      } catch (e) {
        console.warn('[CkgDrive] Google Core token failed, using hub session fallback:', (e && e.message) || e);
      }
    }
    let tok = await getProviderToken();
    if (tok) return tok;
    // No fast-path token — try refresh
    return await refreshTokenViaEdgeFn();
  }

  if (!window._ckgGetDriveToken) window._ckgGetDriveToken = getValidToken;
  bindGoogleCoreStatus();

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

  function bridgeMethod(name) {
    return window.ckgGoogle &&
      window.ckgGoogle.bridge &&
      typeof window.ckgGoogle.bridge[name] === 'function'
      ? window.ckgGoogle.bridge[name].bind(window.ckgGoogle.bridge)
      : null;
  }

  function blobToBase64(blob) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        var raw = String(reader.result || '');
        resolve(raw.indexOf(',') >= 0 ? raw.slice(raw.indexOf(',') + 1) : raw);
      };
      reader.onerror = function () { reject(reader.error || new Error('blob read failed')); };
      reader.readAsDataURL(blob);
    });
  }

  function base64ToBytes(base64) {
    var binary = atob(String(base64 || '').replace(/^data:[^,]+,/, ''));
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function base64ToBlob(base64, mimeType) {
    return new Blob([base64ToBytes(base64)], { type: mimeType || 'application/octet-stream' });
  }

  function base64ToJson(base64) {
    var text = new TextDecoder().decode(base64ToBytes(base64));
    return JSON.parse(text);
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
    var saveBlob = bridgeMethod('saveBlob');
    if (saveBlob && parents && parents[0]) {
      try {
        var saved = await saveBlob({
          folderId: parents[0],
          name: filename,
          base64: await blobToBase64(blob),
          mimeType: blob.type || 'image/png',
          tool: 'report-builder',
          clientId: String((meta && (meta.clientId || meta.reportId || meta.clientName)) || ''),
          overwrite: false,
        });
        try {
          var sBridge = sb();
          if (sBridge) {
            var uBridge = (await sBridge.auth.getUser()).data.user;
            if (uBridge) {
              await sBridge.from('tool_activity_events').insert({
                user_id: uBridge.id,
                tool_id: 'report_builder',
                action: 'report_image_saved_to_google_drive',
                entity_type: 'client_report',
                entity_id: 'drive_' + saved.fileId,
                entity_name: saved.name,
                client_name: (meta && meta.clientName) || null,
                status: 'completed',
                actor_name: uBridge.email || null,
                metadata: { drive_file_id: saved.fileId, drive_link: saved.fileUrl || null, via: 'ckg-drive-bridge' },
              });
            }
          }
        } catch (_e) { /* never block on tracking */ }
        return { id: saved.fileId, name: saved.name, webViewLink: saved.fileUrl || null };
      } catch (e) {
        console.warn('[CkgDrive] bridge save failed, falling back to direct Drive:', (e && e.message) || e);
      }
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
        var loadFile = bridgeMethod('loadFile');
        if (loadFile) {
          try {
            var loaded = await loadFile(doc.id);
            var loadedBlob = base64ToBlob(loaded.base64, loaded.mimeType || doc.mimeType || 'application/octet-stream');
            try { onPicked({ blob: loadedBlob, name: loaded.name || doc.name, id: doc.id }); } catch (_e) {}
            try {
              var sLoaded = sb();
              if (sLoaded) {
                var uLoaded = (await sLoaded.auth.getUser()).data.user;
                if (uLoaded) {
                  await sLoaded.from('tool_activity_events').insert({
                    user_id: uLoaded.id,
                    tool_id: 'report_builder',
                    action: 'report_image_loaded_from_google_drive',
                    entity_type: 'client_report',
                    entity_id: 'drive_load_' + doc.id,
                    entity_name: loaded.name || doc.name,
                    status: 'completed',
                    actor_name: uLoaded.email || null,
                    metadata: { drive_file_id: doc.id, via: 'ckg-drive-bridge' },
                  });
                }
              }
            } catch (_e) {}
            return;
          } catch (e) {
            console.warn('[CkgDrive] bridge load failed, falling back to direct Drive:', (e && e.message) || e);
          }
        }
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
    return Boolean(sb() || (window.ckgGoogle && typeof window.ckgGoogle.getAccessToken === 'function'));
  };

  // ── Phase 9G — File-level helpers (used by docs/history.js) ────────
  //
  // Three primitives the time-series feature needs that aren't covered
  // by the PNG-focused save/load above:
  //   ckgDriveFindFile(name, parentId)  → {id, webViewLink} | null
  //   ckgDriveReadJson(fileId)          → parsed JSON or null
  //   ckgDriveUpsertJson(name, parentId, json) → {id, webViewLink} | null
  //
  // Each handles 401 once via the refresh path, mirrors drive.file scope
  // (only sees files we created), and never throws to the page — failures
  // log a warning and return null so the time-series section degrades to
  // "no history available" rather than blocking the snapshot render.

  async function _driveFetchWithRetry(url, opts) {
    opts = opts || {};
    var tok = await getValidToken();
    if (!tok) return null;
    function call(t) {
      var headers = Object.assign({ 'Authorization': 'Bearer ' + t }, opts.headers || {});
      return fetch(url, Object.assign({}, opts, { headers: headers }));
    }
    var res;
    try {
      res = await call(tok);
      if (res.status === 401) {
        var fresh = await refreshTokenViaEdgeFn();
        if (!fresh) return res;
        res = await call(fresh);
      }
    } catch (e) {
      console.warn('[CkgDrive] fetch threw:', e && e.message);
      return null;
    }
    return res;
  }

  // Look up a single file by exact name within a parent folder. Returns
  // null when nothing matches OR the call fails — the caller decides
  // whether absence means "create it" or "skip silently".
  window.ckgDriveFindFile = async function (name, parentId) {
    if (!name || !parentId) return null;
    var listToolFiles = bridgeMethod('listToolFiles');
    if (listToolFiles) {
      try {
        var indexed = await listToolFiles({ tool: 'report-builder' });
        var hit = ((indexed && indexed.files) || []).find(function (f) {
          return f && f.folderId === parentId && f.name === name;
        });
        if (hit) return { id: hit.fileId, name: hit.name, webViewLink: 'https://drive.google.com/file/d/' + hit.fileId + '/view' };
      } catch (e) {
        console.warn('[CkgDrive] bridge index lookup failed, falling back to Drive search:', (e && e.message) || e);
      }
    }
    var safe = String(name).replace(/'/g, "\\'");
    var q = "trashed=false and name='" + safe + "' and '" + parentId + "' in parents";
    var url = 'https://www.googleapis.com/drive/v3/files?spaces=drive&pageSize=1' +
              '&fields=files(id,name,webViewLink)&q=' + encodeURIComponent(q);
    var res = await _driveFetchWithRetry(url);
    if (!res || !res.ok) return null;
    var json = await res.json().catch(function () { return {}; });
    var f = (json.files || [])[0];
    return f ? { id: f.id, name: f.name, webViewLink: f.webViewLink || null } : null;
  };

  // GET a JSON file's contents. Returns the parsed object, or null on
  // any failure (network, parse, missing). Caller treats null as
  // "history doesn't exist yet" — they should NOT distinguish "missing"
  // from "permission denied", because both end the trend section the
  // same way.
  window.ckgDriveReadJson = async function (fileId) {
    if (!fileId) return null;
    var loadFile = bridgeMethod('loadFile');
    if (loadFile) {
      try {
        var loaded = await loadFile(fileId);
        return base64ToJson(loaded.base64);
      } catch (e) {
        console.warn('[CkgDrive] bridge readJson failed, falling back to direct Drive:', (e && e.message) || e);
      }
    }
    var url = 'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(fileId) + '?alt=media';
    var res = await _driveFetchWithRetry(url);
    if (!res || !res.ok) return null;
    try { return await res.json(); }
    catch (e) {
      console.warn('[CkgDrive] readJson parse failed:', e && e.message);
      return null;
    }
  };

  // Find-or-create then overwrite. Used as: "store this JSON under this
  // exact name in the Snapshots folder, replacing any prior version".
  // Returns {id, webViewLink} on success, null on any failure.
  //
  // Implementation:
  //   - findFile() → if hit, PATCH the bytes
  //   - else POST a multipart create
  // webViewLink is fetched as part of the upload response so callers can
  // surface an "Open in Drive" affordance without an extra round-trip.
  window.ckgDriveUpsertJson = async function (name, parentId, json) {
    if (!name || !parentId) return null;
    var saveJson = bridgeMethod('saveJson');
    if (saveJson) {
      try {
        var saved = await saveJson({
          folderId: parentId,
          name: name,
          json: json,
          tool: 'report-builder',
          overwrite: true,
        });
        return { id: saved.fileId, webViewLink: saved.fileUrl || null };
      } catch (e) {
        console.warn('[CkgDrive] bridge upsertJson failed, falling back to direct Drive:', (e && e.message) || e);
      }
    }
    var body = JSON.stringify(json, null, 2);

    var existing = await window.ckgDriveFindFile(name, parentId);
    if (existing && existing.id) {
      var patchUrl = 'https://www.googleapis.com/upload/drive/v3/files/' +
                     encodeURIComponent(existing.id) +
                     '?uploadType=media&fields=id,webViewLink';
      var patchRes = await _driveFetchWithRetry(patchUrl, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: body,
      });
      if (!patchRes || !patchRes.ok) {
        console.warn('[CkgDrive] upsertJson PATCH failed', patchRes && patchRes.status);
        return null;
      }
      var pj = await patchRes.json().catch(function () { return {}; });
      return { id: pj.id || existing.id, webViewLink: pj.webViewLink || existing.webViewLink };
    }

    // Create new file via multipart upload.
    var metadata = {
      name: name,
      mimeType: 'application/json',
      parents: [parentId],
    };
    var boundary = '-------ckg' + Math.random().toString(36).slice(2);
    var multipart =
      '--' + boundary + '\r\n' +
      'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
      JSON.stringify(metadata) + '\r\n' +
      '--' + boundary + '\r\n' +
      'Content-Type: application/json\r\n\r\n' +
      body + '\r\n' +
      '--' + boundary + '--';
    var createUrl = 'https://www.googleapis.com/upload/drive/v3/files' +
                    '?uploadType=multipart&fields=id,webViewLink';
    var createRes = await _driveFetchWithRetry(createUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'multipart/related; boundary=' + boundary },
      body: multipart,
    });
    if (!createRes || !createRes.ok) {
      console.warn('[CkgDrive] upsertJson CREATE failed', createRes && createRes.status);
      return null;
    }
    var cj = await createRes.json().catch(function () { return {}; });
    return { id: cj.id, webViewLink: cj.webViewLink || null };
  };
})();
