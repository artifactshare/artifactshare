import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { computeTextSha256Hex } from '~/lib/sha256'

/*
 * MCP Apps UI resource: a compact artifact card shared by ChatGPT, Claude,
 * Cursor, and other conforming hosts. The full artifact opens in Artifact
 * Share; the widget never frames or fetches artifact content itself.
 */

export const ARTIFACT_PREVIEW_TEMPLATE_URI = 'ui://artifact-preview.html'

// MCP Apps serves UI as HTML with this profile so hosts treat the resource as
// interactive app UI rather than a plain document.
const RESOURCE_MIME_TYPE = 'text/html;profile=mcp-app'

const WIDGET_HTML = `
<style>
  :root { color-scheme: light dark; }
  html, body { margin: 0; padding: 0; background: transparent; }
  #as-card, #as-card * { box-sizing: border-box; }
  #as-card {
    --as-text: #25231f;
    --as-muted: #706d66;
    --as-border: rgba(55, 53, 47, 0.14);
    --as-surface: #ffffff;
    --as-accent: #e85d3f;
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    color: var(--as-text); background: var(--as-surface);
    display: grid; grid-template-columns: 48px minmax(0, 1fr); gap: 14px;
    align-items: center; width: 100%; min-height: 128px; margin: 0;
    padding: 18px; border: 1px solid var(--as-border); border-radius: 16px;
  }
  #as-mark {
    display: grid; place-items: center; width: 48px; height: 48px;
    border-radius: 13px; color: #fff; background: var(--as-accent);
    font-size: 14px; font-weight: 750; letter-spacing: -0.02em;
  }
  #as-body { min-width: 0; }
  #as-eyebrow {
    color: var(--as-muted); font-size: 12px; font-weight: 650;
    letter-spacing: 0.04em; text-transform: uppercase;
  }
  #as-title {
    margin: 4px 0 12px; overflow: hidden; color: var(--as-text);
    font-size: 17px; font-weight: 700; line-height: 1.3;
    text-overflow: ellipsis; white-space: nowrap;
  }
  #as-actions { display: flex; align-items: center; gap: 10px; }
  #as-open {
    display: inline-flex; align-items: center; justify-content: center;
    min-height: 36px; padding: 8px 13px; border: 1px solid var(--as-text);
    border-radius: 9px; color: var(--as-surface); background: var(--as-text);
    font-size: 13px; font-weight: 650; line-height: 1; text-decoration: none;
    white-space: nowrap;
  }
  #as-open:hover { opacity: 0.88; }
  #as-open[hidden] { display: none; }
  @media (prefers-color-scheme: dark) {
    #as-card {
      --as-text: #f3f1ec;
      --as-muted: #aaa69e;
      --as-border: rgba(255, 255, 255, 0.14);
      --as-surface: #24231f;
      --as-accent: #f06c4f;
    }
  }
</style>
<div id="as-card">
  <div id="as-mark" aria-hidden="true">AS</div>
  <div id="as-body">
    <div id="as-eyebrow">Artifact Share</div>
    <div id="as-title">Artifact</div>
    <div id="as-actions">
      <a id="as-open" target="_blank" rel="noopener noreferrer">Open in Artifact Share ↗</a>
    </div>
  </div>
</div>
<script>
(function () {
  var titleEl = document.getElementById('as-title');
  var eyebrowEl = document.getElementById('as-eyebrow');
  var openLink = document.getElementById('as-open');
  var shareLink = '';
  var openExternal = null;
  var heightReportScheduled = false;
  var lastReportedHeight = 0;

  var kindLabels = {
    markdown_page: { en: 'Markdown', ja: 'Markdown' },
    html_page: { en: 'HTML page', ja: 'HTMLページ' },
    static_site: { en: 'Static site', ja: '静的サイト' },
    spa: { en: 'Web app', ja: 'Webアプリ' },
    workspace_app: { en: 'Workspace app', ja: 'ワークスペースアプリ' },
  };

  // The server mints share_url. Still require an absolute HTTPS URL before it
  // reaches either the anchor or a host link-opening API.
  function validatedHttpsUrl(value) {
    if (typeof value !== 'string') return '';
    try {
      var url = new URL(value);
      return url.protocol === 'https:' ? url.href : '';
    } catch (_) {
      return '';
    }
  }

  // ChatGPT's compatibility bridge does not run the standard MCP Apps SDK's
  // automatic ResizeObserver. Report the card's intrinsic height explicitly so
  // the host does not retain its initial, taller widget allocation.
  function reportIntrinsicHeight() {
    if (
      heightReportScheduled ||
      !window.openai ||
      typeof window.openai.notifyIntrinsicHeight !== 'function'
    ) return;
    heightReportScheduled = true;
    requestAnimationFrame(function () {
      heightReportScheduled = false;
      var card = document.getElementById('as-card');
      var height = card ? Math.ceil(card.getBoundingClientRect().height) : 0;
      if (height > 0 && height !== lastReportedHeight) {
        lastReportedHeight = height;
        window.openai.notifyIntrinsicHeight(height);
      }
    });
  }

  function render(data) {
    data = data || {};
    var locale = data.locale === 'ja' ? 'ja' : 'en';
    var labels = kindLabels[data.artifact_kind] || {
      en: 'Artifact',
      ja: 'アーティファクト',
    };
    titleEl.textContent = data.title || labels[locale];
    eyebrowEl.textContent = 'Artifact Share · ' + labels[locale];
    openLink.textContent =
      locale === 'ja'
        ? 'Artifact Shareで開く ↗'
        : 'Open in Artifact Share ↗';
    shareLink = validatedHttpsUrl(data.share_url);
    if (shareLink) {
      openLink.href = shareLink;
      openLink.hidden = false;
    } else {
      openLink.removeAttribute('href');
      openLink.hidden = true;
    }
    reportIntrinsicHeight();
  }

  openLink.addEventListener('click', function (event) {
    if (openExternal && shareLink) {
      event.preventDefault();
      openExternal(shareLink);
    }
  });

  // Keep ChatGPT's compatibility bridge ready as a fallback. A connected
  // standard MCP Apps client below replaces its link opener.
  if (window.openai) {
    openExternal = function (url) {
      if (window.openai.openExternal) {
        window.openai.openExternal({ href: url });
      }
    };
    render(window.openai.toolOutput);
    window.addEventListener(
      'openai:set_globals',
      function () { render(window.openai.toolOutput); },
      { passive: true },
    );
    if (typeof ResizeObserver === 'function') {
      var compatibilityResizeObserver = new ResizeObserver(reportIntrinsicHeight);
      compatibilityResizeObserver.observe(document.documentElement);
      compatibilityResizeObserver.observe(document.body);
    }
  } else {
    render(null);
  }

  // Prefer the standard MCP Apps bridge on every host. If the client cannot
  // load or connect, the ChatGPT bridge or the plain HTTPS anchor remains.
  import('https://esm.sh/@modelcontextprotocol/ext-apps@1.7.5/app-with-deps')
    .then(function (mod) {
      var app = new mod.App(
        { name: 'Artifact Share card', version: '1.0.0' },
        {},
        { autoResize: true },
      );
      app.ontoolresult = function (result) {
        render(result && result.structuredContent);
      };
      return app.connect(new mod.PostMessageTransport()).then(function () {
        openExternal = function (url) {
          Promise.resolve(app.openLink({ url: url })).catch(function () {});
        };
      });
    })
    .catch(function () {
      // The compatibility bridge or anchor already provides the fallback.
    });
})();
</script>
`.trim()

/** Register the portable artifact card as an MCP Apps UI resource. */
export function registerArtifactPreviewResource(
  server: McpServer,
  appOrigin: string,
  mcpServerUrl: string,
): void {
  server.registerResource(
    'artifact-preview',
    ARTIFACT_PREVIEW_TEMPLATE_URI,
    {
      title: 'Artifact card',
      description:
        'Shows artifact details and opens the full artifact in Artifact Share.',
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
          // Compatibility alias for ChatGPT's dedicated widget origin.
          'openai/widgetDomain': appOrigin,
          ui: {
            // The card draws its own boundary so hosts should not wrap it in a
            // second border.
            prefersBorder: false,
            domain: claudeWidgetDomain,
            // The card loads only the standard MCP Apps client. It never frames
            // or fetches artifact content, so frameDomains is intentionally absent.
            csp: {
              resourceDomains: ['https://esm.sh'],
              connectDomains: ['https://esm.sh'],
            },
          },
        },
      },
    ],
  }
}
