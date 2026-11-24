const { existsSync, readFileSync } = require("node:fs");

const path = "/app/prisma/.jwt_secret";
const secret = process.env.JWT_SECRET;
if (
  !secret ||
  secret.length < 32 ||
  (existsSync("/app/prisma/dev.db") && !existsSync(path)) ||
  (existsSync(path) && readFileSync(path, "utf8").trimEnd() !== secret)
) {
  console.error(
    "JWT_SECRET missing or inconsistent with the stored key. Restore the original key before starting.",
  );
  process.exit(1);
}
