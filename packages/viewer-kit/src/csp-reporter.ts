import { TEXT_ANCHOR_ENGINE_SCRIPT } from './text-anchor.js'

/*
 * Injected into sandbox iframe content so the parent frame can surface
 * CSP violations to the viewer. Without this, an artifact whose external
 * scripts or fetches are blocked just renders blank with no signal.
 *
 * The iframe can postMessage to its parent — CSP doesn't block
 * window.postMessage. The parent (a.$id.tsx) listens for
 * source==='artifactshare' messages and renders a violation banner.
 */
// Substring unique to the reporter — tests assert presence/absence by this.
export const VIOLATION_REPORTER_MARKER = 'securitypolicyviolation'
export const READY_MESSAGE_REPEAT_COUNT = 20
export const READY_MESSAGE_REPEAT_INTERVAL_MS = 100
export const READY_CHECK_MESSAGE_SOURCE = 'artifactshare-parent'
export const READY_CHECK_MESSAGE_KIND = 'ready-check'
export const SANDBOX_READY_CHECK_MESSAGE = {
  source: READY_CHECK_MESSAGE_SOURCE,
  kind: READY_CHECK_MESSAGE_KIND,
} as const
export const SANDBOX_EXTERNAL_LINK_POLICY_MESSAGE = {
  source: READY_CHECK_MESSAGE_SOURCE,
  kind: 'external-link-policy',
  mode: 'parent',
} as const

export function createSandboxChallenge(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  )
}

export function ensureSandboxChallenge(challenge: string | null): string {
  return challenge ?? createSandboxChallenge()
}

export function acceptSandboxToken(
  registeredToken: string | null,
  registeredChallenge: string | null,
  challenge: unknown,
  token: unknown,
): string | null {
  return registeredToken === null &&
    registeredChallenge !== null &&
    typeof challenge === 'string' &&
    challenge.length > 0 &&
    typeof token === 'string' &&
    token.length > 0 &&
    challenge === registeredChallenge
    ? token
    : registeredToken
}

export function canUseOsHandler(
  registeredToken: string | null,
  token: unknown,
  isActive: boolean,
): boolean {
  return (
    registeredToken !== null &&
    registeredToken.length > 0 &&
    typeof token === 'string' &&
    token.length > 0 &&
    token === registeredToken &&
    isActive
  )
}

export const SECURE_MESSAGE_PAYLOAD_SCRIPT = `function createMessagePayload(message) {
    var payload = objectCreate(null);
    payload.source = 'artifactshare';
    var keys = objectKeys(message);
    for (var index = 0; index < keys.length; index++) {
      var key = keys[index];
      payload[key] = message[key];
    }
    return payload;
  }`

export const SAFE_EVENT_VALUE_SCRIPT = `function readEventValue(getter, event) {
    if (!getter) return null;
    try {
      return getter(event);
    } catch (e) {
      return null;
    }
  }`

