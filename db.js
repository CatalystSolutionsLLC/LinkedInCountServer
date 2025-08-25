// db.js
const sql = require("mssql");
require("dotenv").config();

const config = {
  user: process.env.AZURE_SQL_USER,
  password: process.env.AZURE_SQL_PASSWORD,
  server: process.env.AZURE_SQL_SERVER,        // e.g. catalystlidb.database.windows.net
  database: process.env.AZURE_SQL_DATABASE,    // e.g. LinkedInEngagement
  options: { encrypt: true, enableArithAbort: true },
};

let pool;

async function getPool() {
  if (pool?.connected) return pool;
  if (!pool) pool = new sql.ConnectionPool(config);
  if (!pool.connected) await pool.connect();
  return pool;
}

module.exports = { sql, getPool };
