/**
 * core/player-shortcuts-service.test.js
 *
 * Proves: every active character receives its account's keybinds once (not
 * every tick); the Controls-tab UI events validate, persist and resend; and
 * the client snippet — executed against a fake `ctx.sp` that only knows the
 * events SkyrimPlatform declares — dispatches each bound key, handles
 * push-to-talk press/release, and ignores keys while the CEF has focus.
 *
 * Does NOT prove the snippet fires inside the real SkyrimPlatform (same
 * caveat as every lab module here).
 *
 * Executa com: node --test core/player-shortcuts-service.test.js
 */

'use strict';

const assert = require('assert');
const { describe, it, beforeEach, after } = require('node:test');

let atoresAtivos = [];
const contaPorAtor = new Map();
const notificacoes = [];

const Module = require('module');
const originalLoad = Module._load;

Module._load = function (request, parent, isMain) {
  if (request === '../commands' || request === './commands' || request.endsWith('/commands')) {
    return {
      listActiveActorIds: () => [...atoresAtivos],
      getActiveCharacterData: (actorId) => contaPorAtor.has(actorId) ? { accountId: contaPorAtor.get(actorId) } : null,
      sendNotification: (actorId, msg) => notificacoes.push({ actorId, msg })
    };
  }
  return originalLoad.apply(this, arguments);
};

const shortcuts = require('./player-shortcuts-service');
const keybinds = require('./keybinds');

const propertyEscrita = new Map();
global.mp = {
  set: (actorId, propName, valor) => {
    if (propName === shortcuts.PROPERTY) propertyEscrita.set(actorId, valor);
  }
};

// Fake DB: account_id -> bindings_json
const banco = new Map();
let bancoFalha = false;
const consultas = [];
shortcuts._setDatabase({
  query: async (sql, params) => {
    consultas.push(sql);
    if (bancoFalha) throw new Error('db down');
    if (/^SELECT/i.test(sql.trim())) {
      return banco.has(params[0]) ? [{ bindings_json: banco.get(params[0]) }] : [];
    }
    if (/^INSERT/i.test(sql.trim())) { banco.set(params[0], params[1]); return {}; }
    if (/^DELETE/i.test(sql.trim())) { banco.delete(params[0]); return {}; }
    throw new Error(`unexpected sql: ${sql}`);
  }
});

after(() => {
  Module._load = originalLoad;
  delete global.mp;
});

const ATOR_A = 0xff00f001;
const ATOR_B = 0xff00f002;
const DEFAULTS = keybinds.defaultBindings();

beforeEach(() => {
  atoresAtivos = [];
  contaPorAtor.clear();
  propertyEscrita.clear();
  notificacoes.length = 0;
  consultas.length = 0;
  banco.clear();
  bancoFalha = false;
  shortcuts._ultimoEnvio.clear();
  shortcuts._cachePorConta.clear();
});

describe('player-shortcuts-service: envio dos keybinds', () => {
  it('envia os defaults pra quem não tem linha salva', async () => {
    atoresAtivos = [ATOR_A];
    contaPorAtor.set(ATOR_A, 1);
    await shortcuts.tick();
    assert.deepStrictEqual(propertyEscrita.get(ATOR_A).bindings, DEFAULTS);
    assert.strictEqual(typeof propertyEscrita.get(ATOR_A).sentAt, 'number');
  });

  it('envia os keybinds salvos da conta de cada ator', async () => {
    banco.set(2, JSON.stringify({ ...DEFAULTS, 'panel.open': 59 }));
    atoresAtivos = [ATOR_A, ATOR_B];
    contaPorAtor.set(ATOR_A, 1);
    contaPorAtor.set(ATOR_B, 2);
    await shortcuts.tick();
    assert.strictEqual(propertyEscrita.get(ATOR_A).bindings['panel.open'], 60);
    assert.strictEqual(propertyEscrita.get(ATOR_B).bindings['panel.open'], 59);
  });

  it('não reenvia nem relê o banco num segundo tick', async () => {
    atoresAtivos = [ATOR_A];
    contaPorAtor.set(ATOR_A, 1);
    await shortcuts.tick();
    propertyEscrita.clear();
    consultas.length = 0;
    await shortcuts.tick();
    assert.ok(!propertyEscrita.has(ATOR_A));
    assert.strictEqual(consultas.length, 0);
  });

  it('reenvia pro ator que saiu e voltou (usando o cache da conta)', async () => {
    atoresAtivos = [ATOR_A];
    contaPorAtor.set(ATOR_A, 1);
    await shortcuts.tick();
    atoresAtivos = [];
    await shortcuts.tick();
    propertyEscrita.clear();
    consultas.length = 0;
    atoresAtivos = [ATOR_A];
    await shortcuts.tick();
    assert.ok(propertyEscrita.has(ATOR_A));
    assert.strictEqual(consultas.length, 0);
  });

  it('banco fora do ar: joga com os defaults em vez de ficar sem teclas', async () => {
    bancoFalha = true;
    atoresAtivos = [ATOR_A];
    contaPorAtor.set(ATOR_A, 1);
    await shortcuts.tick();
    assert.deepStrictEqual(propertyEscrita.get(ATOR_A).bindings, DEFAULTS);
  });

  it('não escreve nada quando `mp` não está definido', async () => {
    const mpReal = global.mp;
    delete global.mp;
    atoresAtivos = [ATOR_A];
    await assert.doesNotReject(() => shortcuts.tick());
    global.mp = mpReal;
  });
});

