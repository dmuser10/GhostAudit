// Vercel serverless entry: every /api/* request is routed here (see vercel.json).
module.exports = require('../server/index.js').app;
