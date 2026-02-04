// routes/admin.js
// Admin authorization for LinkedIn Community Management API

const express = require("express");
const axios = require("axios");
const { sql, getPool } = require("../db");

const router = express.Router();

const POST_CLIENT_ID = process.env.POST_CLIENT_ID;
const POST_CLIENT_SECRET = process.env.POST_CLIENT_SECRET;
const BASE_URL = process.env.BASE_URL || "http://localhost:3003";
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "http://localhost:5173";

// Scopes needed for Community Management API
const ADMIN_SCOPES = [
  "r_organization_social",       // Read org posts, comments, reactions
  "r_organization_social_feed",  // Read engagement data on org posts
  "rw_organization_admin",       // Admin access to organization
  "w_organization_social",       // Write access (needed for some read endpoints)
].join(" ");

// GET /admin/linkedin/authorize - Start admin OAuth flow
router.get("/linkedin/authorize", (req, res) => {
  if (!POST_CLIENT_ID) {
    return res.status(500).send("POST_CLIENT_ID not configured");
  }

  const state = Math.random().toString(36).slice(2);
  const redirectUri = `${BASE_URL}/admin/linkedin/callback`;

  const authUrl =
    `https://www.linkedin.com/oauth/v2/authorization?` +
    `response_type=code&` +
    `client_id=${encodeURIComponent(POST_CLIENT_ID)}&` +
    `redirect_uri=${encodeURIComponent(redirectUri)}&` +
    `state=${encodeURIComponent(state)}&` +
    `scope=${encodeURIComponent(ADMIN_SCOPES)}`;

  console.log("[Admin] Starting LinkedIn admin authorization");
  res.redirect(authUrl);
});

// GET /admin/linkedin/callback - Handle OAuth callback
router.get("/linkedin/callback", async (req, res) => {
  const { code, error, error_description } = req.query;

  if (error) {
    console.error("[Admin] OAuth error:", error, error_description);
    return res.redirect(`${FRONTEND_ORIGIN}/dashboard?admin_error=${encodeURIComponent(error_description || error)}`);
  }

  if (!code) {
    return res.status(400).send("Missing authorization code");
  }

  try {
    const redirectUri = `${BASE_URL}/admin/linkedin/callback`;

    // Exchange code for tokens
    const tokenRes = await axios.post(
      "https://www.linkedin.com/oauth/v2/accessToken",
      new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: POST_CLIENT_ID,
        client_secret: POST_CLIENT_SECRET,
      }),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );

    const { access_token, expires_in, refresh_token, refresh_token_expires_in } = tokenRes.data;

    // Calculate expiry times
    const now = new Date();
    const accessTokenExpiry = new Date(now.getTime() + (expires_in * 1000));
    const refreshTokenExpiry = refresh_token_expires_in
      ? new Date(now.getTime() + (refresh_token_expires_in * 1000))
      : null;

    // Store token in database
    const pool = await getPool();
    const r = pool.request();
    r.input("tokenType", sql.VarChar, "linkedin_admin");
    r.input("accessToken", sql.VarChar, access_token);
    r.input("refreshToken", sql.VarChar, refresh_token || null);
    r.input("expiresAt", sql.DateTimeOffset, accessTokenExpiry);
    r.input("refreshExpiresAt", sql.DateTimeOffset, refreshTokenExpiry);

    await r.query(`
      MERGE dbo.AdminTokens AS target
      USING (SELECT @tokenType AS tokenType) AS source
      ON target.tokenType = source.tokenType
      WHEN MATCHED THEN
        UPDATE SET
          accessToken = @accessToken,
          refreshToken = @refreshToken,
          expiresAt = @expiresAt,
          refreshExpiresAt = @refreshExpiresAt,
          updatedAt = SYSDATETIMEOFFSET()
      WHEN NOT MATCHED THEN
        INSERT (tokenType, accessToken, refreshToken, expiresAt, refreshExpiresAt)
        VALUES (@tokenType, @accessToken, @refreshToken, @expiresAt, @refreshExpiresAt);
    `);

    console.log("[Admin] LinkedIn admin token stored successfully");
    console.log("[Admin] Token expires:", accessTokenExpiry.toISOString());

    res.redirect(`${FRONTEND_ORIGIN}/dashboard?admin_authorized=true`);
  } catch (err) {
    console.error("[Admin] Token exchange failed:", err.response?.data || err.message);
    res.redirect(`${FRONTEND_ORIGIN}/dashboard?admin_error=${encodeURIComponent("Token exchange failed")}`);
  }
});

// GET /admin/linkedin/status - Check if admin is authorized
router.get("/linkedin/status", async (req, res) => {
  try {
    const pool = await getPool();
    const result = await pool.request()
      .input("tokenType", sql.VarChar, "linkedin_admin")
      .query(`
        SELECT expiresAt, refreshExpiresAt, updatedAt
        FROM dbo.AdminTokens
        WHERE tokenType = @tokenType
      `);

    if (result.recordset.length === 0) {
      return res.json({ authorized: false });
    }

    const token = result.recordset[0];
    const now = new Date();
    const expiresAt = new Date(token.expiresAt);
    const isExpired = expiresAt < now;

    res.json({
      authorized: !isExpired,
      expiresAt: token.expiresAt,
      updatedAt: token.updatedAt,
      isExpired,
    });
  } catch (err) {
    console.error("[Admin] Status check failed:", err.message);
    res.status(500).json({ error: "Failed to check status" });
  }
});

module.exports = router;
