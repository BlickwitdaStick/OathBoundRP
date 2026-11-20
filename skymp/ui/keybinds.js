/*
 * OATHBOUND — keybind helpers for the Controls tab (player panel).
 *
 * The server owns the bindings (skymp/gamemode/core/keybinds.js, stored per
 * account). This file only knows how to SHOW them and how to turn a browser
 * key press into the DirectInput scan code (SkyrimPlatform `DxScanCode`) the
 * game's `buttonEvent` reports. A test checks this table against the server's
 * BINDABLE_CODES and ACTIONS so the two cannot drift.
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.OathboundKeybinds = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  /** Same ids and order as the server's ACTIONS. */
  const ACTIONS = [
    { id: 'panel.open', label: 'Open player panel', hint: 'Press once' },
    { id: 'voice.pushToTalk', label: 'Push to talk', hint: 'Hold to speak; you are silent while released' },
    { id: 'voice.cycleMode', label: 'Cycle voice mode', hint: 'Whisper → Normal → Shout' },
    { id: 'voice.toggleMute', label: 'Mute / unmute', hint: 'Optional; unbound by default' },
    { id: 'chat.open', label: 'Open chat', hint: 'Type, Enter to send, Esc to cancel' }
  ];

  /**
   * KeyboardEvent.code → [DxScanCode, label]. Escape and the console key
   * (Backquote) are absent on purpose: the server refuses them.
   */
  const DOM_KEYS = {
    Digit1: [2, '1'], Digit2: [3, '2'], Digit3: [4, '3'], Digit4: [5, '4'], Digit5: [6, '5'],
    Digit6: [7, '6'], Digit7: [8, '7'], Digit8: [9, '8'], Digit9: [10, '9'], Digit0: [11, '0'],
    Minus: [12, '-'], Equal: [13, '='], Backspace: [14, 'Backspace'], Tab: [15, 'Tab'],
    KeyQ: [16, 'Q'], KeyW: [17, 'W'], KeyE: [18, 'E'], KeyR: [19, 'R'], KeyT: [20, 'T'],
    KeyY: [21, 'Y'], KeyU: [22, 'U'], KeyI: [23, 'I'], KeyO: [24, 'O'], KeyP: [25, 'P'],
    BracketLeft: [26, '['], BracketRight: [27, ']'], Enter: [28, 'Enter'], ControlLeft: [29, 'Left Ctrl'],
    KeyA: [30, 'A'], KeyS: [31, 'S'], KeyD: [32, 'D'], KeyF: [33, 'F'], KeyG: [34, 'G'],
    KeyH: [35, 'H'], KeyJ: [36, 'J'], KeyK: [37, 'K'], KeyL: [38, 'L'],
    Semicolon: [39, ';'], Quote: [40, "'"], ShiftLeft: [42, 'Left Shift'], Backslash: [43, '\\'],
    KeyZ: [44, 'Z'], KeyX: [45, 'X'], KeyC: [46, 'C'], KeyV: [47, 'V'], KeyB: [48, 'B'],
    KeyN: [49, 'N'], KeyM: [50, 'M'], Comma: [51, ','], Period: [52, '.'], Slash: [53, '/'],
    ShiftRight: [54, 'Right Shift'], NumpadMultiply: [55, 'Num *'], AltLeft: [56, 'Left Alt'],
    Space: [57, 'Space'], CapsLock: [58, 'Caps Lock'],
    F1: [59, 'F1'], F2: [60, 'F2'], F3: [61, 'F3'], F4: [62, 'F4'], F5: [63, 'F5'],
    F6: [64, 'F6'], F7: [65, 'F7'], F8: [66, 'F8'], F9: [67, 'F9'], F10: [68, 'F10'],
    NumLock: [69, 'Num Lock'], ScrollLock: [70, 'Scroll Lock'],
    Numpad7: [71, 'Num 7'], Numpad8: [72, 'Num 8'], Numpad9: [73, 'Num 9'], NumpadSubtract: [74, 'Num -'],
    Numpad4: [75, 'Num 4'], Numpad5: [76, 'Num 5'], Numpad6: [77, 'Num 6'], NumpadAdd: [78, 'Num +'],
    Numpad1: [79, 'Num 1'], Numpad2: [80, 'Num 2'], Numpad3: [81, 'Num 3'], Numpad0: [82, 'Num 0'],
    NumpadDecimal: [83, 'Num .'], F11: [87, 'F11'], F12: [88, 'F12'],
    NumpadEnter: [156, 'Num Enter'], ControlRight: [157, 'Right Ctrl'], NumpadDivide: [181, 'Num /'],
    PrintScreen: [183, 'Print Screen'], AltRight: [184, 'Right Alt'], Pause: [197, 'Pause'],
    Home: [199, 'Home'], ArrowUp: [200, 'Up'], PageUp: [201, 'Page Up'], ArrowLeft: [203, 'Left'],
    ArrowRight: [205, 'Right'], End: [207, 'End'], ArrowDown: [208, 'Down'], PageDown: [209, 'Page Down'],
    Insert: [210, 'Insert'], Delete: [211, 'Delete']
  };

  const LABEL_BY_CODE = {};
  for (const name of Object.keys(DOM_KEYS)) LABEL_BY_CODE[DOM_KEYS[name][0]] = DOM_KEYS[name][1];

  function keyLabel(code) {
    if (code === null || code === undefined) return 'Unbound';
    return LABEL_BY_CODE[code] || `Key ${code}`;
  }

  /** @param {string} domCode KeyboardEvent.code @returns {number|null} */
  function scanCodeFromDomCode(domCode) {
    const entry = DOM_KEYS[domCode];
    return entry ? entry[0] : null;
  }

  function labelOf(actionId) {
    const action = ACTIONS.find(a => a.id === actionId);
    return action ? action.label : actionId;
  }

  /**
   * Assigns `code` to `actionId` in a copy of `draft`. If another action
   * already uses that key, it becomes unbound (one key = one action, the
   * server rejects duplicates).
   * @returns {{draft:Record<string, number|null>, movedFrom:string|null}}
   */
  function assignKey(draft, actionId, code) {
    const next = Object.assign({}, draft);
    let movedFrom = null;
    for (const id of Object.keys(next)) {
      if (id !== actionId && next[id] === code) {
        next[id] = null;
        movedFrom = id;
      }
    }
    next[actionId] = code;
    return { draft: next, movedFrom };
  }

  function sameBindings(a, b) {
    if (!a || !b) return false;
    return ACTIONS.every(action => (a[action.id] ?? null) === (b[action.id] ?? null));
  }

  /** Same as the server defaults (core/keybinds.js); a test keeps them equal. */
  const DEFAULT_BINDINGS = { 'panel.open': 60, 'voice.pushToTalk': 47, 'voice.cycleMode': 87, 'voice.toggleMute': null, 'chat.open': 28 };

  return { ACTIONS, DEFAULT_BINDINGS, DOM_KEYS, keyLabel, scanCodeFromDomCode, labelOf, assignKey, sameBindings };
});
