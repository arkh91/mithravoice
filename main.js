// main.js
//
// Entry point for the Telegram bot. Creates the bot instance, records
// every user who contacts it (needed for @username lookups), registers
// commands, starts polling, and handles graceful shutdown.
//
// Usage:
//   node main.js

const { Telegraf } = require('telegraf');
const { BOT_TOKEN } = require('./token');
const registerCommands = require('./commands');
const accounts = require('./accounts');

// Fail fast if the token was never set, instead of getting a confusing
// error from the Telegram API later.
if (!BOT_TOKEN || BOT_TOKEN === 'PUT_YOUR_TELEGRAM_BOT_TOKEN_HERE') {
  console.error('BOT_TOKEN is not set. Edit token.js or set the BOT_TOKEN environment variable.');
  process.exit(1);
}

// Create the bot instance used for the lifetime of the process.
const bot = new Telegraf(BOT_TOKEN);

/**
 * Saves (or refreshes) the sender's Telegram info into telegram_accounts.
 * Registered as global middleware below, so it runs on /start and on
 * every later message — this is what lets /admincommand resolve a plain
 * "@username" to a numeric Telegram ID later (see accounts.js).
 *
 * Usage:
 *   bot.use(saveUserToDatabase);
 *
 * @param {import('telegraf').Context} ctx - the current update's context
 * @param {Function} next - call to continue on to the next handler (e.g. the /start reply)
 */
async function saveUserToDatabase(ctx, next) {
  if (ctx.from) {
    try {
      await accounts.upsertAccount(ctx.from);
    } catch (err) {
      console.error('Failed to upsert telegram_accounts row:', err);
    }
  }
  return next();
}

bot.use(saveUserToDatabase);

// Attach all command handlers defined in commands.js.
registerCommands(bot);

// Log any errors thrown inside command handlers instead of crashing silently.
bot.catch((err, ctx) => {
  console.error(`Error while handling update ${ctx.updateType}:`, err);
});

/**
 * Starts the bot in long-polling mode.
 *
 * Usage: called once at the bottom of this file when the script runs.
 */
async function start() {
  await bot.launch();
  console.log('Bot started and polling for updates.');
}

start();

// Enable graceful stop so the process shuts down cleanly on Ctrl+C or
// container/service restarts (recommended by Telegraf's docs).
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