describe('player-shortcuts-service: eventos da aba Controls', () => {
  beforeEach(() => {
    atoresAtivos = [ATOR_A];
    contaPorAtor.set(ATOR_A, 5);
  });

  it('keybinds:set valida, grava por conta e reenvia', async () => {
    const novos = { ...DEFAULTS, 'voice.pushToTalk': 48, 'voice.toggleMute': 50 };
    assert.strictEqual(await shortcuts.handleUiEvent(ATOR_A, { type: 'keybinds:set', data: { bindings: novos } }), true);
    assert.deepStrictEqual(JSON.parse(banco.get(5)), novos);
    assert.deepStrictEqual(propertyEscrita.get(ATOR_A).bindings, novos);
    assert.match(notificacoes.at(-1).msg, /saved/i);
  });

  it('keybinds:set inválido não grava, avisa e reenvia o estado atual', async () => {
    const ruins = { ...DEFAULTS, 'voice.toggleMute': 47 }; // duplicado com push-to-talk
    await shortcuts.handleUiEvent(ATOR_A, { type: 'keybinds:set', data: { bindings: ruins } });
    assert.ok(!banco.has(5));
    assert.match(notificacoes.at(-1).msg, /not saved/i);
    assert.deepStrictEqual(propertyEscrita.get(ATOR_A).bindings, DEFAULTS);
  });

  it('keybinds:set com falha no banco não muda o que o jogador tem', async () => {
    await shortcuts.tick();
    bancoFalha = true;
    await shortcuts.handleUiEvent(ATOR_A, { type: 'keybinds:set', data: { bindings: { ...DEFAULTS, 'panel.open': 59 } } });
    assert.match(notificacoes.at(-1).msg, /server error/i);
    assert.strictEqual(propertyEscrita.get(ATOR_A).bindings['panel.open'], 60);
  });

  it('keybinds:reset apaga a linha e volta aos defaults', async () => {
    banco.set(5, JSON.stringify({ ...DEFAULTS, 'panel.open': 59 }));
    await shortcuts.handleUiEvent(ATOR_A, { type: 'keybinds:reset' });
    assert.ok(!banco.has(5));
    assert.deepStrictEqual(propertyEscrita.get(ATOR_A).bindings, DEFAULTS);
  });

  it('keybinds:get reenvia mesmo sem mudança (a aba precisa dos dados)', async () => {
    await shortcuts.tick();
    propertyEscrita.clear();
    await shortcuts.handleUiEvent(ATOR_A, { type: 'keybinds:get' });
    assert.ok(propertyEscrita.has(ATOR_A));
  });

  it('sem personagem ativo não grava nada', async () => {
    contaPorAtor.clear();
    await shortcuts.handleUiEvent(ATOR_A, { type: 'keybinds:set', data: { bindings: DEFAULTS } });
    assert.strictEqual(banco.size, 0);
  });

  it('tipo desconhecido não é tratado', async () => {
    assert.strictEqual(await shortcuts.handleUiEvent(ATOR_A, { type: 'keybinds:hack' }), false);
  });
});

