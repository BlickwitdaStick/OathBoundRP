'use strict';

/**
 * Tests for auth-widgets.js — the `window.skyrimPlatform.widgets` host that
 * renders the stock skymp5-client authorization form on the main menu.
 *
 * Runs in Node with a minimal fake DOM (there is no CEF test runner). The
 * widgets below copy the exact shape built by the client's
 * `browsersideWidgetSetter` / `loginFailedWidgetSetter` (client commit
 * 2849e676), so a change in how we render them is caught here.
 */

const assert = require('assert');
const { test } = require('node:test');
const { createWidgetHost, installOn, startFrontLoadedHandshake, ROOT_ID } = require('./auth-widgets.js');

class FakeNode {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.attributes = {};
    this.listeners = {};
    this.className = '';
    this.textContent = '';
    this.id = '';
    this.title = '';
  }
  appendChild(child) { this.children.push(child); child.parentNode = this; return child; }
  removeChild(child) { this.children = this.children.filter(c => c !== child); return child; }
  get firstChild() { return this.children[0] || null; }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  click() { for (const fn of this.listeners.click || []) fn({ preventDefault() {} }); }
}

function fakeDocument() {
  const body = new FakeNode('body');
  const find = (node, id) => {
    if (node.id === id) return node;
    for (const c of node.children) { const r = find(c, id); if (r) return r; }
    return null;
  };
  return {
    body,
    createElement: tag => new FakeNode(tag),
    getElementById: id => find(body, id)
  };
}

function all(node, pred, out = []) {
  if (pred(node)) out.push(node);
  for (const c of node.children) all(c, pred, out);
  return out;
}

function loginWidget(sent, authData, comment = '') {
  return {
    type: 'form',
    id: 1,
    caption: 'authorization',
    elements: [
      { type: 'text', text: authData ? authData.discordUsername : 'not authorized', tags: [] },
      { type: 'button', text: authData ? 'change account' : 'login via skymp', tags: [],
        click: () => sent.push('openDiscordOauth'), hint: 'hint' },
      { type: 'button', text: 'Play', tags: ['BUTTON_STYLE_FRAME', 'ELEMENT_STYLE_MARGIN_EXTENDED'],
        click: () => sent.push('authAttemptEvent'), hint: 'Connect to the game server' },
      { type: 'text', text: comment, tags: [] }
    ]
  };
}

test('renders the stock login form and Play sends authAttemptEvent only on click', () => {
  const doc = fakeDocument();
  const host = createWidgetHost(doc);
  const sent = [];

  host.set([loginWidget(sent, { discordUsername: 'Ysolda' })]);

  const root = doc.getElementById(ROOT_ID);
  assert.ok(root, 'root container is created on first set');
  assert.strictEqual(root.className, 'oa-visible');
  const texts = all(root, n => n.className && n.className.includes('oa-text')).map(n => n.textContent);
  assert.deepStrictEqual(texts, ['Ysolda'], 'empty status line is not rendered');
  const caption = all(root, n => n.className === 'oa-caption')[0];
  assert.strictEqual(caption.textContent, 'authorization');

  const buttons = all(root, n => n.tagName === 'BUTTON');
  assert.deepStrictEqual(buttons.map(b => b.textContent), ['change account', 'Play']);
  assert.ok(buttons[1].className.includes('oa-button-primary'));
  assert.deepStrictEqual(sent, [], 'rendering must never send anything by itself');

  buttons[1].click();
  assert.deepStrictEqual(sent, ['authAttemptEvent']);
});

test('set([]) hides the form (client does this after the actor is created)', () => {
  const doc = fakeDocument();
  const host = createWidgetHost(doc);
  host.set([loginWidget([], null, 'connecting')]);
  host.set([]);
  const root = doc.getElementById(ROOT_ID);
  assert.strictEqual(root.children.length, 0);
  assert.strictEqual(root.className, '');
  assert.deepStrictEqual(host.get(), []);
});

test('renders the login-failed form and its Back button', () => {
  const doc = fakeDocument();
  const host = createWidgetHost(doc);
  const sent = [];
  host.set([{
    type: 'form', id: 2, caption: 'oops',
    elements: [
      { type: 'text', text: 'session not found', tags: [] },
      { type: 'button', text: 'back', tags: ['ELEMENT_STYLE_MARGIN_EXTENDED'],
        click: () => sent.push('backToLogin'), hint: undefined }
    ]
  }]);
  const root = doc.getElementById(ROOT_ID);
  const [back] = all(root, n => n.tagName === 'BUTTON');
  assert.ok(back.className.includes('oa-margin'));
  back.click();
  assert.deepStrictEqual(sent, ['backToLogin']);
});

