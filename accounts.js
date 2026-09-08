// accounts.js
//
// Data-access helpers for the telegram_accounts table, which records
// every Telegram user who has interacted with the bot. This is what lets
// /admincommand resolve a plain "@username" to a numeric Telegram ID,
// since bots can't look that up from Telegram itself unless the user has
// messaged the bot before.
//
// Usage:
//   const accounts = require('./accounts');
//   await accounts.upsertAccount(ctx.from);

const pool = require('./db');

/**
 * Inserts a Telegram user into telegram_accounts on first contact, or
 * refreshes their name/username if they've already been seen. Call this
 * from a bot-wide middleware (see main.js) so every user who messages the
 * bot becomes resolvable by @username later.
 *
 * Usage:
 *   bot.use(async (ctx, next) => {
 *     if (ctx.from) await accounts.upsertAccount(ctx.from);
 *     return next();
 *   });
 *
 * @param {object} from - Telegraf's ctx.from object (id, first_name, last_name, username)
 */
async function upsertAccount(from) {
  await pool.query(
    `INSERT INTO telegram_accounts (UserID, FirstName, LastName, Username)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       FirstName = VALUES(FirstName),
       LastName  = VALUES(LastName),
       Username  = VALUES(Username)`,
    [from.id, from.first_name || null, from.last_name || null, from.username || null]
  );
}

/**
 * Looks up a known account by @username (case-insensitive, no leading @).
 *
 * Usage:
 *   const account = await getAccountByUsername('someuser');
 */
async function getAccountByUsername(username) {
  const [rows] = await pool.query(
    'SELECT * FROM telegram_accounts WHERE LOWER(Username) = LOWER(?) LIMIT 1',
    [username]
  );
  return rows[0] || null;
}

/**
 * Looks up a known account by numeric Telegram user ID.
 *
 * Usage:
 *   const account = await getAccountByUserId(542797568);
 */
async function getAccountByUserId(userId) {
  const [rows] = await pool.query(
    'SELECT * FROM telegram_accounts WHERE UserID = ? LIMIT 1',
    [userId]
  );
  return rows[0] || null;
}

module.exports = { upsertAccount, getAccountByUsername, getAccountByUserId };