// Script body, split out so the CSP layer can hash it. Ready is repeated
// briefly because SSR can load the iframe before the parent hydrates. The
// parent also probes after hydration so a missed initial ready is recoverable.
export const VIOLATION_REPORTER_SCRIPT_BODY = `(function () {
  if (parent === window) return;

  var savedParent = parent;
  var savedPostMessage = Function.prototype.call.bind(savedParent.postMessage);
  var savedAddEventListener = window.addEventListener.bind(window);
  var trustedGetter = Object.getOwnPropertyDescriptor(Event.prototype, 'isTrusted');
  var targetGetter = Object.getOwnPropertyDescriptor(Event.prototype, 'target');
  var defaultPreventedGetter = Object.getOwnPropertyDescriptor(Event.prototype, 'defaultPrevented');
  var buttonGetter = Object.getOwnPropertyDescriptor(MouseEvent.prototype, 'button');
  var metaKeyGetter = Object.getOwnPropertyDescriptor(MouseEvent.prototype, 'metaKey');
  var ctrlKeyGetter = Object.getOwnPropertyDescriptor(MouseEvent.prototype, 'ctrlKey');
  var shiftKeyGetter = Object.getOwnPropertyDescriptor(MouseEvent.prototype, 'shiftKey');
  var altKeyGetter = Object.getOwnPropertyDescriptor(MouseEvent.prototype, 'altKey');
  var trustedGet = trustedGetter && trustedGetter.get
    ? Function.prototype.call.bind(trustedGetter.get)
    : null;
  var targetGet = targetGetter && targetGetter.get
    ? Function.prototype.call.bind(targetGetter.get)
    : null;
  var defaultPreventedGet = defaultPreventedGetter && defaultPreventedGetter.get
    ? Function.prototype.call.bind(defaultPreventedGetter.get)
    : null;
  var buttonGet = buttonGetter && buttonGetter.get
    ? Function.prototype.call.bind(buttonGetter.get)
    : null;
  var metaKeyGet = metaKeyGetter && metaKeyGetter.get
    ? Function.prototype.call.bind(metaKeyGetter.get)
    : null;
  var ctrlKeyGet = ctrlKeyGetter && ctrlKeyGetter.get
    ? Function.prototype.call.bind(ctrlKeyGetter.get)
    : null;
  var shiftKeyGet = shiftKeyGetter && shiftKeyGetter.get
    ? Function.prototype.call.bind(shiftKeyGetter.get)
    : null;
  var altKeyGet = altKeyGetter && altKeyGetter.get
    ? Function.prototype.call.bind(altKeyGetter.get)
    : null;
  var preventDefault = Function.prototype.call.bind(Event.prototype.preventDefault);
  var addEventListener = Function.prototype.call.bind(EventTarget.prototype.addEventListener);
  var arrayMap = Function.prototype.call.bind(Array.prototype.map);
  var weakMapDelete = Function.prototype.call.bind(WeakMap.prototype.delete);
  var weakMapGet = Function.prototype.call.bind(WeakMap.prototype.get);
  var weakMapSet = Function.prototype.call.bind(WeakMap.prototype.set);
  var defineProperty = Object.defineProperty;
  var objectCreate = Object.create;
  var objectKeys = Object.keys;
  var closest = Function.prototype.call.bind(Element.prototype.closest);
  var getAttribute = Function.prototype.call.bind(Element.prototype.getAttribute);
  var hasAttribute = Function.prototype.call.bind(Element.prototype.hasAttribute);
  var documentToken = '';
  var readyChallenge = '';
  var externalLinkPolicyMode = 'parent';
  var pendingLinkClicks = new WeakMap();
  function trusted(event) {
    try {
      return trustedGetter && trustedGetter.get
        ? trustedGet(event) === true
        : event.isTrusted === true;
    } catch (e) {
      return false;
    }
  }

  ${SAFE_EVENT_VALUE_SCRIPT}

  ${TEXT_ANCHOR_ENGINE_SCRIPT}
  var highlightNames = [];
  var textPaints = [];
  var pendingHighlights = [];
  var pendingAnchors = [];
  var measuredText = null;
  var anchorSnapshotGeneration = 0;
  var paintedAnchors = [];
  var resolveStartedAt = 0;
  var resolveTimer = null;
  var checkingTimer = null;
  var checkingDeadlines = {};
  var pendingVerificationId = null;
  var resolutionGeneration = 0;
  var lastResolutionSignature = '';
  var displayedVersionId = null;
  var displayedPath = null;
  var badges = [];
  var badgeOffsets = {};
  var badgeDragged = false;
  var appliedHighlightKey = '';
  var textAnchorsEnabled = false;
  var mermaidBlocks = objectCreate(null);
  var mermaidRequested = false;
  var commentLabels = {
    openOne: 'Open 1 unresolved comment on this text',
    openOther: 'Open {n} unresolved comments on this text',
    resolvedOne: 'Open 1 resolved comment on this text',
    resolvedOther: 'Open {n} resolved comments on this text',
  };

  function send(message) {
    try {
      ${SECURE_MESSAGE_PAYLOAD_SCRIPT}
      var payload = createMessagePayload(message);
      savedPostMessage(savedParent, payload, '*');
    } catch (e) {}
  }

  function ready() {
    if (readyChallenge && documentToken) {
      send({ kind: 'ready', challenge: readyChallenge, token: documentToken });
    }
  }

  function requestMermaidRendering() {
    if (mermaidRequested) return;
    if (!document.body || !document.body.hasAttribute('data-artifact-markdown')) return;
    var blocks = document.querySelectorAll('pre code.language-mermaid');
    var diagrams = [];
    for (
      var index = 0;
      index < blocks.length && diagrams.length < 16;
      index++
    ) {
      var source = blocks[index].textContent || '';
      if (!source || source.length > 20000) continue;
      var pre = blocks[index].closest('pre');
      if (!pre) continue;
      var id = 'artifactshare-mermaid-' + index;
      mermaidBlocks[id] = pre;
      diagrams.push({ id: id, source: source });
    }
    if (diagrams.length) {
      mermaidRequested = true;
      send({
        kind: 'mermaid-render-request',
        renderToken: readyChallenge,
        diagrams: diagrams,
      });
    }
  }

  function installMermaidResults(renderToken, results) {
    if (renderToken !== readyChallenge) return;
    if (!Array.isArray(results)) return;
    for (var index = 0; index < results.length; index++) {
      var result = results[index] || {};
      var pre = typeof result.id === 'string' ? mermaidBlocks[result.id] : null;
      if (!pre || typeof result.svg !== 'string' || !result.svg.startsWith('<svg')) continue;
      var svgDocument = new DOMParser().parseFromString(result.svg, 'image/svg+xml');
      var svg = svgDocument.documentElement;
      if (
        svg.localName !== 'svg' ||
        svg.namespaceURI !== 'http://www.w3.org/2000/svg' ||
        svgDocument.querySelector('parsererror')
      ) continue;
      var container = document.createElement('div');
      container.className = 'mermaid-diagram';
      container.appendChild(document.importNode(svg, true));
      pre.dataset.mermaidRendered = 'true';
      pre.hidden = true;
      pre.before(container);
      delete mermaidBlocks[result.id];
    }
    schedulePositionBadges();
  }

  function onReadyCheck(event) {
    var message = event && event.data;
    if (
      !event ||
      event.source !== savedParent ||
      !message ||
      message.source !== 'artifactshare-parent' ||
      message.kind !== 'ready-check'
    ) return;
    if (typeof message.challenge !== 'string' || !message.challenge) return;
    readyChallenge = message.challenge;
    requestMermaidRendering();
    ready();
  }
  try {
    var random = new Uint8Array(32);
    crypto.getRandomValues(random);
    documentToken = arrayMap(random, function (byte) {
      return byte.toString(16).padStart(2, '0');
    }).join('');
  } catch (e) {
    documentToken = '';
  }

  function shouldHandleLink(url) {
    if (url.origin !== location.origin) return true;
    if (url.pathname !== location.pathname) return true;
    if (url.search !== location.search && url.search !== '') return true;
    return false;
  }

  function openExternalLink(href) {
    window.open(href, '_blank', 'noopener,noreferrer');
  }

  function isExternallyOpenable(url) {
    return url.protocol === 'http:' || url.protocol === 'https:';
  }

  function prepareLinkClick(event) {
    var defaultPrevented = readEventValue(defaultPreventedGet, event);
    var button = readEventValue(buttonGet, event);
    var metaKey = readEventValue(metaKeyGet, event);
    var ctrlKey = readEventValue(ctrlKeyGet, event);
    var shiftKey = readEventValue(shiftKeyGet, event);
    var altKey = readEventValue(altKeyGet, event);
    if (
      !trusted(event) ||
      defaultPrevented !== false ||
      button !== 0 ||
      metaKey !== false ||
      ctrlKey !== false ||
      shiftKey !== false ||
      altKey !== false
    ) {
      return;
    }
    if (hitComment(event)) return;
    var target = readEventValue(targetGet, event);
    var element =
      target && target.nodeType === 1 ? target : target && target.parentElement;
    if (
      element &&
      closest(element, '.ash-comment-highlight, .ash-comment-highlight-badge')
    ) {
      return;
    }
    var anchor = element ? closest(element, 'a[href]') : null;
    if (!anchor || hasAttribute(anchor, 'download')) return;
    var rawHref = getAttribute(anchor, 'href');
    if (!rawHref || rawHref.charAt(0) === '#') return;

    var url;
    var href;
    var openExternally = false;
    try {
      url = new URL(rawHref, location.href);
      if (!shouldHandleLink(url)) return;
      href = url.href;
      openExternally =
        url.origin !== location.origin && isExternallyOpenable(url);
    } catch (e) {
      href = rawHref;
    }

    var pending = objectCreate(null);
    pending.artifactPrevented = false;
    pending.href = href;
    pending.openExternally = openExternally;
    try {
      defineProperty(event, 'preventDefault', {
        configurable: true,
        value: function () {
          pending.artifactPrevented = true;
          preventDefault(event);
        },
      });
      defineProperty(event, 'defaultPrevented', {
        configurable: true,
        get: function () {
          return pending.artifactPrevented;
        },
      });
      weakMapSet(pendingLinkClicks, event, pending);
    } catch (e) {
      // If the event cannot be wrapped, suppress navigation rather than bypass the gate.
      preventDefault(event);
      return;
    }
    preventDefault(event);
  }

  function finishLinkClick(event) {
    var pending = weakMapGet(pendingLinkClicks, event);
    if (!pending) return;
    weakMapDelete(pendingLinkClicks, event);
    if (pending.artifactPrevented) return;
    if (pending.openExternally && externalLinkPolicyMode === 'direct') {
      openExternalLink(pending.href);
      return;
    }
    send({ kind: 'link-clicked', href: pending.href, token: documentToken });
  }

  function cssPath(element) {
    if (!element || element.nodeType !== 1) return null;
    var parts = [];
    while (element && element.nodeType === 1 && element !== document.body) {
      var name = element.nodeName.toLowerCase();
      var index = 1;
      var sibling = element;
      while ((sibling = sibling.previousElementSibling)) {
        if (sibling.nodeName.toLowerCase() === name) index++;
      }
      parts.unshift(name + ':nth-of-type(' + index + ')');
      element = element.parentElement;
    }
    return parts.length ? 'body > ' + parts.join(' > ') : 'body';
  }

  function selectedElement(range) {
    var node = range.commonAncestorContainer;
    return (node.nodeType === 1 ? node : node.parentElement) || document.body;
  }

  function anchorRoot() {
    return document.querySelector('[data-comment-content]') || document.body;
  }

  function ensureCommentStyles() {
    if (document.getElementById('ash-comment-highlight-style')) return;
    var style = document.createElement('style');
    style.setAttribute('data-anchor-ignore', '');
    style.id = 'ash-comment-highlight-style';
    style.textContent =
      '.ash-comment-highlight-badge::after{content:attr(data-count);}';
    document.head.appendChild(style);
  }

  function sendSelection() {
    if (!textAnchorsEnabled) return;
    var selection = getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      send({ kind: 'text-selection-cleared' });
      return;
    }
    var range = selection.getRangeAt(0);
    if (!range.toString().trim()) { send({ kind: 'text-selection-cleared' }); return; }
    var engine = createTextAnchorEngine(anchorRoot());
    var selector = engine.describe(range);
    if (!selector) { send({ kind: 'text-selection-cleared' }); return; }
    var rect = range.getBoundingClientRect();
    send({
      kind: 'text-selection',
      token: documentToken,
      quotedText: selector.quotedText,
      prefixText: selector.prefixText,
      suffixText: selector.suffixText,
      textStart: selector.textStart,
      textEnd: selector.textEnd,
      selectorFormat: selector.selectorFormat,
      textHash: selector.textHash,
      ambiguousAtCreation: selector.ambiguousAtCreation,
      versionId: displayedVersionId,
      cssPath: cssPath(selectedElement(range)),
      rect: {
        top: rect.top,
        left: rect.left,
        width: rect.width,
        height: rect.height,
      },
    });
  }

  var reusableBadges = new Map();
  function clearMarks(preserveBadges) {
    for (var i = 0; i < badges.length; i++) {
      if (preserveBadges) reusableBadges.set(badges[i].badge.dataset.threadId, badges[i].badge);
      else badges[i].badge.remove();
    }
    badges = [];
    paintedAnchors = [];
    if (typeof CSS !== 'undefined' && CSS.highlights) {
      highlightNames.forEach(function (name) { CSS.highlights.delete(name); });
    }
    highlightNames = [];
    textPaints = [];
    var svgOverlays = document.querySelectorAll('.ash-comment-highlight-svg');
    for (var s = 0; s < svgOverlays.length; s++) svgOverlays[s].remove();
    if (!preserveBadges) svgActiveThreads = {};
    appliedHighlightKey = '';
    var style = document.getElementById('ash-comment-highlight-style');
    if (style) style.textContent = '.ash-comment-highlight-badge::after{content:attr(data-count);}';
  }

  function paintIntact(highlightsById) {
    var style = document.getElementById('ash-comment-highlight-style');
    if (paintedAnchors.length && (!style || !style.isConnected || style.textContent !== textPaintCss())) return false;
    if (typeof CSS !== 'undefined' && CSS.highlights &&
        textPaints.some(function (paint) {
          return CSS.highlights.get(paint.name) !== paint.highlight || paint.highlight.size !== paint.ranges.length ||
            paint.ranges.some(function (range) { return !paint.highlight.has(range); });
        })) return false;
    if (badges.some(function (entry) {
      return !highlightsById.has(entry.highlight.threadId) || !entry.badge.isConnected || (entry.overlays && Object.values(entry.overlays).some(function (shape) { return !shape.isConnected; }));
    })) return false;
    return paintedAnchors.every(function (entry) {
      var next = highlightsById.get(entry.highlight.threadId);
      if (!next || next.ranges.length !== entry.ranges.length || entry.ranges.some(function (range, index) {
        var current = next.ranges[index];
        return range.startContainer !== current.startContainer || range.startOffset !== current.startOffset ||
          range.endContainer !== current.endContainer || range.endOffset !== current.endOffset;
      })) return false;
      if (entry.groups.length) {
        var groups = svgTextRange(entry.ranges);
        if (groups.length !== entry.groups.length || groups.some(function (group, index) {
          var previous = entry.groups[index];
          return group.text !== previous.text || group.start !== previous.start || group.end !== previous.end;
        })) return false;
      }
      return true;
    });
  }

  function setCommentLabels(labels) {
    if (!labels || typeof labels !== 'object') return;
    if (typeof labels.openOne === 'string') commentLabels.openOne = labels.openOne;
    if (typeof labels.openOther === 'string') commentLabels.openOther = labels.openOther;
    if (typeof labels.resolvedOne === 'string') commentLabels.resolvedOne = labels.resolvedOne;
    if (typeof labels.resolvedOther === 'string') commentLabels.resolvedOther = labels.resolvedOther;
  }

  function commentLabel(highlight) {
    var count = highlight.count || 1;
    var template =
      highlight.status === 'resolved'
        ? count === 1
          ? commentLabels.resolvedOne
          : commentLabels.resolvedOther
        : count === 1
          ? commentLabels.openOne
          : commentLabels.openOther;
    var label = template.replace(/\\{n\\}/g, String(count));
    return highlight.quotedText ? label + ': ' + highlight.quotedText : label;
  }

  function parseRgbColor(value) {
    if (!value || value === 'transparent') return null;
    var match = value.match(
      /^rgba?\\(\\s*([\\d.]+)\\s*,\\s*([\\d.]+)\\s*,\\s*([\\d.]+)(?:\\s*,\\s*([\\d.]+))?\\s*\\)$/,
    );
    if (!match) return null;
    return [
      parseFloat(match[1]),
      parseFloat(match[2]),
      parseFloat(match[3]),
      match[4] === undefined ? 1 : parseFloat(match[4]),
    ];
  }

  function rgbToLuminance(r, g, b) {
    return (
      0.2126 * (r / 255) + 0.7152 * (g / 255) + 0.0722 * (b / 255)
    );
  }

  function parseColorValue(value) {
    if (!value || value === 'transparent') return { type: 'none' };
    var rgb = parseRgbColor(value);
    if (rgb) {
      return { type: 'rgb', r: rgb[0], g: rgb[1], b: rgb[2], a: rgb[3] };
    }
    var modernMatch = value.match(
      /^oklch\\(\\s*([\\d.]+)(%?)[^/)]*(?:\\/\\s*([\\d.]+)(%?))?/,
    );
    if (modernMatch) {
      var lightness = parseFloat(modernMatch[1]);
      if (modernMatch[2] === '%') lightness = lightness / 100;
      var oklchAlpha =
        modernMatch[3] === undefined ? 1 : parseFloat(modernMatch[3]);
      if (modernMatch[4] === '%') oklchAlpha = oklchAlpha / 100;
      return { type: 'luminance', value: lightness, a: oklchAlpha };
    }
    modernMatch = value.match(
      /^lab\\(\\s*([\\d.]+)(%?)[^/)]*(?:\\/\\s*([\\d.]+)(%?))?/,
    );
    if (modernMatch) {
      var labLightness = parseFloat(modernMatch[1]);
      if (modernMatch[2] === '%') labLightness = labLightness / 100;
      else labLightness = labLightness / 100;
      var labAlpha = modernMatch[3] === undefined ? 1 : parseFloat(modernMatch[3]);
      if (modernMatch[4] === '%') labAlpha = labAlpha / 100;
      return { type: 'luminance', value: labLightness, a: labAlpha };
    }
    modernMatch = value.match(
      /^color\\(\\s*(?:display-p3|srgb)\\s+([\\d.]+)\\s+([\\d.]+)\\s+([\\d.]+)[^/)]*(?:\\/\\s*([\\d.]+)(%?))?/,
    );
    if (modernMatch) {
      var colorAlpha =
        modernMatch[4] === undefined ? 1 : parseFloat(modernMatch[4]);
      if (modernMatch[5] === '%') colorAlpha = colorAlpha / 100;
      return {
        type: 'luminance',
        value:
          0.2126 * parseFloat(modernMatch[1]) +
          0.7152 * parseFloat(modernMatch[2]) +
          0.0722 * parseFloat(modernMatch[3]),
        a: colorAlpha,
      };
    }
    return { type: 'none' };
  }

  function resolveBackgroundRgb(el) {
    while (el) {
      var parsed = parseColorValue(getComputedStyle(el).backgroundColor);
      if (parsed.type === 'none') {
        el = el.parentElement;
        continue;
      }
      if (parsed.type === 'luminance') {
        if (parsed.a === 0) {
          el = el.parentElement;
          continue;
        }
        var gray = parsed.value * 255;
        if (parsed.a < 1) {
          var ancestorRgb = resolveBackgroundRgb(el.parentElement);
          var lumAlpha = parsed.a;
          return [
            gray * lumAlpha + ancestorRgb[0] * (1 - lumAlpha),
            gray * lumAlpha + ancestorRgb[1] * (1 - lumAlpha),
            gray * lumAlpha + ancestorRgb[2] * (1 - lumAlpha),
          ];
        }
        return [gray, gray, gray];
      }
      if (parsed.type === 'rgb') {
        if (parsed.a === 0) {
          el = el.parentElement;
          continue;
        }
        if (parsed.a < 1) {
          var ancestorRgb = resolveBackgroundRgb(el.parentElement);
          var alpha = parsed.a;
          return [
            parsed.r * alpha + ancestorRgb[0] * (1 - alpha),
            parsed.g * alpha + ancestorRgb[1] * (1 - alpha),
            parsed.b * alpha + ancestorRgb[2] * (1 - alpha),
          ];
        }
        return [parsed.r, parsed.g, parsed.b];
      }
    }
    return [255, 255, 255];
  }

  function resolvedLuminance(element) {
    function resolveFrom(el) {
      while (el) {
        var parsed = parseColorValue(getComputedStyle(el).backgroundColor);
        if (parsed.type === 'none') {
          el = el.parentElement;
          continue;
        }
        if (parsed.type === 'luminance') {
          if (parsed.a === 0) {
            el = el.parentElement;
            continue;
          }
          if (parsed.a < 1) {
            var ancestor = resolveFrom(el.parentElement);
            var ancestorLum = ancestor !== null ? ancestor : 1;
            return parsed.value * parsed.a + ancestorLum * (1 - parsed.a);
          }
          return parsed.value;
        }
        if (parsed.type === 'rgb') {
          if (parsed.a === 0) {
            el = el.parentElement;
            continue;
          }
          if (parsed.a < 1) {
            var ancestorRgb = resolveBackgroundRgb(el.parentElement);
            var alpha = parsed.a;
            return rgbToLuminance(
              parsed.r * alpha + ancestorRgb[0] * (1 - alpha),
              parsed.g * alpha + ancestorRgb[1] * (1 - alpha),
              parsed.b * alpha + ancestorRgb[2] * (1 - alpha),
            );
          }
          return rgbToLuminance(parsed.r, parsed.g, parsed.b);
        }
      }
      return null;
    }
    var result = resolveFrom(element);
    return result !== null ? result : 1;
  }

  function isDarkBackground(element) {
    return resolvedLuminance(element) < 0.5;
  }

  function isDarkBackgroundForSvgText(text) {
    if (!text) return isDarkBackground(document.body);
    var fill = getComputedStyle(text).fill;
    var parsed = parseColorValue(fill);
    if (parsed.type === 'rgb' && parsed.a > 0) return rgbToLuminance(parsed.r, parsed.g, parsed.b) >= 0.5;
    if (parsed.type === 'luminance' && parsed.a > 0) return parsed.value >= 0.5;
    return isDarkBackground(text);
  }

  var svgActiveThreads = {};
  var svgOverlayStyles = new WeakMap();
  function textPaintCss() {
    return '.ash-comment-highlight-badge::after{content:attr(data-count);}' + textPaints.map(function (paint) {
      return '::highlight(' + paint.name + '){background-color:' + paint.palette.markBg + ';text-decoration:underline;text-decoration-color:' +
        (paint.active ? paint.palette.outline : paint.palette.markUnderline) + ';text-decoration-thickness:' + (paint.active ? '3px' : '2px') + ';}';
    }).join('');
  }
  function refreshTextPaints() {
    var style = document.getElementById('ash-comment-highlight-style');
    if (!style) return;
    var css = textPaintCss();
    if (style.textContent !== css) style.textContent = css;
  }
  function setSvgHighlightState(threadId, active) {
    textPaints.forEach(function (paint) { if (paint.threadId === threadId) paint.active = active || paint.target; });
    refreshTextPaints();
    var overlays = document.querySelectorAll('.ash-comment-highlight-svg[data-thread-id="' + CSS.escape(threadId) + '"]');
    for (var i = 0; i < overlays.length; i++) {
      var overlay = overlays[i];
      var palette = overlay.dataset.palette;
      if (!palette) continue;
      var parts = palette.split('|');
      var normalFill = parts[0];
      var outline = parts[1];
      var target = overlay.dataset.target === 'true';
      var state = active || target ? 'active' : 'normal';
      var applied = svgOverlayStyles.get(overlay);
      if (overlay.dataset.state !== state) overlay.dataset.state = state;
      if (applied && applied.state === state && overlay.getAttribute('style') === applied.style) continue;
      if (active || target) {
        overlay.style.fill = normalFill;
        overlay.style.stroke = outline;
        overlay.style.strokeWidth = '2';
        overlay.style.vectorEffect = 'non-scaling-stroke';
      } else {
        overlay.style.fill = normalFill;
        overlay.style.stroke = 'none';
        overlay.style.strokeWidth = '0';
      }
      svgOverlayStyles.set(overlay, { state: state, style: overlay.getAttribute('style') });
    }
  }

  function highlightPalette(isDark, resolved) {
    if (isDark) {
      if (resolved) {
        return {
          markBg: 'rgba(134,197,165,.14)',
          markUnderline: 'rgba(134,197,165,.75)',
          outline: '#86c5a5',
          badgeBorder: 'rgba(134,197,165,.75)',
          badgeText: '#86c5a5',
          badgeBg: '#1f2937',
          badgeTargetBorder: '#86c5a5',
          badgeTargetText: '#fff',
          badgeTargetBg: '#86c5a5',
        };
      }
      return {
        markBg: 'rgba(96,165,250,.16)',
        markUnderline: 'rgba(96,165,250,.85)',
        outline: '#60a5fa',
        badgeBorder: 'rgba(96,165,250,.85)',
        badgeText: '#60a5fa',
        badgeBg: '#1f2937',
        badgeTargetBorder: '#60a5fa',
        badgeTargetText: '#fff',
        badgeTargetBg: '#60a5fa',
      };
    }
    if (resolved) {
      return {
        markBg: 'rgba(68,131,97,.12)',
        markUnderline: 'rgba(68,131,97,.58)',
        outline: '#448361',
        badgeBorder: 'rgba(68,131,97,.36)',
        badgeText: '#448361',
        badgeBg: '#fff',
        badgeTargetBorder: '#448361',
        badgeTargetText: '#fff',
        badgeTargetBg: '#448361',
      };
    }
    return {
      markBg: 'rgba(37,99,235,.16)',
      markUnderline: 'rgba(37,99,235,.72)',
      outline: '#2383e2',
      badgeBorder: 'rgba(35,131,226,.44)',
      badgeText: '#2383e2',
      badgeBg: '#fff',
      badgeTargetBorder: '#2383e2',
      badgeTargetText: '#fff',
      badgeTargetBg: '#2383e2',
    };
  }

  function badgeStyleForHighlight(highlight, isDark) {
    var palette = highlightPalette(isDark, highlight.status === 'resolved');
    var base =
      'display:inline-flex;align-items:center;gap:4px;min-height:16px;padding:0 5px;border-radius:999px;font:700 10px system-ui,sans-serif;box-shadow:0 2px 8px rgba(27,39,35,.08);cursor:pointer;touch-action:none;position:absolute;z-index:2147483646;';
    var borderColor;
    var textColor;
    var bgColor;
    if (highlight.target) {
      borderColor = palette.badgeTargetBorder;
      textColor = palette.badgeTargetText;
      bgColor = palette.badgeTargetBg;
    } else {
      borderColor = palette.badgeBorder;
      textColor = palette.badgeText;
      bgColor = palette.badgeBg;
    }
    return (
      base +
      'border:1px solid ' +
      borderColor +
      ';color:' +
      textColor +
      ';background:' +
      bgColor +
      ';'
    );
  }

  function positionSingleBadge(entry) {
    var badge = entry.badge;
    var rects = measureBadgeEntry(entry);
    var rect = rects.length ? rects[rects.length - 1] : null;
    if (!rect || rect.width === 0 || rect.height === 0) {
      badge.style.display = 'none';
      return;
    }
    badge.style.display = 'inline-flex';
    badge.style.left = '0px';
    badge.style.top = '0px';
    var base = badge.getBoundingClientRect();
    var scaleX = badge.offsetWidth ? base.width / badge.offsetWidth : 1;
    var scaleY = badge.offsetHeight ? base.height / badge.offsetHeight : 1;
    if (!scaleX || !isFinite(scaleX)) scaleX = 1;
    if (!scaleY || !isFinite(scaleY)) scaleY = 1;
    var badgeHeight = badge.offsetHeight || 16;
    var threadId = badge.dataset.threadId;
    var offset = badgeOffsets[threadId] || { x: 0, y: 0 };
    badge.style.left =
      (rect.right - base.left) / scaleX - 6 + offset.x + 'px';
    badge.style.top =
      (rect.top - base.top) / scaleY - badgeHeight + 3 + offset.y + 'px';
  }

  function positionBadges() {
    var layouts = [];
    for (var i = 0; i < badges.length; i++) {
      var badge = badges[i].badge;
      var rects = measureBadgeEntry(badges[i]);
      var rect = rects.length ? rects[rects.length - 1] : null;
      badge.style.display = 'inline-flex';
      badge.style.left = '0px';
      badge.style.top = '0px';
      var base = badge.getBoundingClientRect();
      var scaleX = badge.offsetWidth ? base.width / badge.offsetWidth : 1;
      var scaleY = badge.offsetHeight ? base.height / badge.offsetHeight : 1;
      if (!scaleX || !isFinite(scaleX)) scaleX = 1;
      if (!scaleY || !isFinite(scaleY)) scaleY = 1;
      layouts.push({
        badge: badge,
        rect: rect,
        base: base,
        badgeHeight: badge.offsetHeight || 16,
        scaleX: scaleX,
        scaleY: scaleY,
        threadId: badge.dataset.threadId,
      });
    }
    for (var j = 0; j < layouts.length; j++) {
      var layout = layouts[j];
      if (
        !layout.rect ||
        layout.rect.width === 0 ||
        layout.rect.height === 0
      ) {
        layout.badge.style.display = 'none';
        continue;
      }
      var offset = badgeOffsets[layout.threadId] || { x: 0, y: 0 };
      layout.badge.style.display = 'inline-flex';
      layout.badge.style.left =
        (layout.rect.right - layout.base.left) / layout.scaleX -
        6 +
        offset.x +
        'px';
      layout.badge.style.top =
        (layout.rect.top - layout.base.top) / layout.scaleY -
        layout.badgeHeight +
        3 +
        offset.y +
        'px';
    }
  }

  function isBadgeAnchorVisible(element) {
    // Visibility affects badge geometry, not selector text or painted ranges.
    if (!element) return false;
    var visibility = getComputedStyle(element).visibility;
    if (visibility === 'hidden' || visibility === 'collapse') return false;
    var boxedElement = element;
    while (boxedElement && getComputedStyle(boxedElement).display === 'contents') {
      boxedElement = boxedElement.parentElement;
    }
    return !!boxedElement && !!boxedElement.getClientRects().length &&
      (!boxedElement.checkVisibility || boxedElement.checkVisibility());
  }

  function measureBadgeEntry(entry) {
    if (entry.measure) return entry.measure();
    return [];
  }

  var badgePositionFrame = 0;
  function schedulePositionBadges() {
    if (badgePositionFrame) return;
    badgePositionFrame = requestAnimationFrame(function () {
      badgePositionFrame = 0;
      positionBadges();
    });
  }

  function svgTextRange(ranges) {
    return ranges.flatMap(function (range) {
      var node = range.startContainer;
      if (!node.parentElement.closest('svg text')) return [];
      // SVG character indexes are local to the text content element. A tspan
      // avoids counting indentation or collapsed separators in sibling spans.
      var text = node.parentElement.closest('text,tspan,textPath');
      if (!text || !text.getNumberOfChars) return [];
      var walker = document.createTreeWalker(text, NodeFilter.SHOW_TEXT);
      var raw = [], collapsed = [], candidate;
      var whitespace = false;
      while ((candidate = walker.nextNode())) {
        var value = candidate.nodeValue || '';
        for (var offset = 0; offset < value.length; offset++) {
          var unit = { node: candidate, offset: offset };
          raw.push([unit]);
          if (/[\\t\\n\\r ]/.test(value[offset])) {
            if (!collapsed.length) continue;
            if (whitespace) collapsed[collapsed.length - 1].push(unit);
            else collapsed.push([unit]);
            whitespace = true;
          } else {
            collapsed.push([unit]);
            whitespace = false;
          }
        }
      }
      if (whitespace) collapsed.pop();
      var count = text.getNumberOfChars();
      var characters = collapsed.length === count ? collapsed : raw.length === count ? raw : null;
      // Do not guess glyph offsets when the browser's shaping disagrees.
      if (!characters) return [];
      var start = -1, end = -1;
      characters.forEach(function (units, index) {
        if (units.some(function (unit) { return unit.node === node && unit.offset >= range.startOffset && unit.offset < range.endOffset; })) {
          if (start < 0) start = index;
          end = index + 1;
        }
      });
      return start < 0 ? [] : [{ text: text, start: start, end: end }];
    });
  }

  function wrapSvgRange(highlight, groups) {
    if (!groups.length) return false;
    var texts = groups.map(function (group) { return group.text; }).filter(function (text, index, all) { return all.indexOf(text) === index; });
    var first = texts[0];
    var svg = first && first.ownerSVGElement;
    while (svg && svg.ownerSVGElement) svg = svg.ownerSVGElement;
    if (!svg || !svg.parentNode) return false;
    ensureCommentStyles();
    var overlays = {};
    var badgeEntry = { badge: null, highlight: highlight, overlays: overlays, measure: measureSvgRange };

    function overlayKey(text, index) {
      return texts.indexOf(text) + ':' + index;
    }

    function setAttributeIfChanged(shape, name, value) {
      value = String(value);
      if (shape.getAttribute(name) !== value) shape.setAttribute(name, value);
    }

    function updateOverlay(text, index, box, screenCtm) {
      var highlight = badgeEntry.highlight;
      var key = overlayKey(text, index);
      var shape = overlays[key];
      if (!shape) {
        shape = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        shape.setAttribute('class', 'ash-comment-highlight-svg');
        shape.setAttribute('data-anchor-ignore', '');
        shape.setAttribute('pointer-events', 'none');
        shape.dataset.threadId = highlight.threadId;
        shape.dataset.target = highlight.target ? 'true' : 'false';
        var palette = highlightPalette(isDarkBackgroundForSvgText(text), highlight.status === 'resolved');
        shape.dataset.palette = palette.markBg + '|' + palette.outline;
        // Shapes must be siblings of <text>, not children of a <text>/<tspan>.
        var textRoot = text.closest('text');
        textRoot.parentNode.insertBefore(shape, textRoot);
        overlays[key] = shape;
      }
      var scaleX = screenCtm ? Math.hypot(screenCtm.a, screenCtm.b) : 1;
      var scaleY = screenCtm ? Math.hypot(screenCtm.c, screenCtm.d) : 1;
      var padX = scaleX ? 2 / scaleX : 2;
      var padY = scaleY ? 2 / scaleY : 2;
      setAttributeIfChanged(shape, 'x', box.x - padX);
      setAttributeIfChanged(shape, 'y', box.y - padY);
      setAttributeIfChanged(shape, 'width', box.width + padX * 2);
      setAttributeIfChanged(shape, 'height', box.height + padY * 2);
      var textCtm = text.getCTM ? text.getCTM() : null;
      var parentCtm = shape.parentNode && shape.parentNode.getCTM ? shape.parentNode.getCTM() : null;
      if (textCtm && parentCtm && parentCtm.inverse) {
        var matrix = parentCtm.inverse().multiply(textCtm);
        setAttributeIfChanged(shape,
          'transform',
          'matrix(' + [matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f].join(' ') + ')',
        );
      } else if (shape.hasAttribute('transform')) {
        shape.removeAttribute('transform');
      }
      return shape;
    }

    function measureSvgRange() {
      var current = [];
      var lastElement = null;
      var usedOverlays = {};
      for (var i = 0; i < groups.length; i++) {
        var group = groups[i];
        var ctm = group.text.getScreenCTM ? group.text.getScreenCTM() : null;
        var runs = [];
        for (var index = group.start; index < group.end; index++) {
          try {
            var box = group.text.getExtentOfChar(index);
            if (!box || box.width < 0 || box.height <= 0) continue;
            var previous = runs.length ? runs[runs.length - 1] : null;
            var overlapsVertically =
              previous &&
              box.y <= previous.y + previous.height &&
              previous.y <= box.y + box.height;
            var sameLine =
              previous &&
              overlapsVertically &&
              box.x <= previous.x + previous.width + Math.max(4, box.height * 0.5);
            if (sameLine) {
              var runRight = Math.max(previous.x + previous.width, box.x + box.width);
              var runBottom = Math.max(previous.y + previous.height, box.y + box.height);
              previous.x = Math.min(previous.x, box.x);
              previous.y = Math.min(previous.y, box.y);
              previous.width = runRight - previous.x;
              previous.height = runBottom - previous.y;
            } else {
              runs.push({ x: box.x, y: box.y, width: box.width, height: box.height });
            }
          } catch (e) {}
        }
        for (var runIndex = 0; runIndex < runs.length; runIndex++) {
          try {
            var run = runs[runIndex];
            var overlayIndex = i + '-' + runIndex;
            var overlay = updateOverlay(group.text, overlayIndex, run, ctm);
            var display = isBadgeAnchorVisible(group.text) ? 'inline' : 'none';
            if (overlay.style.display !== display) overlay.style.display = display;
            usedOverlays[overlayKey(group.text, overlayIndex)] = true;
            var points = [
              [run.x, run.y],
              [run.x + run.width, run.y],
              [run.x, run.y + run.height],
              [run.x + run.width, run.y + run.height],
            ].map(function (point) {
              return ctm
                ? new DOMPoint(point[0], point[1]).matrixTransform(ctm)
                : { x: point[0], y: point[1] };
            });
            var left = Math.min.apply(null, points.map(function (point) { return point.x; }));
            var top = Math.min.apply(null, points.map(function (point) { return point.y; }));
            var right = Math.max.apply(null, points.map(function (point) { return point.x; }));
            var bottom = Math.max.apply(null, points.map(function (point) { return point.y; }));
            if (right > left && bottom > top) {
              current.push({ left: left, right: right, top: top, width: right - left, height: bottom - top });
              lastElement = group.text;
            }
          } catch (e) {}
        }
      }
      Object.keys(overlays).forEach(function (key) {
        if (!usedOverlays[key]) {
          overlays[key].remove();
          delete overlays[key];
        }
      });
      setSvgHighlightState(
        highlight.threadId,
        svgActiveThreads[highlight.threadId] === true,
      );
      if (current.length) return isBadgeAnchorVisible(lastElement) ? current : [];
      if (!isBadgeAnchorVisible(first)) return [];
      var fallback = first.getBoundingClientRect ? first.getBoundingClientRect() : null;
      if (!fallback || fallback.width === 0 || fallback.height === 0) {
        fallback = svg.getBoundingClientRect ? svg.getBoundingClientRect() : null;
      }
      return fallback ? [fallback] : [];
    }

    var badge = takeBadge(highlight);
    badge.setAttribute('data-anchor-ignore', '');
    badge.type = 'button';
    badge.className = 'ash-comment-highlight-badge';
    badge.dataset.threadId = highlight.threadId;
    badge.dataset.count = String(highlight.count || 1);
    badge.setAttribute('aria-label', commentLabel(highlight));
    badge.innerHTML =
      highlight.status === 'resolved'
        ? '<svg viewBox="0 0 24 24" width="10" height="10" style="width:10px;height:10px;flex:none;border:0;padding:0;margin:0;background:none;box-shadow:none" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>'
        : '<svg viewBox="0 0 24 24" width="10" height="10" style="width:10px;height:10px;flex:none;border:0;padding:0;margin:0;background:none;box-shadow:none" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z"/></svg>';
    badge.style.cssText = badgeStyleForHighlight(highlight, isDarkBackgroundForSvgText(first));
    badgeEntry.badge = badge;
    badges.push(badgeEntry);
    measureSvgRange();
    return true;
  }

  function wrapRange(highlight, ranges, covered) {
    if (!ranges.length) return;
    var groups = !covered && document.querySelector('svg text') ? svgTextRange(ranges) : [];
    paintedAnchors.push({ highlight: highlight, ranges: ranges, groups: groups });
    if (covered) return;
    var svgWrapped = wrapSvgRange(highlight, groups);
    ensureCommentStyles();
    var name = 'ash-comment-' + highlightNames.length;
    var palette = highlightPalette(isDarkBackground(ranges[0].startContainer.parentElement), highlight.status === 'resolved');
    if (typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight !== 'undefined') {
      var paint = new Highlight(...ranges);
      CSS.highlights.set(name, paint);
      highlightNames.push(name);
      textPaints.push({ name: name, highlight: paint, ranges: ranges, threadId: highlight.threadId, palette: palette, active: highlight.target, target: highlight.target });
      refreshTextPaints();
    }
    if (svgWrapped) return;
    var badge = takeBadge(highlight);
    badge.setAttribute('data-anchor-ignore', '');
    badge.type = 'button';
    badge.className = 'ash-comment-highlight-badge';
    badge.setAttribute('aria-label', commentLabel(highlight));
    badge.dataset.threadId = highlight.threadId;
    badge.dataset.count = String(highlight.count || 1);
    badge.style.cssText = badgeStyleForHighlight(highlight, isDarkBackground(ranges[0].startContainer.parentElement));
    badges.push({ badge: badge, highlight: highlight, measure: function () {
      var rects = [];
      var lastElement = null;
      ranges.forEach(function (range) {
        var current = Array.from(range.getClientRects());
        if (current.length) {
          rects.push(...current);
          lastElement = range.startContainer.parentElement;
        }
      });
      return isBadgeAnchorVisible(lastElement) ? rects : [];
    }});
  }

  function takeBadge(highlight) {
    var badge = reusableBadges.get(highlight.threadId);
    if (badge) reusableBadges.delete(highlight.threadId);
    else {
      badge = document.createElement('button');
      bindBadgePointer(badge);
    }
    if (!badge.isConnected) document.documentElement.appendChild(badge);
    return badge;
  }

  function missingState(id) {
    if (!checkingDeadlines[id]) checkingDeadlines[id] = Date.now() + 3000;
    return Date.now() < checkingDeadlines[id] ? 'checking' : 'needs-check';
  }
  function scheduleChecking() {
    if (checkingTimer) clearTimeout(checkingTimer);
    var deadlines = Object.values(checkingDeadlines).filter(function (deadline) { return deadline > Date.now(); });
    if (!deadlines.length) { checkingTimer = null; return; }
    checkingTimer = setTimeout(function () {
      checkingTimer = null;
      var engine = createTextAnchorEngine(anchorRoot());
      applyHighlights(pendingHighlights, engine); verifyAnchors(pendingAnchors, engine);
    }, Math.max(1, Math.min.apply(null, deadlines) - Date.now()));
  }

  function applyHighlights(list, engine) {
    anchorSnapshotGeneration++;
    pendingHighlights = Array.isArray(list) ? list : [];
    if (!pendingHighlights.length) { lastResolutionSignature = ''; clearMarks(); return; }
    var forcePaint = !!engine;
    engine = engine || createTextAnchorEngine(anchorRoot());
    measuredText = engine.text;
    var results = [];
    var resolvedHighlights = pendingHighlights.map(function (highlight) {
      var resolved = engine.resolve(highlight);
      return { highlight: resolved ? { ...highlight, ...resolved } : highlight, resolved: resolved,
        ranges: resolved ? engine.ranges(resolved.textStart, resolved.textEnd) : [] };
    });
    var highlightsById = new Map(resolvedHighlights.map(function (entry) { return [entry.highlight.threadId, entry]; }));
    // Metadata echoes retain paint only while its DOM ranges and owned nodes survive.
    var paintKey = JSON.stringify(resolvedHighlights.map(function (entry) {
      var palettes = entry.ranges.map(function (range) {
        var element = range.startContainer.parentElement;
        var svgText = element.closest('svg text') && element.closest('text,tspan,textPath');
        return [isDarkBackground(element), svgText ? isDarkBackgroundForSvgText(svgText) : null];
      });
      return [entry.highlight.threadId, entry.highlight.status, entry.highlight.target, palettes,
        entry.resolved && entry.resolved.textStart, entry.resolved && entry.resolved.textEnd];
    }).sort(function (left, right) { return left[0].localeCompare(right[0]); }));
    var repaint = forcePaint || appliedHighlightKey !== paintKey || !paintIntact(highlightsById);
    if (repaint) clearMarks(true);
    else {
      paintedAnchors.forEach(function (entry) { entry.highlight = highlightsById.get(entry.highlight.threadId).highlight; });
      badges.forEach(function (entry) {
        var highlight = highlightsById.get(entry.highlight.threadId).highlight;
        entry.highlight = highlight;
        if (entry.badge.dataset.threadId !== highlight.threadId) entry.badge.dataset.threadId = highlight.threadId;
        var count = String(highlight.count || 1), label = commentLabel(highlight);
        if (entry.badge.dataset.count !== count) entry.badge.dataset.count = count;
        if (entry.badge.getAttribute('aria-label') !== label) entry.badge.setAttribute('aria-label', label);
      });
    }
    resolvedHighlights.forEach(function (entry) {
      var highlight = entry.highlight, resolved = entry.resolved;
      var covered = resolved && highlight.status === 'resolved' && resolvedHighlights.some(function (other) {
        return other.highlight.status !== 'resolved' && other.resolved &&
          resolved.textStart < other.resolved.textEnd && other.resolved.textStart < resolved.textEnd;
      });
      if (resolved) {
        delete checkingDeadlines[highlight.threadId];
        if (repaint) wrapRange(entry.highlight, entry.ranges, covered);
      }
      results.push({ threadId: highlight.threadId,
        state: resolved ? 'attached' : missingState(highlight.threadId),
        textStart: resolved ? resolved.textStart : null,
        textEnd: resolved ? resolved.textEnd : null,
        textHash: resolved ? engine.hash : null });
    });
    reusableBadges.forEach(function (badge) { badge.remove(); });
    reusableBadges.clear();
    appliedHighlightKey = paintKey;
    positionBadges();
    var signature = JSON.stringify([documentToken, displayedVersionId, displayedPath, results.map(function (result) {
      return [result.threadId, result.state, result.textStart, result.textEnd];
    })]);
    if (signature !== lastResolutionSignature) for (var offset = 0; offset < results.length; offset += 100) {
      send({ kind: 'anchor-resolutions', token: documentToken, versionId: displayedVersionId,
        targetPath: displayedPath, generation: ++resolutionGeneration, results: results.slice(offset, offset + 100) });
    }
    lastResolutionSignature = signature;
    scheduleChecking();
  }

  function invalidateChangedPaint(engine) {
    paintedAnchors = paintedAnchors.filter(function (entry) {
      // Measure the entire span, including newly inserted nodes between pieces.
      var first = entry.ranges[0];
      var last = entry.ranges[entry.ranges.length - 1];
      if (engine.paintedText(first, last) === engine.normalizedQuote(entry.highlight)) return true;
      appliedHighlightKey = '';
      var id = entry.highlight.threadId;
      textPaints = textPaints.filter(function (paint) {
        if (paint.threadId !== id) return true;
        if (typeof CSS !== 'undefined' && CSS.highlights) CSS.highlights.delete(paint.name);
        return false;
      });
      badges = badges.filter(function (entry) {
        if (entry.badge.dataset.threadId !== id) return true;
        entry.badge.remove(); return false;
      });
      document.querySelectorAll('.ash-comment-highlight-svg').forEach(function (shape) {
        if (shape.dataset.threadId === id) shape.remove();
      });
      return false;
    });
  }

  var observedAnchorRoot = anchorRoot();
  var anchorObserver = new MutationObserver(function (records) {
    var root = anchorRoot();
    var rootReplaced = root !== observedAnchorRoot;
    observedAnchorRoot = root;
    // Exclusion changes can arrive while a text debounce is pending, including
    // on nodes now ignored by the normal mutation filter. Never reuse that snapshot.
    if (rootReplaced || records.some(function (record) {
      return record.type === 'attributes' &&
        (record.attributeName === 'data-anchor-ignore' || record.attributeName === 'data-comment-ui' ||
          record.attributeName === 'class');
    })) anchorSnapshotGeneration++;
    if (!root || !document.body || (!pendingHighlights.length && !pendingAnchors.length)) return;
    var relevant = records.filter(function (record) {
      if (record.type !== 'attributes' && !root.contains(record.target)) return false;
      var element = record.target.nodeType === 1 ? record.target : record.target.parentElement;
      if (element && element.closest('[data-anchor-ignore],#ash-comment-highlight-style')) return false;
      if (record.type === 'childList' && Array.from(record.addedNodes).concat(Array.from(record.removedNodes)).every(function (node) {
        return node.nodeType === 1 && (node.hasAttribute('data-anchor-ignore') || node.id === 'ash-comment-highlight-style');
      })) return false;
      return true;
    });
    if (!rootReplaced && !relevant.length) return;
    // Layout changes never alter anchor text, but live range geometry may change.
    schedulePositionBadges();
    if (rootReplaced || relevant.some(function (record) { return record.type !== 'attributes'; })) {
      // Observe ancestors too: replacing the content root invalidates its ranges.
      rebuildAfterMutations();
    }
  });
  function rebuildAfterMutations() {
    var hasText = pendingHighlights.length || pendingAnchors.some(function (anchor) { return anchor.kind === 'text'; });
    if (!hasText) { verifyAnchors(pendingAnchors); return; }
    var engine = createTextAnchorEngine(anchorRoot());
    if (engine.text === measuredText) {
      // Ranges are live DOM objects: rebuild even for equal-value node replacement.
      clearTimeout(resolveTimer); resolveStartedAt = 0;
      applyHighlights(pendingHighlights, engine); verifyAnchors(pendingAnchors, engine);
    } else {
      invalidateChangedPaint(engine);
      clearTimeout(resolveTimer);
      if (!resolveStartedAt) resolveStartedAt = Date.now();
      var snapshotGeneration = anchorSnapshotGeneration;
      resolveTimer = setTimeout(function () {
        resolveStartedAt = 0;
        if (snapshotGeneration !== anchorSnapshotGeneration) engine = createTextAnchorEngine(anchorRoot());
        applyHighlights(pendingHighlights, engine); verifyAnchors(pendingAnchors, engine);
      }, Math.min(300, Math.max(0, 1000 - (Date.now() - resolveStartedAt))));
    }
  }
  anchorObserver.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
  window.addEventListener('pagehide', function () {
    anchorObserver.disconnect(); clearTimeout(resolveTimer); clearTimeout(checkingTimer);
    cancelAnimationFrame(badgePositionFrame); clearMarks();
  });

  function scrollToThread(id) {
    var painted = paintedAnchors.find(function (entry) { return entry.highlight.threadId === id; });
    if (painted && painted.ranges.length) {
      var start = painted.ranges[0].startContainer;
      var target = start.nodeType === 1 ? start : start.parentElement;
      if (target) {
        target.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
        // The parent may be an entire code block or paragraph. Reveal the
        // verified text rect within each scrollport, from the inside out.
        var range = painted.ranges[0];
        for (var ancestor = target; ancestor && ancestor !== document.scrollingElement; ancestor = ancestor.parentElement) {
          var style = getComputedStyle(ancestor);
          var scrollX = /(auto|scroll|hidden|overlay)/.test(style.overflowX) && ancestor.scrollWidth > ancestor.clientWidth;
          var scrollY = /(auto|scroll|hidden|overlay)/.test(style.overflowY) && ancestor.scrollHeight > ancestor.clientHeight;
          if (!scrollX && !scrollY) continue;
          var rect = range.getClientRects()[0];
          if (!rect) return;
          var box = ancestor.getBoundingClientRect();
          var scaleX = ancestor.offsetWidth ? box.width / ancestor.offsetWidth : 1;
          var scaleY = ancestor.offsetHeight ? box.height / ancestor.offsetHeight : 1;
          if (!scaleX || !scaleY) continue;
          var left = box.left + ancestor.clientLeft * scaleX;
          var top = box.top + ancestor.clientTop * scaleY;
          var width = ancestor.clientWidth * scaleX;
          var height = ancestor.clientHeight * scaleY;
          var dx = rect.left < left || rect.width > width ? rect.left - left : Math.max(0, rect.right - left - width);
          ancestor.scrollBy({
            left: scrollX ? dx / scaleX : 0,
            top: scrollY ? (rect.top + rect.height / 2 - top - height / 2) / scaleY : 0,
            behavior: 'instant',
          });
        }
        var visible = range.getClientRects()[0];
        if (visible) {
          var viewportWidth = document.documentElement.clientWidth;
          window.scrollBy({
            left: visible.left < 0 || visible.width > viewportWidth ? visible.left : Math.max(0, visible.right - viewportWidth),
            top: visible.top + visible.height / 2 - document.documentElement.clientHeight / 2,
            behavior: 'instant',
          });
        }
        schedulePositionBadges();
      }
      return;
    }
    var element = document.querySelector(
      '.ash-comment-highlight[data-thread-id="' + CSS.escape(id) + '"], .ash-comment-highlight-badge[data-thread-id="' + CSS.escape(id) + '"], .ash-comment-highlight-svg[data-thread-id="' + CSS.escape(id) + '"]',
    );
    if (element) element.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  function hitComment(event) {
    // Firefox can give keyboard link activation a positive click count.
    // PointerEvent uses an empty pointerType for non-pointer activation;
    // older Firefox MouseEvents identify keyboard input with source 6.
    if (!trusted(event) || (event.type === 'click' && (
      event.detail <= 0 || event.pointerType === '' || event.mozInputSource === 6
    ))) return null;
    for (var index = 0; index < badges.length; index++) {
      var rects = measureBadgeEntry(badges[index]);
      if (Array.from(rects).some(function (rect) {
        return event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
      })) return badges[index].badge;
    }
    return null;
  }
  document.addEventListener('click', function (event) {
    var selection = getSelection();
    if (selection && !selection.isCollapsed) return;
    var badge = hitComment(event);
    if (!badge) return;
    selectThreadFromElement(badge, rectFromPointer(event, badge.getBoundingClientRect()));
    event.preventDefault(); event.stopPropagation();
  });

  function rectFromPointer(event, fallback) {
    if (
      event.detail !== 0 &&
      typeof event.clientX === 'number' &&
      typeof event.clientY === 'number'
    ) {
      return {
        top: event.clientY - 8,
        left: event.clientX,
        width: 1,
        height: 16,
      };
    }
    return fallback;
  }

  function bindBadgePointer(badge) {
    var dragState = null;
    var badgeEntry = null;

    function finishDrag(event) {
      if (!dragState || event.pointerId !== dragState.pointerId) return;
      if (event.type === 'pointerup' && dragState.dragged) badgeDragged = true;
      try {
        badge.releasePointerCapture(event.pointerId);
      } catch (e) {}
      dragState = null;
    }

    badge.addEventListener('pointerdown', function (event) {
      badgeDragged = false;
      if (event.button !== 0) return;
      for (var i = 0; i < badges.length; i++) {
        if (badges[i].badge === badge) {
          badgeEntry = badges[i];
          break;
        }
      }
      var threadId = badge.dataset.threadId;
      var offset = badgeOffsets[threadId] || { x: 0, y: 0 };
      dragState = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        offsetX: offset.x,
        offsetY: offset.y,
        dragged: false,
      };
      try {
        badge.setPointerCapture(event.pointerId);
      } catch (e) {}
      event.preventDefault();
    });

    badge.addEventListener('pointermove', function (event) {
      if (!dragState || event.pointerId !== dragState.pointerId) return;
      var dx = event.clientX - dragState.startX;
      var dy = event.clientY - dragState.startY;
      if (!dragState.dragged && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) {
        dragState.dragged = true;
      }
      if (!dragState.dragged) return;
      var threadId = badge.dataset.threadId;
      badgeOffsets[threadId] = {
        x: dragState.offsetX + dx,
        y: dragState.offsetY + dy,
      };
      if (badgeEntry) positionSingleBadge(badgeEntry);
    });

    badge.addEventListener('pointerup', finishDrag);
    badge.addEventListener('pointercancel', finishDrag);

    badge.addEventListener('click', function (event) {
      if (badgeDragged) {
        badgeDragged = false;
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      var r = badge.getBoundingClientRect();
      selectThreadFromElement(badge, rectFromPointer(event, r));
      event.preventDefault();
      event.stopPropagation();
    });
    function updateSvgActive(active) {
      svgActiveThreads[badge.dataset.threadId] = active;
      setSvgHighlightState(badge.dataset.threadId, active);
    }
    badge.addEventListener('pointerenter', function () { updateSvgActive(true); });
    badge.addEventListener('pointerleave', function () { updateSvgActive(document.activeElement === badge); });
    badge.addEventListener('focus', function () { updateSvgActive(true); });
    badge.addEventListener('blur', function () { updateSvgActive(badge.matches(':hover')); });
  }

  function selectThreadFromElement(element, rect) {
    send({
      kind: 'comment-thread-selected',
      threadId: element.dataset.threadId,
      rect: {
        top: rect.top,
        left: rect.left,
        width: rect.width,
        height: rect.height,
      },
    });
  }

  function sendOutsidePointerDown(event) {
    if (!textAnchorsEnabled || hitComment(event)) return;
    var target = event.target;
    if (
      target &&
      target.closest &&
      target.closest(
        '.ash-comment-highlight, .ash-comment-highlight-badge, [data-code-copy]',
      )
    ) {
      return;
    }
    send({ kind: 'comment-outside-pointer-down' });
  }

  function updateMarkdownToc() {
    var links = document.querySelectorAll('.md-toc a[href^="#"]');
    if (!links.length) return;
    var activeId = null;
    for (var index = 0; index < links.length; index++) {
      var id = links[index].getAttribute('href').slice(1);
      var heading = document.getElementById(id);
      if (heading && heading.getBoundingClientRect().top <= 96) activeId = id;
    }
    if (!activeId) activeId = links[0].getAttribute('href').slice(1);
    for (var linkIndex = 0; linkIndex < links.length; linkIndex++) {
      if (links[linkIndex].getAttribute('href').slice(1) === activeId) {
        links[linkIndex].setAttribute('aria-current', 'location');
      } else {
        links[linkIndex].removeAttribute('aria-current');
      }
    }
  }

  var annotateModeEnabled = false;
  var annotateHoverElement = null;

  function ensureAnnotateStyles() {
    if (document.getElementById('as-preview-annotate-style')) return;
    var style = document.createElement('style');
    style.setAttribute('data-anchor-ignore', '');
    style.id = 'as-preview-annotate-style';
    style.textContent =
      '.as-preview-annotate-hover{outline:2px solid #6366f1 !important;outline-offset:2px;}' +
      '.as-preview-pinged{outline:2px solid #6366f1 !important;outline-offset:2px;background-color:rgba(99,102,241,0.12) !important;transition:background-color 0.4s ease;}' +
      '.as-preview-flash{background-color:rgba(34,197,94,0.35) !important;transition:background-color 1s ease;}' +
      '.as-preview-flash-fade{background-color:transparent !important;}';
    document.head.appendChild(style);
  }

  function annotateTargetFrom(target) {
    if (!target || target.nodeType !== 1) return null;
    if (target === document.body || target === document.documentElement) return null;
    if (target.closest && target.closest('[data-comment-ui]')) return null;
    return target;
  }

  function clearAnnotateHover() {
    if (annotateHoverElement) {
      annotateHoverElement.classList.remove('as-preview-annotate-hover');
      annotateHoverElement = null;
    }
  }

  function elementLabel(el) {
    var quote = function (text) {
      return '\x22' + text + '\x22';
    };
    var tag = el.nodeName.toLowerCase();
    var ariaLabel = el.getAttribute && el.getAttribute('aria-label');
    if (ariaLabel) return tag + ' ' + quote(ariaLabel.trim());
    var text = (el.textContent || '').replace(/\\s+/g, ' ').trim();
    if (text) return tag + ' ' + quote(text.slice(0, 25));
    if (tag === 'img') {
      var alt = el.getAttribute('alt');
      if (alt) return 'img ' + quote(alt.trim());
    }
    var role = el.getAttribute && el.getAttribute('role');
    if (role) return tag + ' [role=' + role + ']';
    return tag;
  }

  function siblingText(el) {
    return el && el.textContent
      ? el.textContent.replace(/\\s+/g, ' ').trim().slice(0, 40)
      : '';
  }

  function annotateContextText(el) {
    var own = (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 100);
    var before = siblingText(el.previousElementSibling);
    var after = siblingText(el.nextElementSibling);
    var parts = [own];
    if (before) parts.push('[before: ' + before + ']');
    if (after) parts.push('[after: ' + after + ']');
    return parts.join(' ').trim();
  }

  /** Re-resolve saved anchors against the reloaded document.
   *
   * The captured selector is positional, so it answers the wrong question
   * twice over: inserting anything above the target breaks a path that still
   * has its element, and deleting the first of two identical items leaves the
   * path quietly matching the survivor. What identifies the target is its own
   * content, so that is what is searched for; the captured surroundings only
   * decide between several equal candidates. */
  function verifyAnchors(anchors, engine) {
    anchorSnapshotGeneration++;
    pendingAnchors = anchors || [];
    if (!pendingAnchors.length) return;
    var verdicts = [];
    if (!engine && pendingAnchors.some(function (anchor) { return anchor.kind === 'text'; })) engine = createTextAnchorEngine(anchorRoot());
    for (var i = 0; i < (anchors || []).length; i++) {
      var anchor = anchors[i] || {};
      var attached = false;
      if (anchor.kind === 'element') {
        attached = findElement(anchor) !== null;
      } else if (anchor.kind === 'text') {
        attached = engine.resolve(anchor) !== null;
      }
      if (attached) delete checkingDeadlines[anchor.thread];
      verdicts.push({ thread: anchor.thread, attached: attached, position_state: attached ? 'attached' : missingState(anchor.thread) });
    }
    send({ kind: 'anchor-verdicts', verificationId: pendingVerificationId, generation: ++resolutionGeneration, verdicts: verdicts });
    scheduleChecking();
  }

  function findElement(anchor) {
    if (!anchor.ownText) {
      // Nothing to search for, so the selector is all there is.
      try { return document.querySelector(anchor.selector); } catch (error) { return null; }
    }
    var peers = anchor.tagName
      ? anchorRoot().getElementsByTagName(anchor.tagName)
      : anchorRoot().getElementsByTagName('*');
    var matches = [];
    for (var i = 0; i < peers.length; i++) {
      if (ownText(peers[i]) === anchor.ownText) matches.push(peers[i]);
    }
    if (matches.length === 0) return null;
    if (matches.length === 1) return matches[0];
    for (var j = 0; j < matches.length; j++) {
      if (annotateContextText(matches[j]) === anchor.contextText) return matches[j];
    }
    // Several identical candidates and none in the captured surroundings:
    // saying "attached" here would point the comment at content nobody wrote
    // it about.
    return null;
  }

  function ownText(el) {
    return (el.textContent || '').replace(/\\s+/g, ' ').trim();
  }

  function setAnnotateMode(enabled) {
    annotateModeEnabled = enabled === true;
    if (annotateModeEnabled) {
      ensureAnnotateStyles();
    } else {
      clearAnnotateHover();
    }
  }

  function pingElement(selector) {
    if (typeof selector !== 'string' || !selector) return;
    var el = null;
    try {
      el = document.querySelector(selector);
    } catch (error) {}
    if (!el) return;
    ensureAnnotateStyles();
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('as-preview-pinged');
    setTimeout(function () {
      el.classList.remove('as-preview-pinged');
    }, 2500);
  }

  function flashElement(selector) {
    if (typeof selector !== 'string' || !selector) return;
    var el = null;
    try {
      el = document.querySelector(selector);
    } catch (error) {}
    if (!el) return;
    ensureAnnotateStyles();
    el.classList.add('as-preview-flash');
    setTimeout(function () {
      el.classList.add('as-preview-flash-fade');
    }, 100);
    setTimeout(function () {
      el.classList.remove('as-preview-flash');
      el.classList.remove('as-preview-flash-fade');
    }, 1100);
  }

  function onAnnotateHover(event) {
    if (!annotateModeEnabled) return;
    var target = annotateTargetFrom(targetGet ? targetGet(event) : event.target);
    if (target === annotateHoverElement) return;
    clearAnnotateHover();
    if (!target) return;
    annotateHoverElement = target;
    target.classList.add('as-preview-annotate-hover');
  }

  function onAnnotateClick(event) {
    if (!annotateModeEnabled) return;
    var target = annotateTargetFrom(targetGet ? targetGet(event) : event.target);
    if (!target) return;
    event.preventDefault();
    event.stopPropagation();
    // The click that ends a drag-selection belongs to that selection, not to
    // an element pick. Both would otherwise open the popover and the anchor
    // kind would depend on which task the browser ran first.
    var selected = getSelection();
    if (selected && !selected.isCollapsed && selected.toString().trim()) return;
    var rect = target.getBoundingClientRect();
    send({
      kind: 'element-annotate',
      selector: cssPath(target),
      label: elementLabel(target),
      contextText: annotateContextText(target),
      ownText: ownText(target),
      tagName: target.tagName,
      rect: {
        top: rect.top,
        left: rect.left,
        width: rect.width,
        height: rect.height,
      },
    });
  }

  addEventListener(document, 'mousemove', onAnnotateHover, true);
  addEventListener(document, 'mouseover', onAnnotateHover, true);
  addEventListener(document, 'click', onAnnotateClick, true);

  savedAddEventListener('message', function (event) {
    var data = event.data || {};
    if (event.source !== savedParent || data.source !== '${READY_CHECK_MESSAGE_SOURCE}') {
      return;
    }
    if (data.kind === '${READY_CHECK_MESSAGE_KIND}') {
      onReadyCheck(event);
      displayedVersionId = data.versionId || displayedVersionId;
      displayedPath = data.targetPath || displayedPath;
      textAnchorsEnabled = data.textAnchorsEnabled === true;
      setCommentLabels(data.commentLabels);
    } else if (
      data.kind === 'external-link-policy' &&
      (data.mode === 'parent' || data.mode === 'direct')
    ) {
      externalLinkPolicyMode = data.mode;
    } else if (data.kind === 'comment-highlights') {
      textAnchorsEnabled = data.textAnchorsEnabled === true;
      setCommentLabels(data.commentLabels);
      displayedVersionId = data.versionId || null;
      displayedPath = data.targetPath || null;
      applyHighlights(data.highlights);
    } else if (data.kind === 'scroll-to-comment') {
      scrollToThread(data.threadId);
    } else if (data.kind === 'mermaid-rendered') {
      installMermaidResults(data.renderToken, data.results);
    } else if (data.kind === 'annotate-mode') {
      setAnnotateMode(data.enabled);
    } else if (data.kind === 'element-ping') {
      pingElement(data.selector);
    } else if (data.kind === 'element-flash') {
      flashElement(data.selector);
    } else if (data.kind === 'verify-anchors') {
      if (Number.isSafeInteger(pendingVerificationId) && Number.isSafeInteger(data.verificationId) && data.verificationId < pendingVerificationId) return;
      pendingVerificationId = data.verificationId;
      verifyAnchors(data.anchors);
    }
  });

  document.addEventListener('mouseup', function () {
    setTimeout(sendSelection, 0);
  });
  document.addEventListener('keyup', function () {
    setTimeout(sendSelection, 0);
  });
  document.addEventListener('click', function (event) {
    var target = event.target;
    var button = target && target.closest && target.closest('[data-code-copy]');
    if (!button) return;
    var block = button.closest('.md-code-block');
    var code = block && block.querySelector('pre code');
    if (!code) return;
    event.preventDefault();
    event.stopPropagation();

    var copied = function () {
      button.textContent = 'Copied';
      button.setAttribute('aria-label', 'Code copied');
      setTimeout(function () {
        button.textContent = 'Copy';
        button.setAttribute('aria-label', 'Copy code');
      }, 1500);
    };
    var fallback = function () {
      var textarea = document.createElement('textarea');
      textarea.setAttribute('data-anchor-ignore', '');
      textarea.value = code.textContent || '';
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      try {
        if (document.execCommand('copy')) copied();
      } catch (error) {}
      textarea.remove();
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(code.textContent || '').then(copied, fallback);
    } else {
      fallback();
    }
  });
  addEventListener(window, 'click', prepareLinkClick, true);
  addEventListener(window, 'click', finishLinkClick);
  document.addEventListener('pointerdown', sendOutsidePointerDown);
  document.addEventListener('${VIOLATION_REPORTER_MARKER}', function (event) {
    send({
      kind: 'csp-violation',
      directive: event.violatedDirective || event.effectiveDirective,
      blockedURI: event.blockedURI || 'inline',
      sourceFile: event.sourceFile || null,
      lineNumber: event.lineNumber || null,
    });
  });

  window.addEventListener('resize', schedulePositionBadges);
  window.addEventListener('scroll', schedulePositionBadges, true);
  window.addEventListener('load', function () {
    if (!pendingHighlights.length && !pendingAnchors.length) return;
    var engine = createTextAnchorEngine(anchorRoot());
    applyHighlights(pendingHighlights, engine); verifyAnchors(pendingAnchors, engine);
  });
  window.addEventListener('load', schedulePositionBadges);
  window.addEventListener('load', updateMarkdownToc);
  window.addEventListener('scroll', updateMarkdownToc, { passive: true });
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(schedulePositionBadges);
  }

  var readyCount = 0;
  var readyInterval = setInterval(function () {
    ready();
    if (++readyCount >= ${READY_MESSAGE_REPEAT_COUNT}) clearInterval(readyInterval);
  }, ${READY_MESSAGE_REPEAT_INTERVAL_MS});
  ready();
})();`

