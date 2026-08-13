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
  var savedPostMessage = savedParent.postMessage.bind(savedParent);
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

  var marks = [];
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
      savedPostMessage(payload, '*');
    } catch (e) {}
  }

  function ready() {
    if (readyChallenge && documentToken) {
      send({ kind: 'ready', challenge: readyChallenge, token: documentToken });
    }
  }

  function requestMermaidRendering() {
    if (mermaidRequested) return;
    if (!document.body || document.body.dataset.markdownRenderer !== 'tanstack') return;
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
    if (pending.openExternally) {
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

  function acceptsAnchorText(node) {
    return !(
      node.parentElement &&
      (node.parentElement.closest('script,style,.ash-comment-highlight-badge') ||
        (document.body.dataset.markdownRenderer === 'tanstack' &&
          node.parentElement.closest('.mermaid-diagram')))
    );
  }

  function acceptsHighlightText(node) {
    return !(
      node.parentElement &&
      (node.parentElement.closest(
        'script,style,.ash-comment-highlight,.ash-comment-highlight-badge,.ash-comment-highlight-svg',
      ) ||
        (document.body.dataset.markdownRenderer === 'tanstack' &&
          node.parentElement.closest('.mermaid-diagram')))
    );
  }

  function anchorRoot() {
    return document.querySelector('[data-comment-content]') || document.body;
  }

  function textOffset(node, offset) {
    var walker = document.createTreeWalker(anchorRoot(), NodeFilter.SHOW_TEXT, {
      acceptNode: function (textNode) {
        return acceptsAnchorText(textNode)
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT;
      },
    });
    var position = 0;
    var textNode;
    while ((textNode = walker.nextNode())) {
      if (textNode === node) return position + offset;
      position += textNode.nodeValue.length;
    }
    return position;
  }

  function anchorTextContent() {
    var walker = document.createTreeWalker(anchorRoot(), NodeFilter.SHOW_TEXT, {
      acceptNode: function (node) {
        return acceptsAnchorText(node)
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT;
      },
    });
    var text = '';
    var node;
    while ((node = walker.nextNode())) {
      text += node.nodeValue;
    }
    return text;
  }

  function ensureCommentStyles() {
    if (document.getElementById('ash-comment-highlight-style')) return;
    var style = document.createElement('style');
    style.id = 'ash-comment-highlight-style';
    style.textContent =
      '.ash-comment-highlight-badge::after{content:attr(data-count);}';
    document.head.appendChild(style);
  }

  function sendSelection() {
    if (!textAnchorsEnabled) return;
    var selection = getSelection();
    if (!selection || selection.rangeCount === 0) {
      send({ kind: 'text-selection-cleared' });
      return;
    }
    var selectionText = selection.toString();
    var quotedText = selectionText.trim();
    if (!quotedText) {
      send({ kind: 'text-selection-cleared' });
      return;
    }
    var range = selection.getRangeAt(0);
    if (!anchorRoot().contains(range.commonAncestorContainer)) {
      return;
    }

    var rawStart = textOffset(range.startContainer, range.startOffset);
    var leadingWhitespace = selectionText.length - selectionText.trimStart().length;
    var start = rawStart + leadingWhitespace;
    var end = start + quotedText.length;
    var bodyText = anchorTextContent();
    var rect = range.getBoundingClientRect();
    send({
      kind: 'text-selection',
      quotedText: quotedText,
      prefixText: bodyText.slice(Math.max(0, start - 120), start).trim(),
      suffixText: bodyText.slice(end, Math.min(bodyText.length, end + 120)).trim(),
      textStart: start,
      textEnd: end,
      cssPath: cssPath(selectedElement(range)),
      rect: {
        top: rect.top,
        left: rect.left,
        width: rect.width,
        height: rect.height,
      },
    });
  }

  function clearMarks() {
    for (var i = 0; i < badges.length; i++) {
      badges[i].badge.remove();
    }
    badges = [];
    for (var i = 0; i < marks.length; i++) {
      marks[i].replaceWith(document.createTextNode(marks[i].textContent || ''));
    }
    marks = [];
    var svgOverlays = document.querySelectorAll('.ash-comment-highlight-svg');
    for (var s = 0; s < svgOverlays.length; s++) svgOverlays[s].remove();
    svgActiveThreads = {};
    appliedHighlightKey = '';
    document.body.normalize();
  }

  function highlightKey(list) {
    return list
      .map(function (highlight) {
        return [
          highlight.threadId,
          highlight.status,
          highlight.textStart,
          highlight.textEnd,
          highlight.quotedText || '',
          highlight.target ? '1' : '0',
        ].join(':');
      })
      .join('|');
  }

  function updateHighlightBadges(list) {
    for (var i = 0; i < list.length; i++) {
      var highlight = list[i];
      var badgeElements = document.querySelectorAll(
        '.ash-comment-highlight-badge[data-thread-id="' +
          CSS.escape(highlight.threadId) +
          '"]',
      );
      for (var j = 0; j < badgeElements.length; j++) {
        badgeElements[j].dataset.count = String(highlight.count || 1);
        badgeElements[j].setAttribute('aria-label', commentLabel(highlight));
      }
    }
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
  function setSvgHighlightState(threadId, active) {
    var overlays = document.querySelectorAll('.ash-comment-highlight-svg[data-thread-id="' + CSS.escape(threadId) + '"]');
    for (var i = 0; i < overlays.length; i++) {
      var overlay = overlays[i];
      var palette = overlay.dataset.palette;
      if (!palette) continue;
      var parts = palette.split('|');
      var normalFill = parts[0];
      var outline = parts[1];
      var target = overlay.dataset.target === 'true';
      overlay.dataset.state = active || target ? 'active' : 'normal';
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

  function markStyleForHighlight(highlight, isDark) {
    var palette = highlightPalette(isDark, highlight.status === 'resolved');
    var css =
      'background:' +
      palette.markBg +
      ';box-shadow:inset 0 -2px 0 ' +
      palette.markUnderline +
      ';color:inherit;border-radius:3px;scroll-margin:120px;cursor:pointer;touch-action:manipulation;';
    if (highlight.target) {
      css +=
        'outline:2px solid ' +
        palette.outline +
        ';outline-offset:2px;box-shadow:inset 0 -2px 0 ' +
        palette.outline +
        ';';
    }
    return css;
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

  function measureBadgeEntry(entry) {
    if (entry.measure) return entry.measure();
    return entry.mark && entry.mark.getClientRects ? entry.mark.getClientRects() : [];
  }

  var badgePositionFrame = 0;
  function schedulePositionBadges() {
    if (badgePositionFrame) return;
    badgePositionFrame = requestAnimationFrame(function () {
      badgePositionFrame = 0;
      positionBadges();
    });
  }

  function svgTextRange(highlight) {
    var walker = document.createTreeWalker(anchorRoot(), NodeFilter.SHOW_TEXT, {
      acceptNode: function (node) {
        return acceptsAnchorText(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });
    var position = 0;
    var groups = [];
    var node;
    while ((node = walker.nextNode())) {
      var parent = node.parentElement;
      var text = parent && parent.closest ? parent.closest('text') : null;
      var length = node.nodeValue.length;
      if (text && position < highlight.textEnd && position + length > highlight.textStart) {
        var localStart = Math.max(0, highlight.textStart - position);
        var localEnd = Math.min(length, highlight.textEnd - position);
        var localPosition = 0;
        var localWalker = document.createTreeWalker(text, NodeFilter.SHOW_TEXT, {
          acceptNode: function (candidate) {
            return acceptsAnchorText(candidate) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
          },
        });
        var candidate;
        while ((candidate = localWalker.nextNode()) && candidate !== node) {
          if (candidate.nodeValue.trim()) localPosition += candidate.nodeValue.length;
        }
        if (candidate === node) groups.push({ text: text, start: localPosition + localStart, end: localPosition + localEnd });
      }
      position += length;
      if (position >= highlight.textEnd) break;
    }
    return groups;
  }

  function wrapSvgRange(highlight) {
    if (!document.querySelector('svg text')) return false;
    var groups = svgTextRange(highlight);
    if (!groups.length) return false;
    var texts = groups.map(function (group) { return group.text; }).filter(function (text, index, all) { return all.indexOf(text) === index; });
    var mappingValid = texts.every(function (text) {
      if (!text.getNumberOfChars) return false;
      var walker = document.createTreeWalker(text, NodeFilter.SHOW_TEXT);
      var domLength = 0;
      var node;
      while ((node = walker.nextNode())) {
        if (node.nodeValue.trim()) domLength += node.nodeValue.length;
      }
      return domLength === text.getNumberOfChars();
    });
    var first = texts[0];
    var svg = first && first.ownerSVGElement;
    while (svg && svg.ownerSVGElement) svg = svg.ownerSVGElement;
    if (!svg || !svg.parentNode) return false;
    ensureCommentStyles();
    var overlays = {};

    function overlayKey(text, index) {
      return texts.indexOf(text) + ':' + index;
    }

    function updateOverlay(text, index, box, screenCtm) {
      var key = overlayKey(text, index);
      var shape = overlays[key];
      if (!shape) {
        shape = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        shape.setAttribute('class', 'ash-comment-highlight-svg');
        shape.setAttribute('pointer-events', 'none');
        shape.dataset.threadId = highlight.threadId;
        shape.dataset.target = highlight.target ? 'true' : 'false';
        var palette = highlightPalette(isDarkBackgroundForSvgText(text), highlight.status === 'resolved');
        shape.dataset.palette = palette.markBg + '|' + palette.outline;
        text.parentNode.insertBefore(shape, text);
        overlays[key] = shape;
      }
      var scaleX = screenCtm ? Math.hypot(screenCtm.a, screenCtm.b) : 1;
      var scaleY = screenCtm ? Math.hypot(screenCtm.c, screenCtm.d) : 1;
      var padX = scaleX ? 2 / scaleX : 2;
      var padY = scaleY ? 2 / scaleY : 2;
      shape.setAttribute('x', box.x - padX);
      shape.setAttribute('y', box.y - padY);
      shape.setAttribute('width', box.width + padX * 2);
      shape.setAttribute('height', box.height + padY * 2);
      var textCtm = text.getCTM ? text.getCTM() : null;
      var parentCtm = text.parentNode && text.parentNode.getCTM ? text.parentNode.getCTM() : null;
      if (textCtm && parentCtm && parentCtm.inverse) {
        var matrix = parentCtm.inverse().multiply(textCtm);
        shape.setAttribute(
          'transform',
          'matrix(' + [matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f].join(' ') + ')',
        );
      } else {
        shape.removeAttribute('transform');
      }
      return shape;
    }

    function measureSvgRange() {
      var current = [];
      var usedOverlays = {};
      for (var i = 0; mappingValid && i < groups.length; i++) {
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
      if (current.length) return current;
      var fallback = first.getBoundingClientRect ? first.getBoundingClientRect() : null;
      if (!fallback || fallback.width === 0 || fallback.height === 0) {
        fallback = svg.getBoundingClientRect ? svg.getBoundingClientRect() : null;
      }
      return fallback ? [fallback] : [];
    }

    var badge = document.createElement('button');
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
    bindBadgePointer(badge);
    svg.parentNode.insertBefore(badge, svg.nextSibling);
    badges.push({ badge: badge, measure: measureSvgRange });
    measureSvgRange();
    return true;
  }

  function wrapRange(highlight) {
    var start = highlight.textStart;
    var end = highlight.textEnd;
    if (typeof start !== 'number' || typeof end !== 'number' || end <= start) {
      return;
    }
    var svgWrapped = wrapSvgRange(highlight);
    var walker = document.createTreeWalker(anchorRoot(), NodeFilter.SHOW_TEXT, {
      acceptNode: function (node) {
        return acceptsAnchorText(node)
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT;
      },
    });
    var position = 0;
    var parts = [];
    var node;
    var badgeAdded = svgWrapped;
    while ((node = walker.nextNode())) {
      var length = node.nodeValue.length;
      var next = position + length;
      if (next <= start) {
        position = next;
        continue;
      }
      if (position >= end) break;
      var localStart = Math.max(0, start - position);
      var localEnd = Math.min(length, end - position);
      var parent = node.parentElement;
      var inSvgText = parent && parent.closest && parent.closest('svg text');
      if (!inSvgText) {
        parts.push({ node: node, start: localStart, end: localEnd });
      }
      position = next;
    }
    for (var i = parts.length - 1; i >= 0; i--) {
      var part = parts[i];
      var range = document.createRange();
      range.setStart(part.node, part.start);
      range.setEnd(part.node, part.end);
      var mark = document.createElement('mark');
      mark.className =
        'ash-comment-highlight' +
        (highlight.target ? ' is-target' : '') +
        (highlight.status === 'resolved' ? ' is-resolved' : '');
      mark.dataset.threadId = highlight.threadId;
      var isDark = isDarkBackground(part.node.parentElement);
      mark.style.cssText = markStyleForHighlight(highlight, isDark);
      try {
        range.surroundContents(mark);
        if (!badgeAdded) {
          ensureCommentStyles();
          var badge = document.createElement('button');
          badge.type = 'button';
          badge.className = 'ash-comment-highlight-badge';
          badge.setAttribute('aria-label', commentLabel(highlight));
          badge.dataset.threadId = highlight.threadId;
          badge.dataset.count = String(highlight.count || 1);
          badge.innerHTML =
            highlight.status === 'resolved'
              ? '<svg viewBox="0 0 24 24" width="10" height="10" style="width:10px;height:10px;flex:none;border:0;padding:0;margin:0;background:none;box-shadow:none" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>'
              : '<svg viewBox="0 0 24 24" width="10" height="10" style="width:10px;height:10px;flex:none;border:0;padding:0;margin:0;background:none;box-shadow:none" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z"/></svg>';
          badge.style.cssText = badgeStyleForHighlight(highlight, isDark);
          bindBadgePointer(badge);
          mark.insertAdjacentElement('afterend', badge);
          badges.push({ badge: badge, mark: mark });
          badgeAdded = true;
        }
        bindCommentPointer(mark);
        marks.push(mark);
      } catch (e) {}
    }
  }

  function applyHighlights(list) {
    if (!Array.isArray(list)) {
      clearMarks();
      return;
    }
    var sorted = list
      .slice()
      .sort(function (a, b) {
        return b.textStart - a.textStart;
      });
    var nextKey = highlightKey(sorted);
    if (
      nextKey === appliedHighlightKey &&
      (marks.length > 0 || badges.length > 0 || sorted.length === 0)
    ) {
      updateHighlightBadges(sorted);
      return;
    }
    clearMarks();
    sorted.forEach(wrapRange);
    positionBadges();
    appliedHighlightKey =
      marks.length > 0 || badges.length > 0 || sorted.length === 0 ? nextKey : '';
  }

  function scrollToThread(id) {
    var element = document.querySelector(
      '.ash-comment-highlight[data-thread-id="' + CSS.escape(id) + '"], .ash-comment-highlight-badge[data-thread-id="' + CSS.escape(id) + '"], .ash-comment-highlight-svg[data-thread-id="' + CSS.escape(id) + '"]',
    );
    if (element) element.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

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

  function bindCommentPointer(element) {
    element.addEventListener('click', function (event) {
      var r = this.getBoundingClientRect();
      selectThreadFromElement(this, rectFromPointer(event, r));
      event.preventDefault();
      event.stopPropagation();
    });
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
    if (!textAnchorsEnabled) return;
    var target = event.target;
    if (
      target &&
      target.closest &&
      target.closest('.ash-comment-highlight, .ash-comment-highlight-badge')
    ) {
      return;
    }
    send({ kind: 'comment-outside-pointer-down' });
  }

  function updateMarkdownToc() {
    var links = document.querySelectorAll('.md-toc a[href^="#"]');
    if (!links.length) return;
    var active = null;
    for (var index = 0; index < links.length; index++) {
      var id = links[index].getAttribute('href').slice(1);
      var heading = document.getElementById(id);
      if (heading && heading.getBoundingClientRect().top <= 96) active = links[index];
    }
    if (!active) active = links[0];
    for (var linkIndex = 0; linkIndex < links.length; linkIndex++) {
      if (links[linkIndex] === active) {
        links[linkIndex].setAttribute('aria-current', 'location');
      } else {
        links[linkIndex].removeAttribute('aria-current');
      }
    }
  }

  savedAddEventListener('message', function (event) {
    var data = event.data || {};
    if (event.source !== savedParent || data.source !== '${READY_CHECK_MESSAGE_SOURCE}') {
      return;
    }
    if (data.kind === '${READY_CHECK_MESSAGE_KIND}') {
      onReadyCheck(event);
      textAnchorsEnabled = data.textAnchorsEnabled === true;
      setCommentLabels(data.commentLabels);
    } else if (data.kind === 'comment-highlights') {
      textAnchorsEnabled = data.textAnchorsEnabled === true;
      setCommentLabels(data.commentLabels);
      applyHighlights(data.highlights);
    } else if (data.kind === 'scroll-to-comment') {
      scrollToThread(data.threadId);
    } else if (data.kind === 'mermaid-rendered') {
      installMermaidResults(data.renderToken, data.results);
    }
  });

  document.addEventListener('mouseup', function () {
    setTimeout(sendSelection, 0);
  });
  document.addEventListener('keyup', function () {
    setTimeout(sendSelection, 0);
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
  'GMHSYRSUYjY7pwcMEEfaGI7flq2W3LhkOU8cO8ar3NU='

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
  rect: {
    top: number
    left: number
    width: number
    height: number
  }
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
  | TextSelectionClearedMessage
  | CommentThreadSelectedMessage
  | CommentOutsidePointerDownMessage
  | LinkClickedMessage
  | MermaidRenderRequestMessage

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
  if (v.kind === 'text-selection') {
    const rect = v.rect as Record<string, unknown> | undefined
    return (
      typeof v.quotedText === 'string' &&
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
