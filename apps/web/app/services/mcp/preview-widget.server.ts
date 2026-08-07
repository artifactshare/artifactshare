import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { SANDBOX_HOST } from '~/lib/hosts'
import { computeTextSha256Hex } from '~/lib/sha256'

/*
 * MCP Apps UI resource: a preview widget that renders an artifact inside the
 * chat host (ChatGPT / Cursor / Claude) with a fullscreen option. A tool whose
 * `_meta.ui.resourceUri` points at ARTIFACT_PREVIEW_TEMPLATE_URI makes the host
 * fetch this HTML via `resources/read` and render it after the tool runs.
 *
 * The widget reads the tool's structuredContent through whichever host bridge is
 * present — `window.openai` on ChatGPT, the `@modelcontextprotocol/ext-apps`
 * client on standard hosts — and frames `preview_url` (a cookie-free embed of
 * the artifact's sandboxed content; falls back to the share page).
 */

export const ARTIFACT_PREVIEW_TEMPLATE_URI = 'ui://artifact-preview.html'

// MCP Apps serves UI as HTML with this profile so hosts treat the resource as
// interactive app UI rather than a plain document.
const RESOURCE_MIME_TYPE = 'text/html;profile=mcp-app'

const WIDGET_HTML = `
<style>
  :root { color-scheme: light dark; }
  #as-preview * { box-sizing: border-box; }
  #as-preview {
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    display: flex; flex-direction: column; height: 100%; min-height: 360px; margin: 0;
  }
  /* Standard hosts (Cursor) can give the widget the full pane height, which lets
     the framed artifact's 100vh hero balloon. Pin a card height inline, and only
     fill the viewport in fullscreen. ChatGPT (window.openai) keeps height: 100%. */
  #as-preview.as-managed { height: 460px; }
  #as-preview.as-managed.as-full { height: 100vh; }
  #as-bar {
    display: flex; align-items: center; gap: 10px;
    padding: 10px 12px; border-bottom: 1px solid rgba(55,53,47,0.12);
  }
  #as-mark {
    width: 22px; height: 22px; border-radius: 6px; flex: none;
    background: linear-gradient(135deg, #ff8a65, #ff6f61);
  }
  #as-title {
    flex: 1; min-width: 0; font-weight: 600; font-size: 14px; color: #37352f;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .as-btn {
    font: inherit; font-size: 13px; padding: 6px 12px; border-radius: 8px;
    border: 1px solid rgba(55,53,47,0.16); background: #fff; color: #37352f;
    cursor: pointer; text-decoration: none; white-space: nowrap;
  }
  .as-btn:hover { background: #fbfaf8; }
  #as-frame-wrap { position: relative; flex: 1; background: #fbfaf8; }
  #as-frame { border: 0; width: 100%; height: 100%; display: block; }
  #as-empty { padding: 24px; color: rgba(55,53,47,0.65); font-size: 14px; }
</style>
<div id="as-preview">
  <div id="as-bar">
    <div id="as-mark"></div>
    <div id="as-title">Artifact Share</div>
    <button id="as-full" class="as-btn" type="button">Fullscreen</button>
    <a id="as-open" class="as-btn" target="_blank" rel="noopener">Open</a>
  </div>
  <div id="as-frame-wrap"><div id="as-empty"></div></div>
</div>
<script>
(function () {
  var titleEl = document.getElementById('as-title');
  var fullBtn = document.getElementById('as-full');
  var openLink = document.getElementById('as-open');
  var wrap = document.getElementById('as-frame-wrap');
  var preview = document.getElementById('as-preview');
  // Set by whichever host bridge connects (ChatGPT or the MCP Apps standard).
  var requestFullscreen = null;
  // Opens an external URL through the host. The widget iframe is sandboxed
  // without allow-popups, so a raw target=_blank link is blocked — the host has
  // to open it for us.
  var openExternal = null;
  var shareLink = '';

  // Only honour https URLs — defence in depth against a non-https scheme ever
  // reaching the tool output (the server only ever mints https).
  function https(u) {
    return typeof u === 'string' && u.indexOf('https://') === 0 ? u : '';
  }

  // Render from the tool's structuredContent: { share_url, preview_url, title,
  // locale }. preview_url frames a cookie-free embed of the content; the "open"
  // link goes to the share page so the user gets the full viewer in a browser.
  function render(d) {
    d = d || {};
    var ja = d.locale === 'ja';
    titleEl.textContent = d.title || (ja ? 'アーティファクト' : 'Artifact');
    fullBtn.textContent = ja ? '全画面' : 'Fullscreen';
    openLink.textContent = ja ? '新しいタブで開く ↗' : 'Open in new tab ↗';
    shareLink = https(d.share_url);
    var frameUrl = https(d.preview_url) || shareLink;
    openLink.style.display = shareLink ? '' : 'none';
    if (shareLink) openLink.href = shareLink; // for hover / copy-link
    if (frameUrl && !document.getElementById('as-frame')) {
      var f = document.createElement('iframe');
      f.id = 'as-frame';
      f.src = frameUrl;
      f.setAttribute('referrerpolicy', 'no-referrer');
      wrap.innerHTML = '';
      wrap.appendChild(f);
    }
  }

  fullBtn.addEventListener('click', function () {
    if (requestFullscreen) requestFullscreen();
  });

  openLink.addEventListener('click', function (e) {
    // Route through the host's link opener; the sandboxed iframe can't open a
    // new window itself. Fall back to the default anchor if no bridge connected.
    if (openExternal && shareLink) {
      e.preventDefault();
      openExternal(shareLink);
    }
  });

  // ChatGPT exposes window.openai; the tool result is window.openai.toolOutput.
  if (window.openai) {
    requestFullscreen = function () {
      if (window.openai.requestDisplayMode) {
        window.openai.requestDisplayMode({ mode: 'fullscreen' });
      }
    };
    openExternal = function (url) {
      if (window.openai.openExternal) window.openai.openExternal({ href: url });
    };
    render(window.openai.toolOutput);
    window.addEventListener(
      'openai:set_globals',
      function () {
        render(window.openai.toolOutput);
      },
      { passive: true },
    );
    return;
  }

  // MCP Apps standard host (Cursor / Claude): read structuredContent over
  // postMessage via the ext-apps client. Loaded only on this branch, so ChatGPT
  // never fetches it.
  // Pin a card height here — standard hosts may give the widget the full pane
  // height, ballooning the framed artifact's 100vh hero.
  preview.classList.add('as-managed');
  function applyDisplayMode(ctx) {
    preview.classList.toggle('as-full', !!(ctx && ctx.displayMode === 'fullscreen'));
  }
  render(null); // show the chrome while the bridge connects
  import('https://esm.sh/@modelcontextprotocol/ext-apps@1.7.4/app-with-deps')
    .then(function (mod) {
      var app = new mod.App({
        name: 'Artifact Share preview',
        version: '1.0.0',
      });
      app.ontoolresult = function (p) {
        render(p && p.structuredContent);
      };
      app.ontoolinput = function (p) {
        if (p && p.structuredContent) render(p.structuredContent);
      };
      app.onhostcontextchanged = applyDisplayMode;
      openExternal = function (url) {
        Promise.resolve(app.openLink({ url: url })).catch(function () {});
      };
      return app.connect(new mod.PostMessageTransport()).then(function () {
        var ctx = app.getHostContext && app.getHostContext();
        applyDisplayMode(ctx);
        // Only offer fullscreen when the host advertises it; some hosts (Cursor)
        // reject or mis-respond to the request otherwise, throwing in the client.
        var canFull =
          !!ctx &&
          !!ctx.availableDisplayModes &&
          ctx.availableDisplayModes.indexOf('fullscreen') >= 0;
        if (canFull) {
          requestFullscreen = function () {
            Promise.resolve(
              app.requestDisplayMode({ mode: 'fullscreen' }),
            ).catch(function () {});
          };
        } else {
          fullBtn.style.display = 'none';
        }
      });
    })
    .catch(function () {
      // Leave the static chrome up if the client can't load.
    });
})();
</script>
`.trim()

