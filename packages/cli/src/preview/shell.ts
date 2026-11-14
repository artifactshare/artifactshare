import {
  READY_CHECK_MESSAGE_KIND,
  READY_CHECK_MESSAGE_SOURCE,
  READY_MESSAGE_REPEAT_COUNT,
  READY_MESSAGE_REPEAT_INTERVAL_MS,
} from '@artifactshare/viewer-kit/csp-reporter'
import { validPreviewObservation } from './reporter-protocol.js'
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
  const extensionAt = fileName.lastIndexOf('.')
  const stem = extensionAt > 0 ? fileName.slice(0, extensionAt) : fileName
  const extension = extensionAt > 0 ? fileName.slice(extensionAt) : ''
  const isMarkdown = /\.(md|markdown)$/i.test(fileName)
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
<meta name="referrer" content="no-referrer">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(fileName)} - as preview</title>
<style>
  :root {
    --background: #ffffff; --surface-warm: #fbfaf8; --foreground: #37352f;
    --muted-foreground: rgba(55,53,47,0.86); --faint: rgba(55,53,47,0.45);
    --border: rgba(55,53,47,0.1); --border-strong: rgba(55,53,47,0.22);
    --accent: rgba(55,53,47,0.04); --link: #116bb1; --primary: #1766ad;
    --coral: #ff6f61; --pending: #e07b00; --success: #1a7f4b; --card: #ffffff;
    --badge-on-link: #ffffff; --badge-on-dismissed: #37352f;
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
      --badge-on-link: #111315; --badge-on-dismissed: #ffffff;
      --shadow-md: rgba(0,0,0,0.4) 0 0 0 1px, rgba(0,0,0,0.5) 0 3px 6px;
      --shadow-lg: rgba(0,0,0,0.4) 0 0 0 1px, rgba(0,0,0,0.5) 0 8px 24px;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--surface-warm); color: var(--foreground);
    font-family: ui-sans-serif, -apple-system, "Segoe UI", "Hiragino Sans", sans-serif;
    font-size: 14px; line-height: 1.5; }
  html[lang="ja"] body { line-break: strict; word-break: auto-phrase; }
  .topbar { display: flex; align-items: center; gap: 10px; height: 46px; padding: 0 14px;
    background: var(--background); border-bottom: 1px solid var(--border);
    position: sticky; top: 0; z-index: 40; }
  .brand { width: 20px; height: 20px; border-radius: 5px; background: var(--coral);
    color: #fff; font-weight: 700; font-size: 11px; display: grid; place-items: center; }
  .topbar > :not(.file-name):not(.spacer) { flex-shrink: 0; white-space: nowrap; }
  .file-name { display: flex; font-weight: 600; font-size: 13px; min-width: 0;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .file-stem { overflow: hidden; text-overflow: ellipsis; }
  .file-extension { flex-shrink: 0; }
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
  .btn-primary { background: var(--primary); border-color: var(--primary); color: var(--badge-on-link); }
  .btn-primary:not(:disabled):hover, .btn-primary:not(:disabled):focus { background: var(--primary); }
  .btn:disabled { cursor: default; opacity: 0.5; }
  .btn-primary:disabled:hover { background: var(--primary); }
  .layout { display: flex; height: calc(100vh - 46px); }
  .doc-wrap { flex: 1; display: flex; position: relative; }
  #artifactFrame { flex: 1; width: 100%; height: 100%; border: 0; background: #ffffff;${isMarkdown ? '' : ' color-scheme: light;'} }
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
  .mode-toggle .count { background: var(--pending); color: #2a1800; border-radius: var(--r-full);
    font-size: 11px; min-width: 18px; height: 18px; display: none; place-items: center; padding: 0 5px; }
  .mode-toggle .count.show { display: grid; }
  .mode-hint { position: fixed; right: 320px; bottom: 64px; z-index: 60; display: none;
    font-size: 12px; color: var(--muted-foreground); background: var(--card);
    border-radius: var(--r-full); box-shadow: var(--shadow-lg); padding: 4px 12px; }
  body.annotate .mode-hint { display: block; }
  /* Touch and narrow layouts have no Alt key; they use the switch. */
  @media (hover: none), (max-width: 860px) { body.annotate .mode-hint { display: none; } }
  .popover { position: fixed; z-index: 80; width: min(300px, calc(100vw - 16px));
    background: var(--card); border-radius: var(--r-lg); box-shadow: var(--shadow-lg);
    padding: 10px; display: none; }
  .popover.show { display: flex; flex-direction: column; overflow-y: auto; }
  .popover textarea { min-height: 48px; flex-shrink: 0; }
  .popover textarea::placeholder { color: var(--muted-foreground); opacity: 1; }
  .popover .row { position: sticky; bottom: 0; background: var(--card); flex-shrink: 0; }
  #popStatus { font-size: 12px; color: var(--muted-foreground); }
  .canvas-control { font-size: 12px; color: var(--muted-foreground); }
  .canvas-control select { font: inherit; color: var(--foreground); background: var(--background); }
  .popover .target-label { font-size: 11px; color: var(--muted-foreground); margin-bottom: 6px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .popover textarea { width: 100%; border: 1px solid var(--border);
    border-radius: var(--r-md); font: inherit; font-size: 13px; padding: 7px 9px;
    resize: none; background: var(--background); color: var(--foreground); }
  .popover textarea:focus { outline: 2px solid var(--link); outline-offset: -1px; }
  #popError { color: var(--foreground); font-size: 13px; line-height: 1.4; }
  #popError:not(:empty) { margin-top: 8px; }
  .popover .row { display: flex; justify-content: flex-end; gap: 6px; margin-top: 8px; }
  .popover .inline-hint { display: none; font-size: 12px; line-height: 1.4; margin-bottom: 6px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .popover.inline .inline-hint { display: block; }
  .popover .rewrite-field { display: none; flex-direction: column; margin-top: 8px; }
  .popover.rewriting:not(.inline) .rewrite-field { display: flex; }
  .popover label { font-size: 12px; margin-bottom: 4px; }
  .thread .rewrite { margin: 6px 0 0; font-size: 12px; line-height: 1.5;
    border-left: 2px solid var(--border); padding-left: 8px; overflow-wrap: anywhere; }
  .thread .rewrite .who { font-weight: 600; font-size: 11px; display: block; color: var(--muted-foreground); }
  .thread .rewrite del { color: var(--muted-foreground); }
  .thread .rewrite ins { text-decoration: none; background: var(--accent); }
  .panel { width: 300px; border-left: 1px solid var(--border); background: var(--background);
    padding: 14px; display: flex; flex-direction: column; gap: 10px; overflow-y: auto; }
  .panel h2 { font-size: 12px; margin: 0; color: var(--muted-foreground); font-weight: 600; }
  .thread { border: 1px solid var(--border); border-radius: var(--r-lg); padding: 10px;
    font-size: 12.5px; cursor: pointer; }
  .thread:hover { border-color: var(--border-strong); }
  .thread .head { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; }
  .thread .num { width: 17px; height: 17px; border-radius: 50%; background: var(--pending);
    color: #2a1800; font-size: 10px; font-weight: 700; display: grid; place-items: center; flex: none; }
  .thread.working .num { background: var(--link); color: var(--badge-on-link); }
  .thread.resolved .num { background: var(--success); color: #fff; }
  .thread.dismissed .num { background: var(--faint); color: var(--badge-on-dismissed); }
  .thread .state { font-size: 11px; color: var(--muted-foreground); margin-left: auto; flex: none; }
  .thread .anchor-label { color: var(--muted-foreground); font-size: 11px; overflow: hidden;
    text-overflow: ellipsis; white-space: nowrap; }
  .thread .screen-link { display: block; margin: 6px 0 0; padding: 0; border: 0; background: none;
    font: inherit; font-size: 12px; text-align: left; color: var(--link); cursor: pointer; }
  .thread .screen-link:hover { text-decoration: underline; }
  .thread .msg { margin: 4px 0 0; }
  .thread .msg.agent { color: var(--muted-foreground); border-left: 2px solid var(--border);
    padding-left: 8px; margin-top: 8px; }
  .thread .msg .who { font-weight: 600; font-size: 11px; display: block; color: var(--muted-foreground); }
  .thread .draft-del, .thread .reopen-btn { margin-left: 6px; background: none; border: none;
    cursor: pointer; color: var(--muted-foreground); font-size: 12px; padding: 3px 4px;
    min-width: 24px; min-height: 24px; flex: none; }
  .thread .draft-del:hover, .thread .reopen-btn:hover { color: var(--foreground); }

  .panel .empty { color: var(--muted-foreground); font-size: 12.5px; padding: 20px 4px; text-align: center; }
  .submit-bar { display: none; align-items: center; gap: 8px; }
  .submit-bar.show { display: flex; }
  .submit-bar .btn { white-space: nowrap; }
  .submit-bar .btn-primary { flex: 1; min-width: 0; }
  .batch-status { display: none; align-items: center; gap: 8px; font-size: 12.5px;
    color: var(--muted-foreground); background: var(--surface-warm);
    border-radius: var(--r-md); padding: 8px 10px; }
  .batch-status.show { display: flex; }
  .batch-status.manual { border-left: 3px solid var(--pending); }
  .batch-status.error { border-left: 3px solid var(--coral); }
  .batch-status .spin { width: 12px; height: 12px; border-radius: 50%; flex: none;
    border: 2px solid var(--link); border-top-color: transparent;
    animation: spin .8s linear infinite; }
  .batch-status.static .spin { display: none; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) {
    .watch-dot { animation: none; }
    .batch-status .spin { display: none; }
    .mode-toggle .knob, .mode-toggle .knob::after, .toast { transition: none; }
  }
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
  .ended.show { display: grid; overflow-y: auto; }
  .ended .popover.show { position: static; width: 100%; max-height: none !important; text-align: left; box-shadow: none; }
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
    .local-badge, .watch-label { display: none; }
    .mode-toggle { right: 20px; bottom: calc(min(42vh, 340px) + 14px); }
    .toast { bottom: calc(min(42vh, 340px) + 60px); }
  }
</style>
</head>
<body class="annotate">
<header class="topbar">
  <div class="brand">as</div>
  <span class="file-name"><span class="file-stem">${escapeHtml(stem)}</span><span class="file-extension">${escapeHtml(extension)}</span></span>
  <span class="local-badge" data-msg="preview.localBadge" aria-hidden="true"></span>
  <span id="watchStatus" role="status" style="font-size:12px;color:var(--muted-foreground)"><span class="watch-dot" aria-hidden="true"></span><span class="watch-label" data-msg="preview.watching"></span></span>
  <div class="spacer"></div>
  <button class="btn btn-primary" id="shareBtn" data-msg="preview.share"></button>
</header>
<div class="layout">
  <div class="doc-wrap">
    <iframe id="artifactFrame" sandbox="allow-scripts" referrerpolicy="no-referrer" src="/artifact" title="${escapeHtml(fileName)}"></iframe>
  </div>
  <aside class="panel">
    <p data-msg="preview.isolationNotice" style="font-size:12px;color:var(--muted-foreground);margin:0"></p>
    ${isMarkdown ? '' : `<label class="canvas-control"><span data-msg="preview.canvasLabel"></span> <select id="canvasBackground" aria-describedby="canvasHelp"><option value="light" data-msg="preview.canvasLight"></option><option value="dark" data-msg="preview.canvasDark"></option></select></label><p class="canvas-control" id="canvasHelp" data-msg="preview.canvasHelp"></p>`}
    <h2 data-msg="preview.panelTitle"></h2>
    <div id="operationError" role="alert"></div>
    <div class="submit-bar" id="submitBar">
      <button class="btn btn-primary" id="submitBtn" aria-describedby="batchStatus"></button>
      <button class="btn" id="discardAll" data-msg="preview.discardDrafts"></button>
    </div>
    <div class="batch-status" id="batchStatus" role="status" aria-live="polite" aria-atomic="true">
      <span class="spin" aria-hidden="true"></span>
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
<div class="mode-hint" id="modeHint" data-msg="preview.modeHint"></div>
<div class="popover" id="popover">
  <div class="target-label" id="popTarget"></div>
  <div class="inline-hint" id="popInlineHint" data-msg="preview.inlineHint"></div>
  <label for="popText" id="popTextLabel" data-msg="preview.editorLabel"></label>
  <textarea id="popText" rows="2" aria-describedby="popTarget popStatus"></textarea>
  <div class="rewrite-field">
    <label for="popRewrite" data-msg="preview.rewriteLabel"></label>
    <textarea id="popRewrite" rows="3" maxlength="16000" aria-describedby="popTarget popStatus"></textarea>
  </div>
  <div id="popStatus" role="status"></div>
  <div id="popError" role="alert"></div>
  <div class="row">
    <button class="btn" id="popCancel" data-msg="preview.cancel"></button>
    <button class="btn btn-primary" id="popAdd" data-msg="preview.add"></button>
  </div>
</div>
<div class="toast" id="toast" role="status" aria-live="polite" aria-atomic="true"></div>
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
  const watchStatus = document.getElementById('watchStatus');
  watchStatus.setAttribute('aria-label', t('preview.localBadge') + ' · ' + t('preview.watching'));
  watchStatus.title = t('preview.watching');

  const frame = document.getElementById('artifactFrame');
  const canvasBackground = document.getElementById('canvasBackground');
  if (canvasBackground) canvasBackground.addEventListener('change', () => {
    frame.style.backgroundColor = canvasBackground.value === 'dark' ? '#111315' : '#ffffff';
  });

  // Saved annotations can outlive edits made while the preview was stopped, so
  // reconcile once the first frame is ready rather than waiting for a save.
  frame.addEventListener('load', function onFirstLoad() {
    frame.removeEventListener('load', onFirstLoad);
    setTimeout(() => { lastVerifiedAnchors = null; checkOrphans(); }, 400);
  });  const body = document.body;
  const popover = document.getElementById('popover');
  const popTarget = document.getElementById('popTarget');
  const popText = document.getElementById('popText');
  const popRewrite = document.getElementById('popRewrite');
  // The anchored text a rewrite may replace. Text-only elements are edited on
  // the page itself (inline); popRewrite then mirrors that draft and stays
  // hidden. Anything else that has text shows popRewrite, prefilled.
  let rewritable = null;
  let inlineEditing = false;
  function setRewriteMode(inline) {
    inlineEditing = inline && rewritable !== null;
    popover.classList.toggle('rewriting', rewritable !== null);
    popover.classList.toggle('inline', inlineEditing);
    document.getElementById('popTextLabel').textContent =
      t(rewritable !== null ? 'preview.commentOptional' : 'preview.editorLabel');
  }
  // What the reader has entered: a comment, a changed rewrite, or both.
  function entryRewrite() {
    if (rewritable === null) return null;
    // Kept exactly as typed: boundary spaces can be part of the wording.
    const proposed = popRewrite.value;
    return proposed === rewritable ? null : { original: rewritable, proposed };
  }
  function entryHasContent() {
    return Boolean(popText.value.trim()) || entryRewrite() !== null;
  }
  function entryKey() {
    const rewrite = entryRewrite();
    return JSON.stringify([popText.value.trim(), rewrite ? rewrite.proposed : null]);
  }
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
  let annotationVersion = 0;
  let agent = { state: 'manual_required' };
  let pendingAnchor = null;
  let annotateMode = true;
  let revision = null;
  let pendingReload = null;
  let orphanedThreads = new Set();
  let checkingThreads = new Set();
  let lastVerifiedAnchors = null;
  // URL screen of an interactive document, as the reporter last observed it.
  let currentScreen = '';
  // Comments whose screen the document could not show again. They stay
  // stored and are not offered for bulk discard.
  let unrestorableThreads = new Set();
  let screenAfterReload = null;
  let pingAfterVerify = null;
  let pendingRestore = null;
  let verificationId = 0;
  let verificationGeneration = -1;
  let verifyPending = false;
  let batchWorkingCount = 0;
  function renderBatchStatus() {
    if (agent.state === 'processing') {
      batchText.textContent = tCount('preview.batchWorking', batchWorkingCount);
      return;
    }
    if (agent.state === 'queued') {
      const key = agent.provider === 'codex'
        ? 'preview.batchQueuedCodex'
        : agent.provider === 'claude_code'
          ? 'preview.batchQueuedClaude'
        : agent.provider === 'cursor'
          ? 'preview.batchQueuedCursor'
        : 'preview.batchQueued';
      batchText.textContent = tCount(key, batchWorkingCount);
      return;
    }
    if (agent.state === 'failed') {
      const key = agent.provider === 'codex'
        ? 'preview.batchFailedCodex'
        : agent.provider === 'claude_code'
          ? 'preview.batchFailedClaude'
        : agent.provider === 'cursor'
          ? 'preview.batchFailedCursor'
        : 'preview.batchFailed';
      batchText.textContent = tCount(key, batchWorkingCount);
      return;
    }
    const key = agent.provider === 'claude_code'
      ? 'preview.batchManualClaude'
      : agent.provider === 'cursor'
        ? 'preview.batchManualCursor'
        : 'preview.batchManual';
    batchText.textContent = tCount(key, batchWorkingCount);
  }
  let ended = false;

  // --- iframe protocol ----------------------------------------------------
  const validObservation = ${validPreviewObservation.toString()};
  let documentGeneration = 0;
  let previewCapability = '';
  let sendSequence = 0;
  let receiveSequence = 0;
  let sharePopup = null;
  function postToFrame(message) {
    try {
      frame.contentWindow.postMessage(
        Object.assign({ source: CONFIG.readySource, previewCapability, documentGeneration, sequence: ++sendSequence }, message), '*');
    } catch (error) {}
  }
  function readyPayload() {
    return {
      kind: CONFIG.readyKind,
      challenge: previewCapability,
      textAnchorsEnabled: true,
      commentLabels: {},
    };
  }
  let readyBurstTimer = null;
  function startReadyBurst() {
    if (readyBurstTimer) clearInterval(readyBurstTimer);
    documentGeneration++;
    previewCapability = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('');
    sendSequence = 0;
    receiveSequence = 0;
    let sent = 0;
    const payload = readyPayload();
    postToFrame(payload);
    postToFrame({ kind: 'annotate-mode', enabled: annotateMode });
    // The CLI preview has no external-link interstitial; open links directly.
    postToFrame({ kind: 'external-link-policy', mode: 'direct' });
    readyBurstTimer = setInterval(() => {
      sent += 1;
      if (sent >= CONFIG.readyRepeat) {
        clearInterval(readyBurstTimer);
        readyBurstTimer = null;
        return;
      }
      postToFrame(payload);
      postToFrame({ kind: 'annotate-mode', enabled: annotateMode });
      postToFrame({ kind: 'external-link-policy', mode: 'direct' });
    }, CONFIG.readyIntervalMs);
  }

  window.addEventListener('message', (event) => {
    // The share dialog runs on its own origin and may only report that the
    // share finished; everything else must come from the artifact frame.
    const data = event.data || {};
    if (data.source === 'artifactshare-preview-share') {
      if (!sharePopup || event.source !== sharePopup || event.origin !== CONFIG.shareOrigin) return;
      // "Preview ended" has to be true for the agent too: without the stop,
      // the process keeps serving and pending next polls never receive
      // session_ended.
      if (data.kind === 'share-finished' && !ended) {
        api('POST', '/api/agent/stop');
        showEnded();
      }
      return;
    }
    // Only the artifact frame may drive the annotation UI. Without the source
    // check any page that opens this port can post a crafted element-annotate
    // and steer what the user is about to write into the store.
    if (event.source !== frame.contentWindow) return;
    if (ended || !previewCapability || event.origin !== 'null') return;
    if (!validObservation(data) || data.previewCapability !== previewCapability ||
      data.documentGeneration !== documentGeneration || data.sequence <= receiveSequence) return;
    receiveSequence = data.sequence;
    if (data.kind === 'element-annotate') {
      if (!annotateMode) return;
      if (cancelAddFocusRestore) cancelAddFocusRestore();
      openPopover({
        kind: 'element', state: 'attached',
        selector: data.selector, label: data.label, contextText: data.contextText,
        ...(data.ownTextHash ? { ownTextHash: data.ownTextHash, ownTextExcerpt: data.ownTextExcerpt } : { ownText: data.ownText }), tagName: data.tagName,
        ...(currentScreen ? { screen: currentScreen } : {}),
      }, data.label, data.rect, data.sequence, data.editable === true);
    } else if (data.kind === 'edit-text') {
      if (!inlineEditing || savePending || !pendingAnchor) return;
      popRewrite.value = data.text;
      document.getElementById('popAdd').disabled = false;
    } else if (data.kind === 'edit-ended') {
      // The page edit could not start or was removed; popRewrite already
      // holds the latest draft.
      if (!inlineEditing || !pendingAnchor) return;
      leaveInline();
    } else if (data.kind === 'edit-key') {
      if (!inlineEditing || !pendingAnchor) return;
      if (data.key === 'commit') addAnnotation();
      else if (data.key === 'cancel') hidePopover(true);
      else { window.focus(); popText.focus(); }
    } else if (data.kind === 'screen') {
      onScreen(data.screen);
    } else if (data.kind === 'screen-shown') {
      onScreenShown(data.screen, data.outcome);
    } else if (data.kind === 'annotation-geometry') {
      if (!pendingAnchor || data.pickSequence !== targetPickSequence) return;
      targetRect = data.rect;
      positionPopover();
    } else if (data.kind === 'anchor-verdicts') {
      if (data.verificationId !== verificationId || !Number.isSafeInteger(data.generation) || data.generation <= verificationGeneration) return;
      verificationGeneration = data.generation;
      applyAnchorVerdicts(data.verdicts);
    } else if (data.kind === 'text-selection') {
      // The reporter keeps emitting selections so normal reading still works;
      // only annotation mode turns one into a comment.
      if (!annotateMode) return;
      if (cancelAddFocusRestore) cancelAddFocusRestore();
      openPopover({
        kind: 'text', state: 'attached', position_state: 'attached',
        selectorFormat: data.selectorFormat, textHash: data.textHash, ambiguousAtCreation: data.ambiguousAtCreation,
        quotedText: data.quotedText, prefixText: data.prefixText,
        suffixText: data.suffixText, textStart: data.textStart,
        textEnd: data.textEnd, cssPath: data.cssPath,
        ...(currentScreen ? { screen: currentScreen } : {}),
      }, data.quotedText, data.rect, data.sequence);
    }
  });

  // --- popover ------------------------------------------------------------
  let cancelAddFocusRestore = null;
  let savePending = false;
  let saveFailed = false;
  // Text that reconciliation confirmed as already saved for this attempt.
  let confirmedSavedKey = null;
  let unconfirmedSave = null;
  let targetRect = null;
  let targetPickSequence = null;
  function positionPopover() {
    if (ended || !popover.classList.contains('show')) return;
    const viewport = window.visualViewport;
    const left = (viewport ? viewport.offsetLeft : 0) + 8;
    const top = (viewport ? viewport.offsetTop : 0) + 8;
    const width = viewport ? viewport.width : window.innerWidth;
    const height = viewport ? viewport.height : window.innerHeight;
    popover.style.maxHeight = Math.max(0, height - 16) + 'px';
    popover.style.maxWidth = Math.max(0, width - 16) + 'px';
    const box = popover.getBoundingClientRect();
    const frameRect = frame.getBoundingClientRect();
    const targetTop = frameRect.top + (targetRect ? targetRect.top : 60);
    const above = targetTop - box.height - 8;
    const preferred = above >= top ? above : targetTop + (targetRect ? targetRect.height : 0) + 8;
    popover.style.left = Math.max(left, Math.min(frameRect.left + (targetRect ? targetRect.left : 40), left + width - 16 - (box.width || 300))) + 'px';
    popover.style.top = Math.max(top, Math.min(preferred, top + height - 16 - box.height)) + 'px';
  }
  window.addEventListener('resize', positionPopover);
  window.addEventListener('orientationchange', positionPopover);
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', positionPopover);
    window.visualViewport.addEventListener('scroll', positionPopover);
  }
  function openPopover(anchor, label, rect, pickSequence, editable = false) {
    if (ended) return;
    if (savePending || saveFailed || (pendingAnchor && entryHasContent())) {
      document.getElementById('popStatus').textContent = t(pendingReload !== null ? 'preview.updateQueued' : savePending ? 'preview.savePending' : 'preview.entryBlocked');
      positionPopover();
      return;
    }
    document.getElementById('popStatus').textContent = pendingReload !== null ? t('preview.updateQueued') : '';
    document.getElementById('popError').textContent = '';
    pendingAnchor = anchor;
    popTarget.textContent = label;
    targetRect = rect;
    targetPickSequence = pickSequence;
    postToFrame({ kind: 'track-annotation-pick', pickSequence });
    popText.value = '';
    rewritable = rewritableTextOf(anchor);
    popRewrite.value = rewritable === null ? '' : rewritable;
    setRewriteMode(editable && anchor.kind === 'element');
    popover.classList.add('show');
    positionPopover();
    // Inline, the reader is already typing on the page (Tab comes here).
    if (inlineEditing) postToFrame({ kind: 'inline-edit', pickSequence });
    else popText.focus();
  }
  // The page took the edited element away: keep the draft in the field.
  function leaveInline() {
    if (!inlineEditing) return;
    setRewriteMode(false);
    positionPopover();
  }
  // Mirrors the CLI contract: quoted text, or an element's raw own text.
  function rewritableTextOf(anchor) {
    if (anchor.kind === 'text') return anchor.quotedText || null;
    if (anchor.kind === 'element') return anchor.ownText || null;
    return null;
  }
  function hidePopover(flushReload = false) {
    if (savePending || ended) return;
    popover.classList.remove('show');
    inlineEditing = false;
    saveFailed = false;
    confirmedSavedKey = null;
    unconfirmedSave = null;
    document.getElementById('popAdd').textContent = t('preview.add');
    document.getElementById('popAdd').disabled = false;
    pendingAnchor = null;
    targetPickSequence = null;
    postToFrame({ kind: 'track-annotation-pick', pickSequence: null });
    if (flushReload && pendingReload !== null) {
      const target = pendingReload;
      pendingReload = null;
      reloadFrame(target);
    }
  }
  document.getElementById('popCancel').addEventListener('click', () => hidePopover(true));
  for (const field of [popText, popRewrite]) {
    field.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) addAnnotation();
      if (event.key === 'Escape') hidePopover(true);
    });
    field.addEventListener('input', () => {
      if (!savePending && !ended) document.getElementById('popAdd').disabled = false;
    });
  }
  document.getElementById('popAdd').addEventListener('click', addAnnotation);
  async function checkUnconfirmedSave(restoreFocus) {
    const refreshed = await reconcileAnnotations();
    if (ended) return;
    const attempt = unconfirmedSave;
    const found = annotations.some(annotation => !attempt.threads.has(annotation.thread) &&
      annotation.comment === attempt.comment &&
      JSON.stringify(annotation.rewrite || null) === JSON.stringify(attempt.rewrite || null) && annotation.anchor &&
      Object.entries(attempt.anchor).every(([key, value]) => annotation.anchor[key] === value));
    const add = document.getElementById('popAdd');
    savePending = false;
    saveFailed = true;
    confirmedSavedKey = found ? attempt.key : null;
    add.disabled = found && entryKey() === attempt.key;
    add.textContent = t(refreshed || found ? 'preview.add' : 'preview.checkSave');
    document.getElementById('popError').textContent = t(found ? 'preview.annotationAlreadySaved' :
      refreshed ? 'preview.annotationSaveFailed' : 'preview.annotationSaveUnknown');
    // A failed read must never turn the next click into another write.
    if ((refreshed && !found) || (found && entryKey() !== attempt.key)) unconfirmedSave = null;
    positionPopover();
    if (restoreFocus()) {
      // Firefox can retain the artifact browsing context after a blocked pick.
      // Reclaim it only for this failed Add, unless the user moved away during
      // the request. Focusing the textarea alone does not cross that boundary.
      window.focus();
      popText.focus();
    }
  }
  async function addAnnotation() {
    const comment = popText.value.trim();
    const rewrite = entryRewrite();
    if (ended || (!comment && !rewrite) || !pendingAnchor || savePending) return;
    // Explicit Add owns the editor before tracking this attempt. Firefox may
    // still have the opaque frame active after a blocked annotation pick.
    window.focus();
    popText.focus();
    // Disabling Add may drop focus to the document. Restore that lost focus,
    // but do not override a deliberate move while the request is pending.
    let focusMoved = false;
    const observeFocus = (event) => {
      if (event.target !== document.body && event.target !== popText && event.target !== popRewrite &&
          event.target !== document.getElementById('popAdd')) focusMoved = true;
    };
    const movedAway = () => { focusMoved = true; };
    document.addEventListener('focusin', observeFocus);
    cancelAddFocusRestore = movedAway;
    try {
      savePending = true;
      // Freeze the submitted text until acknowledgement/reconciliation finishes.
      // Keep it selectable, including when the session ends during the request.
      popText.readOnly = true;
      popRewrite.readOnly = true;
      if (inlineEditing) postToFrame({ kind: 'inline-edit-lock', locked: true });
      popText.setAttribute('aria-busy', 'true');
      document.getElementById('popCancel').disabled = true;
      document.getElementById('popStatus').textContent = t(pendingReload !== null ? 'preview.updateQueued' : 'preview.savePending');
      positionPopover();
      document.getElementById('popAdd').textContent = t('preview.savePending');
      document.getElementById('popAdd').disabled = true;
      window.addEventListener('blur', movedAway);
      popText.addEventListener('blur', movedAway, true);
      popRewrite.addEventListener('blur', movedAway, true);
      if (unconfirmedSave) {
        await checkUnconfirmedSave(() => !focusMoved);
        return;
      }
      const attempt = { anchor: pendingAnchor, comment, rewrite, key: entryKey(), threads: new Set(annotations.map(annotation => annotation.thread)) };
      const result = await api('POST', '/api/annotations', { anchor: pendingAnchor, comment, ...(rewrite ? { rewrite } : {}) }, false);
      if (ended) return;
      if (!result || !result.annotation || typeof result.annotation.thread !== 'string' || !result.annotation.thread) {
        unconfirmedSave = attempt;
        await checkUnconfirmedSave(() => !focusMoved);
        return;
      }
      savePending = false;
      document.getElementById('popAdd').disabled = false;
      document.getElementById('popError').textContent = '';
      popText.value = '';
      popRewrite.value = '';
      hidePopover(true);
    } finally {
      popText.readOnly = ended;
      popRewrite.readOnly = ended;
      // Still open after a failure: the page text can be edited again.
      if (inlineEditing && !ended && pendingAnchor) postToFrame({ kind: 'inline-edit-lock', locked: false });
      popText.removeAttribute('aria-busy');
      document.getElementById('popCancel').disabled = ended;
      document.getElementById('popStatus').textContent = !ended && pendingReload !== null ? t('preview.updateQueued') : '';
      positionPopover();
      document.removeEventListener('focusin', observeFocus);
      window.removeEventListener('blur', movedAway);
      popText.removeEventListener('blur', movedAway, true);
      popRewrite.removeEventListener('blur', movedAway, true);
      cancelAddFocusRestore = null;
    }
  }

  // --- API ----------------------------------------------------------------
  async function reconcileAnnotations() {
    const version = annotationVersion;
    try {
      const response = await fetch('/api/annotations', { cache: 'no-store' });
      if (!response.ok) return false;
      const data = await response.json();
      // An incoming event or another completed read supersedes this snapshot.
      // Returning false also keeps an unknown save from becoming a new POST.
      if (ended || version !== annotationVersion || !data || !Array.isArray(data.annotations)) return false;
      annotationVersion++;
      if (JSON.stringify(annotations) !== JSON.stringify(data.annotations) ||
          (data.agent && JSON.stringify(agent) !== JSON.stringify(data.agent))) {
        annotations = data.annotations;
        agent = data.agent || agent;
        renderPanel();
        checkOrphans();
      }
      return true;
    } catch (error) {
      return false;
    }
  }
  async function api(method, path, bodyValue, reportFailure = true) {
    if (ended) return null;
    const operationError = document.getElementById('operationError');
    operationError.textContent = '';
    const focused = document.activeElement;
    const submittedThreads = path === '/api/annotations/submit'
      ? new Set(annotations.filter(annotation => annotation.status === 'draft').map(annotation => annotation.thread))
      : null;
    const headers = { 'content-type': 'application/json' };
    headers[MUTATION_HEADER] = '1';
    try {
      const response = await fetch(path, {
        method,
        headers,
        body: bodyValue === undefined ? '{}' : JSON.stringify(bodyValue),
      });
      if (!response.ok) throw new Error('operation failed');
      return await response.json();
    } catch (error) {
      if (reportFailure) {
        await reconcileAnnotations();
        if (ended) return null;
        const submitted = submittedThreads && annotations.some(annotation =>
          submittedThreads.has(annotation.thread) && annotation.status !== 'draft');
        operationError.textContent = t(submitted ? 'preview.submitUnconfirmed' : 'preview.operationFailed');
        if (document.activeElement === document.body && focused && (!focused.isConnected || focused.disabled)) {
          operationError.tabIndex = -1;
          operationError.focus();
        }
      }
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
    if (status === 'requested') {
      return agent.state === 'queued'
        ? t('preview.stateQueued')
        : t('preview.stateSaved');
    }
    if (status === 'in_progress') return t('preview.stateWorking');
    if (status === 'resolved') return t('preview.stateResolved');
    return t('preview.stateDismissed');
  }
  function renderPanel() {
    if (ended) return;
    threadsEl.textContent = '';
    const ordered = annotations.slice().reverse();
    ordered.forEach((annotation, index) => {
      const thread = document.createElement('div');
      thread.className = 'thread';
      if (annotation.status === 'in_progress') thread.classList.add('working');
      if (annotation.status === 'resolved') thread.classList.add('resolved');
      if (annotation.status === 'dismissed') thread.classList.add('dismissed');
      if (orphanedThreads.has(annotation.thread) || unrestorableThreads.has(annotation.thread)) thread.classList.add('orphaned');
      const head = document.createElement('div');
      head.className = 'head';
      const num = document.createElement('span');
      num.className = 'num';
      num.textContent = String(annotations.length - index);
      const label = document.createElement('span');
      label.className = 'anchor-label';
      label.textContent = anchorLabel(annotation.anchor);
      if (checkingThreads.has(annotation.thread)) label.textContent += ' · ' + t('preview.positionChecking');
      else if (orphanedThreads.has(annotation.thread) || unrestorableThreads.has(annotation.thread)) label.textContent += ' · ' + t('preview.positionNeedsCheck');
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
      if (onOtherScreen(annotation)) {
        // Its own wrapping line, and a real button so keyboards can go there.
        const go = document.createElement('button');
        go.type = 'button';
        go.className = 'screen-link';
        go.textContent = t('preview.positionOtherScreen');
        go.addEventListener('click', (event) => {
          event.stopPropagation();
          restoreScreen(annotation);
        });
        thread.appendChild(go);
      }
      if (annotation.rewrite) {
        // The reader's own wording, shown before and after.
        const rewrite = document.createElement('div');
        rewrite.className = 'rewrite';
        const who = document.createElement('span');
        who.className = 'who';
        who.textContent = t('preview.rewriteHeading');
        const before = document.createElement('del');
        before.textContent = annotation.rewrite.original;
        const after = document.createElement('ins');
        after.textContent = annotation.rewrite.proposed || t('preview.rewriteRemoved');
        rewrite.append(who, before, document.createTextNode(' → '), after);
        thread.appendChild(rewrite);
      }
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
        if (onOtherScreen(annotation)) {
          restoreScreen(annotation);
          return;
        }
        if (annotation.anchor && annotation.anchor.kind === 'element') {
          if (!orphanedThreads.has(annotation.thread) && !checkingThreads.has(annotation.thread)) postToFrame({ kind: 'element-ping', selector: annotation.anchor.selector });
        }
      });
      threadsEl.appendChild(thread);
    });
    panelEmpty.style.display = annotations.length === 0 ? '' : 'none';
    const drafts = annotations.filter((entry) => entry.status === 'draft');
    const hasActiveBatch = annotations.some(
      (entry) => entry.status === 'requested' || entry.status === 'in_progress');
    submitBtn.textContent = tCount('preview.requestFixes', drafts.length);
    submitBtn.disabled = hasActiveBatch;
    submitBar.classList.toggle('show', drafts.length > 0);
    const open = annotations.filter(
      (entry) => entry.status !== 'resolved' && entry.status !== 'dismissed');
    pendingCount.textContent = String(open.length);
    pendingCount.classList.toggle('show', open.length > 0);
    updateBatchStatus();
  }

  // --- batch status -------------------------------------------------------
  function updateBatchStatus() {
    const working = annotations.filter(
      (entry) => entry.status === 'requested' || entry.status === 'in_progress');
    if (working.length === 0) {
      batchStatus.classList.remove('show');
      batchStatus.classList.remove('manual');
      batchStatus.classList.remove('error');
      batchText.textContent = '';
      return;
    }
    batchStatus.classList.add('show');
    batchStatus.classList.toggle('static', agent.state !== 'processing');
    batchStatus.classList.toggle('manual', agent.state === 'manual_required');
    batchStatus.classList.toggle('error', agent.state === 'failed');
    batchWorkingCount = working.length;
    renderBatchStatus();
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
    if (!entryHasContent() && !saveFailed && pendingReload === null) hidePopover();
  });

  // --- screens (URL state of interactive documents) ----------------------
  function onScreen(screen) {
    if (screenAfterReload !== null) {
      const target = screenAfterReload;
      screenAfterReload = null;
      // A reload starts on the default screen; return to where the reader was.
      if (target !== screen) postToFrame({ kind: 'show-screen', screen: target });
    }
    if (screen === currentScreen) return;
    currentScreen = screen;
    lastVerifiedAnchors = null;
    checkOrphans(false);
  }
  // The stored screen decides, for every comment including finished ones.
  function onOtherScreen(annotation) {
    const anchor = annotation.anchor;
    return Boolean(anchor) && anchor.kind !== 'artifact' && (anchor.screen || '') !== currentScreen;
  }
  function showTarget(annotation) {
    if (annotation.anchor.kind === 'element')
      postToFrame({ kind: 'element-ping', selector: annotation.anchor.selector });
    else if (annotation.anchor.kind === 'text')
      postToFrame({ kind: 'scroll-to-comment', threadId: annotation.thread });
  }
  // Never attach the comment to another screen's element; mark it as
  // needing a check instead.
  function markUnrestorable(thread) {
    unrestorableThreads.add(thread);
    renderPanel();
  }
  // The frame reports whether the screen was shown, could not be shown, or
  // the reader moved on first. A frame that never answers changes nothing.
  function armRestoreTimer() {
    const restoring = pendingRestore;
    clearTimeout(restoring.timer);
    restoring.timer = setTimeout(() => {
      if (pendingRestore === restoring) pendingRestore = null;
    }, 5000);
  }
  function onScreenShown(screen, outcome) {
    if (!pendingRestore || screen !== pendingRestore.target) return;
    const restoring = pendingRestore;
    clearTimeout(restoring.timer);
    pendingRestore = null;
    if (outcome === 'not-shown') {
      markUnrestorable(restoring.thread);
      return;
    }
    if (outcome !== 'shown') return;
    const restored = annotations.find(entry => entry.thread === restoring.thread);
    if (restored && (restored.status === 'resolved' || restored.status === 'dismissed')) showTarget(restored);
    else pingAfterVerify = restoring.thread;
    lastVerifiedAnchors = null;
    checkOrphans();
  }
  function restoreScreen(annotation) {
    if (pendingRestore) clearTimeout(pendingRestore.timer);
    pendingRestore = { thread: annotation.thread, target: annotation.anchor.screen || '', timer: null };
    armRestoreTimer();
    postToFrame({ kind: 'show-screen', screen: pendingRestore.target });
  }

  // --- reload + orphan handling ------------------------------------------
  function reloadFrame(nextRevision) {
    if (ended || savePending || saveFailed || (pendingAnchor && entryHasContent())) return;
    previewCapability = '';
    hidePopover();
    // A restore in progress continues on the reloaded document, with a fresh
    // allowance for it to load.
    screenAfterReload = pendingRestore ? pendingRestore.target : currentScreen;
    if (pendingRestore) armRestoreTimer();
    verificationId++;
    verificationGeneration = -1;
    let scrollY = 0;
    try { scrollY = frame.contentWindow.scrollY || 0; } catch (error) {}
    const restore = () => {
      try { frame.contentWindow.scrollTo(0, scrollY); } catch (error) {}
      setTimeout(() => { lastVerifiedAnchors = null; checkOrphans(); }, 400);
      frame.removeEventListener('load', restore);
    };
    frame.addEventListener('load', restore);
    frame.src = '/artifact?rev=' + encodeURIComponent(nextRevision || '');
  }

  function checkOrphans(showChecking = true) {
    // The frame captured these anchors, so it also decides whether they still
    // resolve: re-implementing the rules here would let capture and
    // verification drift apart. Resolved and dismissed threads are excluded —
    // their target was supposed to change.
    const pending = annotations.filter((annotation) => {
      if (annotation.status === 'resolved' || annotation.status === 'dismissed') return false;
      const anchor = annotation.anchor;
      return Boolean(anchor) && anchor.kind !== 'artifact';
    });
    const key = JSON.stringify(pending.map(annotation => {
      const { state, position_state, ...selector } = annotation.anchor;
      return { thread: annotation.thread, ...selector };
    }));
    if (key === lastVerifiedAnchors) return;
    lastVerifiedAnchors = key;
    // A screen change re-verifies quietly: the panel keeps its labels.
    if (showChecking) checkingThreads = new Set(pending.map(annotation => annotation.thread));
    renderPanel();
    verificationId++;
    verificationGeneration = -1;
    const request = {
      verificationId,
      kind: 'verify-anchors',
      anchors: pending.map((annotation) => Object.assign(
        { thread: annotation.thread }, annotation.anchor)),
    };
    verifyPending = true;
    // Highlight only this screen's quotes: another screen may repeat the text.
    postToFrame({ kind: 'comment-highlights', textAnchorsEnabled: true, highlights: pending.filter(a => a.anchor.kind === 'text' && (a.anchor.screen || '') === currentScreen).map(a => Object.assign({ threadId: a.thread, count: 1 }, a.anchor)) });
    postToFrame(request);
    // The frame arms its listener during the ready handshake, which this can
    // still race. One resend keeps a missed request from leaving every anchor
    // on a stale verdict.
    setTimeout(() => { if (verifyPending && request.verificationId === verificationId) postToFrame(request); }, 1200);
  }

  function applyAnchorVerdicts(verdicts) {
    verifyPending = false;
    const attached = new Map((verdicts || []).map((v) => [v.thread, v.attached === true]));
    checkingThreads = new Set((verdicts || []).filter(v => v.position_state === 'checking').map(v => v.thread));
    // A comment on another screen is neither found nor lost here.
    const otherScreen = new Set((verdicts || []).filter(v => v.position_state === 'other-screen').map(v => v.thread));
    const newlyOrphaned = [];
    annotations.forEach((annotation) => {
      if (!attached.has(annotation.thread) || checkingThreads.has(annotation.thread) ||
        otherScreen.has(annotation.thread)) return;
      unrestorableThreads.delete(annotation.thread);
      const found = attached.get(annotation.thread);
      if (!found && !orphanedThreads.has(annotation.thread)) {
        newlyOrphaned.push(annotation.thread);
      }
      if (!found) orphanedThreads.add(annotation.thread);
      else orphanedThreads.delete(annotation.thread);
    });
    if (pingAfterVerify !== null) {
      const shown = annotations.find(annotation => annotation.thread === pingAfterVerify);
      pingAfterVerify = null;
      if (shown && attached.get(shown.thread) === true) showTarget(shown);
    }
    // Reporter observations are display-only. Persist only explicit user actions.
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
    if (!result) return;
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
    try {
      const data = JSON.parse(event.data);
      annotationVersion++;
      annotations = data.annotations || [];
      agent = data.agent || agent;
    }
    catch (error) { return; }
    renderPanel();
    checkOrphans();
  });
  events.addEventListener('reload', (event) => {
    let data = null;
    try { data = JSON.parse(event.data); } catch (error) { return; }
    revision = data.revision;
    if (popover.classList.contains('show')) {
      pendingReload = revision;
      document.getElementById('popStatus').textContent = t('preview.updateQueued');
      positionPopover();
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
    postToFrame({ kind: 'track-annotation-pick', pickSequence: null });
    popText.removeAttribute('aria-busy');
    document.getElementById('popStatus').textContent = '';
    previewCapability = '';
    if (readyBurstTimer) clearInterval(readyBurstTimer);
    events.close();
    const screen = document.getElementById('endedScreen');
    // A comment confirmed as saved is not unsaved work, unless it was edited.
    const confirmedSaved = confirmedSavedKey !== null && entryKey() === confirmedSavedKey;
    if (pendingAnchor && !confirmedSaved && (popText.value || entryRewrite() !== null || savePending || saveFailed)) {
      endedBody.innerHTML = t('preview.ended.unsaved', { command: '__CMD__' }).replace('__CMD__', '<code></code>');
      endedBody.querySelector('code').textContent = CONFIG.resumeCommand;
      popText.readOnly = true;
      popRewrite.readOnly = true;
      // The page edit is gone with the session; show the draft so it can be copied.
      leaveInline();
      popover.querySelector('.row').hidden = true;
      popover.querySelector('.row').style.display = 'none';
      screen.querySelector('.box').appendChild(popover);
    }
    document.querySelectorAll('button, select').forEach(control => { control.disabled = true; });
    screen.classList.add('show');
  }

  // --- share --------------------------------------------------------------
  document.getElementById('shareBtn').addEventListener('click', () => {
    if (sharePopup && !sharePopup.closed) {
      sharePopup.focus();
      sharePopup.postMessage({ source: 'artifactshare-preview', kind: 'refresh-snapshot' }, CONFIG.shareOrigin);
      return;
    }
    sharePopup = window.open(CONFIG.shareOrigin + '/', '_blank', 'width=440,height=560');
  });

  // --- boot ---------------------------------------------------------------
  frame.addEventListener('load', () => { startReadyBurst(); });
  fetch('/api/annotations', { cache: 'no-store' })
    .then((response) => response.json())
    .then((data) => {
      if (ended) return;
      // Initial SSE can arrive first. Only its annotation state supersedes
      // this read; revision and quarantine metadata still belong to startup.
      if (annotationVersion === 0) {
        annotations = (data && data.annotations) || [];
        agent = (data && data.agent) || agent;
      }
      revision = data ? data.revision : null;
      renderPanel();
      checkOrphans();
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
