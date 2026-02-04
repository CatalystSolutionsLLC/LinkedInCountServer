// run-migration.js
// Run SQL migration against Azure SQL Database

const fs = require("fs");
const path = require("path");
const sql = require("mssql");
require("dotenv").config({ path: ".env.production" });

const config = {
  user: process.env.AZURE_SQL_USER,
  password: process.env.AZURE_SQL_PASSWORD,
  server: process.env.AZURE_SQL_SERVER,
  database: process.env.AZURE_SQL_DATABASE,
  options: { encrypt: true, enableArithAbort: true },
};

async function runMigration() {
  const migrationFile = process.argv[2] || "migrations/001_create_engagement_tables.sql";
  const sqlPath = path.resolve(__dirname, migrationFile);

  if (!fs.existsSync(sqlPath)) {
    console.error(`Migration file not found: ${sqlPath}`);
    process.exit(1);
  }

  console.log(`Running migration: ${migrationFile}`);
  console.log(`Server: ${config.server}`);
  console.log(`Database: ${config.database}`);

  const sqlContent = fs.readFileSync(sqlPath, "utf8");

  // Split by GO statements (case-insensitive, on own line)
  const batches = sqlContent
    .split(/\nGO\n/gi)
    .map((b) => b.trim())
    .filter((b) => b && !b.match(/^--[^\n]*$/));

  let pool;
  try {
    pool = await sql.connect(config);
    console.log("Connected to database\n");

    let successCount = 0;
    let skipCount = 0;

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      if (!batch) continue;

      // Show first 60 chars of each statement
      const preview = batch.substring(0, 60).replace(/\s+/g, " ");
      console.log(`[${i + 1}/${batches.length}] ${preview}...`);

      try {
        await pool.request().query(batch);
        console.log("    OK");
        successCount++;
      } catch (err) {
        // Check if it's a "already exists" error - not fatal
        if (
          err.message.includes("already exists") ||
          err.message.includes("already an object") ||
          err.message.includes("There is already an")
        ) {
          console.log(`    SKIPPED (already exists)`);
          skipCount++;
        } else {
          console.error(`    FAILED: ${err.message}`);
          if (err.precedingErrors) {
            err.precedingErrors.forEach((e) => console.error(`    PRECEDING: ${e.message}`));
          }
          throw err;
        }
      }
    }

    console.log(`\nMigration completed! ${successCount} executed, ${skipCount} skipped.`);
  } catch (err) {
    console.error("\nMigration failed:", err.message);
    process.exit(1);
  } finally {
    if (pool) await pool.close();
  }
}

runMigration();
