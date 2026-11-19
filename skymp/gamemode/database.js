const mysql = require('mysql2/promise');
const path = require('path');
const fs = require('fs');

let pool = null;

function init() {
  if (pool) return pool;

  try {
    const configPath = path.resolve(__dirname, '../config/database.local.json');
    if (!fs.existsSync(configPath)) {
      throw new Error(`Database config file not found at: ${configPath}`);
    }

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    
    pool = mysql.createPool({
      host: config.host || '127.0.0.1',
      port: config.port || 3306,
      user: config.user || 'root',
      password: config.password || '',
      database: config.database || 'skymp_rp',
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0
    });

    console.log('[database] MySQL connection pool initialized successfully');
    return pool;
  } catch (err) {
    console.error('[database] Failed to initialize MySQL pool:', err.message);
    throw err;
  }
}

async function query(sql, params) {
  if (!pool) {
    init();
  }
  const [rows] = await pool.execute(sql, params);
  return rows;
}

async function getConnection() {
  if (!pool) {
    init();
  }
  return pool.getConnection();
}

/**
 * Closes the pool and frees the event loop.
 *
 * The game server never calls this — it runs until it is shut down. What needs it
 * is a command-line script: while the pool exists, mysql2 keeps sockets
 * open and Node does not exit on its own.
 *
 * `scripts/verify-governance-market-stalls.js` already called `db.close()`, behind
 * an `if (typeof db.close === 'function')` — and this function did not exist, so the
 * guard never fired. The result was that `RUN_DB_CHECK=1 npm run
 * test:systems` printed "10/10 checks passed" and **hung
 * forever**, without giving the prompt back. In a CI with a database, the job would only end on
 * timeout, and the report would say "cancelled" instead of "passed".
 */
async function close() {
  if (!pool) return;
  const atual = pool;
  pool = null;
  await atual.end();
}

module.exports = {
  init,
  query,
  getConnection,
  close,
  getPool: () => pool
};
