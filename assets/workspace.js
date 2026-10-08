(function(){
  'use strict';

  /* ============================================================
     STATE
  ============================================================ */
  const state = {
    uploadMode: 'zip',        // 'zip' | 'folder'
    repoMode: 'existing',     // 'existing' | 'new'
    visibility: 'private',    // 'private' | 'public'
    files: [],                // flat list: {path, data(ArrayBuffer), size, mode, checked, locked, note}
    raw: null,                // entries as read from the ZIP/folder, before path clean-up
    stripRoot: true,          // drop a single shared top-level folder
    tree: null,               // nested tree built from files
    isPushing: false,
    dragDepth: 0
  };

  const TOKEN_KEY = 'zip2git_pat_v1';
  const MAX_BLOB = 100 * 1024 * 1024;   // GitHub rejects blobs over 100 MB
  const WARN_BLOB = 50 * 1024 * 1024;   // GitHub warns above 50 MB
  const SEED_PATH = '.zip2git-init';    // temporary file used to initialise an empty repo
  const JUNK_RE = /(^|\/)(__MACOSX|\.DS_Store|Thumbs\.db|desktop\.ini|\._[^/]*)(\/|$)/;


  /* ============================================================
     DOM REFS (workspace-specific — nav/footer refs live in site.js)
  ============================================================ */
  const $ = (id) => document.getElementById(id);

  const patInput = $('patInput');
  const patToggle = $('patToggle');
  const rememberTokenCheck = $('rememberTokenCheck');
  const clearTokenBtn = $('clearTokenBtn');
  const repoModeSeg = $('repoModeSeg');
  const visibilityField = $('visibilityField');
  const visibilitySeg = $('visibilitySeg');
  const repoNameInput = $('repoNameInput');
  const repoNameHint = $('repoNameHint');
  const branchInput = $('branchInput');
  const commitMsgInput = $('commitMsgInput');

  const tabZip = $('tabZip');
  const tabFolder = $('tabFolder');
  const dropzone = $('dropzone');
  const dropzoneTitle = $('dropzoneTitle');
  const fileInputZip = $('fileInputZip');
  const fileInputFolder = $('fileInputFolder');
  const stripRootCheck = $('stripRootCheck');

  const statsBar = $('statsBar');
  const statFileCount = $('statFileCount');
  const statTotalSize = $('statTotalSize');
  const statSelectedCount = $('statSelectedCount');

  const treeWrap = $('treeWrap');
  const selectAllBtn = $('selectAllBtn');
  const deselectAllBtn = $('deselectAllBtn');

  const terminalWrap = $('terminalWrap');
  const clearLogBtn = $('clearLogBtn');

  const pushBtn = $('pushBtn');
  const pushBtnIcon = $('pushBtnIcon');
  const pushBtnText = $('pushBtnText');
  const successBanner = $('successBanner');
  const successSub = $('successSub');
  const viewRepoLink = $('viewRepoLink');
  const errorBanner = $('errorBanner');
  const errorTitle = $('errorTitle');
  const errorSub = $('errorSub');

  const ICONS = {
    folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/></svg>',
    file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/></svg>',
    chevron: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>',
    eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:17px;height:17px"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7Z"/><circle cx="12" cy="12" r="3"/></svg>',
    eyeOff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:17px;height:17px"><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 7 11 7a13.16 13.16 0 0 1-1.67 2.68M6.61 6.61C3.35 8.36 1 12 1 12s4 7 11 7a9.26 9.26 0 0 0 5.39-1.61M9.9 9.9a3 3 0 1 0 4.2 4.2"/><line x1="1" y1="1" x2="23" y2="23"/></svg>',
    pushArrow: '<path d="M12 19V5m0 0-6 6m6-6 6 6"/>',
    spinner: '<circle cx="12" cy="12" r="9" stroke-opacity=".25"/><path d="M21 12a9 9 0 0 0-9-9"/>'
  };
  /* ============================================================
     SMALL UTILITIES
  ============================================================ */
  function formatBytes(bytes){
    if(!bytes) return '0 KB';
    const units = ['B','KB','MB','GB'];
    let i = 0, n = bytes;
    while(n >= 1024 && i < units.length - 1){ n /= 1024; i++; }
    return (i === 0 ? n : n.toFixed(n < 10 ? 2 : 1)) + ' ' + units[i];
  }

  function escapeHtml(str){
    return String(str).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  function arrayBufferToBase64(buffer){
    const bytes = new Uint8Array(buffer);
    const chunkSize = 0x8000, parts = [];
    for(let i = 0; i < bytes.length; i += chunkSize){
      parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize)));
    }
    return btoa(parts.join(''));
  }

  // Strips a single shared top-level folder from every path, if one exists
  // (e.g. GitHub zip exports wrap everything in "repo-main/", folder picks
  // wrap everything in the folder name). Keeps paths untouched otherwise.
  function isJunk(p){ return JUNK_RE.test(p); }

  function stripCommonRoot(paths){
    const real = paths.filter((p) => !isJunk(p));
    if(real.length === 0 || !real.every((p) => p.includes('/'))) return { paths, root: '' };
    const root = real[0].split('/')[0];
    if(!root || !real.every((p) => p.split('/')[0] === root)) return { paths, root: '' };
    return { paths: paths.map((p) => p.startsWith(root + '/') ? p.slice(root.length + 1) : p), root };
  }

  function normalizePath(p){
    const segs = String(p).replace(/\\/g, '/').split('/').filter((x) => x && x !== '.');
    return segs.some((x) => x === '..') ? null : segs.join('/');
  }

  function errorText(err){
    return [err.message].concat((err.details || []).map((d) => typeof d === 'string' ? d : (d && d.message) || '')).filter(Boolean).join(' — ');
  }

  /* ============================================================
     TERMINAL
  ============================================================ */
  let progressLineEl = null;

  function log(msg, type){
    progressLineEl = null;
    const line = document.createElement('div');
    line.className = 'term-line ' + (type || 'plain');
    line.innerHTML = '<span class="t-prompt">' + (type === 'ok' ? '✓' : type === 'err' ? '✗' : type === 'warn' ? '!' : '$') + '</span><span class="t-msg">' + escapeHtml(msg) + '</span>';
    terminalWrap.appendChild(line);
    terminalWrap.scrollTop = terminalWrap.scrollHeight;
  }

  // Updates the same line in place (used for "Creating blobs (n/total)")
  function logProgress(msg){
    if(!progressLineEl){
      progressLineEl = document.createElement('div');
      progressLineEl.className = 'term-line info';
      progressLineEl.innerHTML = '<span class="t-prompt">$</span><span class="t-msg"></span>';
      terminalWrap.appendChild(progressLineEl);
    }
    progressLineEl.querySelector('.t-msg').textContent = msg;
    terminalWrap.scrollTop = terminalWrap.scrollHeight;
  }

  function clearLog(){
    progressLineEl = null;
    terminalWrap.innerHTML = '<div class="term-line plain"><span class="t-prompt">$</span><span class="t-msg">Terminal cleared.</span></div>';
  }
  clearLogBtn.addEventListener('click', clearLog);

  /* ============================================================
     TOKEN PERSISTENCE
  ============================================================ */
  function loadStoredToken(){
    try{
      const saved = localStorage.getItem(TOKEN_KEY);
      if(saved){
        patInput.value = saved;
        rememberTokenCheck.checked = true;
      }
    }catch(e){ /* localStorage unavailable — ignore silently */ }
  }

  rememberTokenCheck.addEventListener('change', () => {
    try{
      if(rememberTokenCheck.checked && patInput.value){
        localStorage.setItem(TOKEN_KEY, patInput.value);
      }else if(!rememberTokenCheck.checked){
        localStorage.removeItem(TOKEN_KEY);
      }
    }catch(e){ log('Could not access localStorage in this browser.', 'warn'); }
  });

  patInput.addEventListener('input', () => {
    if(rememberTokenCheck.checked){
      try{ localStorage.setItem(TOKEN_KEY, patInput.value); }catch(e){}
    }
  });

  clearTokenBtn.addEventListener('click', () => {
    try{ localStorage.removeItem(TOKEN_KEY); }catch(e){}
    patInput.value = '';
    rememberTokenCheck.checked = false;
    log('Saved token cleared from this device.', 'warn');
  });

  patToggle.addEventListener('click', () => {
    const showing = patInput.type === 'text';
    patInput.type = showing ? 'password' : 'text';
    patToggle.innerHTML = showing ? ICONS.eye : ICONS.eyeOff;
  });


  /* ============================================================
     SEGMENTED CONTROLS (repo mode / visibility)
  ============================================================ */
  repoModeSeg.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-mode]');
    if(!btn) return;
    state.repoMode = btn.dataset.mode;
    repoModeSeg.querySelectorAll('button').forEach(b => b.classList.toggle('active', b === btn));
    visibilityField.style.display = state.repoMode === 'new' ? 'flex' : 'none';
    repoNameHint.innerHTML = state.repoMode === 'new'
      ? 'This exact name will be created under the account behind your token.'
      : 'Uses the account behind your token. You can also enter <code style="font-family:var(--mono);color:var(--green)">owner/repo</code> directly.';
  });

  visibilitySeg.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-vis]');
    if(!btn) return;
    state.visibility = btn.dataset.vis;
    visibilitySeg.querySelectorAll('button').forEach(b => b.classList.toggle('active', b === btn));
  });
  /* ============================================================
     UPLOAD MODE (ZIP vs FOLDER)
  ============================================================ */
  function setUploadMode(mode){
    state.uploadMode = mode;
    tabZip.classList.toggle('active', mode === 'zip');
    tabFolder.classList.toggle('active', mode === 'folder');
    dropzoneTitle.textContent = mode === 'zip'
      ? 'Drag & drop a .zip file here, or click to browse'
      : 'Drag & drop a folder here, or click to choose one';
  }
  tabZip.addEventListener('click', () => setUploadMode('zip'));
  tabFolder.addEventListener('click', () => setUploadMode('folder'));

  /* ============================================================
     TREE MODEL
  ============================================================ */
  function buildTree(files){
    const root = { type: 'folder', name: '', path: '', children: {} };
    files.forEach((f) => {
      const parts = f.path.split('/').filter(Boolean);
      let node = root, curPath = '';
      parts.forEach((part, i) => {
        curPath = curPath ? curPath + '/' + part : part;
        const isFile = i === parts.length - 1;
        if(!node.children[part]){
          node.children[part] = isFile
            ? { type: 'file', name: part, path: curPath, size: f.size, ref: f }
            : { type: 'folder', name: part, path: curPath, children: {} };
        }
        node = node.children[part];
      });
    });
    return root;
  }

  function sortedChildren(node){
    return Object.values(node.children).sort((a, b) => {
      if(a.type !== b.type) return a.type === 'folder' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }

  function findNodeByPath(node, path){
    if(node.path === path) return node;
    for(const c of Object.values(node.children || {})){
      const found = findNodeByPath(c, path);
      if(found) return found;
    }
    return null;
  }

  function getFolderCheckState(node){
    let total = 0, checkedCount = 0;
    (function walk(n){
      sortedChildren(n).forEach((c) => {
        if(c.type === 'file'){ if(c.ref.locked) return; total++; if(c.ref.checked) checkedCount++; }
        else walk(c);
      });
    })(node);
    return { checked: total > 0 && checkedCount === total, indeterminate: checkedCount > 0 && checkedCount < total };
  }

  function renderNode(node){
    if(node.type === 'file'){
      return '<div class="tree-row" data-row-path="' + escapeHtml(node.path) + '"' + (node.ref.note ? ' title="' + escapeHtml(node.ref.note) + '"' : '') + '>' +
        '<input type="checkbox" aria-label="Include ' + escapeHtml(node.path) + '" data-path="' + escapeHtml(node.path) + '"' + (node.ref.checked ? ' checked' : '') + (node.ref.locked ? ' disabled' : '') + '>' +
        '<span class="t-icon file">' + ICONS.file + '</span>' +
        '<span class="t-name">' + escapeHtml(node.name) + '</span>' +
        '<span class="t-size">' + formatBytes(node.size) + '</span></div>';
    }
    const kids = sortedChildren(node);
    const st = getFolderCheckState(node);
    const childrenHtml = kids.map(renderNode).join('');
    return '<div class="tree-row is-folder" data-row-path="' + escapeHtml(node.path) + '">' +
      '<input type="checkbox" aria-label="Include folder ' + escapeHtml(node.path) + '" data-folder-path="' + escapeHtml(node.path) + '"' + (st.checked ? ' checked' : '') + '>' +
      '<span class="t-icon folder">' + ICONS.folder + '</span>' +
      '<span class="t-name">' + escapeHtml(node.name) + '</span></div>' +
      '<div class="tree-children">' + childrenHtml + '</div>';
  }

  function refreshFolderCheckboxStates(){
    treeWrap.querySelectorAll('input[data-folder-path]').forEach((cb) => {
      const node = findNodeByPath(state.tree, cb.dataset.folderPath);
      if(!node) return;
      const st = getFolderCheckState(node);
      cb.checked = st.checked;
      cb.indeterminate = st.indeterminate;
    });
  }

  function renderTree(){
    if(!state.tree || state.files.length === 0){
      treeWrap.innerHTML = '<div class="tree-empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/></svg><span>Nothing uploaded yet — finish step 2 to see your file tree here</span></div>';
      return;
    }
    treeWrap.innerHTML = sortedChildren(state.tree).map(renderNode).join('');
    refreshFolderCheckboxStates();
  }

  treeWrap.addEventListener('change', (e) => {
    const t = e.target;
    if(t.matches('input[data-path]')){
      const entry = state.files.find((f) => f.path === t.dataset.path);
      if(entry) entry.checked = t.checked;
      refreshFolderCheckboxStates();
      updateStatsBar();
    }else if(t.matches('input[data-folder-path]')){
      const prefix = t.dataset.folderPath ? t.dataset.folderPath + '/' : '';
      state.files.forEach((f) => { if(!f.locked && (f.path === t.dataset.folderPath || f.path.startsWith(prefix))) f.checked = t.checked; });
      renderTree();
      updateStatsBar();
    }
  });

  selectAllBtn.addEventListener('click', () => { state.files.forEach((f) => f.checked = !f.locked); renderTree(); updateStatsBar(); });
  deselectAllBtn.addEventListener('click', () => { state.files.forEach((f) => f.checked = false); renderTree(); updateStatsBar(); });

  function updateStatsBar(){
    const total = state.files.length;
    const selected = state.files.filter((f) => f.checked).length;
    const totalSize = state.files.reduce((sum, f) => sum + f.size, 0);
    statFileCount.textContent = total;
    statTotalSize.textContent = formatBytes(totalSize);
    statSelectedCount.textContent = selected;
    statsBar.style.display = total > 0 ? 'flex' : 'none';
  }

  /* ============================================================
     FILE INGESTION (ZIP / folder input / drag & drop)
  ============================================================ */
  function ingestFiles(rawEntries, sourceLabel){
    if(!rawEntries || rawEntries.length === 0){
      log('No files found in that ' + sourceLabel + '.', 'warn');
      return;
    }
    state.raw = rawEntries;
    applyEntries();
    successBanner.classList.remove('show');
    errorBanner.classList.remove('show');
  }

  // Cleans paths, drops duplicates/collisions, flags files that can't or shouldn't be pushed.
  function applyEntries(){
    const unique = new Map();
    let bad = 0;
    (state.raw || []).forEach((e) => {
      const p = normalizePath(e.path);
      if(!p){ bad++; return; }
      unique.set(p, Object.assign({}, e, { path: p }));
    });
    if(bad) log('Skipped ' + bad + ' entries with empty or unsafe paths.', 'warn');
    let list = Array.from(unique.values());
    let root = '';
    if(state.stripRoot){
      const r = stripCommonRoot(list.map((e) => e.path));
      root = r.root;
      list.forEach((e, i) => { e.path = r.paths[i]; });
    }
    const byPath = new Map();
    list.forEach((e) => byPath.set(e.path, e));
    const dirs = new Set();
    byPath.forEach((e, p) => { const seg = p.split('/'); for(let i = 1; i < seg.length; i++) dirs.add(seg.slice(0, i).join('/')); });
    list = Array.from(byPath.values()).filter((e) => {
      if(dirs.has(e.path)){ log('Skipped "' + e.path + '" — a file and a folder share that path.', 'warn'); return false; }
      return true;
    });
    state.files = list.map((e) => {
      const f = { path: e.path, data: e.data, size: e.size, mode: e.mode || '100644', checked: true, locked: false, note: '' };
      if(f.path.split('/').includes('.git')){ f.checked = false; f.locked = true; f.note = 'GitHub does not accept .git folders'; }
      else if(f.size > MAX_BLOB){ f.checked = false; f.locked = true; f.note = "Over GitHub's 100 MB file limit"; }
      else if(isJunk(f.path)){ f.checked = false; f.note = 'OS metadata file — unchecked by default'; }
      return f;
    });
    state.tree = buildTree(state.files);
    renderTree();
    updateStatsBar();
    if(state.files.length === 0){ log('Nothing usable was found in that upload.', 'warn'); return; }
    const totalSize = state.files.reduce((sum, f) => sum + f.size, 0);
    log('Extracted ' + state.files.length + ' files (' + formatBytes(totalSize) + ').' + (root ? ' Removed the shared top-level folder "' + root + '/" (untick the option above to keep it).' : ''), 'ok');
    const locked = state.files.filter((f) => f.locked).length;
    const junk = state.files.filter((f) => !f.checked && !f.locked).length;
    const big = state.files.filter((f) => f.checked && f.size > WARN_BLOB).length;
    if(locked) log(locked + ' file(s) cannot be pushed (.git folders or files over 100 MB) and were left out.', 'warn');
    if(junk) log(junk + ' OS metadata file(s) (__MACOSX, .DS_Store…) start unchecked.', 'warn');
    if(big) log(big + ' file(s) are over 50 MB — GitHub warns about files that large.', 'warn');
  }

  stripRootCheck.addEventListener('change', () => {
    state.stripRoot = stripRootCheck.checked;
    if(state.raw) applyEntries();
  });

  async function handleZipFile(file){
    if(!file) return;
    if(typeof JSZip === 'undefined'){
      log('JSZip did not load — check your connection and reload the page.', 'err');
      return;
    }
    log('Unpacking ZIP archive "' + file.name + '"...', 'info');
    try{
      const zip = await JSZip.loadAsync(file);
      const entries = [];
      const names = Object.keys(zip.files);
      for(const name of names){
        const zEntry = zip.files[name];
        if(zEntry.dir) continue;
        const data = await zEntry.async('arraybuffer');
        const perm = zEntry.unixPermissions;
        let mode = '100644';
        if(typeof perm === 'number'){
          if((perm & 0o170000) === 0o120000) mode = '120000';
          else if(perm & 0o111) mode = '100755';
        }
        entries.push({ path: name, data, size: data.byteLength, mode });
      }
      ingestFiles(entries, 'ZIP file');
    }catch(err){
      log('Could not read that ZIP file — ' + err.message, 'err');
    }
  }

  async function handleFolderFileList(fileList){
    const files = Array.from(fileList);
    if(files.length === 0) return;
    log('Reading ' + files.length + ' files from the selected folder...', 'info');
    try{
      const entries = await Promise.all(files.map(async (f) => ({
        path: f.webkitRelativePath || f.name,
        data: await f.arrayBuffer(),
        size: f.size
      })));
      ingestFiles(entries, 'folder');
    }catch(err){
      log('Could not read the selected folder — ' + err.message, 'err');
    }
  }

  function traverseEntry(entry, basePath){
    return new Promise((resolve) => {
      if(entry.isFile){
        entry.file(async (file) => {
          try{
            const data = await file.arrayBuffer();
            resolve([{ path: basePath + entry.name, data, size: data.byteLength }]);
          }catch(e){ resolve([]); }
        }, () => resolve([]));
      }else if(entry.isDirectory){
        const reader = entry.createReader();
        let collected = [];
        const readBatch = () => {
          reader.readEntries(async (batch) => {
            if(batch.length === 0){
              const nested = await Promise.all(collected.map((en) => traverseEntry(en, basePath + entry.name + '/')));
              resolve(nested.flat());
            }else{
              collected = collected.concat(batch);
              readBatch();
            }
          }, () => resolve([]));
        };
        readBatch();
      }else{
        resolve([]);
      }
    });
  }

  async function handleDataTransfer(dataTransfer){
    const items = dataTransfer.items;
    if(items && items.length && items[0].webkitGetAsEntry){
      const entries = Array.from(items).map((it) => it.webkitGetAsEntry()).filter(Boolean);
      if(state.uploadMode === 'zip' && entries.length === 1 && entries[0].isFile && /\.zip$/i.test(entries[0].name)){
        entries[0].file((f) => handleZipFile(f));
        return;
      }
      log('Reading dropped contents...', 'info');
      const nested = await Promise.all(entries.map((en) => traverseEntry(en, '')));
      ingestFiles(nested.flat(), 'folder');
      return;
    }
    const files = dataTransfer.files;
    if(files && files.length === 1 && /\.zip$/i.test(files[0].name)){
      handleZipFile(files[0]);
    }else if(files && files.length){
      handleFolderFileList(files);
    }
  }

  ['dragenter', 'dragover'].forEach((evt) => dropzone.addEventListener(evt, (e) => {
    e.preventDefault(); e.stopPropagation();
    dropzone.classList.add('drag');
  }));
  ['dragleave', 'dragend'].forEach((evt) => dropzone.addEventListener(evt, (e) => {
    e.preventDefault(); e.stopPropagation();
    dropzone.classList.remove('drag');
  }));
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault(); e.stopPropagation();
    dropzone.classList.remove('drag');
    handleDataTransfer(e.dataTransfer);
  });
  dropzone.addEventListener('click', () => {
    (state.uploadMode === 'zip' ? fileInputZip : fileInputFolder).click();
  });
  fileInputZip.addEventListener('change', (e) => { if(e.target.files[0]) handleZipFile(e.target.files[0]); e.target.value = ''; });
  fileInputFolder.addEventListener('change', (e) => { if(e.target.files.length) handleFolderFileList(e.target.files); e.target.value = ''; });

  /* ============================================================
     GITHUB GIT DATA API CLIENT
  ============================================================ */
  const API_BASE = 'https://api.github.com';

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // retries: how many times to retry on network errors, 5xx and rate limits (0 = never)
  async function githubFetch(path, method, body, retries){
    const max = retries || 0;
    for(let attempt = 0; ; attempt++){
      let res;
      try{
        res = await fetch(API_BASE + path, {
          method: method || 'GET',
          headers: Object.assign(
            { 'Authorization': 'Bearer ' + patInput.value.trim(), 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
            body ? { 'Content-Type': 'application/json' } : {}
          ),
          body: body ? JSON.stringify(body) : undefined
        });
      }catch(netErr){
        if(attempt < max){ await sleep(800 * Math.pow(2, attempt)); continue; }
        throw new Error('Network error — check your connection and try again.');
      }
      let json = null;
      try{ json = await res.json(); }catch(e){ /* empty body, fine */ }
      if(res.ok) return json;
      const msg = (json && json.message) || (res.status + ' ' + res.statusText);
      const limited = res.status === 429 || (res.status === 403 && /rate limit|abuse|secondary/i.test(msg));
      if(attempt < max && (limited || res.status >= 500)){
        const ra = parseInt(res.headers && res.headers.get('retry-after'), 10);
        const wait = ra > 0 ? Math.min(ra, 60) * 1000 : 1000 * Math.pow(2, attempt);
        log('GitHub asked us to slow down — retrying in ' + Math.round(wait / 1000) + 's…', 'warn');
        await sleep(wait);
        continue;
      }
      const err = new Error(msg);
      err.status = res.status;
      err.details = json && json.errors;
      throw err;
    }
  }

  function normalizeRepoInput(){
    const v = repoNameInput.value.trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\/+$/, '').replace(/\.git$/i, '');
    return /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)?$/.test(v) && !/^\.{1,2}$/.test(v.split('/').pop()) ? v : null;
  }
  function normalizeBranch(){
    const v = (branchInput.value.trim() || 'main').replace(/^refs\/heads\//, '');
    return /^[^\s~^:?*\[\\]+$/.test(v) && !/(^\/|\/$|\.\.|\/\/|\.lock$|@\{|^-)/.test(v) ? v : null;
  }
  // Slashes in branch names must stay literal in ref URLs (feature/x), only each part is encoded.
  function encodeRef(b){ return b.split('/').map(encodeURIComponent).join('/'); }

  // The Git Data API refuses to work in a repository with no commits, so make one first.
  async function seedEmptyRepo(owner, repoName, branch){
    log('Repository is empty — creating a temporary first commit (GitHub needs one before the Git Data API works).', 'warn');
    const url = '/repos/' + owner + '/' + repoName + '/contents/' + SEED_PATH;
    const body = { message: 'Initialize repository (Zip2Git)', content: btoa('temporary file created by Zip2Git\n') };
    try{
      await githubFetch(url, 'PUT', Object.assign({ branch }, body), 2);
    }catch(err){
      if(err.status === 404 || err.status === 422) await githubFetch(url, 'PUT', body, 2);
      else throw err;
    }
  }

  async function resolveOwnerAndRepo(){
    log('Authenticating with GitHub...', 'info');
    const user = await githubFetch('/user', 'GET', null, 2);
    log('Authenticated as ' + user.login + '.', 'ok');
    let repoName = normalizeRepoInput();
    let owner = user.login;
    if(repoName.includes('/')){
      const parts = repoName.split('/');
      owner = parts[0];
      repoName = parts.slice(1).join('/');
    }
    return { owner, repoName, isOrg: owner.toLowerCase() !== user.login.toLowerCase() };
  }

  async function ensureRepoExists(owner, repoName, isOrg){
    if(state.repoMode === 'new'){
      const endpoint = isOrg ? '/orgs/' + owner + '/repos' : '/user/repos';
      log('Creating repository ' + owner + '/' + repoName + '...', 'info');
      try{
        const repo = await githubFetch(endpoint, 'POST', { name: repoName, private: state.visibility === 'private', auto_init: false });
        log('Repository created: ' + repo.full_name, 'ok');
        return repo;
      }catch(err){
        if(err.status === 422 && /already exists/i.test(errorText(err))){
          log('That repository already exists — continuing with it.', 'warn');
          return await githubFetch('/repos/' + owner + '/' + repoName);
        }
        throw err;
      }
    }
    log('Resolving repository ' + owner + '/' + repoName + '...', 'info');
    const repo = await githubFetch('/repos/' + owner + '/' + repoName);
    log('Found repository ' + repo.full_name + '.', 'ok');
    return repo;
  }

  async function getBaseRef(owner, repoName, branch){
    try{
      const ref = await githubFetch('/repos/' + owner + '/' + repoName + '/git/ref/heads/' + encodeRef(branch), 'GET', null, 2);
      const commit = await githubFetch('/repos/' + owner + '/' + repoName + '/git/commits/' + ref.object.sha, 'GET', null, 2);
      return { exists: true, commitSha: ref.object.sha, treeSha: commit.tree.sha };
    }catch(err){
      if(err.status === 404) return { exists: false };
      if(err.status === 409 && /empty/i.test(err.message)) return { exists: false, empty: true };
      throw err;
    }
  }

  async function createBlobs(owner, repoName, entries){
    const results = new Array(entries.length);
    let index = 0, completed = 0, aborted = false;
    const concurrency = Math.min(6, entries.length);
    async function worker(){
      while(index < entries.length && !aborted){
        const i = index++;
        const entry = entries[i];
        try{
          const base64 = arrayBufferToBase64(entry.data);
          const blob = await githubFetch('/repos/' + owner + '/' + repoName + '/git/blobs', 'POST', { content: base64, encoding: 'base64' }, 4);
          results[i] = { path: entry.path, mode: entry.mode || '100644', type: 'blob', sha: blob.sha };
        }catch(err){ aborted = true; throw err; }
        completed++;
        logProgress('Creating Git blobs (' + completed + '/' + entries.length + ')...');
      }
    }
    await Promise.all(new Array(concurrency).fill(0).map(worker));
    return results;
  }

  function describeError(err){
    if(err.status === 401) return 'GitHub rejected the token — check that it is valid and has not expired.';
    if(err.status === 403) return err.message || 'Forbidden — check the token scope or GitHub rate limits.';
    if(err.status === 404) return 'Repository or branch not found. Check the name, or switch to "Create New Repository".';
    if(err.status === 422) return errorText(err) || 'GitHub rejected the request — check the repository name and branch.';
    return err.message || 'An unexpected error occurred.';
  }

  function fireConfetti(){
    if(typeof confetti !== 'function') return;
    const colors = ['#00ff88', '#a855f7', '#3fffa8', '#c084fc'];
    confetti({ particleCount: 90, spread: 70, origin: { y: 0.6 }, colors });
    setTimeout(() => confetti({ particleCount: 55, angle: 60, spread: 55, origin: { x: 0 }, colors }), 200);
    setTimeout(() => confetti({ particleCount: 55, angle: 120, spread: 55, origin: { x: 1 }, colors }), 200);
  }

  function setPushingUI(isPushing){
    state.isPushing = isPushing;
    pushBtn.disabled = isPushing;
    window.onbeforeunload = isPushing ? (e) => { e.preventDefault(); e.returnValue = ''; return ''; } : null;
    pushBtnText.textContent = isPushing ? 'Pushing…' : 'Push to GitHub';
    pushBtnIcon.innerHTML = isPushing ? ICONS.spinner : ICONS.pushArrow;
    pushBtnIcon.classList.toggle('spin', isPushing);
  }

  function showError(title, sub){
    errorTitle.textContent = title;
    errorSub.textContent = sub || '';
    errorBanner.classList.add('show');
  }

  function validateBeforePush(){
    if(!patInput.value.trim()){ showError('Missing token', 'Paste a GitHub personal access token with repo scope in Step 1.'); return false; }
    if(!repoNameInput.value.trim()){ showError('Missing repository name', 'Enter a repository name in Step 1.'); return false; }
    if(!normalizeRepoInput()){ showError('Invalid repository name', 'Use letters, numbers, ".", "-" or "_" — optionally as owner/repo.'); return false; }
    if(!normalizeBranch()){ showError('Invalid branch name', 'Branch names cannot contain spaces or characters like ~ ^ : ? * [ \\ and cannot start or end with "/".'); return false; }
    if(state.files.filter((f) => f.checked).length === 0){ showError('Nothing selected', 'Upload a project in Step 2 and keep at least one file checked.'); return false; }
    return true;
  }

  async function pushToGithub(){
    if(state.isPushing) return;
    errorBanner.classList.remove('show');
    successBanner.classList.remove('show');
    if(!validateBeforePush()) return;

    const branch = normalizeBranch();
    const commitMessage = commitMsgInput.value.trim() || 'Initial commit via Zip2Git';
    const selectedEntries = state.files.filter((f) => f.checked);

    setPushingUI(true);
    log('Initializing Zip2Git push engine...', 'info');
    try{
      const { owner, repoName, isOrg } = await resolveOwnerAndRepo();
      const repo = await ensureRepoExists(owner, repoName, isOrg);
      const finalOwner = repo.owner ? repo.owner.login : owner;

      let baseRef = await getBaseRef(finalOwner, repoName, branch);
      let seeded = false;
      if(baseRef.empty){
        await seedEmptyRepo(finalOwner, repoName, branch);
        seeded = true;
        baseRef = await getBaseRef(finalOwner, repoName, branch);
        if(baseRef.empty) throw new Error('The repository still looks empty after creating the first commit — try again in a moment.');
        if(!baseRef.exists) log('Branch "' + branch + '" is separate from the default branch, which keeps a placeholder file named ' + SEED_PATH + '.', 'warn');
      }
      log(baseRef.exists ? 'Branch "' + branch + '" found — building on it.' : 'Branch "' + branch + '" not found — it will be created.', 'info');

      log('Reading ' + selectedEntries.length + ' selected files into memory...', 'info');
      const blobEntries = await createBlobs(finalOwner, repoName, selectedEntries);

      log('Building Git tree...', 'info');
      if(baseRef.exists && seeded && !blobEntries.some((e) => e.path === SEED_PATH)){
        blobEntries.push({ path: SEED_PATH, mode: '100644', type: 'blob', sha: null }); // remove the temporary file again
      }
      const treeBody = { tree: blobEntries };
      if(baseRef.exists) treeBody.base_tree = baseRef.treeSha;
      const newTree = await githubFetch('/repos/' + finalOwner + '/' + repoName + '/git/trees', 'POST', treeBody, 2);
      log('Tree created: ' + newTree.sha.slice(0, 7), 'ok');

      log('Creating commit...', 'info');
      const newCommit = await githubFetch('/repos/' + finalOwner + '/' + repoName + '/git/commits', 'POST', {
        message: commitMessage, tree: newTree.sha, parents: baseRef.exists ? [baseRef.commitSha] : []
      }, 2);
      log('Commit created: ' + newCommit.sha.slice(0, 7), 'ok');

      log('Updating branch reference...', 'info');
      if(baseRef.exists){
        await githubFetch('/repos/' + finalOwner + '/' + repoName + '/git/refs/heads/' + encodeRef(branch), 'PATCH', { sha: newCommit.sha, force: false });
      }else{
        await githubFetch('/repos/' + finalOwner + '/' + repoName + '/git/refs', 'POST', { ref: 'refs/heads/' + branch, sha: newCommit.sha });
      }

      log('Commit successful! Pushed to ' + finalOwner + '/' + repoName + '@' + branch + '.', 'ok');
      viewRepoLink.href = 'https://github.com/' + finalOwner + '/' + repoName + '/tree/' + branch;
      successSub.textContent = selectedEntries.length + ' files pushed to ' + finalOwner + '/' + repoName + '@' + branch + '.';
      successBanner.classList.add('show');
      fireConfetti();
    }catch(err){
      log('Push failed — ' + err.message, 'err');
      showError('Push failed', describeError(err));
    }finally{
      setPushingUI(false);
    }
  }

  pushBtn.addEventListener('click', pushToGithub);


  /* ============================================================
     INIT
  ============================================================ */
  loadStoredToken();
  setUploadMode('zip');
  updateStatsBar();
})();