export const VIOLATION_REPORTER_TAG = `<script>${VIOLATION_REPORTER_SCRIPT_BODY}</script>`

// Base64-encoded SHA-256 of VIOLATION_REPORTER_SCRIPT_BODY.
//
// The Markdown CSP profile is strict (default-src 'none', no script-src
// 'unsafe-inline'), so the reporter <script> is blocked unless we
// allow-list it explicitly. A hash works because the body is a fixed
// string. If the body changes, the drift test in csp-reporter.test.ts
// fails and prints the new value to paste here.
export const VIOLATION_REPORTER_SHA256 =
  'AZKgd4eLLk2qN4NHBL9K9kTNtMuMUWhFXpYTHygM1/Y='

export interface CspViolationMessage {
  source: 'artifactshare'
  kind: 'csp-violation'
  directive: string
  blockedURI: string
  sourceFile: string | null
  lineNumber: number | null
}

export interface TextSelectionMessage {
  source: 'artifactshare'
  kind: 'text-selection'
  quotedText: string
  prefixText: string
  suffixText: string
  textStart: number
  textEnd: number
  cssPath: string | null
  selectorFormat?: 'normalized-v1'
  textHash?: string
  ambiguousAtCreation?: boolean
  versionId?: string | null
  token?: string
  rect: {
    top: number
    left: number
    width: number
    height: number
  }
}