/**
 * Register the preview widget as a UI resource. `appOrigin` is the app origin
 * (from the request base URL): the widget frames `/a/:id` from there, and it is
 * ChatGPT's widget domain — supplied through the `openai/widgetDomain`
 * compatibility alias. Claude reads the standard `_meta.ui.domain`, which must
 * be derived from the MCP server URL rather than the app origin.
 */
export function registerArtifactPreviewResource(
  server: McpServer,
  appOrigin: string,
  mcpServerUrl: string,
): void {
  server.registerResource(
    'artifact-preview',
    ARTIFACT_PREVIEW_TEMPLATE_URI,
    {
      title: 'Artifact preview',
      description:
        'Renders a shared artifact inside the chat, with a fullscreen view.',
    },
    () => artifactPreviewResourceContents(appOrigin, mcpServerUrl),
  )
}

export async function computeClaudeWidgetDomain(
  mcpServerUrl: string,
): Promise<string> {
  const hash = await computeTextSha256Hex(mcpServerUrl)
  return `${hash.slice(0, 32)}.claudemcpcontent.com`
}

export async function artifactPreviewResourceContents(
  appOrigin: string,
  mcpServerUrl: string,
) {
  const claudeWidgetDomain = await computeClaudeWidgetDomain(mcpServerUrl)

  return {
    contents: [
      {
        uri: ARTIFACT_PREVIEW_TEMPLATE_URI,
        mimeType: RESOURCE_MIME_TYPE,
        text: WIDGET_HTML,
        _meta: {
          // ChatGPT's widget domain via the compatibility alias (renders the
          // widget under `<domain>.web-sandbox.oaiusercontent.com` and enables
          // fullscreen). Claude ignores this alias.
          'openai/widgetDomain': appOrigin,
          ui: {
            prefersBorder: true,
            domain: claudeWidgetDomain,
            // Permit the widget to frame the preview target: the sandbox
            // subdomain (embed token) for single-file artifacts, and the app
            // origin (share page) for the multi-file fallback.
            csp: {
              frameDomains: [appOrigin, `https://*.${SANDBOX_HOST}`],
              // Lets the widget load the MCP Apps standard client (used by
              // Cursor / Claude). ChatGPT uses window.openai and never fetches
              // it. Ignored by hosts that hardcode their widget CSP.
              resourceDomains: ['https://esm.sh'],
              // The client's source map is fetched over connect-src; allow it
              // so it doesn't error in the console (the module itself loads via
              // resourceDomains).
              connectDomains: ['https://esm.sh'],
            },
          },
        },
      },
    ],
  }
}
