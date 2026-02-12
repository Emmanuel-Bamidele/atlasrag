// scripts/create_user.js
// Create a user with a bcrypt-hashed password in Postgres.

const bcrypt = require("bcryptjs");
const { createUser, getUserByUsername } = require("../db");

function readArg(flag) {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return "";
  return process.argv[idx + 1] || "";
}

async function main() {
  const username = readArg("--username") || process.env.USERNAME || "";
  const password = readArg("--password") || process.env.PASSWORD || "";
  const tenant = readArg("--tenant") || process.env.TENANT || username;
  const role = readArg("--role") || process.env.ROLE || "";

  if (!username || !password || !tenant) {
    console.error("Usage: node scripts/create_user.js --username USER --password PASS --tenant TENANT [--role admin]");
    process.exit(1);
  }

  const existing = await getUserByUsername(username);
  if (existing) {
    console.error("User already exists:", username);
    process.exit(1);
  }

  const hash = await bcrypt.hash(password, 12);
  const roles = role ? [role] : [];
  const user = await createUser({
    username,
    passwordHash: hash,
    tenantId: tenant,
    roles
  });

  console.log("Created user:", user.username, "tenant:", user.tenant_id);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
