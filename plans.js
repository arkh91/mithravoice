// plans.js
//
// Data-access helpers for the plans table (the sellable tiers used by
// /newkey and server/create_license_key.py).
//
// Usage:
//   const plans = require('./plans');
//   const plan = await plans.getPlanByCode('online_bronze_monthly');

const pool = require('./db');

/**
 * Looks up a plan by its unique code.
 *
 * Usage:
 *   const plan = await getPlanByCode('online_bronze_monthly');
 */
async function getPlanByCode(code) {
  const [rows] = await pool.query('SELECT * FROM plans WHERE code = ? LIMIT 1', [code]);
  return rows[0] || null;
}

/**
 * Returns every plan, cheapest-and-shortest-billing first. Used by
 * /newkey to show valid codes when called without arguments, so the
 * list is always live instead of a hardcoded copy.
 *
 * Usage:
 *   const rows = await listPlans();
 */
async function listPlans() {
  const [rows] = await pool.query('SELECT * FROM plans ORDER BY billing_interval, price_cents');
  return rows;
}

module.exports = { getPlanByCode, listPlans };
