/**
 * inventory-service.test.js
 *
 * `syncInventoryToClient` roda no login e entrega só o que está em
 * `character_inventory_pending` (migration-v37). Antes ela dava AddItem em
 * todo `character_inventory`, em cima do inventário que o SkyMP já salva no
 * changeForm do personagem: um spell tome dado pelo staff e largado no chão
 * voltava a cada login. O primeiro describe congela essa regressão.
 *
 * `giveItem`/`removeItem`/`hasItem` são delegadores puros para
 * `core/transaction-service` — o teste deles é só de propagação de
 * argumento e dos defaults (`reason='unknown'`, `module='inventory'`).
 *
 * `./database` e `./core/transaction-service` são interceptados via
 * `Module._load`, mesmo padrão de jobs-service.test.js. `./core/papyrus`
 * NÃO é mockado — `actorRef()` real roda contra o `global.mp` mockado
 * abaixo, porque é só uma leitura de `mp.getDescFromId`.
 *
 * Executa com: node --test inventory-service.test.js
 */

'use strict';

const assert = require('node:assert/strict');
const { describe, it, after, beforeEach } = require('node:test');

// ─────────────────────────────────────────────────────────────────────────────
// Banco falso: duas tabelas em memória, chaveadas por `${characterId}:${baseId}`.

const inventoryTable = new Map(); // character_inventory
const pendingTable = new Map();   // character_inventory_pending
const k = (c, b) => `${c}:${b}`;

const addItemCalls = []; // [{baseId, count, self}]
const giveItemCalls = [];
const removeItemCalls = [];
const hasItemCalls = [];
const queueCalls = [];

let addItemImpl = (baseId, count, actorId) => {}; // sucesso por padrão

const databaseMock = {
  query: async (sql, params) => {
    if (/FROM character_inventory_pending p/.test(sql)) {
      const [charId] = params;
      const rows = [];
      for (const [key, count] of pendingTable) {
        const [c, b] = key.split(':').map(Number);
        if (c !== charId) continue;
        rows.push({ base_id: b, pending: count, count: Math.min(count, inventoryTable.get(key) || 0) });
      }
      return rows;
    }
    if (/^UPDATE character_inventory_pending SET count = count - \?/.test(sql)) {
      const [n, c, b] = params;
      if (pendingTable.has(k(c, b))) pendingTable.set(k(c, b), pendingTable.get(k(c, b)) - n);
      return { affectedRows: 1 };
    }
    if (/^DELETE FROM character_inventory_pending/.test(sql)) {
      const [c, b] = params;
      if ((pendingTable.get(k(c, b)) ?? 1) <= 0) pendingTable.delete(k(c, b));
      return { affectedRows: 1 };
    }
    // A query do código antigo (reenviava todo character_inventory). Responder
    // a ela de verdade é o que faz o teste do spell tome falhar se ela voltar.
    if (/^SELECT base_id, count FROM character_inventory WHERE character_id = \?/.test(sql)) {
      const [charId] = params;
      return [...inventoryTable].filter(([key]) => Number(key.split(':')[0]) === charId)
        .map(([key, count]) => ({ base_id: Number(key.split(':')[1]), count }));
    }
    throw new Error(`query inesperada: ${sql}`);
  }
};

const transactionServiceMock = {
  giveItem: async (opts) => { giveItemCalls.push(opts); return true; },
  removeItem: async (opts) => { removeItemCalls.push(opts); return true; },
  hasItem: async (characterId, baseId, minCount) => { hasItemCalls.push({ characterId, baseId, minCount }); return true; },
  queuePendingDelivery: async (c, b, n) => {
    queueCalls.push({ c, b, n });
    pendingTable.set(k(c, b), (pendingTable.get(k(c, b)) || 0) + n);
  }
};

const Module = require('module');
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === './database' || request.endsWith('/database')) return databaseMock;
  if (request === './core/transaction-service' || request.endsWith('/core/transaction-service')) return transactionServiceMock;
  return originalLoad.apply(this, arguments);
};

const inventory = require('./inventory-service');

Module._load = originalLoad;

after(() => {
  delete global.mp;
});

// Item arguments to Papyrus must be base-record refs (core/papyrus.baseRef):
// SkyMP silently ignores a raw FormID, so the item never reached the game.
// The fake rejects a raw number so that bug cannot come back unnoticed.
function itemIdOf(a) {
  if (!a || typeof a !== 'object' || a.type !== 'espm') {
    throw new Error(`item argument must be baseRef ({type:'espm'}), got ${JSON.stringify(a)}`);
  }
  const d = String(a.desc);
  return d.startsWith('desc-') ? Number(d.slice(5)) : parseInt(d.split(':')[0], 16);
}

global.mp = {
  getDescFromId: (formId) => `${formId.toString(16)}:Skyrim.esm`,
  callPapyrusFunction: (kind, className, fn, self, args) => {
    if (kind === 'method' && className === 'ObjectReference' && fn === 'AddItem') {
      const baseId = itemIdOf(args[0]);
      const count = args[1];
      addItemCalls.push({ baseId, count, self });
      addItemImpl(baseId, count, self);
    }
    return null;
  }
};

beforeEach(() => {
  inventoryTable.clear();
  pendingTable.clear();
  addItemCalls.length = 0;
  giveItemCalls.length = 0;
  removeItemCalls.length = 0;
  hasItemCalls.length = 0;
  queueCalls.length = 0;
  addItemImpl = () => {};
});

const SPELL_TOME = 0x0009e2a7; // Spell Tome: Flames, qualquer livro serve

// ─────────────────────────────────────────────────────────────────────────────

