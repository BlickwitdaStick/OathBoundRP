'use strict';

/**
 * skills-panel.js run against a minimal fake DOM (no CEF here).
 *
 * Regression (owner report, 21/11/2026): server data opened the menu by
 * itself — at login (the property's stored value) or when the answer to
 * `skills:open` came after the player had closed it — without the browser
 * having focus, so the menu stayed on screen with no cursor.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { test } = require('node:test');

function fakeElement() {
  const classes = new Set();
  return {
    children: [],
    style: {},
    attrs: {},
    set innerHTML(_v) { this.children = []; },
    get innerHTML() { return ''; },
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c)
    },
    setAttribute(k, v) { this.attrs[k] = v; },
    appendChild(child) { this.children.push(child); return child; }
  };
}

function loadPanel({ binds = null } = {}) {
  const panel = fakeElement();
  const sent = [];
  const keyListeners = [];
  const window = {
    addEventListener: (type, fn) => { if (type === 'keydown') keyListeners.push(fn); },
    OathboundKeybinds: require('./keybinds'),
    getKeybinds: () => binds
  };
  const context = {
    window,
    document: {
      getElementById: (id) => (id === 'skills-panel' ? panel : null),
      createElement: () => fakeElement()
    },
    sendUiEvent: (type, data) => sent.push({ type, data }),
    normalizePayload: (d) => d
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'skills-panel.js'), 'utf8'), context);
  const key = (code, key = '') => {
    const event = { code, key, target: null, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    for (const fn of keyListeners) fn(event);
  };
  return { window, panel, sent, key };
}

const DATA = { sentAt: 1, profile: { chosen: false }, catalog: [] };

test('data for a closed skills menu does not open it', () => {
  const p = loadPanel();
  p.window.handleSkillsPanelData(DATA);
  assert.equal(p.window.SkillsPanel.isOpen(), false);
  assert.equal(p.panel.classList.contains('open'), false);
});

test('data fills the menu the player opened', () => {
  const p = loadPanel();
  p.window.openSkillsPanel();
  assert.deepEqual(p.sent.map(s => s.type), ['skills:open']);
  p.window.handleSkillsPanelData(DATA);
  assert.equal(p.window.SkillsPanel.isOpen(), true);
  assert.equal(p.panel.classList.contains('open'), true);
});

test('Esc and the menu\'s own key (F3, or the rebound one) close it and release focus', () => {
  const p = loadPanel();
  p.window.openSkillsPanel();
  p.key('Escape', 'Escape');
  assert.equal(p.window.SkillsPanel.isOpen(), false);
  assert.equal(p.sent[p.sent.length - 1].type, 'skills:close');

  p.window.openSkillsPanel();
  p.key('F3');
  assert.equal(p.window.SkillsPanel.isOpen(), false, 'F3 by default');

  const r = loadPanel({ binds: { 'skills.open': 37 } }); // K
  r.window.openSkillsPanel();
  r.key('F3');
  assert.equal(r.window.SkillsPanel.isOpen(), true, 'F3 no longer closes once rebound');
  r.key('KeyK');
  assert.equal(r.window.SkillsPanel.isOpen(), false);
});
