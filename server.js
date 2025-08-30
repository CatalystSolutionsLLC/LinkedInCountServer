// server.js
// Node.js + Express + LinkedIn OAuth2 + Azure SQL (prod-ready, lazy SQL connect)

const express = require("express");
const session = require("express-session");
const axios = require("axios");
const cors = require("cors");
const { sql, getPool } = require("./db"); // 👈 lazy pool from db.js
require("dotenv").config();

const PORT = process.env.PORT ? Number(process.env.PORT) : 3003;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const CLIENT_ID = process.env.LINKEDIN_CLIENT_ID;
const CLIENT_SECRET = process.env.LINKEDIN_CLIENT_SECRET;
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "http://localhost:5173";
const REDIRECT_URI = `${BASE_URL}/callback`;
const isProd = process.env.NODE_ENV === "production";

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("Missing LINKEDIN_CLIENT_ID or LINKEDIN_CLIENT_SECRET");
  process.exit(1);
}

const app = express();

//  routes BEFORE any heavy middleware
app.get("/healthz", (_req, res) => res.json({ ok: true }));
app.get("/", (_req, res) =>
  res.type("text").send("OK - Backend alive. Try /healthz or /login")
);

// Make secure cookies work behind Azure’s proxy
app.set("trust proxy", 1);

// CORS (SWA -> App Service)
app.use(
  cors({
    origin: FRONTEND_ORIGIN,
    credentials: true,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// Sessions (SameSite=None for cross-site in prod)
app.use(
  session({
    name: "sid",
    secret: process.env.SESSION_SECRET || "supersecret",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: isProd ? "none" : "lax",
      secure: isProd,
      maxAge: 1000 * 60 * 60 * 8, // 8h
    },
  })
);

// Start LinkedIn OAuth (Authorization Code)
app.get("/login", (req, res) => {
  const state = Math.random().toString(36).slice(2);
  req.session.state = state;

  const authURL =
    `https://www.linkedin.com/oauth/v2/authorization?` +
    `response_type=code&` +
    `client_id=${encodeURIComponent(CLIENT_ID)}&` +
    `redirect_uri=${encodeURIComponent(REDIRECT_URI)}&` +
    `state=${encodeURIComponent(state)}&` +
    `scope=${encodeURIComponent("openid profile email")}`;

  res.redirect(authURL);
});

// OAuth Callback
app.get("/callback", async (req, res) => {
  const { code, state } = req.query;

  if (!code) return res.status(400).send("Missing authorization code.");
  if (!state || state !== req.session.state) {
    return res.status(400).send("State mismatch.");
  }

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

    // Fetch OIDC userinfo
    const { data: userinfo } = await axios.get(
      "https://api.linkedin.com/v2/userinfo",
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    // Save to session
    req.session.userinfo = userinfo;

    // ⬇️ ensure the session is actually written before redirecting
    await new Promise((resolve, reject) =>
      req.session.save((err) => (err ? reject(err) : resolve()))
    );

    // Upsert to Azure SQL (lazy connect)
    const { sql, getPool } = require("./db");
    const pool = await getPool();
    const r = pool.request();
    r.input("sub", sql.VarChar, userinfo.sub);
    r.input("email", sql.VarChar, userinfo.email || null);
    r.input("name", sql.VarChar, userinfo.name || null);
    r.input("firstName", sql.VarChar, userinfo.given_name || null);
    r.input("lastName", sql.VarChar, userinfo.family_name || null);
    r.input(
      "locale",
      sql.VarChar,
      typeof userinfo.locale === "string"
        ? userinfo.locale
        : JSON.stringify(userinfo.locale || null)
    );
    r.input("picture", sql.VarChar, userinfo.picture || null);
    r.input("emailVerified", sql.Bit, userinfo.email_verified ? 1 : 0);

    await r.query(`
      MERGE users AS target
      USING (SELECT @sub AS sub) AS source
      ON target.sub = source.sub
      WHEN MATCHED THEN
        UPDATE SET email=@email,name=@name,firstName=@firstName,lastName=@lastName,
                   locale=@locale,picture=@picture,emailVerified=@emailVerified
      WHEN NOT MATCHED THEN
        INSERT (sub,email,name,firstName,lastName,locale,picture,emailVerified)
        VALUES (@sub,@email,@name,@firstName,@lastName,@locale,@picture,@emailVerified);
    `);

    console.log("✅ User upserted to Azure SQL:", userinfo.sub);

    // Redirect back to your SPA
    res.redirect(`${FRONTEND_ORIGIN}/dashboard`);
  } catch (err) {
    const msg = err.response?.data || err.message || String(err);
    console.error("OAuth callback error:", msg);
    res.status(500).send("OAuth failed.");
  }
});

// Frontend reads session user
app.get("/api/user", (req, res) => {
  if (!req.session.userinfo) return res.status(401).json({ error: "Not logged in" });
  res.json(req.session.userinfo);
});

// List users from SQL (minimal fields). Requires login.
app.get("/api/users", async (req, res) => {
  if (!req.session.userinfo) return res.status(401).json({ error: "Not logged in" });

  try {
    const pool = await getPool();
    const limit = Math.min(Number(req.query.limit || 25), 200);
    const search = (req.query.q || "").trim();

    let sqlText = `
      SELECT TOP (@limit)
        sub,
        COALESCE(NULLIF(name,''), CONCAT(COALESCE(firstName,''), ' ', COALESCE(lastName,''))) AS name,
        email,
        picture,
        emailVerified
      FROM dbo.users
    `;

    if (search) {
      sqlText += `
        WHERE email LIKE @search OR name LIKE @search 
              OR firstName LIKE @search OR lastName LIKE @search
      `;
    }

    sqlText += ` ORDER BY name ASC, email ASC`;

    const request = pool.request()
      .input("limit", sql.Int, limit)
      .input("search", sql.VarChar, `%${search}%`);

    const result = await request.query(sqlText);

    // Optionally hide the current user so the table shows “others”
    const meSub = req.session.userinfo?.sub;
    const rows = (result.recordset || []).filter(r => r.sub !== meSub);

    res.json(rows);
  } catch (e) {
    console.error("Fetch users error:", e.message);
    res.status(500).json({ error: "Failed to fetch users" });
  }
});


// ===== LinkedIn Community Mgmt: Company Posts (separate app creds) =====
const POST_CLIENT_ID = process.env.POST_CLIENT_ID;
const POST_CLIENT_SECRET = process.env.POST_CLIENT_SECRET;
const POST_REDIRECT = process.env.POST_REDIRECT; // not used for client_credentials
const LINKEDIN_ORG_URN = process.env.LINKEDIN_ORG_URN || "urn:li:organization:30474";
const LINKEDIN_API_VERSION = process.env.LINKEDIN_API_VERSION || "202501";

// fail fast helper
function assertPostAppCreds() {
  if (!POST_CLIENT_ID || !POST_CLIENT_SECRET) {
    const msg = "Missing POST_CLIENT_ID/POST_CLIENT_SECRET for posts endpoint.";
    const e = new Error(msg);
    e.status = 500;
    throw e;
  }
}

// simple in-memory token cache for the posts app
let postsTokenCache = { token: null, expiresAt: 0 };

async function getPostsAccessToken() {
  assertPostAppCreds();
  const now = Date.now();
  if (postsTokenCache.token && postsTokenCache.expiresAt > now + 30_000) {
    return postsTokenCache.token;
  }

  // LinkedIn OAuth token (client_credentials)
  const form = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: POST_CLIENT_ID,
    client_secret: POST_CLIENT_SECRET,
    // redirect_uri is NOT used for client_credentials
  });

  const { data } = await axios.post(
    "https://www.linkedin.com/oauth/v2/accessToken",
    form,
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
  );

  const token = data.access_token;
  const expiresInMs = Number(data.expires_in || 0) * 1000;
  postsTokenCache = {
    token,
    // refresh slightly early
    expiresAt: now + Math.max(expiresInMs - 60_000, 0),
  };
  return token;
}