describe('login não reenvia o inventário que o SkyMP já salvou', () => {
  it('item dado enquanto online e depois largado não volta no login (bug do spell tome)', async () => {
    // Staff deu 5 tomos com o jogador online: o giveItem já entregou no jogo,
    // então só `character_inventory` tem a linha — nada pendente.
    inventoryTable.set(k(501, SPELL_TOME), 5);

    // Jogador largou 4 no chão (só o jogo sabe), sai e entra de novo, várias vezes.
    for (let login = 0; login < 3; login++) {
      await inventory.syncInventoryToClient(0xff000001, 501);
    }

    assert.strictEqual(addItemCalls.length, 0, 'nenhum AddItem: o tomo largado não pode reaparecer');
  });

  it('item dado offline é entregue uma vez e só uma vez', async () => {
    inventoryTable.set(k(501, 0x0000000f + 1), 3);
    pendingTable.set(k(501, 0x0000000f + 1), 3);

    await inventory.syncInventoryToClient(0xff000001, 501);
    assert.deepStrictEqual(addItemCalls, [{ baseId: 0x10, count: 3, self: { type: 'form', desc: 'ff000001:Skyrim.esm' } }]);
    assert.strictEqual(pendingTable.size, 0, 'a pendência é consumida');

    await inventory.syncInventoryToClient(0xff000001, 501);
    assert.strictEqual(addItemCalls.length, 1, 'o segundo login não entrega de novo');
  });

  it('nunca entrega mais do que o banco diz que o personagem tem', async () => {
    inventoryTable.set(k(501, 0x20), 2);
    pendingTable.set(k(501, 0x20), 5);

    await inventory.syncInventoryToClient(0xff000001, 501);
    assert.strictEqual(addItemCalls[0].count, 2);
    assert.strictEqual(pendingTable.size, 0);
  });

  it('pendência de item que o personagem já não tem é descartada sem AddItem', async () => {
    pendingTable.set(k(501, 0x20), 5);

    await inventory.syncInventoryToClient(0xff000001, 501);
    assert.strictEqual(addItemCalls.length, 0);
    assert.strictEqual(pendingTable.size, 0);
  });

  it('AddItem que falha devolve a pendência e não impede os demais', async () => {
    inventoryTable.set(k(501, 0x0f), 1);
    inventoryTable.set(k(501, 0x10), 1);
    pendingTable.set(k(501, 0x0f), 1);
    pendingTable.set(k(501, 0x10), 1);
    addItemImpl = (baseId) => { if (baseId === 0x0f) throw new Error('cliente desconectou no meio'); };

    await inventory.syncInventoryToClient(0xff000001, 501);
    assert.strictEqual(addItemCalls.length, 2, 'os dois foram tentados');
    assert.deepStrictEqual(queueCalls, [{ c: 501, b: 0x0f, n: 1 }]);
    assert.deepStrictEqual([...pendingTable.keys()], [k(501, 0x0f)], 'só o item que falhou continua pendente');

    addItemImpl = () => {};
    await inventory.syncInventoryToClient(0xff000001, 501);
    assert.strictEqual(addItemCalls.filter(c => c.baseId === 0x0f).length, 2, 'tentado de novo no próximo login');
    assert.strictEqual(pendingTable.size, 0);
  });

  it('pendências de outro personagem não são entregues', async () => {
    inventoryTable.set(k(502, 0x0f), 3);
    pendingTable.set(k(502, 0x0f), 3);

    await inventory.syncInventoryToClient(0xff000001, 501);
    assert.strictEqual(addItemCalls.length, 0);
    assert.strictEqual(pendingTable.size, 1);
  });

  it('erro de banco não propaga — syncInventoryToClient nunca rejeita', async () => {
    const databaseMockOriginal = databaseMock.query;
    databaseMock.query = async () => { throw new Error('connection lost'); };
    try {
      await assert.doesNotReject(inventory.syncInventoryToClient(0xff000001, 501));
    } finally {
      databaseMock.query = databaseMockOriginal;
    }
  });
});

describe('giveItem/removeItem/hasItem — delegadores para transaction-service', () => {
  it('giveItem repassa os campos e usa os defaults quando reason/module são omitidos', async () => {
    const ok = await inventory.giveItem(0xff000001, 501, 0x0000000f, 3);

    assert.strictEqual(ok, true);
    assert.deepStrictEqual(giveItemCalls[0], {
      actorId: 0xff000001, characterId: 501, baseId: 0x0000000f, count: 3,
      reason: 'unknown', module: 'inventory'
    });
  });

  it('giveItem repassa reason/module explícitos sem usar o default', async () => {
    await inventory.giveItem(0xff000001, 501, 0x0000000f, 3, 'quest_reward', 'quests');

    assert.strictEqual(giveItemCalls[0].reason, 'quest_reward');
    assert.strictEqual(giveItemCalls[0].module, 'quests');
  });

  it('removeItem repassa os campos e usa os defaults', async () => {
    await inventory.removeItem(0xff000001, 501, 0x0000000f, 2);

    assert.deepStrictEqual(removeItemCalls[0], {
      actorId: 0xff000001, characterId: 501, baseId: 0x0000000f, count: 2,
      reason: 'unknown', module: 'inventory'
    });
  });

  it('hasItem repassa minCount e usa 1 como default', async () => {
    await inventory.hasItem(501, 0x0000000f);
    assert.deepStrictEqual(hasItemCalls[0], { characterId: 501, baseId: 0x0000000f, minCount: 1 });

    await inventory.hasItem(501, 0x0000000f, 5);
    assert.deepStrictEqual(hasItemCalls[1], { characterId: 501, baseId: 0x0000000f, minCount: 5 });
  });
});
