// commands.js
//
// Central registry for all bot commands. Add new commands here by calling
// defineCommand(...) inside registerCommands (not bot.command directly) —
// that's what makes /admin automatically pick up new commands, filtered
// by the role required to see them.
//
// Usage:
//   const registerCommands = require('./commands');
//   registerCommands(bot);   // call once, right after creating the bot instance

const admins = require('./admins');
const accounts = require('./accounts');
const plans = require('./plans');
const licensing = require('./licensing');

const ADMIN_USAGE = [
  'MithraVoice👑: ⚠️ Usage:',
  '/admincommand add <@username|UserID> <superadmin|admin|moderator>',
  '/admincommand remove <@username|UserID>',
  '/admincommand list',
  '/admincommand status <@username|UserID>',
].join('\n');

// Every command that's been registered via defineCommand, in registration
// order. /admin reads this list and filters it by the caller's rank — it
// never needs its own hardcoded copy of the command list.
const registry = [];

/**
 * Registers a command with Telegraf AND records it in the registry that
 * /admin reads from. Use this instead of bot.command(...) directly for
 * every new command, so it shows up in /admin automatically.
 *
 * Usage:
 *   defineCommand(bot, 'ping', 'Health check', admins.ROLE_RANK.public, (ctx) => ctx.reply('pong'));
 *
 * @param {import('telegraf').Telegraf} bot - the bot instance
 * @param {string} name - command name, without the leading slash
 * @param {string} description - one-line description shown in /admin
 * @param {number} minRank - lowest admins.ROLE_RANK value that can see/use this command (admins.ROLE_RANK.public for everyone)
 * @param {Function} handler - the Telegraf command handler, (ctx) => ...
 */
function defineCommand(bot, name, description, minRank, handler) {
  registry.push({ name, description, minRank });
  bot.command(name, handler);
}

/**
 * Attaches all command handlers to the given Telegraf bot instance.
 *
 * Usage:
 *   const { Telegraf } = require('telegraf');
 *   const bot = new Telegraf(BOT_TOKEN);
 *   registerCommands(bot);
 *
 * @param {import('telegraf').Telegraf} bot - the bot instance to attach commands to
 */
function registerCommands(bot) {
  // /start — sent automatically by Telegram clients when a user first opens the bot
  defineCommand(bot, 'start', 'Greet the bot', admins.ROLE_RANK.public, (ctx) => {
    ctx.reply('👋 Welcome! The bot is up and running.');
  });

  // /help — lists what the bot can do
  defineCommand(bot, 'help', 'Show basic help', admins.ROLE_RANK.public, (ctx) => {
    ctx.reply('Available commands:\n/start - greet the bot\n/help - show this message\n/admin - list commands available to you');
  });

  // /admin — lists every command the caller is allowed to see, pulled
  // live from the registry above (see handleAdminMenu).
  defineCommand(bot, 'admin', 'List commands available to your role', admins.ROLE_RANK.public, (ctx) => handleAdminMenu(ctx));

  // /admincommand — manage who is a bot admin (add/remove/list/status).
  // Only usable by people already in telegram_admins; see bootstrap_admin.sql
  // for how to seed the very first superadmin.
  defineCommand(bot, 'admincommand', 'Manage bot admins: add, remove, list, status', admins.ROLE_RANK.moderator, (ctx) => handleAdminCommand(ctx));

  // /newkey — issue a new license key against a real plan row.
  // Admin and superadmin only; moderators can't mint keys.
  defineCommand(bot, 'newkey', 'Issue a new license key for a customer', admins.ROLE_RANK.admin, (ctx) => handleNewKey(ctx));

  // Add more commands below using defineCommand(...) so they automatically
  // show up in /admin for whichever rank you give them.
}

/**
 * Handles "/admin". Shows every registered command whose minRank the
 * caller meets, so a plain user, a moderator, and a superadmin each see
 * a different list without any manually-maintained text.
 *
 * Usage: called directly by the bot.command('admin', ...) binding above.
 */
