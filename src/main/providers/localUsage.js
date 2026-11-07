// Local histories only: account quota and billed balance are not available here.
'use strict';
const U = require('../../shared/usage.js');
const ledger = require('../agentLedger.js');
async function fetchUsage(id, ctx) {
  const usage = U.unavailable(id, 'localQuotaUnavailable');
  try { usage.ledger = await ledger.readLedger(id, ctx.dataDir); } catch { /* unavailable */ }
  return usage;
}
module.exports = { fetchUsage };
