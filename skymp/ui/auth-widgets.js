/*
 * OATHBOUND — host for the stock skymp5-client authorization widgets.
 *
 * Why this file exists
 * --------------------
 * The distributed skymp5-client (AuthService) draws its main-menu login
 * screen by running, inside this page, code like:
 *
 *   window.skyrimPlatform.widgets.set([{ type: 'form', caption, elements }])
 *
 * In stock SkyMP that `widgets` object is provided by skymp5-front (the React
 * bundle normally shipped as Data/Platform/UI). OATHBOUND replaces that bundle
 * with its own `index.html`, which never provided `widgets` — so the
 * authorization form could never appear and every `widgets.set(...)` threw
 * "Cannot read properties of undefined (reading 'set')".
 *
 * This file implements exactly the subset the client uses:
 *   - widget type `form` with `caption` and `elements`;
 *   - element types `text`, `button` (with `click` and `hint`) and `icon`;
 *   - `widgets.set([])` to hide everything (sent when the player's actor is
 *     created, i.e. after a successful login).
 *
 * It never connects or authenticates on its own: buttons only run the
 * `click` callbacks the client supplied (which call
 * `window.skyrimPlatform.sendMessage(...)`).
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.OathboundAuthWidgets = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  const ROOT_ID = 'oathbound-auth-widgets';

  function toList(widgets) {
    if (!Array.isArray(widgets)) return [];
    return widgets.filter(w => w && typeof w === 'object');
  }

  function textOf(value) {
    if (value === null || value === undefined) return '';
    return String(value);
  }

  function renderElement(doc, element) {
    const tags = Array.isArray(element.tags) ? element.tags : [];
    let node;
    switch (element.type) {
      case 'button': {
        node = doc.createElement('button');
        node.type = 'button';
        node.className = 'oa-button';
        if (tags.includes('BUTTON_STYLE_FRAME')) node.className += ' oa-button-primary';
        node.textContent = textOf(element.text);
        if (element.hint) node.title = textOf(element.hint);
        node.addEventListener('click', (event) => {
          if (event && typeof event.preventDefault === 'function') event.preventDefault();
          if (typeof element.click === 'function') {
            try { element.click(); } catch (e) { console.error('[auth-widgets] click failed', e); }
          }
        });
        break;
      }
      case 'icon': {
        node = doc.createElement('div');
        node.className = 'oa-icon';
        node.textContent = textOf(element.text);
        break;
      }
      case 'text':
      default: {
        node = doc.createElement('div');
        node.className = 'oa-text';
        node.textContent = textOf(element.text);
        break;
      }
    }
    if (tags.includes('ELEMENT_STYLE_MARGIN_EXTENDED')) node.className += ' oa-margin';
    return node;
  }

  function renderForm(doc, widget) {
    const form = doc.createElement('div');
    form.className = 'oa-form';
    if (widget.id !== undefined) form.setAttribute('data-widget-id', textOf(widget.id));

    if (widget.caption) {
      const caption = doc.createElement('div');
      caption.className = 'oa-caption';
      caption.textContent = textOf(widget.caption);
      form.appendChild(caption);
    }
    const elements = Array.isArray(widget.elements) ? widget.elements : [];
    for (const element of elements) {
      if (!element || typeof element !== 'object') continue;
      // Empty status lines (browserState.comment === '') would only add gaps.
      if (element.type === 'text' && textOf(element.text) === '') continue;
      form.appendChild(renderElement(doc, element));
    }
    return form;
  }

  /**
   * Creates the object installed as `window.skyrimPlatform.widgets`.
   * @param {Document} doc
   */
  function createWidgetHost(doc) {
    let current = [];
    let listeners = [];
    let setCalls = 0;

    function ensureRoot() {
      let rootNode = doc.getElementById(ROOT_ID);
      if (!rootNode) {
        rootNode = doc.createElement('div');
        rootNode.id = ROOT_ID;
        doc.body.appendChild(rootNode);
      }
      return rootNode;
    }

    function render() {
      const rootNode = ensureRoot();
      while (rootNode.firstChild) rootNode.removeChild(rootNode.firstChild);
      const forms = current.filter(w => w.type === 'form');
      for (const widget of forms) rootNode.appendChild(renderForm(doc, widget));
      rootNode.className = forms.length > 0 ? 'oa-visible' : '';
    }

    return {
      set(widgets) {
        setCalls++;
        current = toList(widgets);
        render();
        for (const listener of listeners) {
          try { listener(current); } catch (e) { console.error('[auth-widgets] listener failed', e); }
        }
      },
      get() {
        return current.slice();
      },
      /** True once the client has drawn anything (proof it heard front-loaded). */
      wasSet() {
        return setCalls > 0;
      },
      addListener(listener) {
        if (typeof listener === 'function') listeners.push(listener);
      },
      removeListener(listener) {
        listeners = listeners.filter(l => l !== listener);
      }
    };
  }

  /**
   * Installs the host on the real SkyrimPlatform bridge object, never on a
   * placeholder: the bridge is injected asynchronously by SkyrimPlatform, and
   * creating `window.skyrimPlatform` ourselves broke it (fixed 23/08/2026).
   * Returns true when `widgets` is available after the call.
   */
  function installOn(platform, doc) {
    if (!platform || typeof platform !== 'object') return false;
    if (platform.widgets && typeof platform.widgets.set === 'function') return true;
    platform.widgets = createWidgetHost(doc);
    return true;
  }

  /**
   * Repeats `front-loaded` until the client answers by calling widgets.set().
   *
   * In-game evidence (19/11/2026, skymp5-client trace on the main menu): the
   * client logged "Received authNeeded event" but never "Received
   * browserWindowLoaded event". CEF loads this page at game start, long before
   * skymp5-client's BrowserService subscribes to `browserMessage`; a single
   * early `front-loaded` is dropped and the login form is never drawn. The
   * stock skymp5-front only got away with one message because its bundle is
   * slow to load.
   *
   * Re-sending is safe: BrowserService only turns it into
   * `browserWindowLoaded`, and AuthService just sets a flag until `authNeeded`
   * has also fired. It never authenticates or connects anything.
   *
   * @param {{getPlatform:()=>any, doc:Document, intervalMs?:number, maxMs?:number,
   *          setIntervalFn?:Function, clearIntervalFn?:Function, now?:()=>number}} opts
   * @returns {{stop:()=>void, sentCount:()=>number}}
   */
  function startFrontLoadedHandshake(opts) {
    const intervalMs = opts.intervalMs || 1000;
    const maxMs = opts.maxMs || 15 * 60 * 1000;
    const setIntervalFn = opts.setIntervalFn || setInterval;
    const clearIntervalFn = opts.clearIntervalFn || clearInterval;
    const now = opts.now || (() => Date.now());
    const startedAt = now();
    let sent = 0;
    let handle = null;

    function stop() {
      if (handle !== null) { clearIntervalFn(handle); handle = null; }
    }

    function tick() {
      if (now() - startedAt > maxMs) { stop(); return; }
      const platform = opts.getPlatform();
      if (!platform || typeof platform.sendMessage !== 'function') return;
      installOn(platform, opts.doc);
      if (platform.widgets && typeof platform.widgets.wasSet === 'function' && platform.widgets.wasSet()) {
        stop();
        return;
      }
      try {
        platform.sendMessage('front-loaded');
        sent++;
      } catch (e) {
        console.error('[auth-widgets] front-loaded failed', e);
      }
    }

    handle = setIntervalFn(tick, intervalMs);
    tick();
    return { stop, sentCount: () => sent };
  }

  return { ROOT_ID, createWidgetHost, installOn, startFrontLoadedHandshake };
});
