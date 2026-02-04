// server.js
// LinkedIn OAuth2 + JWT + Azure SQL (cross-browser safe, stateless)

const express = require("express");
const axios = require("axios");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const cron = require("node-cron");
const { sql, getPool } = require("./db");
const engagementRoutes = require("./routes/engagement");
const syncRoutes = require("./routes/sync");
const adminRoutes = require("./routes/admin");
const { runFullSync, MOCK_MODE } = require("./services/linkedinSync");
require("dotenv").config();

const PORT = process.env.PORT || 3003;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const CLIENT_ID = process.env.LINKEDIN_CLIENT_ID;
const CLIENT_SECRET = process.env.LINKEDIN_CLIENT_SECRET;
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "http://localhost:5173";
const JWT_SECRET = process.env.JWT_SECRET || "super-secret-key";
const REDIRECT_URI = `${BASE_URL}/callback`;
const isProd = process.env.NODE_ENV === "production";

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("❌ Missing LINKEDIN_CLIENT_ID or LINKEDIN_CLIENT_SECRET");
  process.exit(1);
}

const app = express();

// -----------------------------------------------------------------------------
// Health Check
// -----------------------------------------------------------------------------
app.get("/healthz", (_, res) => res.json({ ok: true }));

// -----------------------------------------------------------------------------
// CORS
// -----------------------------------------------------------------------------
app.use(
  cors({
    origin: [FRONTEND_ORIGIN, "http://localhost:5173"],
    credentials: true,
    methods: ["GET", "POST", "OPTIONS"],
  })
);

app.set("trust proxy", 1);

// -----------------------------------------------------------------------------
// Step 1: Start LinkedIn OAuth
// -----------------------------------------------------------------------------
app.get("/login", (req, res) => {
  const state = Math.random().toString(36).slice(2);
  const authURL =
    `https://www.linkedin.com/oauth/v2/authorization?response_type=code&` +
    `client_id=${encodeURIComponent(CLIENT_ID)}&` +
    `redirect_uri=${encodeURIComponent(REDIRECT_URI)}&` +
    `state=${encodeURIComponent(state)}&` +
    `scope=${encodeURIComponent("openid profile email")}`;

  res.redirect(authURL);
});

// -----------------------------------------------------------------------------
// Step 2: OAuth Callback
// -----------------------------------------------------------------------------
app.get("/callback", async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send("Missing authorization code");

  try {
    // Exchange code for access token
    const tokenRes = await axios.post(
      "https://www.linkedin.com/oauth/v2/accessToken",
      new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
      }),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );

    const accessToken = tokenRes.data.access_token;

    // Fetch user info from LinkedIn
    const { data: userinfo } = await axios.get(
      "https://api.linkedin.com/v2/userinfo",
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    // Extract picture safely
    console.log(`[OAuth] userinfo.picture raw:`, JSON.stringify(userinfo.picture));
    const pictureUrl =
      typeof userinfo.picture === "string"
        ? userinfo.picture
        : userinfo.picture?.data?.url || null;
    console.log(`[OAuth] Extracted pictureUrl: ${pictureUrl}`);

    // Upsert user into Azure SQL
    const pool = await getPool();
    const r = pool.request();
    r.input("sub", sql.VarChar, userinfo.sub);
    r.input("email", sql.VarChar, userinfo.email || null);
    r.input("name", sql.VarChar, userinfo.name || null);
    r.input("firstName", sql.VarChar, userinfo.given_name || null);
    r.input("lastName", sql.VarChar, userinfo.family_name || null);
    r.input("picture", sql.VarChar, pictureUrl);
    r.input("emailVerified", sql.Bit, userinfo.email_verified ? 1 : 0);

    await r.query(`
      MERGE users AS target
      USING (SELECT @sub AS sub) AS source
      ON target.sub = source.sub
      WHEN MATCHED THEN
        UPDATE SET 
          email=@email,
          name=@name,
          firstName=@firstName,
          lastName=@lastName,
          picture=@picture,
          emailVerified=@emailVerified
      WHEN NOT MATCHED THEN
        INSERT (sub, email, name, firstName, lastName, picture, emailVerified)
        VALUES (@sub, @email, @name, @firstName, @lastName, @picture, @emailVerified);
    `);

    console.log(`✅ Upserted user ${userinfo.name || userinfo.email}`);

    // Generate JWT
    const jwtToken = jwt.sign(userinfo, JWT_SECRET, { expiresIn: "8h" });

    // Redirect back to frontend
    res.redirect(`${FRONTEND_ORIGIN}/dashboard?token=${jwtToken}`);
  } catch (err) {
    console.error("❌ OAuth callback error:", err.response?.data || err.message);
    res.status(500).send("OAuth failed");
  }
});

// -----------------------------------------------------------------------------
// Step 3: JWT Auth Middleware
// -----------------------------------------------------------------------------
function auth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader)
    return res.status(401).json({ error: "Missing Authorization header" });

  const token = authHeader.split(" ")[1];
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}

// -----------------------------------------------------------------------------
// Step 4: API Routes
// -----------------------------------------------------------------------------
app.get("/api/user", auth, (req, res) => res.json(req.user));

app.get("/api/users", auth, async (req, res) => {
  try {
    const pool = await getPool();
    const result = await pool.request().query(`
      SELECT TOP (50)
        sub,
        COALESCE(NULLIF(name,''), CONCAT(COALESCE(firstName,''), ' ', COALESCE(lastName,''))) AS name,
        email,
        picture,
        emailVerified
      FROM dbo.users
      ORDER BY name ASC, email ASC;
    `);
    res.json(result.recordset);
  } catch (err) {
    console.error("❌ Fetch users failed:", err.message);
    res.status(500).json({ error: "Database query failed" });
  }
});

// -----------------------------------------------------------------------------
// Engagement & Sync Routes
// -----------------------------------------------------------------------------
app.use("/api/engagement", auth, engagementRoutes);
app.use("/api/sync", auth, syncRoutes);

// -----------------------------------------------------------------------------
// Admin Routes (LinkedIn authorization for sync)
// -----------------------------------------------------------------------------
app.use("/admin", adminRoutes);

// -----------------------------------------------------------------------------
// Logout (frontend clears token)
// -----------------------------------------------------------------------------
app.get("/logout", (_, res) => res.redirect(FRONTEND_ORIGIN));

// -----------------------------------------------------------------------------
// Daily Cron Job - Sync LinkedIn engagements at 6 AM
// -----------------------------------------------------------------------------
cron.schedule("0 6 * * *", async () => {
  console.log("[Cron] Starting daily LinkedIn sync...");
  try {
    const result = await runFullSync();
    console.log(`[Cron] Sync completed: ${result.postsProcessed} posts, ${result.engagementsFound} engagements`);
  } catch (err) {
    console.error("[Cron] Sync failed:", err.message);
  }
});

// -----------------------------------------------------------------------------
// Start
// -----------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`➡ BASE_URL: ${BASE_URL}`);
  console.log(`➡ FRONTEND_ORIGIN: ${FRONTEND_ORIGIN}`);
  console.log(`➡ NODE_ENV: ${process.env.NODE_ENV}`);
  console.log(`➡ LINKEDIN_MOCK_MODE: ${MOCK_MODE}`);
});
