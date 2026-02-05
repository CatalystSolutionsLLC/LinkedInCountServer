// routes/posts.js
// Company posts feed, engagement detail, and publish endpoints

const express = require("express");
const axios = require("axios");
const { sql, getPool } = require("../db");
const { getAdminToken, MOCK_MODE } = require("../services/linkedinSync");

const LINKEDIN_ORG_URN = process.env.LINKEDIN_ORG_URN || "urn:li:organization:30474";
const LINKEDIN_API_VERSION = process.env.LINKEDIN_API_VERSION || "202501";

const router = express.Router();

// GET /api/posts
// List company posts with reaction/comment counts
router.get("/", async (req, res) => {
  try {
    const pool = await getPool();

    const result = await pool.request().query(`
      SELECT
        lp.postId,
        lp.text,
        lp.author,
        lp.visibility,
        lp.source,
        lp.mediaUrl,
        lp.publishedAt,
        COUNT(CASE WHEN pe.engagementType = 'REACTION' THEN 1 END) AS reactionCount,
        COUNT(CASE WHEN pe.engagementType = 'COMMENT' THEN 1 END) AS commentCount,
        COUNT(pe.id) AS totalEngagements
      FROM dbo.LinkedInPosts lp
      LEFT JOIN dbo.PostEngagements pe ON lp.postId = pe.postId
      GROUP BY lp.postId, lp.text, lp.author, lp.visibility, lp.source, lp.mediaUrl, lp.publishedAt
      ORDER BY lp.publishedAt DESC;
    `);

    res.json(result.recordset);
  } catch (err) {
    console.error("Posts list failed:", err.message);
    res.status(500).json({ error: "Failed to fetch posts" });
  }
});

// GET /api/posts/:postId/engagements
// Who engaged with a specific post (name, photo, email, type) + accessible fields
router.get("/:postId/engagements", async (req, res) => {
  try {
    const pool = await getPool();
    const r = pool.request();
    r.input("postId", sql.VarChar(255), req.params.postId);

    const result = await r.query(`
      SELECT
        pe.engagementType,
        pe.reactionType,
        pe.commentText,
        pe.engagedAt,
        u.sub,
        COALESCE(NULLIF(u.name,''), CONCAT(COALESCE(u.firstName,''), ' ', COALESCE(u.lastName,''))) AS name,
        u.email,
        u.picture
      FROM dbo.PostEngagements pe
      JOIN dbo.users u ON pe.userSub = u.sub COLLATE SQL_Latin1_General_CP1_CI_AS
      WHERE pe.postId = @postId
      ORDER BY pe.engagedAt DESC;
    `);

    // Data transparency: list what member fields are accessible
    const accessibleFields = [
      { field: "name", description: "Member's full name from LinkedIn profile" },
      { field: "email", description: "Member's email address (if shared)" },
      { field: "picture", description: "Profile photo URL" },
      { field: "engagementType", description: "Type of engagement (REACTION or COMMENT)" },
      { field: "reactionType", description: "Specific reaction (LIKE, CELEBRATE, etc.)" },
      { field: "engagedAt", description: "Date and time of engagement" },
    ];

    res.json({
      engagements: result.recordset,
      accessibleFields,
      totalCount: result.recordset.length,
    });
  } catch (err) {
    console.error("Post engagements failed:", err.message);
    res.status(500).json({ error: "Failed to fetch post engagements" });
  }
});

// POST /api/posts/publish
// Publish a post to the company LinkedIn page (or store locally in mock mode)
router.post("/publish", async (req, res) => {
  try {
    const { text } = req.body;
    if (!text || !text.trim()) {
      return res.status(400).json({ error: "Post text is required" });
    }

    const pool = await getPool();

    if (MOCK_MODE) {
      // Mock mode: store locally only
      const postId = `urn:li:share:local_${Date.now()}`;
      const r = pool.request();
      r.input("postId", sql.VarChar(255), postId);
      r.input("text", sql.NVarChar, text.trim());
      r.input("author", sql.VarChar, LINKEDIN_ORG_URN);
      r.input("visibility", sql.VarChar, "PUBLIC");
      r.input("publishedAt", sql.DateTimeOffset, new Date());
      r.input("source", sql.VarChar(20), "published");

      await r.query(`
        INSERT INTO dbo.LinkedInPosts (postId, text, author, visibility, publishedAt, source)
        VALUES (@postId, @text, @author, @visibility, @publishedAt, @source);
      `);

      return res.json({ success: true, postId, mockMode: true });
    }

    // Real mode: publish via LinkedIn API
    const token = await getAdminToken();

    const { data } = await axios.post(
      "https://api.linkedin.com/rest/posts",
      {
        author: LINKEDIN_ORG_URN,
        commentary: text.trim(),
        visibility: "PUBLIC",
        distribution: {
          feedDistribution: "MAIN_FEED",
          targetEntities: [],
          thirdPartyDistributionChannels: [],
        },
        lifecycleState: "PUBLISHED",
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "X-Restli-Protocol-Version": "2.0.0",
          "LinkedIn-Version": LINKEDIN_API_VERSION,
        },
      }
    );

    // Store in DB
    const postId = data.id || `urn:li:share:api_${Date.now()}`;
    const r = pool.request();
    r.input("postId", sql.VarChar(255), postId);
    r.input("text", sql.NVarChar, text.trim());
    r.input("author", sql.VarChar, LINKEDIN_ORG_URN);
    r.input("visibility", sql.VarChar, "PUBLIC");
    r.input("publishedAt", sql.DateTimeOffset, new Date());
    r.input("source", sql.VarChar(20), "published");

    await r.query(`
      INSERT INTO dbo.LinkedInPosts (postId, text, author, visibility, publishedAt, source)
      VALUES (@postId, @text, @author, @visibility, @publishedAt, @source);
    `);

    res.json({ success: true, postId, mockMode: false });
  } catch (err) {
    console.error("Publish post failed:", err.message);
    res.status(500).json({ error: "Failed to publish post" });
  }
});

module.exports = router;
