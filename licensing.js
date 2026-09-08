// licensing.js
//
// Issues new license keys: finds/creates the customer's users row, opens
// a subscriptions row for the chosen plan, and generates the
// license_keys row the customer types into the app. This mirrors
// server/create_license_key.py's logic exactly (same key format, same
// table order), just callable from the bot instead of the command line.
//
// Usage:
//   const licensing = require('./licensing');
//   const result = await licensing.issueKey({ email, planCode, months });

const crypto = require('crypto');
const pool = require('./db');
const plans = require('./plans');

// No 0/O or 1/I, so a spoken/typed key is never ambiguous — matches
// server/create_license_key.py's alphabet so keys look identical
// regardless of which tool issued them.
const KEY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/**
 * Generates a human-typeable key like 'MVCE-7F3A-9K2Q-XPL4'.
 *
 * Usage:
 *   const code = generateKeyCode();
 */
function generateKeyCode() {
  const groups = [];
  for (let g = 0; g < 3; g++) {
    let group = '';
    for (let i = 0; i < 4; i++) {
      group += KEY_ALPHABET[crypto.randomInt(KEY_ALPHABET.length)];
    }
    groups.push(group);
  }
  return 'MVCE-' + groups.join('-');
}

/**
 * Finds a users row by email, or creates one if this is a new customer.
 * Returns the user's id either way.
 *
 * Usage:
 *   const userId = await findOrCreateUser('jane@example.com', 'Jane Doe');
 */
async function findOrCreateUser(email, fullName) {
  const [rows] = await pool.query('SELECT id FROM users WHERE email = ? LIMIT 1', [email]);
  if (rows[0]) return rows[0].id;

  const id = crypto.randomUUID();
  await pool.query('INSERT INTO users (id, email, full_name) VALUES (?, ?, ?)', [id, email, fullName || null]);
  return id;
}

/**
 * Works out when a new subscription period should end, based on the
 * plan's billing_interval, unless an explicit month count overrides it.
 * 'lifetime' plans get a 100-year expiry rather than a real "never".
 *
 * Usage:
 *   const end = periodEndFor(plan, months); // months may be undefined
 */
function periodEndFor(plan, months) {
  const end = new Date();

  if (plan.billing_interval === 'lifetime') {
    end.setFullYear(end.getFullYear() + 100);
    return end;
  }

  const defaultMonths = plan.billing_interval === 'annual' ? 12 : 1;
  end.setMonth(end.getMonth() + (months || defaultMonths));
  return end;
}

/**
 * Issues a brand-new license key for a customer: finds/creates their
 * user row, opens a subscription for the given plan, and generates the
 * key — the same users -> subscriptions -> license_keys write path a
 * real purchase should trigger.
 *
 * Usage:
 *   const result = await issueKey({ email: 'jane@example.com', planCode: 'online_bronze_monthly' });
 *   if (result.error) { ... } else { console.log(result.keyCode); }
 *
 * @param {object} opts
 * @param {string} opts.email - customer's email (used to find/create their users row)
 * @param {string} opts.planCode - a code from the plans table, e.g. 'online_bronze_monthly'
 * @param {string} [opts.fullName] - optional display name, only used if the user is new
 * @param {number} [opts.months] - override the plan's default period length, in months
 */
async function issueKey({ email, planCode, fullName, months }) {
  const plan = await plans.getPlanByCode(planCode);
  if (!plan) {
    return { error: `No such plan: ${planCode}` };
  }

  const userId = await findOrCreateUser(email, fullName);
  const periodStart = new Date();
  const periodEnd = periodEndFor(plan, months);

  const subscriptionId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO subscriptions (id, user_id, plan_id, status, current_period_start, current_period_end)
     VALUES (?, ?, ?, 'active', ?, ?)`,
    [subscriptionId, userId, plan.id, periodStart, periodEnd]
  );

  const keyCode = generateKeyCode();
  const licenseKeyId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO license_keys (id, subscription_id, key_code, status, expires_at)
     VALUES (?, ?, ?, 'active', ?)`,
    [licenseKeyId, subscriptionId, keyCode, periodEnd]
  );

  return { keyCode, expiresAt: periodEnd, plan, userId, subscriptionId };
}

module.exports = { issueKey, generateKeyCode, findOrCreateUser, periodEndFor };
