// The company's home currency: policy limits and pre-approval thresholds are in it,
// dashboard totals are reported in it, and a plain "$" on a receipt or policy means it.
// Exchange rates are still stored against USD (FxRates.rate_to_usd, Expenses.fx_rate_to_usd)
// and converted to this currency when amounts are compared or shown.
const BASE_CURRENCY = String(process.env.BASE_CURRENCY || 'AUD').toUpperCase();

module.exports = { BASE_CURRENCY };
