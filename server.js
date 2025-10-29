// server.js
const express = require("express");
const axios = require("axios");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const { sql, getPool } = require("./db");
require("dotenv").config();

const PORT = process.env.PORT || 3003;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const CLIENT_ID = process.env.LINKEDIN_CLIENT_ID;
const CLIENT_SECRET = process.env.LINKEDIN_CLIENT_SECRET;
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "http://localhost:5173";
const JWT_SECRET = process.env.JWT_SECRET || "super-secret-key";
const REDIRECT_URI = `${BASE_URL}/callback`;
const isProd = process.env.NODE_ENV === "production";

const app = express();

// Health check
app.get("/healthz", (_, res) => res.json({ ok: true }));

// CORS
app.use(
  cors({
    origin: [FRONTEND_ORIGIN, "http://localhost:5173"],
    credentials: true,
    methods: ["GET", "POST", "OPTIONS"],
  })
);

// Trust proxy
app.set("trust proxy", 1);

// Step 1: Start LinkedIn OAuth
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

// Step 2: Handle LinkedIn callback
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

    // Fetch LinkedIn profile
    const { data: userinfo } = await axios.get("https://api.linkedin.com/v2/userinfo", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    // Upsert into Azure SQL
    const pool = await getPool();
    const r = pool.request();
    r.input("sub", sql.VarChar, userinfo.sub);
    r.input("email", sql.VarChar, userinfo.email || null);
    r.input("name", sql.VarChar, userinfo.name || null);
    r.input("firstName", sql.VarChar, userinfo.given_name || null);
    r.input("lastName", sql.VarChar, userinfo.family_name || null);
    r.input("picture", sql.VarChar, userinfo.picture || null);
    await r.query(`
      MERGE users AS target
      USING (SELECT @sub AS sub) AS source
      ON target.sub = source.sub
      WHEN MATCHED THEN
        UPDATE SET email=@email,name=@name,firstName=@firstName,lastName=@lastName,picture=@picture
      WHEN NOT MATCHED THEN
        INSERT (sub,email,name,firstName,lastName,picture)
        VALUES (@sub,@email,@name,@firstName,@lastName,@picture);
    `);

    // Generate JWT
    const jwtToken = jwt.sign(userinfo, JWT_SECRET, { expiresIn: "8h" });

    // Redirect with token as query param
    res.redirect(`${FRONTEND_ORIGIN}/dashboard?token=${jwtToken}`);
  } catch (err) {
    console.error("OAuth error:", err.response?.data || err.message);
    res.status(500).send("OAuth failed");
  }
});

// Step 3: Protected routes
function auth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: "Missing token" });
  const token = authHeader.split(" ")[1];
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}

app.get("/api/user", auth, (req, res) => res.json(req.user));

app.get("/api/users", auth, async (req, res) => {
  const pool = await getPool();
  const result = await pool.request().query(`
    SELECT TOP (50) sub, name, email, picture FROM dbo.users ORDER BY name ASC
  `);
  res.json(result.recordset);
});

// Logout (frontend just deletes token)
app.get("/logout", (_, res) => res.redirect(FRONTEND_ORIGIN));

// Start
app.listen(PORT, () => {
  console.log(`✅ Server running on ${PORT}`);
});
