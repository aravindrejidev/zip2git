(function(){
  'use strict';

  /* ============================================================
     STATE
  ============================================================ */
  const state = {
    uploadMode: 'zip',        // 'zip' | 'folder'
    repoMode: 'existing',     // 'existing' | 'new'
    visibility: 'private',    // 'private' | 'public'
    files: [],                // flat list: {path, data(ArrayBuffer), size, checked}
    tree: null,               // nested tree built from files
    isPushing: false,
    dragDepth: 0
  };

  const TOKEN_KEY = 'zip2git_pat_v1';


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
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const chunkSize = 0x8000;
    for(let i = 0; i < bytes.length; i += chunkSize){
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
  }

  // Strips a single shared top-level folder from every path, if one exists
  // (e.g. GitHub zip exports wrap everything in "repo-main/", folder picks
  // wrap everything in the folder name). Keeps paths untouched otherwise.
  function stripCommonRoot(paths){
    if(paths.length === 0) return paths;
    const firstSegs = paths.map(p => p.split('/')[0]);
    const root = firstSegs[0];
    const allShareRoot = root && firstSegs.every(s => s === root) && paths.every(p => p.includes('/'));
    if(!allShareRoot) return paths;
    return paths.map(p => p.slice(root.length + 1));
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
        if(c.type === 'file'){ total++; if(c.ref.checked) checkedCount++; }
        else walk(c);
      });
    })(node);
    return { checked: total > 0 && checkedCount === total, indeterminate: checkedCount > 0 && checkedCount < total };
  }

  function renderNode(node){
    if(node.type === 'file'){
      return '<div class="tree-row" data-row-path="' + escapeHtml(node.path) + '">' +
        '<input type="checkbox" data-path="' + escapeHtml(node.path) + '"' + (node.ref.checked ? ' checked' : '') + '>' +
        '<span class="t-icon file">' + ICONS.file + '</span>' +
        '<span class="t-name">' + escapeHtml(node.name) + '</span>' +
        '<span class="t-size">' + formatBytes(node.size) + '</span></div>';
    }
    const kids = sortedChildren(node);
    const st = getFolderCheckState(node);
    const childrenHtml = kids.map(renderNode).join('');
    return '<div class="tree-row is-folder" data-row-path="' + escapeHtml(node.path) + '">' +
      '<input type="checkbox" data-folder-path="' + escapeHtml(node.path) + '"' + (st.checked ? ' checked' : '') + '>' +
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
      state.files.forEach((f) => { if(f.path === t.dataset.folderPath || f.path.startsWith(prefix)) f.checked = t.checked; });
      renderTree();
      updateStatsBar();
    }
  });

  selectAllBtn.addEventListener('click', () => { state.files.forEach((f) => f.checked = true); renderTree(); updateStatsBar(); });
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
    const strippedPaths = stripCommonRoot(rawEntries.map((e) => e.path));
    state.files = rawEntries.map((e, i) => ({ path: strippedPaths[i], data: e.data, size: e.size, checked: true }));
    state.tree = buildTree(state.files);
    renderTree();
    updateStatsBar();
    const totalSize = state.files.reduce((s, f) => s + f.size, 0);
    log('Extracted ' + state.files.length + ' files (' + formatBytes(totalSize) + ').', 'ok');
    successBanner.classList.remove('show');
    errorBanner.classList.remove('show');
  }

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
        entries.push({ path: name, data, size: data.byteLength });
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

  async function githubFetch(path, method, body){
    const res = await fetch(API_BASE + path, {
      method: method || 'GET',
      headers: Object.assign(
        { 'Authorization': 'Bearer ' + patInput.value.trim(), 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
        body ? { 'Content-Type': 'application/json' } : {}
      ),
      body: body ? JSON.stringify(body) : undefined
    });
    let json = null;
    try{ json = await res.json(); }catch(e){ /* empty body, fine */ }
    if(!res.ok){
      const err = new Error((json && json.message) || (res.status + ' ' + res.statusText));
      err.status = res.status;
      throw err;
    }
    return json;
  }

  async function resolveOwnerAndRepo(){
    log('Authenticating with GitHub...', 'info');
    const user = await githubFetch('/user');
    log('Authenticated as ' + user.login + '.', 'ok');
    let repoName = repoNameInput.value.trim();
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
        if(err.status === 422){
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
      const ref = await githubFetch('/repos/' + owner + '/' + repoName + '/git/ref/heads/' + encodeURIComponent(branch));
      const commit = await githubFetch('/repos/' + owner + '/' + repoName + '/git/commits/' + ref.object.sha);
      return { exists: true, commitSha: ref.object.sha, treeSha: commit.tree.sha };
    }catch(err){
      if(err.status === 404) return { exists: false };
      throw err;
    }
  }

  async function createBlobs(owner, repoName, entries){
    const results = new Array(entries.length);
    let index = 0, completed = 0;
    const concurrency = Math.min(6, entries.length);
    async function worker(){
      while(index < entries.length){
        const i = index++;
        const entry = entries[i];
        const base64 = arrayBufferToBase64(entry.data);
        const blob = await githubFetch('/repos/' + owner + '/' + repoName + '/git/blobs', 'POST', { content: base64, encoding: 'base64' });
        results[i] = { path: entry.path, mode: '100644', type: 'blob', sha: blob.sha };
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
    if(err.status === 422) return err.message || 'GitHub rejected the request — check the repository name and branch.';
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
    if(state.files.filter((f) => f.checked).length === 0){ showError('Nothing selected', 'Upload a project in Step 2 and keep at least one file checked.'); return false; }
    return true;
  }

  async function pushToGithub(){
    if(state.isPushing) return;
    errorBanner.classList.remove('show');
    successBanner.classList.remove('show');
    if(!validateBeforePush()) return;

    const branch = branchInput.value.trim() || 'main';
    const commitMessage = commitMsgInput.value.trim() || 'Initial commit via Zip2Git';
    const selectedEntries = state.files.filter((f) => f.checked);

    setPushingUI(true);
    log('Initializing Zip2Git push engine...', 'info');
    try{
      const { owner, repoName, isOrg } = await resolveOwnerAndRepo();
      const repo = await ensureRepoExists(owner, repoName, isOrg);
      const finalOwner = repo.owner ? repo.owner.login : owner;

      const baseRef = await getBaseRef(finalOwner, repoName, branch);
      log(baseRef.exists ? 'Branch "' + branch + '" found — building on it.' : 'Branch "' + branch + '" not found — it will be created.', 'info');

      log('Reading ' + selectedEntries.length + ' selected files into memory...', 'info');
      const blobEntries = await createBlobs(finalOwner, repoName, selectedEntries);

      log('Building Git tree...', 'info');
      const treeBody = { tree: blobEntries };
      if(baseRef.exists) treeBody.base_tree = baseRef.treeSha;
      const newTree = await githubFetch('/repos/' + finalOwner + '/' + repoName + '/git/trees', 'POST', treeBody);
      log('Tree created: ' + newTree.sha.slice(0, 7), 'ok');

      log('Creating commit...', 'info');
      const newCommit = await githubFetch('/repos/' + finalOwner + '/' + repoName + '/git/commits', 'POST', {
        message: commitMessage, tree: newTree.sha, parents: baseRef.exists ? [baseRef.commitSha] : []
      });
      log('Commit created: ' + newCommit.sha.slice(0, 7), 'ok');

      log('Updating branch reference...', 'info');
      if(baseRef.exists){
        await githubFetch('/repos/' + finalOwner + '/' + repoName + '/git/refs/heads/' + encodeURIComponent(branch), 'PATCH', { sha: newCommit.sha, force: false });
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
