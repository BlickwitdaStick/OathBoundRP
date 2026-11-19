/**
 * core/command-registry.js
 *
 * Central registry of chat commands.
 * Replaces the monolithic switch in commands.js.
 *
 * Modules register their commands via:
 *   commandRegistry.register('chopwood', handler, { module: 'woodcutting', phase: 'lab' });
 *
 * Dispatch happens via:
 *   commandRegistry.dispatch(actorId, '/chopwood', 'args...');
 *
 * If the module that owns a command is not enabled,
 * the command is not registered and does not exist for the player.
 */

// Map of command → { handler, module, phase, description }
const _commands = new Map();

/**
 * Registers a command in the registry.
 *
 * @param {string|string[]} command - Command (e.g. '/chopwood') or a list of aliases
 * @param {Function} handler - async function(actorId, args) → void
 * @param {object} [opts]
 * @param {string} [opts.module] - ID of the owning module
 * @param {string} [opts.phase] - Module phase ('core', 'lab', 'parked')
 * @param {string} [opts.description] - Description for /help
 * @param {string} [opts.usage] - Usage example
 * @param {boolean} [opts.hidden] - Task 11 (Legacy Command Cleanup): does not
 *   show up in the player-facing listing (`list({ playerFacing: true })`),
 *   but stays registered and working — it is for debug/staff/bad-network
 *   fallback, not for disappearing. A command that became a real contextual
 *   action (the interaction menu, the `[E]` prompt) is marked `hidden: true` instead of being removed.
 */
function register(command, handler, opts = {}) {
  const commands = Array.isArray(command) ? command : [command];
  for (const cmd of commands) {
    const normalized = cmd.toLowerCase().startsWith('/') ? cmd.toLowerCase() : `/${cmd.toLowerCase()}`;
    if (_commands.has(normalized)) {
      console.warn(`[command-registry] Warning: command ${normalized} overridden by module '${opts.module || 'unknown'}'`);
    }
    _commands.set(normalized, {
      handler,
      module: opts.module || 'unknown',
      phase: opts.phase || 'core',
      description: opts.description || '',
      usage: opts.usage || normalized,
      hidden: Boolean(opts.hidden)
    });
  }
}

/**
 * Removes a command from the registry (used when a module shuts down).
 * @param {string|string[]} command
 */
function unregister(command) {
  const commands = Array.isArray(command) ? command : [command];
  for (const cmd of commands) {
    const normalized = cmd.toLowerCase().startsWith('/') ? cmd.toLowerCase() : `/${cmd.toLowerCase()}`;
    _commands.delete(normalized);
  }
}

/**
 * Dispatches a command to its registered handler.
 *
 * @param {number} actorId
 * @param {string} command - Command with '/' (e.g. '/chopwood')
 * @param {string} args - Arguments as a string
 * @returns {boolean} true if the command was found and dispatched, false if it does not exist
 */
function dispatch(actorId, command, args) {
  const normalized = command.toLowerCase();
  const entry = _commands.get(normalized);

  if (!entry) {
    return false; // Command not found
  }

  try {
    const result = entry.handler(actorId, args);
    if (result instanceof Promise) {
      result.catch((err) => {
        console.error(`[command-registry] Error in handler for ${normalized} (module: ${entry.module}):`, err.message);
      });
    }
  } catch (err) {
    console.error(`[command-registry] Synchronous error in handler for ${normalized} (module: ${entry.module}):`, err.message);
  }

  return true;
}

/**
 * Checks whether a command is registered.
 * @param {string} command
 * @returns {boolean}
 */
function has(command) {
  const normalized = command.toLowerCase().startsWith('/') ? command.toLowerCase() : `/${command.toLowerCase()}`;
  return _commands.has(normalized);
}

/**
 * Lists registered commands.
 *
 * With no options it lists EVERYTHING — including `hidden` — because that is
 * what a staff/debug panel needs to see. There is no `/help` in this project
 * yet (Task 11 did not invent one); when one is written, it is the one that
 * passes `playerFacing: true`, not this file deciding on its own what the
 * player sees.
 *
 * @param {{playerFacing?: boolean}} [opcoes]
 * @returns {Array<{command: string, module: string, phase: string, description: string, usage: string, hidden: boolean}>}
 */
function list(opcoes = {}) {
  const todos = Array.from(_commands.entries()).map(([cmd, entry]) => ({
    command: cmd,
    module: entry.module,
    phase: entry.phase,
    description: entry.description,
    usage: entry.usage,
    hidden: entry.hidden
  }));
  return opcoes.playerFacing ? todos.filter((c) => !c.hidden) : todos;
}

module.exports = { register, unregister, dispatch, has, list };