test('text is assigned via textContent (no HTML injection from server strings)', () => {
  const doc = fakeDocument();
  const host = createWidgetHost(doc);
  host.set([{ type: 'form', elements: [{ type: 'text', text: '<img src=x onerror=alert(1)>' }] }]);
  const [t] = all(doc.getElementById(ROOT_ID), n => n.className === 'oa-text');
  assert.strictEqual(t.textContent, '<img src=x onerror=alert(1)>');
  assert.strictEqual(t.children.length, 0);
});

test('installOn only augments the real bridge and never replaces an existing widgets', () => {
  const doc = fakeDocument();
  assert.strictEqual(installOn(undefined, doc), false, 'never fabricates window.skyrimPlatform');

  const bridge = { sendMessage() {} };
  assert.strictEqual(installOn(bridge, doc), true);
  assert.strictEqual(typeof bridge.widgets.set, 'function');

  const existing = { set() {}, get() { return []; } };
  const other = { sendMessage() {}, widgets: existing };
  installOn(other, doc);
  assert.strictEqual(other.widgets, existing);
});

// ── front-loaded handshake ──────────────────────────────────────────────────

function fakeClock() {
  let t = 0;
  let fn = null;
  return {
    now: () => t,
    setIntervalFn: (f) => { fn = f; return 1; },
    clearIntervalFn: () => { fn = null; },
    advance(ms, step = 1000) { for (let i = 0; i < ms; i += step) { t += step; if (fn) fn(); } },
    running: () => fn !== null
  };
}

// Mimics skymp5-client: BrowserService only hears browserMessage once the
// client's services are constructed; AuthService then draws the login form.
function fakeClientBridge(doc) {
  const bridge = { listening: false, received: [] };
  bridge.sendMessage = (msg) => {
    bridge.received.push(msg);
    if (bridge.listening && msg === 'front-loaded') {
      bridge.widgets.set([loginWidget([], { discordUsername: 'Ysolda' })]);
    }
  };
  return bridge;
}

test('handshake survives the in-game race: front-loaded sent before the client listens', () => {
  const doc = fakeDocument();
  const clock = fakeClock();
  const bridge = fakeClientBridge(doc);

  startFrontLoadedHandshake({ getPlatform: () => bridge, doc, ...clock });
  clock.advance(5000);                       // page up, client still booting
  assert.ok(bridge.received.length >= 5, 'keeps re-sending while nobody answers');
  assert.strictEqual(doc.getElementById(ROOT_ID), null, 'no form yet');

  bridge.listening = true;                   // client services constructed
  clock.advance(2000);                       // answer on one tick, stop on the next
  assert.strictEqual(doc.getElementById(ROOT_ID).className, 'oa-visible', 'login form is drawn');
  assert.strictEqual(clock.running(), false, 'stops once the client answered');

  const sentAfter = bridge.received.length;
  clock.advance(10000);
  assert.strictEqual(bridge.received.length, sentAfter, 'no more messages after the form is up');
  assert.ok(bridge.received.every(m => m === 'front-loaded'), 'never sends authAttemptEvent');
});

test('handshake waits for a bridge that is injected late', () => {
  const doc = fakeDocument();
  const clock = fakeClock();
  let platform;
  const h = startFrontLoadedHandshake({ getPlatform: () => platform, doc, ...clock });
  clock.advance(3000);
  assert.strictEqual(h.sentCount(), 0);
  platform = fakeClientBridge(doc);
  platform.listening = true;
  clock.advance(2000);
  assert.strictEqual(h.sentCount(), 1);
  assert.strictEqual(clock.running(), false);
});

test('handshake gives up after maxMs (no infinite loop if the client never answers)', () => {
  const doc = fakeDocument();
  const clock = fakeClock();
  const bridge = fakeClientBridge(doc);
  startFrontLoadedHandshake({ getPlatform: () => bridge, doc, maxMs: 60000, ...clock });
  clock.advance(61000);
  assert.strictEqual(clock.running(), false);
});
