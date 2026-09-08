// admins.js
//
// Data-access helpers for the telegram_admins table. Used by the
// /admincommand handler in commands.js to add, remove, list, and look up
// bot admins.
//
// Usage:
//   const admins = require('./admins');
//   const me = await admins.getAdminByUserId(ctx.from.id);

const pool = require('./db');
const accounts = require('./accounts');

// Valid roles, and their rank for permission checks (higher = more access).
// 'public' isn't a real role in the ENUM — it's the rank for anyone who
// isn't an admin at all, so command-visibility checks have a floor to compare against.
const ROLES = ['superadmin', 'admin', 'moderator'];
const ROLE_RANK = { superadmin: 3, admin: 2, moderator: 1, public: 0 };

/**
 * Looks up an admin row by Telegram numeric user ID, active or not.
 *
 * Usage:
 *   const admin = await getAdminByUserId(542797568);
 */
async function getAdminByUserId(userId) {
  const [rows] = await pool.query(
    'SELECT * FROM telegram_admins WHERE UserID = ? LIMIT 1',
    [userId]
  );
  return rows[0] || null;
}

/**
 * Inserts a new admin, or reactivates/updates an existing row for the
 * same Telegram user ID (so re-adding a removed admin just flips them
 * back to active instead of erroring on the UserID unique key).
 *
 * Usage:
 *   await addAdmin(542797568, 'someusername', 'superadmin');
 */
async function addAdmin(telegramUserId, username, role) {
  await pool.query(
    `INSERT INTO telegram_admins (UserID, Username, Role, IsActive)
     VALUES (?, ?, ?, 1)
     ON DUPLICATE KEY UPDATE
       Username = VALUES(Username),
       Role     = VALUES(Role),
       IsActive = 1`,
    [telegramUserId, username, role]
  );
}

/**
 * Soft-removes an admin (IsActive = 0) rather than deleting the row, so
 * the audit trail (when they were added, their role history) is kept.
 * Returns true if a matching row was found and updated.
 *
 * Usage:
 *   const removed = await removeAdmin(542797568);
 */
async function removeAdmin(telegramUserId) {
  const [result] = await pool.query(
    'UPDATE telegram_admins SET IsActive = 0 WHERE UserID = ?',
    [telegramUserId]
  );
  return result.affectedRows > 0;
}

/**
 * Returns every currently active admin, most recently added first.
 *
 * Usage:
 *   const rows = await listAdmins();
 */
async function listAdmins() {
  const [rows] = await pool.query(
    'SELECT * FROM telegram_admins WHERE IsActive = 1 ORDER BY AddedAt DESC'
  );
  return rows;
}

/**
 * Resolves a command argument ("@username" or a raw numeric ID) to a
 * numeric Telegram user ID. Unlike getAdminByUserId, this works even for
 * people who aren't admins yet, by checking telegram_accounts (everyone
 * who has ever messaged the bot) — necessary for /admincommand add.
 * Returns null if a username can't be resolved.
 *
 * Usage:
 *   const userId = await resolveIdentifier('@someuser');
 */
async function resolveIdentifier(identifier) {
  const clean = identifier.replace(/^@/, '');

  if (/^\d+$/.test(clean)) {
    return Number(clean);
  }

  const account = await accounts.getAccountByUsername(clean);
  return account ? account.UserID : null;
}

/**
 * Convenience check: does this admin row's role meet or exceed the given
 * rank? Pass a row from getAdminByUserId (may be null/inactive).
 *
 * Usage:
 *   if (!hasRank(actor, ROLE_RANK.superadmin)) return ctx.reply('...');
 */
function hasRank(adminRow, requiredRank) {
  if (!adminRow || !adminRow.IsActive) return false;
  return ROLE_RANK[adminRow.Role] >= requiredRank;
}

/**
 * Turns an admin row (or null/inactive, for a regular user) into a
 * numeric rank, so command-visibility checks (e.g. /admin) can compare
 * against it the same way hasRank does.
 *
 * Usage:
 *   const rank = getRank(actor); // 0 for non-admins, up to 3 for superadmin
 */
function getRank(adminRow) {
  if (!adminRow || !adminRow.IsActive) return ROLE_RANK.public;
  return ROLE_RANK[adminRow.Role] ?? ROLE_RANK.public;
}

module.exports = {
  ROLES,
  ROLE_RANK,
  getAdminByUserId,
  addAdmin,
  removeAdmin,
  listAdmins,
  resolveIdentifier,
  hasRank,
  getRank,
};
