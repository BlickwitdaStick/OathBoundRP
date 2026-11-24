const db = require('./database');
const commands = require('./commands');
const inventoryService = require('./inventory-service');
const adminService = require('./admin-service');
const characterState = require('./core/character-state');
const serverOptions = require('./core/server-options');
const transactionService = require('./core/transaction-service');
const economyPhysicalSync = require('./core/economy-physical-sync');
const characterNumbers = require('./core/character-numbers');
// NOTA: nenhum módulo PARKED é importado aqui. Eles são inicializados
// exclusivamente pelo module-registry quando a flag ENABLE_* correspondente
// está ligada — importar direto no boot os faria rodar sem passar pelo registry.

/**
 * WHITELIST_REQUIRED=false opens the server: anyone the launcher lets in plays,
 * and a first login creates their character. Anything but an explicit "false"
 * keeps the whitelist on.
 */
function whitelistRequired() {
  return String(process.env.WHITELIST_REQUIRED || '').trim().toLowerCase() !== 'false';
}

/** Last name a character created on first login carries until the player picks one (/rpname). */
const UNNAMED = commands.UNNAMED_LAST_NAME || 'Unnamed';

/** First name for a new character: the player's Discord name, cleaned to letters. */
async function newcomerFirstName(accountId) {
  try {
    const rows = await db.query('SELECT username FROM discord_identities WHERE account_id = ? LIMIT 1', [accountId]);
    const clean = String((rows[0] && rows[0].username) || '').replace(/[^A-Za-z' -]/g, '').trim().slice(0, 32);
    if (clean) return clean.charAt(0).toUpperCase() + clean.slice(1);
  } catch (err) {
    console.error('[whitelist] Could not read the Discord name:', err.message);
  }
  return `Traveler ${accountId}`;
}

/** True when the account has never had a character (any status). */
async function hasNoCharacters(accountId) {
  const rows = await db.query('SELECT COUNT(*) AS n FROM characters WHERE account_id = ?', [accountId]);
  return Number(rows[0] && rows[0].n) === 0;
}

function allowLocalAutoWhitelist(profileId) {
  if (process.env.NODE_ENV === 'production') return false;
  if (process.env.ALLOW_LOCAL_AUTOWHITELIST !== 'true') return false;
  return profileId === 1 || profileId === 2;
}

// In online mode, SkyMP gets `profileId` from `user.id` in the Master API.
// Our Master API deliberately returns `accounts.id`; it is not a Discord ID.
function accountIdFromProfileId(profileId) {
  const accountId = Number(profileId);
  return Number.isSafeInteger(accountId) && accountId > 0 ? accountId : null;
}

/**
 * Grants the starting gold (`economy.startingGold`) exactly once per character.
 *
 * The "only once" guarantee comes from the UNIQUE `idempotency_key` of
 * `gold_transactions`: the key is derived from the characterId, so the second
 * attempt is ignored by `transaction-service` itself. Without that, the gold
 * would be granted on every login and become an infinite source of money —
 * exactly the kind of thing the server-authoritative economy exists to
 * prevent.
 *
 * Characters created through the panel (`apps/web`) are born with the DB default;
 * it is here, on the first spawn, that the gameplay option is applied.
 */
async function grantStartingGold(characterId) {
  const startingGold = serverOptions.get('economy.startingGold');
  if (startingGold <= 0) return;

  try {
    await transactionService.addGold({
      characterId,
      amount: startingGold,
      reason: 'starting_gold',
      module: 'whitelist',
      idempotencyKey: `starting_gold:${characterId}`
    });
  } catch (err) {
    // Does not block the spawn: joining without the starting gold is a small problem
    // compared to not being able to join.
    console.error(`[whitelist] Failed to grant starting gold to ${characterId}:`, err.message);
  }
}

/**
 * Derives the soul and delivers the first sign (`SOUL_AFFINITY.md` §II.1).
 *
 * It is here and not in the module's `initialize()` because the sign belongs to the **first
 * spawn**, not to server boot: "every character receives the first sign in the
 * first session" solves an RP server's deadliest problem, which is not
 * balancing — it is the first hour being empty.
 *
 * The require is lazy and behind `isEnabled`, for the same reason as the note at the
 * top of this file: importing at the top would make the module load even with
 * `ENABLE_SOUL_SERVICE` off, and `soul-service` throws at boot when
 * `SOUL_SECRET` is missing. With the flag off nothing here runs, not even the require.
 *
 * Does not block the spawn — same choice as the starting gold: joining without the sign is a
 * small problem compared to not being able to join.
 */
async function revelarPrimeiroSinal(characterId) {
  const moduleRegistry = require('./core/module-registry');
  if (!moduleRegistry.isEnabled('soul')) return;

  try {
    await require('./soul-service').onFirstSpawn(characterId);
  } catch (err) {
    console.error(`[whitelist] Failed to reveal the first sign for ${characterId}:`, err.message);
  }
}

async function checkWhitelist(userId, profileId, actorId) {
  try {
    console.log(`[whitelist] Running check for User:${userId}, Profile:${profileId}, Actor:${actorId.toString(16)}`);

    // 1. In online mode, profileId is the account id resolved by the Master API.
    // Never resolve it through discord_identities: that confuses two namespaces.
    const accountId = accountIdFromProfileId(profileId);
    if (!accountId) {
      console.log(`[whitelist] Invalid account profileId: ${profileId}. Kicking user ${userId}...`);
      if (typeof mp !== 'undefined') mp.kick(userId);
      return false;
    }

    let accountRows = await db.query(
      `SELECT a.id, a.status, a.vip_level 
       FROM accounts a
       WHERE a.id = ?`,
      [accountId]
    );

    let account = null;
    if (accountRows.length === 0) {
      if (!allowLocalAutoWhitelist(profileId)) {
        console.log(`[whitelist] Account not found for profileId: ${profileId}. Kicking user ${userId}...`);
        if (typeof mp !== 'undefined') mp.kick(userId);
        return false;
      }
      console.log(`[whitelist] Account not found for profileId: ${profileId}. Auto-registering local account...`);
      // Local lab only. NEVER in production.
      await db.query(`INSERT INTO accounts (id, status) VALUES (?, 'active')`, [accountId]);
      await db.query(
        `INSERT INTO discord_identities (discord_id, account_id, username) VALUES (?, ?, ?)`,
        [profileId.toString(), accountId, `Player_${profileId}`]
      );
      account = { id: accountId, status: 'active', vip_level: 0 };
    } else {
      account = accountRows[0];
    }

    // 2. Check that the account is active
    if (account.status !== 'active') {
      console.log(`[whitelist] Account ${account.id} is NOT active (status: ${account.status}). Kicking user ${userId}...`);
      if (typeof mp !== 'undefined') mp.kick(userId);
      return false;
    }

    // 3. Check Whitelist approval
    let wlRows = await db.query(
      `SELECT status FROM whitelist_applications WHERE account_id = ? AND status = 'approved'`,
      [account.id]
    );

    if (wlRows.length === 0 && whitelistRequired()) {
      if (allowLocalAutoWhitelist(profileId)) {
        console.log(`[whitelist] Auto-approving whitelist application for profileId ${profileId}...`);
        await db.query(
          `INSERT INTO whitelist_applications (account_id, status, reviewer_notes) VALUES (?, 'approved', 'Auto-approved for local test')`,
          [account.id]
        );
      } else {
        console.log(`[whitelist] User ${userId} (profileId: ${profileId}) has no approved Whitelist. Kicking...`);
        if (typeof mp !== 'undefined') mp.kick(userId);
        return false;
      }
    }

    // 4. Check that there is an active, approved character
    // ORDER BY + LIMIT 1: today there is only 1 approved character per account (the
    // application blocks resubmission while one is pending/approved), but without this
    // the query would pick an arbitrary row from the DB if that changes in the future
    // (e.g. support for a main character + alt).
    let charRows = await db.query(
      `SELECT * FROM characters WHERE account_id = ? AND status = 'approved' ORDER BY id DESC LIMIT 1`,
      [account.id]
    );

    let character = null;
    if (charRows.length === 0) {
      if (allowLocalAutoWhitelist(profileId)) {
        const firstName = profileId === 2 ? 'Jarl' : 'Jon';
        const lastName = profileId === 2 ? 'Balgruuf' : 'Battleborn';
        console.log(`[whitelist] Auto-creating approved character: ${firstName} ${lastName}...`);
        const insertChar = await db.query(
          `INSERT INTO characters (account_id, first_name, last_name, status, pos_x, pos_y, pos_z, angle_z, cell_id) 
           VALUES (?, ?, ?, 'approved', -977, 9, 5, 137, '133c6:Skyrim.esm')`,
          [account.id, firstName, lastName]
        );
        character = {
          id: insertChar.insertId,
          first_name: firstName,
          last_name: lastName,
          pos_x: -977,
          pos_y: 9,
          pos_z: 5,
          angle_z: 137,
          cell_id: '133c6:Skyrim.esm'
        };
      } else if (!whitelistRequired() || await hasNoCharacters(account.id)) {
        // Whitelist off, or whitelisted with no character at all (by Discord
        // role, without a character sheet): the first login makes one. A
        // retired character still needs a new application.
        const firstName = await newcomerFirstName(account.id);
        console.log(`[whitelist] Creating ${firstName}'s first character...`);
        const insertChar = await db.query(
          `INSERT INTO characters (account_id, first_name, last_name, status) VALUES (?, ?, ?, 'approved')`,
          [account.id, firstName, UNNAMED]
        );
        const created = await db.query('SELECT * FROM characters WHERE id = ?', [insertChar.insertId]);
        character = created[0] || { id: insertChar.insertId, first_name: firstName, last_name: UNNAMED };
        if (typeof mp !== 'undefined') {
          setTimeout(() => {
            try {
              commands.sendNotification(actorId, 'Welcome to OATHBOUND. Name your character with /rpname <First> <Last>.');
            } catch (_) { /* the player left */ }
          }, 15000);
        }
      } else {
        console.log(`[whitelist] User ${userId} has no approved characters. Kicking...`);
        if (typeof mp !== 'undefined') mp.kick(userId);
        return false;
      }
    } else {
      character = charRows[0];
    }

    console.log(`[whitelist] Whitelist check passed! Welcome, ${character.first_name} ${character.last_name}`);
    
    // Register in the commands' memory cache
    commands.registerActiveCharacter(actorId, character, account.id, profileId);

    // Character number (#1..#5000) used by chat commands instead of the actorId.
    // A failure here must not block the login: commands still accept 0x actorIds.
    try {
      const charNumber = await characterNumbers.ensureNumber(db, character.id, character.char_number);
      commands.setCharacterNumber(actorId, charNumber);
      if (charNumber) {
        setTimeout(() => commands.sendNotification(actorId, `Your character number is #${charNumber}. Others use it in commands (e.g. /trade ${charNumber}).`), 8000);
      } else {
        console.error(`[whitelist] No free character number for character ${character.id} (all ${characterNumbers.MAX_CHARACTER_NUMBER} in use)`);
      }
    } catch (err) {
      console.error(`[whitelist] Could not assign a character number to character ${character.id}:`, err.message);
    }

    // Registrar cargo de staff (carregado de staff_roles, não de vip_level)
    await adminService.registerStaffRole(actorId, account.id);
    
    // Initialize the state machine (loads IMPRISONED/RESTRAINED from the DB)
    await characterState.initialize(character.id);

    // Came back dead or downed from before a restart/disconnect: revive before
    // the client spawns, or it lands in Skyrim's locked black death screen.
    if (require('./core/module-registry').isEnabled('death')) {
      try { require('./death-service').recoverOnLogin(actorId, character.id); }
      catch (err) { console.error(`[whitelist] Could not clear a leftover death for ${character.id}:`, err.message); }
    }

    await grantStartingGold(character.id);
    await revelarPrimeiroSinal(character.id);

    // Inventory gold and characters.gold are the same money from here on
    // (core/economy-physical-sync.js). After grantStartingGold, so starting
    // gold reaches the inventory. Never blocks login.
    economyPhysicalSync.reconcileOnLogin(actorId, character.id).catch((err) => {
      console.error(`[whitelist] Gold sync failed for character ${character.id}:`, err.message);
    });

    // Survival needs carry over from the last session (survival-service.js).
    if (require('./core/module-registry').isEnabled('survival')) {
      require('./survival-service').onLogin(actorId, character.id).catch((err) => {
        console.error(`[whitelist] Survival needs failed to load for character ${character.id}:`, err.message);
      });
    }

    // 5. Atualizar posição do jogador in-game a partir do banco de dados
    if (typeof mp !== 'undefined' && actorId) {
      const positionPersistence = require('./core/position-persistence');
      // cell_id must reach SkyMP as "id:plugin": a bare '0x162e2' is read as a
      // nonexistent server-generated cell and freezes the actor there
      // (see core/position-persistence.js).
      const locData = positionPersistence.loginLocation(character,
        typeof mp.getDescFromId === 'function' ? (id) => mp.getDescFromId(id) : null,
        positionPersistence.cellCheckerFor(mp));

      try {
        if (locData) {
          console.log(`[whitelist] Moving actor ${actorId.toString(16)} to db location: pos=[${locData.pos.join(', ')}] cell=${locData.cellOrWorldDesc} (stored: ${character.cell_id})`);
          mp.set(actorId, 'locationalData', locData);
        } else {
          console.error(`[whitelist] Character ${character.id} has no usable saved location (pos=[${character.pos_x}, ${character.pos_y}, ${character.pos_z}] cell=${character.cell_id}); leaving the actor where SkyMP placed it.`);
        }
        // From here on the actor stands where it logged out, so its position
        // may be saved.
        positionPersistence.getInstance().markRestored(actorId);
        mp.set(actorId, 'browserVisible', true);
        console.log(`[whitelist] Spawn locData applied successfully for ${character.first_name} ${character.last_name}`);
        
        // Sync the database inventory to the client (with reconciliation)
        await inventoryService.syncInventoryToClient(actorId, character.id);
        
      } catch (err) {
        console.error(`[whitelist] Failed to apply locationalData:`, err.message);
      }
    }

    return true;
  } catch (err) {
    console.error(`[whitelist] Exception checking whitelist for user ${userId}:`, err);
    if (typeof mp !== 'undefined') mp.kick(userId);
    return false;
  }
}

module.exports = {
  checkWhitelist,
  accountIdFromProfileId
};
