import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';

import { startGameProcess, GameProcessError } from './game-process.mjs';

class ProcessoFalso extends EventEmitter {
  constructor(pid) {
    super();
    this.pid = pid;
    this.unrefCalls = 0;
  }

  unref() {
    this.unrefCalls++;
  }
}

describe('startGameProcess', () => {
  it('uses a direct spawn with a safe cwd and detaches only after the spawn event', async () => {
    const child = new ProcessoFalso(4242);
    let spawnCall;
    const spawnImpl = (...args) => {
      spawnCall = args;
      queueMicrotask(() => child.emit('spawn'));
      return child;
    };

    const resultado = await startGameProcess(
      'C:\\Skyrim\\skse64_loader.exe',
      'C:\\Skyrim',
      { spawnImpl, timeoutMs: 100 }
    );

    assert.deepEqual(resultado, { pid: 4242 });
    assert.equal(spawnCall[0], 'C:\\Skyrim\\skse64_loader.exe');
    assert.deepEqual(spawnCall[1], []);
    assert.deepEqual(spawnCall[2], {
      cwd: 'C:\\Skyrim',
      detached: true,
      stdio: 'ignore',
      shell: false,
      windowsHide: true
    });
    assert.equal(child.unrefCalls, 1);
  });

  it('turns a synchronous spawn error into a stable code', async () => {
    const original = Object.assign(new Error('acesso negado'), { code: 'EACCES' });

    await assert.rejects(
      startGameProcess('loader.exe', 'C:\\Game', {
        spawnImpl: () => { throw original; }
      }),
      (error) => {
        assert.ok(error instanceof GameProcessError);
        assert.equal(error.code, 'GAME_SPAWN_FAILED');
        assert.equal(error.cause, original);
        assert.match(error.message, /acesso negado/);
        return true;
      }
    );
  });

  it('rejects on the error event and does not call unref', async () => {
    const child = new ProcessoFalso(undefined);
    const original = Object.assign(new Error('file does not exist'), { code: 'ENOENT' });
    const pending = startGameProcess('loader.exe', 'C:\\Game', {
      spawnImpl: () => child,
      timeoutMs: 100
    });
    queueMicrotask(() => child.emit('error', original));

    await assert.rejects(pending, (error) => {
      assert.equal(error.code, 'GAME_SPAWN_FAILED');
      assert.equal(error.cause, original);
      return true;
    });
    assert.equal(child.unrefCalls, 0);
  });

  it('rejects a confirmation without a valid PID and does not call unref', async () => {
    for (const pid of [undefined, 0, -1, 1.5]) {
      const child = new ProcessoFalso(pid);
      const pending = startGameProcess('loader.exe', 'C:\\Game', {
        spawnImpl: () => child,
        timeoutMs: 100
      });
      queueMicrotask(() => child.emit('spawn'));

      await assert.rejects(pending, (error) => {
        assert.equal(error.code, 'GAME_SPAWN_NO_PID');
        return true;
      });
      assert.equal(child.unrefCalls, 0);
    }
  });

  it('rejects when there is no confirmation before the timeout', async () => {
    const child = new ProcessoFalso(undefined);

    await assert.rejects(
      startGameProcess('loader.exe', 'C:\\Game', {
        spawnImpl: () => child,
        timeoutMs: 5
      }),
      (error) => {
        assert.equal(error.code, 'GAME_SPAWN_TIMEOUT');
        return true;
      }
    );
    assert.equal(child.unrefCalls, 0);
  });
});