// Map LinkedIn post → inputs for dbo.LinkedInPosts
function mapPostToSqlParams(p, sql) {
  const get = (obj, path, def = null) =>
    path.split(".").reduce((o, k) => (o && k in o ? o[k] : null), obj) ?? def;

  const id = p.id || null;                         // PK (e.g., urn:li:share:..., urn:li:ugcPost:...)
  const postType = id ? id.split(":")[2] || null : null;
  const text = p.commentary || get(p, "text") || null;

  const mediaId = get(p, "content.media.id");
  const mediaAltText = get(p, "content.media.altText");
  const pollQuestion = get(p, "content.poll.question");
  const reshareParent = get(p, "reshareContext.parent");
  const reshareRoot = get(p, "reshareContext.root");

  const createdAt = p.createdAt ? new Date(Number(p.createdAt)) : null;
  const lastModifiedAt = p.lastModifiedAt ? new Date(Number(p.lastModifiedAt)) : null;
  const publishedAt = p.publishedAt ? new Date(Number(p.publishedAt)) : null;

  const isEditedByAuthor = !!get(p, "lifecycleStateInfo.isEditedByAuthor", false);
  const isReshareDisabledByAuthor = !!p.isReshareDisabledByAuthor;

  return [
    { name: "postId", type: sql.VarChar, value: id },
    { name: "postUrn", type: sql.VarChar, value: id }, // duplicate convenience
    { name: "postType", type: sql.VarChar, value: postType },
    { name: "activity", type: sql.VarChar, value: null }, // not in payload
    { name: "text", type: sql.NVarChar, value: text },
    { name: "author", type: sql.VarChar, value: p.author || null },
    { name: "visibility", type: sql.VarChar, value: p.visibility || null },
    { name: "lifecycleState", type: sql.VarChar, value: p.lifecycleState || null },
    { name: "isEditedByAuthor", type: sql.Bit, value: isEditedByAuthor ? 1 : 0 },
    { name: "isReshareDisabledByAuthor", type: sql.Bit, value: isReshareDisabledByAuthor ? 1 : 0 },
    { name: "feedDistribution", type: sql.VarChar, value: get(p, "distribution.feedDistribution") },
    { name: "reshareParent", type: sql.VarChar, value: reshareParent },
    { name: "reshareRoot", type: sql.VarChar, value: reshareRoot },
    { name: "mediaId", type: sql.VarChar, value: mediaId },
    { name: "mediaAltText", type: sql.NVarChar, value: mediaAltText },
    { name: "pollQuestion", type: sql.NVarChar, value: pollQuestion },
    { name: "createdAt", type: sql.DateTimeOffset, value: createdAt },
    { name: "lastModifiedAt", type: sql.DateTimeOffset, value: lastModifiedAt },
    { name: "publishedAt", type: sql.DateTimeOffset, value: publishedAt },
  ];
}

