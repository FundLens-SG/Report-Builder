/* CKG Tools — Google Drive save/load (Phase 9F)
 *
 * Reuses the suite Google Core broker and Drive bridge (server-side
 * refresh_token, acting-as aware). Drive save/load/list operations go
 * through ckg-drive-bridge instead of browser-side Drive REST.
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
 *   window.ckgDriveAvailable()        — true when Google Core is present
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

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  async function waitForGoogleCore() {
    for (var i = 0; i < 20; i++) {
      if (window.ckgGoogle && typeof window.ckgGoogle.getAccessToken === 'function') return window.ckgGoogle;
      await sleep(100);
    }
    return null;
  }

  async function getValidToken() {
    var core = await waitForGoogleCore();
    if (!core) {
      console.warn('[CkgDrive] Google Core helper unavailable');
      return null;
    }
    try {
      return await core.getAccessToken();
    } catch (e) {
      console.warn('[CkgDrive] Google Core token failed:', (e && e.message) || e);
      return null;
    }
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

  async function bridgeMethod(name) {
    var core = await waitForGoogleCore();
    return core &&
      core.bridge &&
      typeof core.bridge[name] === 'function'
      ? core.bridge[name].bind(core.bridge)
      : null;
  }

  function clientNameFor(meta) {
    return String((meta && meta.clientName) || '').trim() || 'Report Builder';
  }

  function clientIdFor(meta) {
    return String((meta && (meta.clientId || meta.reportId || meta.clientName)) || 'general').trim();
  }

  async function ensureReportFolder(meta) {
    var ensureFolder = await bridgeMethod('ensureFolder');
    if (!ensureFolder) {
      console.warn('[CkgDrive] bridge ensureFolder unavailable');
      return null;
    }
    try {
      var folder = await ensureFolder({
        tool: 'report-builder',
        section: 'Clients',
        clientName: clientNameFor(meta),
        clientId: clientIdFor(meta),
      });
      return folder && folder.folderId;
    } catch (e) {
      console.warn('[CkgDrive] bridge folder ensure failed:', (e && e.message) || e);
      return null;
    }
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
    var filename = buildFilename(meta || {});
    var folderId = await ensureReportFolder(meta || {});
    var saveBlob = await bridgeMethod('saveBlob');
    if (!folderId || !saveBlob) {
      console.warn('[CkgDrive] bridge save unavailable');
      return null;
    }
    try {
      var saved = await saveBlob({
        folderId: folderId,
        name: filename,
        base64: await blobToBase64(blob),
        mimeType: blob.type || 'image/png',
        tool: 'report-builder',
        clientId: clientIdFor(meta),
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
      console.warn('[CkgDrive] bridge save failed:', (e && e.message) || e);
      return null;
    }
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
        var loadFile = await bridgeMethod('loadFile');
        if (!loadFile) {
          console.warn('[CkgDrive] bridge load unavailable');
          return;
        }
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
        } catch (e) {
          console.warn('[CkgDrive] bridge load failed:', (e && e.message) || e);
        }
      })
      .build();
    picker.setVisible(true);
  };

  window.ckgDriveAvailable = function () {
    return Boolean(window.ckgGoogle && typeof window.ckgGoogle.getAccessToken === 'function');
  };

  // ── Phase 9G — File-level helpers (used by docs/history.js) ────────
  //
  // Three primitives the time-series feature needs that aren't covered
  // by the PNG-focused save/load above:
  //   ckgDriveFindFile(name, parentId)  → {id, webViewLink} | null
  //   ckgDriveReadJson(fileId)          → parsed JSON or null
  //   ckgDriveUpsertJson(name, parentId, json) → {id, webViewLink} | null
  //
  // Each delegates to the shared Drive bridge and never throws to the page.
  // Failures log a warning and return null so the time-series section degrades to
  // "no history available" rather than blocking the snapshot render.

  // Look up a single file by exact name within a parent folder. Returns
  // null when nothing matches OR the call fails — the caller decides
  // whether absence means "create it" or "skip silently".
  window.ckgDriveFindFile = async function (name, parentId) {
    if (!name || !parentId) return null;
    var listToolFiles = await bridgeMethod('listToolFiles');
    if (listToolFiles) {
      try {
        var indexed = await listToolFiles({ tool: 'report-builder' });
        var hit = ((indexed && indexed.files) || []).find(function (f) {
          return f && f.folderId === parentId && f.name === name;
        });
        if (hit) return { id: hit.fileId, name: hit.name, webViewLink: 'https://drive.google.com/file/d/' + hit.fileId + '/view' };
      } catch (e) {
        console.warn('[CkgDrive] bridge index lookup failed:', (e && e.message) || e);
      }
    }
    return null;
  };

  // GET a JSON file's contents. Returns the parsed object, or null on
  // any failure (network, parse, missing). Caller treats null as
  // "history doesn't exist yet" — they should NOT distinguish "missing"
  // from "permission denied", because both end the trend section the
  // same way.
  window.ckgDriveReadJson = async function (fileId) {
    if (!fileId) return null;
    var loadFile = await bridgeMethod('loadFile');
    if (loadFile) {
      try {
        var loaded = await loadFile(fileId);
        return base64ToJson(loaded.base64);
      } catch (e) {
        console.warn('[CkgDrive] bridge readJson failed:', (e && e.message) || e);
      }
    }
    return null;
  };

  // Find-or-create then overwrite. Used as: "store this JSON under this
  // exact name in the Snapshots folder, replacing any prior version".
  // Returns {id, webViewLink} on success, null on any failure.
  //
  // Implementation delegates to ckg-drive-bridge.saveJson so the browser
  // never uploads directly to Drive.
  window.ckgDriveUpsertJson = async function (name, parentId, json) {
    if (!name || !parentId) return null;
    var saveJson = await bridgeMethod('saveJson');
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
        console.warn('[CkgDrive] bridge upsertJson failed:', (e && e.message) || e);
      }
    }
    return null;
  };
})();