describe('player-shortcuts-service: snippet de cliente', () => {
  // Só os eventos que Data/Platform/Modules/skyrimPlatform.ts declara.
  const EVENTOS_REAIS = new Set(['buttonEvent', 'browserMessage', 'menuOpen', 'menuClose']);

  function ctxFalso({ bindings = DEFAULTS, focused = false, semValor = false, staff = undefined } = {}) {
    const handlers = {};
    const executados = [];
    const foco = [];
    const browser = {
      focused,
      executeJavaScript: (js) => executados.push(js),
      isFocused() { return this.focused; },
      setFocused(v) { this.focused = v; foco.push(v); },
      setVisible() {}
    };
    const ctx = {
      state: {},
      value: semValor ? undefined : { sentAt: 1, bindings, staff },
      sp: {
        on(nome, fn) {
          if (!EVENTOS_REAIS.has(nome)) throw new Error(`evento inexistente no SkyrimPlatform: ${nome}`);
          (handlers[nome] = handlers[nome] || []).push(fn);
        },
        browser
      }
    };
    const run = () => new Function('ctx', shortcuts.SNIPPET_DO_CLIENTE)(ctx); // eslint-disable-line no-new-func
    run();
    const press = (code, extra = {}) => handlers.buttonEvent[0]({ device: 0, code, isDown: true, isUp: false, ...extra });
    const release = (code) => handlers.buttonEvent[0]({ device: 0, code, isDown: false, isUp: true });
    const acoes = () => executados.filter(js => !js.includes('handleKeybindsUpdate'));
    return { ctx, handlers, executados, foco, browser, run, press, release, acoes };
  }

  it('F2 abre E foca localmente, sem esperar o servidor', () => {
    const c = ctxFalso();
    c.press(60);
    assert.deepStrictEqual(c.foco, [true]);
    assert.ok(c.acoes().some(js => js.includes('panel:open')));
  });

  it('fechar o painel (browserMessage panel:close) devolve o foco ao jogo', () => {
    const c = ctxFalso();
    c.press(60);
    c.handlers.browserMessage[0]({ arguments: [{ type: 'panel:close', data: {} }] });
    assert.deepStrictEqual(c.foco, [true, false]);
    c.handlers.browserMessage[0]({ arguments: ['front-loaded'] });
    assert.deepStrictEqual(c.foco, [true, false], 'outras mensagens não mexem no foco');
  });

  it('Enter abre o chat e foca; chat:close devolve o foco', () => {
    const c = ctxFalso();
    c.press(28);
    assert.deepStrictEqual(c.foco, [true]);
    assert.ok(c.acoes().includes('window.openChat && window.openChat()'));
    c.handlers.browserMessage[0]({ arguments: [{ type: 'chat:close', data: {} }] });
    assert.deepStrictEqual(c.foco, [true, false]);
  });

  it('F8 opens and focuses the admin panel for staff; admin:close gives focus back', () => {
    const c = ctxFalso({ staff: true });
    c.press(66);
    assert.deepStrictEqual(c.foco, [true]);
    assert.ok(c.acoes().includes('window.handlePlayerShortcutKey && window.handlePlayerShortcutKey("admin:open")'));
    c.handlers.browserMessage[0]({ arguments: [{ type: 'admin:close', data: {} }] });
    assert.deepStrictEqual(c.foco, [true, false]);
  });

  it('F8 does nothing for non-staff (and before the server said who is staff)', () => {
    for (const opts of [{ staff: false }, {}, { semValor: true }]) {
      const c = ctxFalso(opts);
      c.press(66);
      assert.deepStrictEqual(c.foco, [], JSON.stringify(opts));
      assert.deepStrictEqual(c.acoes(), [], JSON.stringify(opts));
    }
  });

  it('o servidor reconhece chat:open/chat:close (sem aviso de prefixo sem dono)', async () => {
    assert.strictEqual(await shortcuts.handleChatUiEvent(1, { type: 'chat:close' }), true);
    assert.strictEqual(await shortcuts.handleChatUiEvent(1, { type: 'chat:other' }), false);
  });

  it('funciona com os defaults antes de o servidor mandar os keybinds', () => {
    const c = ctxFalso({ semValor: true });
    c.press(60);
    assert.ok(c.acoes().some(js => js.includes('panel:open')));
  });

  const PANEL = 'window.handlePlayerShortcutKey && window.handlePlayerShortcutKey("panel:open")';
  const PTT_ON = 'window.handleVoicePushToTalk && window.handleVoicePushToTalk(true)';
  const PTT_OFF = 'window.handleVoicePushToTalk && window.handleVoicePushToTalk(false)';
  const CYCLE = 'window.handleVoiceCycleKey && window.handleVoiceCycleKey()';
  const MUTE = 'window.handleVoiceMuteKey && window.handleVoiceMuteKey()';

  it('espelha os keybinds na CEF quando o valor muda (e só então)', () => {
    const c = ctxFalso();
    assert.strictEqual(c.executados.filter(js => js.includes('handleKeybindsUpdate')).length, 1);
    assert.ok(c.executados[0].includes('"panel.open":60'));
    c.run(); // updateOwner roda de novo com o mesmo sentAt
    assert.strictEqual(c.executados.filter(js => js.includes('handleKeybindsUpdate')).length, 1);
  });

  it('defaults: F2 abre o painel, F11 cicla o modo, V é push-to-talk', () => {
    const c = ctxFalso();
    c.press(87);
    c.press(47);
    c.release(47);
    c.press(60); // por último: F2 foca o painel, e com foco o jogo ignora as outras teclas
    assert.deepStrictEqual(c.acoes(), [CYCLE, PTT_ON, PTT_OFF, PANEL]);
  });

  it('mutar não tem tecla por padrão; M e Tab não fazem nada', () => {
    const c = ctxFalso();
    c.press(50);
    c.press(15);
    assert.deepStrictEqual(c.acoes(), []);
  });

  it('teclas novas valem assim que o servidor manda outro valor', () => {
    const c = ctxFalso();
    c.ctx.value = { sentAt: 2, bindings: { ...DEFAULTS, 'voice.toggleMute': 50, 'panel.open': 59 } };
    c.run();
    c.press(50);
    c.press(59);
    c.press(60);
    assert.deepStrictEqual(c.acoes(), [MUTE, PANEL]);
  });

  it('ignora teclas com a CEF focada, mas SEMPRE solta o push-to-talk', () => {
    const c = ctxFalso();
    c.press(47);                // começa a falar
    c.browser.focused = true;   // abriu o chat no meio
    c.press(60);
    c.press(87);
    c.release(47);              // soltar precisa fechar o microfone
    assert.deepStrictEqual(c.acoes(), [PTT_ON, PTT_OFF]);
  });

  it('ignora soltar sem ter apertado, outros dispositivos e repetição', () => {
    const c = ctxFalso();
    c.release(47);
    c.press(60, { device: 2 });
    c.press(60, { isDown: false, isHeld: true });
    c.handlers.buttonEvent[0](undefined);
    assert.deepStrictEqual(c.acoes(), []);
  });

  it('registra um único listener mesmo com updateOwner repetido', () => {
    const c = ctxFalso();
    c.run();
    c.run();
    assert.strictEqual(c.handlers.buttonEvent.length, 1);
  });
});

describe('player-shortcuts-service: loading screens', () => {
  it('hides the OATHBOUND HUD while the Loading Menu is open', () => {
    const svc = require('./player-shortcuts-service');
    const handlers = {};
    const js = [];
    const ctx = {
      state: {},
      value: { sentAt: 1, bindings: {}, staff: false },
      sp: {
        on: (n, fn) => { handlers[n] = fn; },
        browser: { executeJavaScript: (s) => js.push(s), isFocused: () => false }
      }
    };
    new Function('ctx', svc.SNIPPET_DO_CLIENTE)(ctx);
    handlers.menuOpen({ name: 'Loading Menu' });
    assert.ok(js.some((s) => s.includes('classList.add("ob-loading")')));
    handlers.menuClose({ name: 'Loading Menu' });
    assert.ok(js.some((s) => s.includes('classList.remove("ob-loading")')));
    js.length = 0;
    handlers.menuOpen({ name: 'InventoryMenu' });
    assert.ok(!js.some((s) => s.includes('ob-loading')));
  });
});