// GET /api/linkedin/posts : fetch & upsert last N (default 10) company posts
app.get("/api/linkedin/posts", async (req, res) => {
  // Keep your existing “must be logged in” rule; remove if you want this public
  if (!req.session.userinfo) {
    return res.status(401).json({ error: "Not logged in" });
  }

  const count = Math.min(Number(req.query.count || 10), 50);
  const start = Math.max(Number(req.query.start || 0), 0);
  const author = req.query.author || LINKEDIN_ORG_URN;

  try {
    const token = await getPostsAccessToken();

    const { data } = await axios.get("https://api.linkedin.com/rest/posts", {
      params: { q: "author", author, start, count },
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Restli-Protocol-Version": "2.0.0",
        "LinkedIn-Version": LINKEDIN_API_VERSION, // pin behavior; optional but recommended
      },
    });

    const elements = Array.isArray(data?.elements) ? data.elements : [];

    const pool = await getPool();
    let upserted = 0;

    for (const p of elements) {
      const request = pool.request();
      for (const param of mapPostToSqlParams(p, sql)) {
        request.input(param.name, param.type, param.value);
      }
      await request.query(`
        MERGE dbo.LinkedInPosts AS target
        USING (SELECT @postId AS postId) AS source
          ON target.postId = source.postId
        WHEN MATCHED THEN
          UPDATE SET
            postUrn=@postUrn,
            postType=@postType,
            activity=@activity,
            text=@text,
            author=@author,
            visibility=@visibility,
            lifecycleState=@lifecycleState,
            isEditedByAuthor=@isEditedByAuthor,
            isReshareDisabledByAuthor=@isReshareDisabledByAuthor,
            feedDistribution=@feedDistribution,
            reshareParent=@reshareParent,
            reshareRoot=@reshareRoot,
            mediaId=@mediaId,
            mediaAltText=@mediaAltText,
            pollQuestion=@pollQuestion,
            createdAt=@createdAt,
            lastModifiedAt=@lastModifiedAt,
            publishedAt=@publishedAt
        WHEN NOT MATCHED THEN
          INSERT (
            postId, postUrn, postType, activity, text, author, visibility,
            lifecycleState, isEditedByAuthor, isReshareDisabledByAuthor,
            feedDistribution, reshareParent, reshareRoot,
            mediaId, mediaAltText, pollQuestion,
            createdAt, lastModifiedAt, publishedAt
          )
          VALUES (
            @postId, @postUrn, @postType, @activity, @text, @author, @visibility,
            @lifecycleState, @isEditedByAuthor, @isReshareDisabledByAuthor,
            @feedDistribution, @reshareParent, @reshareRoot,
            @mediaId, @mediaAltText, @pollQuestion,
            @createdAt, @lastModifiedAt, @publishedAt
          );
      `);
      upserted += 1;
    }

    res.json({
      ok: true,
      author,
      paging: data?.paging || null,
      count: elements.length,
      upserted,
    });
  } catch (e) {
    const msg = e?.response?.data || e?.message || String(e);
    console.error("Fetch/upsert LinkedIn posts error:", msg);
    res.status(500).json({ error: "Failed to fetch/upsert posts" });
  }
});






// Logout
app.get("/logout", (req, res) => {
  req.session.destroy(() => res.redirect(FRONTEND_ORIGIN));
});

// Start server
app.listen(PORT, () => {
  console.log(`✅ Server listening on ${PORT}`);
  console.log(`BASE_URL: ${BASE_URL}`);
  console.log(`FRONTEND_ORIGIN: ${FRONTEND_ORIGIN}`);
  console.log(`NODE_ENV: ${process.env.NODE_ENV}`);
});
// Ver 0.1.0