async function handleAdminMenu(ctx) {
  const actor = await admins.getAdminByUserId(ctx.from.id);
  const rank = admins.getRank(actor);
  const roleLabel = rank > admins.ROLE_RANK.public ? actor.Role : 'user';

  const visible = registry.filter((cmd) => cmd.minRank <= rank);
  const lines = visible.map((cmd) => `/${cmd.name} — ${cmd.description}`);

  return ctx.reply(`MithraVoice👑: Commands available to you (${roleLabel}):\n${lines.join('\n')}`);
}

/**
 * Top-level dispatcher for /admincommand. Checks the caller is a known,
 * active admin, then routes to the add/remove/list/status subhandlers.
 *
 * Usage: called directly by the bot.command('admincommand', ...) binding above.
 */
async function handleAdminCommand(ctx) {
  const args = ctx.message.text.trim().split(/\s+/).slice(1); // drop "/admincommand" itself
  const actor = await admins.getAdminByUserId(ctx.from.id);

  if (!admins.hasRank(actor, admins.ROLE_RANK.moderator)) {
    return ctx.reply('MithraVoice👑: ⛔ You are not authorized to use this command.');
  }

  const [sub, ...rest] = args;
  if (!sub) return ctx.reply(ADMIN_USAGE);

  switch (sub.toLowerCase()) {
    case 'add':
      return handleAdd(ctx, actor, rest);
    case 'remove':
      return handleRemove(ctx, actor, rest);
    case 'list':
      return handleList(ctx, actor);
    case 'status':
      return handleStatus(ctx, actor, rest);
    default:
      return ctx.reply(ADMIN_USAGE);
  }
}

/**
 * Handles "/admincommand add <@username|UserID> <role>". Requires the
 * caller to be a superadmin. Resolves @username via telegram_accounts,
 * so the target must have messaged the bot at least once already.
 *
 * Usage: called from handleAdminCommand's switch statement.
 */
async function handleAdd(ctx, actor, [identifier, role]) {
  if (!admins.hasRank(actor, admins.ROLE_RANK.superadmin)) {
    return ctx.reply('MithraVoice👑: ⛔ Only superadmins can add admins.');
  }
  if (!identifier || !role) return ctx.reply(ADMIN_USAGE);

  role = role.toLowerCase();
  if (!admins.ROLES.includes(role)) {
    return ctx.reply(`MithraVoice👑: ⚠️ Role must be one of: ${admins.ROLES.join(', ')}`);
  }

  const userId = await admins.resolveIdentifier(identifier);
  if (!userId) {
    return ctx.reply(
      `MithraVoice👑: ⚠️ Couldn't resolve ${identifier}. If you used a @username, that ` +
      `person needs to message the bot at least once first — or use their numeric UserID instead.`
    );
  }

  const account = await accounts.getAccountByUserId(userId);
  const username = account ? account.Username : identifier.replace(/^@/, '');

  await admins.addAdmin(userId, username, role);
  return ctx.reply(`MithraVoice👑: ✅ ${username || userId} added as ${role}.`);
}

/**
 * Handles "/admincommand remove <@username|UserID>". Requires the caller
 * to be a superadmin. Soft-removes (IsActive = 0) rather than deleting.
 *
 * Usage: called from handleAdminCommand's switch statement.
 */
async function handleRemove(ctx, actor, [identifier]) {
  if (!admins.hasRank(actor, admins.ROLE_RANK.superadmin)) {
    return ctx.reply('MithraVoice👑: ⛔ Only superadmins can remove admins.');
  }
  if (!identifier) return ctx.reply(ADMIN_USAGE);

  const userId = await admins.resolveIdentifier(identifier);
  if (!userId) {
    return ctx.reply(`MithraVoice👑: ⚠️ Couldn't resolve ${identifier}.`);
  }

  const removed = await admins.removeAdmin(userId);
  return ctx.reply(
    removed
      ? `MithraVoice👑: ✅ ${identifier} removed from admins.`
      : `MithraVoice👑: ⚠️ ${identifier} was not an admin.`
  );
}