export interface AnchorResolutionMessage {
  source: 'artifactshare'
  kind: 'anchor-resolutions'
  token: string
  versionId: string | null
  targetPath: string | null
  generation: number
  results: Array<{
    threadId: string
    state: 'attached' | 'needs-check' | 'checking'
    textStart: number | null
    textEnd: number | null
    textHash: string | null
  }>
}

export interface TextSelectionClearedMessage {
  source: 'artifactshare'
  kind: 'text-selection-cleared'
}

export interface CommentThreadSelectedMessage {
  source: 'artifactshare'
  kind: 'comment-thread-selected'
  threadId: string
  rect: {
    top: number
    left: number
    width: number
    height: number
  }
}

export interface CommentOutsidePointerDownMessage {
  source: 'artifactshare'
  kind: 'comment-outside-pointer-down'
}

export interface LinkClickedMessage {
  source: 'artifactshare'
  kind: 'link-clicked'
  href: string
  token?: string
}

export interface MermaidRenderRequestMessage {
  source: 'artifactshare'
  kind: 'mermaid-render-request'
  renderToken: string
  diagrams: Array<{ id: string; source: string }>
}

export type ElementAnnotateMessage = {
  source: 'artifactshare'
  kind: 'element-annotate'
  selector: string
  label: string
  contextText: string
  rect: { top: number; left: number; width: number; height: number }
}

