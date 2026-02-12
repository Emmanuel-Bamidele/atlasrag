//
//  security.js
//  AtlasRAG
//
//  Created by Emmanuel Bamidele on 2/11/26.
//

// security.js
// API key auth + rate limiting (simple production protections)

const rateLimit = require("express-rate-limit");

// Require x-api-key header for protected routes
function requireApiKey(req, res, next) {
  const required = process.env.API_KEY;

  // If no API_KEY set, we refuse (safer than accidentally public)
  if (!required) {
    return res.status(500).json({ error: "API_KEY not set on server" });
  }

  const got = req.header("x-api-key");
  if (got !== required) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  next();
}

// Rate limiter: max requests per window per IP
const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 60,             // 60 requests/min per IP
  standardHeaders: true,
  legacyHeaders: false
});

module.exports = { requireApiKey, limiter };