/**
 * Handles "/admincommand list". Requires the caller to be admin rank or
 * higher. Lists every currently active admin.
 *
 * Usage: called from handleAdminCommand's switch statement.
 */
async function handleList(ctx, actor) {
  if (!admins.hasRank(actor, admins.ROLE_RANK.admin)) {
    return ctx.reply('MithraVoice👑: ⛔ You are not authorized to view the admin list.');
  }

  const rows = await admins.listAdmins();
  if (rows.length === 0) return ctx.reply('MithraVoice👑: No active admins.');

  const lines = rows.map(
    (r) => `• ${r.Username ? '@' + r.Username : r.UserID} — ${r.Role} (id: ${r.UserID})`
  );
  return ctx.reply(`MithraVoice👑: Active admins:\n${lines.join('\n')}`);
}

/**
 * Handles "/admincommand status <@username|UserID>". Requires the caller
 * to be admin rank or higher. Shows role + active/inactive state.
 *
 * Usage: called from handleAdminCommand's switch statement.
 */
async function handleStatus(ctx, actor, [identifier]) {
  if (!admins.hasRank(actor, admins.ROLE_RANK.admin)) {
    return ctx.reply('MithraVoice👑: ⛔ You are not authorized to view admin status.');
  }
  if (!identifier) return ctx.reply(ADMIN_USAGE);

  const userId = await admins.resolveIdentifier(identifier);
  if (!userId) {
    return ctx.reply(`MithraVoice👑: ⚠️ Couldn't resolve ${identifier}.`);
  }

  const record = await admins.getAdminByUserId(userId);
  if (!record) {
    return ctx.reply(`MithraVoice👑: ${identifier} is not an admin.`);
  }

  return ctx.reply(
    `MithraVoice👑: Status for ${record.Username ? '@' + record.Username : record.UserID}\n` +
    `Role: ${record.Role}\n` +
    `Active: ${record.IsActive ? 'yes' : 'no'}\n` +
    `Added: ${record.AddedAt}`
  );
}

/**
 * Handles "/newkey <email> <plan_code> [months]". Requires the caller to
 * be admin rank or higher. Called with no arguments, it lists every
 * plan code straight from the plans table so you're never guessing what
 * to type — see licensing.js for the actual issuance logic.
 *
 * Usage: called directly by the bot.command('newkey', ...) binding above.
 */
async function handleNewKey(ctx) {
  const actor = await admins.getAdminByUserId(ctx.from.id);
  if (!admins.hasRank(actor, admins.ROLE_RANK.admin)) {
    return ctx.reply('MithraVoice👑: ⛔ Only admins and superadmins can issue keys.');
  }

  const [email, planCode, monthsArg] = ctx.message.text.trim().split(/\s+/).slice(1);

  if (!email || !planCode) {
    const rows = await plans.listPlans();
    const lines = rows.map(
      (p) => `• ${p.code} — ${p.name}, $${(p.price_cents / 100).toFixed(2)}/${p.billing_interval}, ${p.max_devices} device${p.max_devices === 1 ? '' : 's'}`
    );
    return ctx.reply(
      `MithraVoice👑: ⚠️ Usage:\n/newkey <email> <plan_code> [months]\n\nAvailable plans:\n${lines.join('\n')}`
    );
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return ctx.reply('MithraVoice👑: ⚠️ That doesn\u2019t look like a valid email.');
  }

  let months;
  if (monthsArg !== undefined) {
    months = parseInt(monthsArg, 10);
    if (!Number.isInteger(months) || months <= 0) {
      return ctx.reply('MithraVoice👑: ⚠️ months must be a positive whole number.');
    }
  }

  const result = await licensing.issueKey({ email, planCode, months });
  if (result.error) {
    return ctx.reply(`MithraVoice👑: ⚠️ ${result.error}`);
  }

  return ctx.reply(
    `MithraVoice👑: ✅ Key issued for ${email}\n` +
    `Plan: ${result.plan.name} (${planCode})\n` +
    `Key: ${result.keyCode}\n` +
    `Expires: ${result.expiresAt.toISOString().slice(0, 10)}`
  );
}

module.exports = registerCommands;
