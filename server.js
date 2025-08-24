const express = require("express");
const session = require("express-session");
const axios = require("axios");
const { sql, pool, poolConnect } = require("./db"); // 👈 Load Azure DB connection
require("dotenv").config();

const PORT = 3003;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const CLIENT_ID = process.env.LINKEDIN_CLIENT_ID;
const CLIENT_SECRET = process.env.LINKEDIN_CLIENT_SECRET;
const REDIRECT_URI = `${BASE_URL}/callback`;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("Missing LINKEDIN_CLIENT_ID or LINKEDIN_CLIENT_SECRET");
  process.exit(1);
}

const app = express();

app.use(
  session({
    secret: process.env.SESSION_SECRET || "supersecret",
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: "lax" },
  })
);

// Homepage
app.get("/", (req, res) => {
  const userinfo = req.session.userinfo;
  res.send(`
    <h1>LinkedIn OAuth2 Login</h1>
    ${
      userinfo
        ? `<pre>${JSON.stringify(userinfo, null, 2)}</pre><a href="/logout">Logout</a>`
        : `<a href="/login">Login with LinkedIn</a>`
    }
  `);
});

// Step 1 - Redirect to LinkedIn Auth
app.get("/login", (req, res) => {
  const state = Math.random().toString(36).substring(2);
  req.session.state = state;

  const authURL = `https://www.linkedin.com/oauth/v2/authorization?` +
    `response_type=code&` +
    `client_id=${encodeURIComponent(CLIENT_ID)}&` +
    `redirect_uri=${encodeURIComponent(REDIRECT_URI)}&` +
    `state=${encodeURIComponent(state)}&` +
    `scope=${encodeURIComponent("openid profile email")}`;

  res.redirect(authURL);
});

// Step 2 - LinkedIn redirects back here!
app.get("/callback", async (req, res) => {
  const { code, state } = req.query;

  if (!code) {
    return res.status(400).send("Missing code.");
  }

  if (state !== req.session.state) {
    return res.status(400).send("State mismatch.");
  }

  try {
    // Step 3 - Exchange code for access token
    const tokenRes = await axios.post(
      "https://www.linkedin.com/oauth/v2/accessToken",
      new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
      }),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }
    );

    const accessToken = tokenRes.data.access_token;

    // Step 4 - Fetch userinfo from LinkedIn OIDC endpoint
    const userinfoRes = await axios.get("https://api.linkedin.com/v2/userinfo", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    // Save to session
    req.session.userinfo = userinfoRes.data;

    // Step 5 - Upsert to Azure SQL
    const {
      sub,
      name,
      given_name,
      family_name,
      email,
      email_verified,
      locale,
      picture,
    } = userinfoRes.data;

    await poolConnect;

    const request = pool.request();
    request.input("sub", sql.VarChar, sub);
    request.input("email", sql.VarChar, email);
    request.input("name", sql.VarChar, name);
    request.input("firstName", sql.VarChar, given_name);
    request.input("lastName", sql.VarChar, family_name);
    request.input("locale", sql.VarChar, typeof locale === "string" ? locale : JSON.stringify(locale));
    request.input("picture", sql.VarChar, picture);
    request.input("emailVerified", sql.Bit, email_verified ? 1 : 0);

    await request.query(`
      MERGE users AS target
      USING (SELECT @sub AS sub) AS source
      ON target.sub = source.sub
      WHEN MATCHED THEN
        UPDATE SET
          email = @email,
          name = @name,
          firstName = @firstName,
          lastName = @lastName,
          locale = @locale,
          picture = @picture,
          emailVerified = @emailVerified
      WHEN NOT MATCHED THEN
        INSERT (sub, email, name, firstName, lastName, locale, picture, emailVerified)
        VALUES (@sub, @email, @name, @firstName, @lastName, @locale, @picture, @emailVerified);
    `);

    console.log("✅ User upserted to Azure SQL");

    res.redirect("/");
  } catch (err) {
    console.error("OAuth error:", err.response?.data || err.message);
    res.status(500).send("OAuth failed.");
  }
});

// Logout
app.get("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/"));
});

// Health check
app.get("/healthz", (_req, res) => res.json({ ok: true }));

// Start server
app.listen(PORT, () => {
  console.log(`✅ Server running at ${BASE_URL}`);
});
