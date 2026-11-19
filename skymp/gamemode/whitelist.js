const db = require('./database');
const commands = require('./commands');
const inventoryService = require('./inventory-service');
const adminService = require('./admin-service');
const characterState = require('./core/character-state');
const serverOptions = require('./core/server-options');
const transactionService = require('./core/transaction-service');
const economyPhysicalSync = require('./core/economy-physical-sync');
// NOTE: no PARKED module is imported here. They are initialized
// exclusively by the module-registry when the matching ENABLE_* flag
// is on — importing them directly at boot would make them run without going through the registry.

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

    if (wlRows.length === 0) {
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
           VALUES (?, ?, ?, 'approved', 35, -165, -189, 180, '162e2:Skyrim.esm')`,
          [account.id, firstName, lastName]
        );
        character = {
          id: insertChar.insertId,
          first_name: firstName,
          last_name: lastName,
          pos_x: 35,
          pos_y: -165,
          pos_z: -189,
          angle_z: 180,
          cell_id: '162e2:Skyrim.esm'
        };
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

    // Register the staff role (loaded from staff_roles, not from vip_level)
    await adminService.registerStaffRole(actorId, account.id);
    
    // Initialize the state machine (loads IMPRISONED/RESTRAINED from the DB)
    await characterState.initialize(character.id);

    await grantStartingGold(character.id);
    await revelarPrimeiroSinal(character.id);

    // Physical gold anti-cheat (Gold001 should never exist in the inventory
    // — see core/economy-physical-sync.js). Does not block login by design,
    // same philosophy as grantStartingGold above.
    economyPhysicalSync.reconcileOnLogin(actorId, character.id).catch((err) => {
      console.error(`[whitelist] Physical gold anti-cheat failed for ${character.id}:`, err.message);
    });

    // 5. Update the player's in-game position from the database
    if (typeof mp !== 'undefined' && actorId) {
      console.log(`[whitelist] Moving actor ${actorId.toString(16)} to db location: pos=[${character.pos_x}, ${character.pos_y}, ${character.pos_z}] cell=${character.cell_id}`);
      
      const locData = {
        pos: [character.pos_x, character.pos_y, character.pos_z],
        rot: [0, 0, character.angle_z],
        cellOrWorldDesc: character.cell_id
      };
      
      try {
        mp.set(actorId, 'locationalData', locData);
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
