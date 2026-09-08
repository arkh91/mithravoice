// token.js
//
// Holds the Telegram bot token used to authenticate with the Telegram Bot API.
// Keep this file out of version control (add it to .gitignore) since anyone
// with this token can control your bot.
//
// Usage:
//   const { BOT_TOKEN } = require('./token');
//   const bot = new Telegraf(BOT_TOKEN);

// Prefer an environment variable so the real token never lives in source
// control; fall back to the placeholder string below for local testing.
const BOT_TOKEN = process.env.BOT_TOKEN || '';

module.exports = { BOT_TOKEN };