interface ReadyMessage {
  source: 'artifactshare'
  kind: 'ready'
  challenge?: string
  token?: string
}

export type SandboxMessage =
  | CspViolationMessage
  | ReadyMessage
  | TextSelectionMessage
  | AnchorResolutionMessage
  | TextSelectionClearedMessage
  | CommentThreadSelectedMessage
  | CommentOutsidePointerDownMessage
  | LinkClickedMessage
  | MermaidRenderRequestMessage
  | ElementAnnotateMessage

export function isSandboxMessage(value: unknown): value is SandboxMessage {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  if (v.source !== 'artifactshare') return false
  if (
    v.kind === 'csp-violation' ||
    v.kind === 'text-selection-cleared' ||
    v.kind === 'comment-outside-pointer-down'
  ) {
    return true
  }
  if (v.kind === 'ready') {
    return (
      (v.challenge === undefined || typeof v.challenge === 'string') &&
      (v.token === undefined || typeof v.token === 'string')
    )
  }
  if (v.kind === 'anchor-resolutions') {
    return (
      typeof v.token === 'string' &&
      /^[a-f0-9]{64}$/.test(v.token) &&
      (v.versionId === null || typeof v.versionId === 'string') &&
      (v.targetPath === null || typeof v.targetPath === 'string') &&
      Number.isSafeInteger(v.generation) &&
      (v.generation as number) >= 0 &&
      Array.isArray(v.results) &&
      v.results.length <= 100 &&
      v.results.every((result) => {
        if (!result || typeof result !== 'object') return false
        const r = result as Record<string, unknown>
        if (typeof r.threadId !== 'string' || r.threadId.length > 128)
          return false
        if (r.state === 'checking' || r.state === 'needs-check')
          return (
            r.textStart === null && r.textEnd === null && r.textHash === null
          )
        return (
          r.state === 'attached' &&
          Number.isSafeInteger(r.textStart) &&
          Number.isSafeInteger(r.textEnd) &&
          (r.textStart as number) >= 0 &&
          (r.textEnd as number) > (r.textStart as number) &&
          typeof r.textHash === 'string' &&
          /^[a-f0-9]{64}$/.test(r.textHash)
        )
      })
    )
  }
  if (v.kind === 'text-selection') {
    const rect = v.rect as Record<string, unknown> | undefined
    return (
      (v.selectorFormat === undefined ||
        (v.selectorFormat === 'normalized-v1' &&
          typeof v.textHash === 'string' &&
          /^[a-f0-9]{64}$/.test(v.textHash) &&
          typeof v.ambiguousAtCreation === 'boolean' &&
          (v.versionId === null || typeof v.versionId === 'string'))) &&
      typeof v.quotedText === 'string' &&
      v.quotedText.length > 0 &&
      v.quotedText.length <= 1000 &&
      typeof v.prefixText === 'string' &&
      v.prefixText.length <= 400 &&
      typeof v.suffixText === 'string' &&
      v.suffixText.length <= 400 &&
      Number.isSafeInteger(v.textStart) &&
      Number.isSafeInteger(v.textEnd) &&
      (v.textStart as number) >= 0 &&
      (v.textEnd as number) - (v.textStart as number) === v.quotedText.length &&
      typeof v.prefixText === 'string' &&
      typeof v.suffixText === 'string' &&
      typeof v.textStart === 'number' &&
      typeof v.textEnd === 'number' &&
      (v.cssPath === null || typeof v.cssPath === 'string') &&
      Boolean(rect) &&
      typeof rect?.top === 'number' &&
      typeof rect.left === 'number' &&
      typeof rect.width === 'number' &&
      typeof rect.height === 'number'
    )
  }
  if (v.kind === 'comment-thread-selected') {
    const rect = v.rect as Record<string, unknown> | undefined
    return (
      typeof v.threadId === 'string' &&
      Boolean(rect) &&
      typeof rect?.top === 'number' &&
      typeof rect.left === 'number' &&
      typeof rect.width === 'number' &&
      typeof rect.height === 'number'
    )
  }
  if (v.kind === 'link-clicked') {
    return (
      typeof v.href === 'string' &&
      (v.token === undefined || typeof v.token === 'string')
    )
  }
  if (v.kind === 'element-annotate') {
    const rect = v.rect as Record<string, unknown> | undefined
    return (
      typeof v.selector === 'string' &&
      typeof v.label === 'string' &&
      typeof v.contextText === 'string' &&
      Boolean(rect) &&
      typeof rect?.top === 'number' &&
      typeof rect.left === 'number' &&
      typeof rect.width === 'number' &&
      typeof rect.height === 'number'
    )
  }
  if (v.kind === 'mermaid-render-request') {
    return (
      typeof v.renderToken === 'string' &&
      v.renderToken.length > 0 &&
      v.renderToken.length <= 128 &&
      Array.isArray(v.diagrams) &&
      v.diagrams.length > 0 &&
      v.diagrams.length <= 16 &&
      v.diagrams.every(
        (diagram) =>
          diagram !== null &&
          typeof diagram === 'object' &&
          typeof (diagram as Record<string, unknown>).id === 'string' &&
          /^artifactshare-mermaid-\d+$/.test(
            (diagram as Record<string, unknown>).id as string,
          ) &&
          typeof (diagram as Record<string, unknown>).source === 'string' &&
          ((diagram as Record<string, unknown>).source as string).length > 0 &&
          ((diagram as Record<string, unknown>).source as string).length <=
            20_000,
      )
    )
  }
  return false
}
