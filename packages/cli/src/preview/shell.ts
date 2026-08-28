import {
  READY_CHECK_MESSAGE_KIND,
  READY_CHECK_MESSAGE_SOURCE,
  READY_MESSAGE_REPEAT_COUNT,
  READY_MESSAGE_REPEAT_INTERVAL_MS,
} from '@artifactshare/viewer-kit/csp-reporter'
import type { PREVIEW_MESSAGES } from './messages.generated.js'

export interface PreviewShellOptions {
  fileName: string
  /** The command that restarts this exact preview, shown when it ends. */
  resumeCommand: string
  shareOrigin: string
  /** Both locale dictionaries; the client picks by navigator.language. */
  messages: typeof PREVIEW_MESSAGES
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/** Serialise for embedding inside a <script> block. */
function scriptJson(value: unknown): string {
  return JSON.stringify(value).replaceAll('<', '\\u003c')
}

export function renderPreviewShell(options: PreviewShellOptions): string {
  const { fileName, resumeCommand, shareOrigin, messages } = options
  const config = scriptJson({
    fileName,
    resumeCommand,
    shareOrigin,
    messages,
    readySource: READY_CHECK_MESSAGE_SOURCE,
    readyKind: READY_CHECK_MESSAGE_KIND,
    readyRepeat: READY_MESSAGE_REPEAT_COUNT,
    readyIntervalMs: READY_MESSAGE_REPEAT_INTERVAL_MS,
  })

  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(fileName)} - as preview</title>
<style>
  :root {
    --background: #ffffff; --surface-warm: #fbfaf8; --foreground: #37352f;
    --muted-foreground: rgba(55,53,47,0.86); --faint: rgba(55,53,47,0.45);
    --border: rgba(55,53,47,0.1); --border-strong: rgba(55,53,47,0.22);
    --accent: rgba(55,53,47,0.04); --link: #116bb1; --primary: #1766ad;
    --coral: #ff6f61; --pending: #e07b00; --success: #1a7f4b; --card: #ffffff;
    --r-sm: 4px; --r-md: 6px; --r-lg: 8px; --r-full: 9999px;
    --shadow-md: rgba(15,15,15,0.05) 0 0 0 1px, rgba(15,15,15,0.1) 0 3px 6px;
    --shadow-lg: rgba(15,15,15,0.05) 0 0 0 1px, rgba(15,15,15,0.1) 0 8px 24px;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --background: #111315; --surface-warm: #0e1012; --foreground: #e7e2d8;
      --muted-foreground: rgba(231,226,216,0.77); --faint: rgba(231,226,216,0.4);
      --border: rgba(231,226,216,0.13); --border-strong: rgba(231,226,216,0.28);
      --accent: rgba(231,226,216,0.07); --link: #7db7ff; --primary: #7db7ff; --card: #191c1f;
      --shadow-md: rgba(0,0,0,0.4) 0 0 0 1px, rgba(0,0,0,0.5) 0 3px 6px;
      --shadow-lg: rgba(0,0,0,0.4) 0 0 0 1px, rgba(0,0,0,0.5) 0 8px 24px;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--surface-warm); color: var(--foreground);
    font-family: ui-sans-serif, -apple-system, "Segoe UI", "Hiragino Sans", sans-serif;
    font-size: 14px; line-height: 1.5; }
  .topbar { display: flex; align-items: center; gap: 10px; height: 46px; padding: 0 14px;
    background: var(--background); border-bottom: 1px solid var(--border);
    position: sticky; top: 0; z-index: 40; }
  .brand { width: 20px; height: 20px; border-radius: 5px; background: var(--coral);
    color: #fff; font-weight: 700; font-size: 11px; display: grid; place-items: center; }
  .file-name { font-weight: 600; font-size: 13px; }
  .local-badge { font-size: 11px; color: var(--muted-foreground);
    border: 1px solid var(--border); border-radius: var(--r-full);
    padding: 1px 8px; background: var(--accent); }
  .watch-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--success);
    display: inline-block; margin-right: 5px; animation: pulse 2s infinite; }
  @keyframes pulse { 50% { opacity: 0.35; } }
  .topbar .spacer { flex: 1; }
  .btn { font: inherit; font-size: 13px; cursor: pointer; border: 1px solid var(--border);
    border-radius: var(--r-md); background: var(--background); color: var(--foreground);
    padding: 5px 12px; }
  .btn:hover { background: var(--accent); }
  .btn-primary { background: var(--primary); border-color: var(--primary); color: #fff; }
  .layout { display: flex; height: calc(100vh - 46px); }
  .doc-wrap { flex: 1; display: flex; position: relative; }
  #artifactFrame { flex: 1; width: 100%; height: 100%; border: 0; background: var(--background); }
  .mode-toggle { font: inherit; color: inherit; border: 0; position: fixed; right: 320px; bottom: 20px; z-index: 60;
    display: flex; align-items: center; gap: 8px; background: var(--card);
    border-radius: var(--r-full); box-shadow: var(--shadow-lg);
    padding: 8px 14px 8px 10px; cursor: pointer; user-select: none; font-size: 13px; }
  .mode-toggle .knob { display: block; width: 30px; height: 18px; border-radius: var(--r-full);
    background: var(--border-strong); position: relative; transition: background .15s; }
  .mode-toggle .knob::after { content: ""; position: absolute; top: 2px; left: 2px;
    width: 14px; height: 14px; border-radius: 50%; background: #fff; transition: transform .15s; }
  body.annotate .mode-toggle .knob { background: var(--link); }
  body.annotate .mode-toggle .knob::after { transform: translateX(12px); }
  .mode-toggle .count { background: var(--pending); color: #fff; border-radius: var(--r-full);
    font-size: 11px; min-width: 18px; height: 18px; display: none; place-items: center; padding: 0 5px; }
  .mode-toggle .count.show { display: grid; }
  .popover { position: fixed; z-index: 50; width: min(300px, 80vw);
    background: var(--card); border-radius: var(--r-lg); box-shadow: var(--shadow-lg);
    padding: 10px; display: none; }
  .popover.show { display: block; }
  .popover .target-label { font-size: 11px; color: var(--faint); margin-bottom: 6px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .popover textarea { width: 100%; border: 1px solid var(--border);
    border-radius: var(--r-md); font: inherit; font-size: 13px; padding: 7px 9px;
    resize: none; background: var(--background); color: var(--foreground); }
  .popover textarea:focus { outline: 2px solid var(--link); outline-offset: -1px; }
  .popover .row { display: flex; justify-content: flex-end; gap: 6px; margin-top: 8px; }
  .panel { width: 300px; border-left: 1px solid var(--border); background: var(--background);
    padding: 14px; display: flex; flex-direction: column; gap: 10px; overflow-y: auto; }
  .panel h2 { font-size: 12px; margin: 0; color: var(--muted-foreground); font-weight: 600; }
  .thread { border: 1px solid var(--border); border-radius: var(--r-lg); padding: 10px;
    font-size: 12.5px; cursor: pointer; }
  .thread:hover { border-color: var(--border-strong); }
  .thread .head { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; }
  .thread .num { width: 17px; height: 17px; border-radius: 50%; background: var(--pending);
    color: #fff; font-size: 10px; font-weight: 700; display: grid; place-items: center; flex: none; }
  .thread.working .num { background: var(--link); }
  .thread.resolved .num { background: var(--success); }
  .thread.dismissed .num { background: var(--faint); }
  .thread .state { font-size: 11px; color: var(--faint); margin-left: auto; flex: none; }
  .thread .anchor-label { color: var(--faint); font-size: 11px; overflow: hidden;
    text-overflow: ellipsis; white-space: nowrap; }
  .thread .msg { margin: 4px 0 0; }
  .thread .msg.agent { color: var(--muted-foreground); border-left: 2px solid var(--border);
    padding-left: 8px; margin-top: 8px; }
  .thread .msg .who { font-weight: 600; font-size: 11px; display: block; color: var(--faint); }
  .thread .draft-del, .thread .reopen-btn { margin-left: 6px; background: none; border: none;
    cursor: pointer; color: var(--faint); font-size: 12px; padding: 0 2px; flex: none; }
  .thread .draft-del:hover, .thread .reopen-btn:hover { color: var(--foreground); }
  .thread.orphaned .anchor-label { text-decoration: line-through; }
  .panel .empty { color: var(--faint); font-size: 12.5px; padding: 20px 4px; text-align: center; }
  .submit-bar { display: none; align-items: center; gap: 8px; }
  .submit-bar.show { display: flex; }
  .submit-bar .btn { white-space: nowrap; }
  .submit-bar .btn-primary { flex: 1; min-width: 0; }
  .batch-status { display: none; align-items: center; gap: 8px; font-size: 12.5px;
    color: var(--muted-foreground); background: var(--surface-warm);
    border-radius: var(--r-md); padding: 8px 10px; }
  .batch-status.show { display: flex; }
  .batch-status .spin { width: 12px; height: 12px; border-radius: 50%; flex: none;
    border: 2px solid var(--link); border-top-color: transparent;
    animation: spin .8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .elapsed { font-variant-numeric: tabular-nums; }
  .toast { position: fixed; left: 50%; bottom: 70px; transform: translateX(-50%);
    background: var(--foreground); color: var(--background); font-size: 12.5px;
    border-radius: var(--r-full); padding: 8px 16px; z-index: 90;
    box-shadow: var(--shadow-lg); opacity: 0; transition: opacity .25s; pointer-events: none; }
  .toast.show { opacity: 1; }
  .notice { position: fixed; top: 56px; left: 50%; transform: translateX(-50%);
    background: var(--card); border-radius: var(--r-lg); box-shadow: var(--shadow-lg);
    padding: 10px 14px; z-index: 70; display: none; align-items: center; gap: 10px;
    font-size: 12.5px; max-width: min(480px, calc(100vw - 24px)); }
  .notice.show { display: flex; }
  .ended { position: fixed; inset: 0; background: var(--surface-warm); z-index: 100;
    display: none; place-items: center; text-align: center; }
  .ended.show { display: grid; }
  .ended .box { max-width: 420px; padding: 24px; }
  .ended h3 { font-size: 16px; margin: 12px 0 8px; }
  .ended p { font-size: 13px; color: var(--muted-foreground); margin: 0 0 16px; }
  /* The command carries a full path, so it gets its own block and breaks on
     any character rather than fragmenting the sentence across lines. */
  .ended code { display: block; margin-top: 10px; text-align: left;
    background: var(--accent); border-radius: var(--r-sm); padding: 8px 10px;
    font-size: 12px; line-height: 1.6; overflow-wrap: anywhere; }
  @media (max-width: 860px) {
    .layout { display: block; height: auto; }
    .doc-wrap { height: calc(100vh - 46px - min(42vh, 340px)); }
    .panel { position: fixed; left: 0; right: 0; bottom: 0; width: auto;
      height: min(42vh, 340px); overflow-y: auto;
      border-left: none; border-top: 1px solid var(--border);
      box-shadow: var(--shadow-lg); z-index: 55; border-radius: 12px 12px 0 0; }
    .local-badge { display: none; }
    .watch-label { display: none; }
    .mode-toggle { right: 20px; bottom: calc(min(42vh, 340px) + 14px); }
    .toast { bottom: calc(min(42vh, 340px) + 60px); }
  }
</style>
</head>
<body class="annotate">
<header class="topbar">
  <div class="brand">as</div>
  <span class="file-name">${escapeHtml(fileName)}</span>
  <span class="local-badge" data-msg="preview.localBadge"></span>
  <span style="font-size:12px;color:var(--muted-foreground)"><span class="watch-dot"></span><span class="watch-label" data-msg="preview.watching"></span></span>
  <div class="spacer"></div>
  <button class="btn btn-primary" id="shareBtn" data-msg="preview.share"></button>
</header>
<div class="layout">
  <div class="doc-wrap">
    <iframe id="artifactFrame" src="/artifact" title="${escapeHtml(fileName)}"></iframe>
  </div>
  <aside class="panel">
    <h2 data-msg="preview.panelTitle"></h2>
    <div class="submit-bar" id="submitBar">
      <button class="btn btn-primary" id="submitBtn"></button>
      <button class="btn" id="discardAll" data-msg="preview.discardDrafts"></button>
    </div>
    <div class="batch-status" id="batchStatus">
      <span class="spin"></span>
      <span id="batchText"></span>
    </div>
    <div class="empty" id="panelEmpty" data-msg="preview.emptyHint"></div>
    <div id="threads"></div>
  </aside>
</div>
<button type="button" class="mode-toggle" id="modeToggle" role="switch" aria-checked="true">
  <span class="knob"></span>
  <span id="modeLabel" data-msg="preview.annotateMode"></span>
  <span class="count" id="pendingCount">0</span>
</button>
<div class="popover" id="popover">
  <div class="target-label" id="popTarget"></div>
  <textarea id="popText" rows="2"></textarea>
  <div class="row">
    <button class="btn" id="popCancel" data-msg="preview.cancel"></button>
    <button class="btn btn-primary" id="popAdd" data-msg="preview.add"></button>
  </div>
</div>
<div class="toast" id="toast"></div>
<div class="notice" id="orphanNotice">
  <span id="orphanText"></span>
  <button class="btn" id="orphanDiscard" data-msg="preview.orphanDiscard"></button>
  <button class="btn" id="orphanKeep" data-msg="preview.orphanKeep"></button>
</div>
<div class="ended" id="endedScreen">
  <div class="box">
    <div class="brand" style="margin:0 auto">as</div>
    <h3 data-msg="preview.ended.title"></h3>
    <p id="endedBody"></p>
  </div>
</div>
<script>
(() => {
  const CONFIG = ${config};
  const MUTATION_HEADER = ${scriptJson('x-artifactshare-preview')};
  const locale = (navigator.language || 'en').toLowerCase().startsWith('ja') ? 'ja' : 'en';
  const dict = CONFIG.messages[locale] || CONFIG.messages.en;
  // The document is authored as Japanese; an English UI must say so, or a
  // screen reader pronounces it with Japanese rules.
  document.documentElement.lang = locale;
  function t(key, params) {
    let text = dict[key] || CONFIG.messages.en[key] || key;
    if (params) {
      for (const name of Object.keys(params)) {
        text = text.split('{' + name + '}').join(String(params[name]));
      }
    }
    return text;
  }
  function tCount(base, n) {
    return t(n === 1 ? base + 'One' : base + 'Other', { n });
  }
  document.querySelectorAll('[data-msg]').forEach((el) => {
    el.textContent = t(el.getAttribute('data-msg'));
  });

  const frame = document.getElementById('artifactFrame');

  // Saved annotations can outlive edits made while the preview was stopped, so
  // reconcile once the first frame is ready rather than waiting for a save.
  frame.addEventListener('load', function onFirstLoad() {
    frame.removeEventListener('load', onFirstLoad);
    setTimeout(checkOrphans, 400);
  });  const body = document.body;
  const popover = document.getElementById('popover');
  const popTarget = document.getElementById('popTarget');
  const popText = document.getElementById('popText');
  popText.placeholder = t('preview.inputPlaceholder');
  const threadsEl = document.getElementById('threads');
  const panelEmpty = document.getElementById('panelEmpty');
  const pendingCount = document.getElementById('pendingCount');
  const submitBar = document.getElementById('submitBar');
  const submitBtn = document.getElementById('submitBtn');
  const batchStatus = document.getElementById('batchStatus');
  const batchText = document.getElementById('batchText');
  const endedBody = document.getElementById('endedBody');
  endedBody.innerHTML = t('preview.ended.body', { command: '__CMD__' })
    .replace('__CMD__', '<code></code>');
  endedBody.querySelector('code').textContent = CONFIG.resumeCommand;

  let annotations = [];
  let pendingAnchor = null;
  let annotateMode = true;
  let revision = null;
  let pendingReload = null;
  let orphanedThreads = new Set();
  let batchTimer = null;
  let batchStartedAt = null;
  let batchWorkingCount = 0;
  function renderBatchStatus() {
    batchText.textContent = tCount('preview.batchWorking', batchWorkingCount)
      + ' · ' + t('preview.elapsed', { time: fmtElapsed(Date.now() - batchStartedAt) });
  }
  let ended = false;

  // --- iframe protocol ----------------------------------------------------
  function postToFrame(message) {
    try {
      frame.contentWindow.postMessage(
        Object.assign({ source: CONFIG.readySource }, message), '*');
    } catch (error) {}
  }
  function readyPayload() {
    return {
      kind: CONFIG.readyKind,
      challenge: String(Math.random()).slice(2) + String(Date.now()),
      textAnchorsEnabled: true,
      commentLabels: {},
    };
  }
  let readyBurstTimer = null;
  function startReadyBurst() {
    if (readyBurstTimer) clearInterval(readyBurstTimer);
    let sent = 0;
    const payload = readyPayload();
    postToFrame(payload);
    postToFrame({ kind: 'annotate-mode', enabled: annotateMode });
    readyBurstTimer = setInterval(() => {
      sent += 1;
      if (sent >= CONFIG.readyRepeat) {
        clearInterval(readyBurstTimer);
        readyBurstTimer = null;
        return;
      }
      postToFrame(payload);
      postToFrame({ kind: 'annotate-mode', enabled: annotateMode });
    }, CONFIG.readyIntervalMs);
  }

  window.addEventListener('message', (event) => {
    // The share dialog runs on its own origin and may only report that the
    // share finished; everything else must come from the artifact frame.
    const data = event.data || {};
    if (data.source === 'artifactshare-preview-share') {
      if (event.origin !== CONFIG.shareOrigin) return;
      // "Preview ended" has to be true for the agent too: without the stop,
      // the process keeps serving and pending next polls never receive
      // session_ended.
      if (data.kind === 'share-finished') {
        showEnded();
        api('POST', '/api/agent/stop');
      }
      return;
    }
    // Only the artifact frame may drive the annotation UI. Without the source
    // check any page that opens this port can post a crafted element-annotate
    // and steer what the user is about to write into the store.
    if (event.source !== frame.contentWindow) return;
    if (event.origin !== window.location.origin) return;
    if (data.source !== 'artifactshare') return;
    if (data.kind === 'element-annotate') {
      openPopover({
        kind: 'element', state: 'attached',
        selector: data.selector, label: data.label, contextText: data.contextText,
      }, data.label, data.rect);
    } else if (data.kind === 'text-selection') {
      // The reporter keeps emitting selections so normal reading still works;
      // only annotation mode turns one into a comment.
      if (!annotateMode) return;
      openPopover({
        kind: 'text', state: 'attached',
        quotedText: data.quotedText, prefixText: data.prefixText,
        suffixText: data.suffixText, textStart: data.textStart,
        textEnd: data.textEnd, cssPath: data.cssPath,
      }, data.quotedText, data.rect);
    }
  });

  // --- popover ------------------------------------------------------------
  function openPopover(anchor, label, rect) {
    pendingAnchor = anchor;
    popTarget.textContent = label;
    const frameRect = frame.getBoundingClientRect();
    const left = Math.max(8, Math.min(
      frameRect.left + (rect ? rect.left : 40) + 20,
      window.innerWidth - 320));
    const top = Math.max(52, Math.min(
      frameRect.top + (rect ? rect.top + rect.height : 60) + 8,
      window.innerHeight - 140));
    popover.style.left = left + 'px';
    popover.style.top = top + 'px';
    popover.classList.add('show');
    popText.value = '';
    popText.focus();
  }
  function hidePopover() {
    popover.classList.remove('show');
    pendingAnchor = null;
    if (pendingReload !== null) {
      const target = pendingReload;
      pendingReload = null;
      reloadFrame(target);
    }
  }
  document.getElementById('popCancel').addEventListener('click', hidePopover);
  popText.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) addAnnotation();
    if (event.key === 'Escape') hidePopover();
  });
  document.getElementById('popAdd').addEventListener('click', addAnnotation);
  async function addAnnotation() {
    const comment = popText.value.trim();
    if (!comment || !pendingAnchor) return;
    await api('POST', '/api/annotations', { anchor: pendingAnchor, comment });
    hidePopover();
  }

  // --- API ----------------------------------------------------------------
  async function api(method, path, bodyValue) {
    const headers = { 'content-type': 'application/json' };
    headers[MUTATION_HEADER] = '1';
    try {
      const response = await fetch(path, {
        method,
        headers,
        body: bodyValue === undefined ? '{}' : JSON.stringify(bodyValue),
      });
      return await response.json().catch(() => null);
    } catch (error) {
      return null;
    }
  }

  // --- panel rendering ----------------------------------------------------
  function anchorLabel(anchor) {
    if (!anchor) return '';
    if (anchor.kind === 'element') return anchor.label;
    if (anchor.kind === 'text') return '"' + anchor.quotedText + '"';
    return CONFIG.fileName;
  }
  function stateLabel(status) {
    if (status === 'draft') return t('preview.stateDraft');
    if (status === 'requested') return t('preview.stateQueued');
    if (status === 'in_progress') return t('preview.stateWorking');
    if (status === 'resolved') return t('preview.stateResolved');
    return t('preview.stateDismissed');
  }
  function renderPanel() {
    threadsEl.textContent = '';
    const ordered = annotations.slice().reverse();
    ordered.forEach((annotation, index) => {
      const thread = document.createElement('div');
      thread.className = 'thread';
      if (annotation.status === 'in_progress') thread.classList.add('working');
      if (annotation.status === 'resolved') thread.classList.add('resolved');
      if (annotation.status === 'dismissed') thread.classList.add('dismissed');
      if (orphanedThreads.has(annotation.thread)) thread.classList.add('orphaned');
      const head = document.createElement('div');
      head.className = 'head';
      const num = document.createElement('span');
      num.className = 'num';
      num.textContent = String(annotations.length - index);
      const label = document.createElement('span');
      label.className = 'anchor-label';
      label.textContent = anchorLabel(annotation.anchor);
      const state = document.createElement('span');
      state.className = 'state';
      state.textContent = stateLabel(annotation.status);
      head.append(num, label, state);
      if (annotation.status === 'draft') {
        const del = document.createElement('button');
        del.className = 'draft-del';
        del.textContent = t('preview.delete');
        del.addEventListener('click', (event) => {
          event.stopPropagation();
          api('DELETE', '/api/annotations/' + encodeURIComponent(annotation.thread));
        });
        head.appendChild(del);
      }
      if (annotation.status === 'resolved' || annotation.status === 'dismissed') {
        const reopen = document.createElement('button');
        reopen.className = 'reopen-btn';
        reopen.textContent = t('preview.reopen');
        reopen.title = t('preview.reopenNote');
        reopen.addEventListener('click', (event) => {
          event.stopPropagation();
          api('POST', '/api/annotations/' + encodeURIComponent(annotation.thread) + '/reopen');
        });
        head.appendChild(reopen);
      }
      thread.appendChild(head);
      (annotation.messages || []).forEach((message) => {
        const msg = document.createElement('div');
        msg.className = message.author === 'agent' ? 'msg agent' : 'msg';
        const who = document.createElement('span');
        who.className = 'who';
        who.textContent = message.author === 'agent' ? t('preview.agentName') : t('preview.you');
        msg.append(who, document.createTextNode(message.body));
        thread.appendChild(msg);
      });
      thread.addEventListener('click', () => {
        if (annotation.anchor && annotation.anchor.kind === 'element') {
          postToFrame({ kind: 'element-ping', selector: annotation.anchor.selector });
        }
      });
      threadsEl.appendChild(thread);
    });
    panelEmpty.style.display = annotations.length === 0 ? '' : 'none';
    const drafts = annotations.filter((entry) => entry.status === 'draft');
    submitBtn.textContent = tCount('preview.requestFixes', drafts.length);
    submitBar.classList.toggle('show', drafts.length > 0);
    const open = annotations.filter(
      (entry) => entry.status !== 'resolved' && entry.status !== 'dismissed');
    pendingCount.textContent = String(open.length);
    pendingCount.classList.toggle('show', open.length > 0);
    updateBatchStatus();
  }

  // --- batch status -------------------------------------------------------
  function fmtElapsed(ms) {
    const total = Math.floor(ms / 1000);
    return Math.floor(total / 60) + ':' + String(total % 60).padStart(2, '0');
  }
  function updateBatchStatus() {
    const working = annotations.filter(
      (entry) => entry.status === 'requested' || entry.status === 'in_progress');
    if (working.length === 0) {
      batchStatus.classList.remove('show');
      if (batchTimer) { clearInterval(batchTimer); batchTimer = null; }
      batchStartedAt = null;
      return;
    }
    if (batchStartedAt === null) batchStartedAt = Date.now();
    batchStatus.classList.add('show');
    // A batch submitted while another is still running changes the count, so
    // the ticking timer must read it rather than the value it was created with.
    batchWorkingCount = working.length;
    renderBatchStatus();
    if (!batchTimer) batchTimer = setInterval(renderBatchStatus, 1000);
  }

  submitBtn.addEventListener('click', () => { api('POST', '/api/annotations/submit'); });
  document.getElementById('discardAll').addEventListener('click', () => {
    api('POST', '/api/annotations/discard-drafts');
  });

  // --- annotate mode toggle -----------------------------------------------
  const modeToggle = document.getElementById('modeToggle');
  modeToggle.addEventListener('click', () => {
    annotateMode = !annotateMode;
    body.classList.toggle('annotate', annotateMode);
    modeToggle.setAttribute('aria-checked', String(annotateMode));
    postToFrame({ kind: 'annotate-mode', enabled: annotateMode });
    hidePopover();
  });

  // --- reload + orphan handling ------------------------------------------
  function reloadFrame(nextRevision) {
    let scrollY = 0;
    try { scrollY = frame.contentWindow.scrollY || 0; } catch (error) {}
    const restore = () => {
      try { frame.contentWindow.scrollTo(0, scrollY); } catch (error) {}
      startReadyBurst();
      setTimeout(checkOrphans, 400);
      frame.removeEventListener('load', restore);
    };
    frame.addEventListener('load', restore);
    frame.src = '/artifact?rev=' + encodeURIComponent(nextRevision || '');
  }

  function checkOrphans() {
    // Same-origin iframe: verify element/text anchors directly against the
    // reloaded DOM, then persist the verdict so the next agent batch can
    // tell which anchors lost their target.
    let doc = null;
    try { doc = frame.contentWindow.document; } catch (error) { return; }
    if (!doc) return;
    const newlyOrphaned = [];
    const states = [];
    annotations.forEach((annotation) => {
      if (annotation.status === 'resolved' || annotation.status === 'dismissed') return;
      const anchor = annotation.anchor;
      if (!anchor || anchor.kind === 'artifact') return;
      let found = true;
      if (anchor.kind === 'element') {
        try { found = Boolean(doc.querySelector(anchor.selector)); }
        catch (error) { found = false; }
      } else if (anchor.kind === 'text') {
        const text = (doc.body && doc.body.innerText) || '';
        found = anchor.quotedText !== '' && text.indexOf(anchor.quotedText) !== -1;
      }
      if (!found && !orphanedThreads.has(annotation.thread)) {
        newlyOrphaned.push(annotation.thread);
      }
      if (!found) orphanedThreads.add(annotation.thread);
      else orphanedThreads.delete(annotation.thread);
      const nextState = found ? 'attached' : 'orphaned';
      if (anchor.state !== nextState) {
        states.push({ thread: annotation.thread, state: nextState });
      }
    });
    if (states.length > 0) {
      api('POST', '/api/annotations/anchor-state', { states });
    }
    renderPanel();
    if (newlyOrphaned.length > 0) {
      document.getElementById('orphanText').textContent =
        tCount('preview.orphanNotice', orphanedThreads.size);
      // The corruption notice borrows this element and hides the button; an
      // orphan notice always offers discarding.
      document.getElementById('orphanDiscard').style.display = '';
      document.getElementById('orphanNotice').classList.add('show');
    }
  }
  document.getElementById('orphanDiscard').addEventListener('click', async () => {
    const threads = Array.from(orphanedThreads);
    const result = await api('POST', '/api/annotations/orphan-discard', { threads });
    // The server keeps threads the agent is still working on. Forgetting them
    // here would drop their orphan mark while the fix is still in flight.
    const kept = ((result && result.results) || [])
      .filter((entry) => !entry.discarded)
      .map((entry) => entry.thread);
    orphanedThreads = new Set(kept);
    document.getElementById('orphanNotice').classList.remove('show');
    renderPanel();
  });
  document.getElementById('orphanKeep').addEventListener('click', () => {
    document.getElementById('orphanNotice').classList.remove('show');
  });

  // --- toast + title badge ------------------------------------------------
  const baseTitle = document.title;
  let toastTimer = null;
  function showToast(text) {
    const toast = document.getElementById('toast');
    toast.textContent = text;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 4000);
  }
  function setTitleBadge(n) {
    document.title = n > 0 ? '(' + n + ') ' + baseTitle : baseTitle;
  }

  // --- SSE ----------------------------------------------------------------
  const events = new EventSource('/events');
  events.addEventListener('annotations', (event) => {
    try { annotations = JSON.parse(event.data).annotations || []; }
    catch (error) { return; }
    renderPanel();
  });
  events.addEventListener('reload', (event) => {
    let data = null;
    try { data = JSON.parse(event.data); } catch (error) { return; }
    revision = data.revision;
    if (popover.classList.contains('show')) {
      pendingReload = revision;
    } else {
      reloadFrame(revision);
    }
  });
  events.addEventListener('done', (event) => {
    let data = null;
    try { data = JSON.parse(event.data); } catch (error) { return; }
    const threads = data.threads || [];
    threads.forEach((item) => {
      if (item.selector) postToFrame({ kind: 'element-flash', selector: item.selector });
    });
    showToast(tCount('preview.resolvedToast', threads.length));
    setTitleBadge(threads.length);
    setTimeout(() => setTitleBadge(0), 5000);
  });
  events.addEventListener('session-ended', () => { showEnded(); });
  events.onerror = () => {
    if (ended) return;
    fetch('/__preview/session', { cache: 'no-store' })
      .then((response) => { if (!response.ok) showEnded(); })
      .catch(() => showEnded());
  };
  function showEnded() {
    if (ended) return;
    ended = true;
    events.close();
    document.getElementById('endedScreen').classList.add('show');
  }

  // --- share --------------------------------------------------------------
  document.getElementById('shareBtn').addEventListener('click', () => {
    window.open(CONFIG.shareOrigin + '/', 'as-preview-share', 'width=440,height=560');
  });

  // --- boot ---------------------------------------------------------------
  frame.addEventListener('load', () => { startReadyBurst(); });
  fetch('/api/annotations', { cache: 'no-store' })
    .then((response) => response.json())
    .then((data) => {
      annotations = (data && data.annotations) || [];
      revision = data ? data.revision : null;
      renderPanel();
      if (data && data.quarantined) {
        // The saved annotations could not be read; say so, or the empty panel
        // reads as "my work was never saved".
        const notice = document.getElementById('orphanNotice');
        document.getElementById('orphanText').textContent = t('preview.corruptNotice');
        // Nothing readable is left to discard, so the button is hidden here.
        document.getElementById('orphanDiscard').style.display = 'none';
        document.getElementById('orphanKeep').textContent = t('preview.orphanKeep');
        notice.classList.add('show');
      }
    })
    .catch(() => {});
})();
</script>
</body>
</html>`
}
