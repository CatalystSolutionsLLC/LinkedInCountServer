// routes/advocacy.js
// Employee advocacy: suggestions, sharing, and stats

const express = require("express");
const { sql, getPool } = require("../db");

const router = express.Router();

// GET /api/advocacy/suggestions
// Posts suggested for resharing, with already-shared status for current user
router.get("/suggestions", async (req, res) => {
  try {
    const pool = await getPool();
    const userSub = req.user.sub;

    const r = pool.request();
    r.input("userSub", sql.VarChar(100), userSub);

    const result = await r.query(`
      SELECT
        lp.postId,
        lp.text,
        lp.publishedAt,
        lp.mediaUrl,
        CASE WHEN ash.id IS NOT NULL THEN 1 ELSE 0 END AS alreadyShared,
        ash.sharedAt,
        (SELECT COUNT(*) FROM dbo.AdvocacyShares a2 WHERE a2.postId = lp.postId) AS totalShares
      FROM dbo.LinkedInPosts lp
      LEFT JOIN dbo.AdvocacyShares ash
        ON lp.postId = ash.postId
        AND ash.userSub = @userSub COLLATE SQL_Latin1_General_CP1_CI_AS
      WHERE lp.visibility = 'PUBLIC'
      ORDER BY lp.publishedAt DESC;
    `);

    res.json(result.recordset);
  } catch (err) {
    console.error("Advocacy suggestions failed:", err.message);
    res.status(500).json({ error: "Failed to fetch advocacy suggestions" });
  }
});

// POST /api/advocacy/share
// Record that a user shared a post
router.post("/share", async (req, res) => {
  try {
    const { postId } = req.body;
    if (!postId) {
      return res.status(400).json({ error: "postId is required" });
    }

    const pool = await getPool();
    const userSub = req.user.sub;

    const r = pool.request();
    r.input("postId", sql.VarChar(255), postId);
    r.input("userSub", sql.VarChar(100), userSub);

    // Upsert — ignore if already shared
    await r.query(`
      IF NOT EXISTS (
        SELECT 1 FROM dbo.AdvocacyShares
        WHERE postId = @postId AND userSub = @userSub COLLATE SQL_Latin1_General_CP1_CI_AS
      )
      BEGIN
        INSERT INTO dbo.AdvocacyShares (postId, userSub)
        VALUES (@postId, @userSub);
      END
    `);

    res.json({ success: true });
  } catch (err) {
    console.error("Advocacy share failed:", err.message);
    res.status(500).json({ error: "Failed to record share" });
  }
});

// GET /api/advocacy/stats
// Advocacy program stats: total shares, active advocates, top advocates
router.get("/stats", async (req, res) => {
  try {
    const pool = await getPool();

    const result = await pool.request().query(`
      SELECT
        (SELECT COUNT(*) FROM dbo.AdvocacyShares) AS totalShares,
        (SELECT COUNT(DISTINCT userSub) FROM dbo.AdvocacyShares) AS activeAdvocates,
        (SELECT COUNT(*) FROM dbo.LinkedInPosts WHERE visibility = 'PUBLIC') AS postsAvailable;
    `);

    // Top advocates
    const topResult = await pool.request().query(`
      SELECT TOP 5
        u.sub,
        COALESCE(NULLIF(u.name,''), CONCAT(COALESCE(u.firstName,''), ' ', COALESCE(u.lastName,''))) AS name,
        u.picture,
        COUNT(ash.id) AS shareCount
      FROM dbo.AdvocacyShares ash
      JOIN dbo.users u ON ash.userSub = u.sub COLLATE SQL_Latin1_General_CP1_CI_AS
      GROUP BY u.sub, u.name, u.firstName, u.lastName, u.picture
      ORDER BY shareCount DESC;
    `);

    res.json({
      ...result.recordset[0],
      topAdvocates: topResult.recordset,
    });
  } catch (err) {
    console.error("Advocacy stats failed:", err.message);
    res.status(500).json({ error: "Failed to fetch advocacy stats" });
  }
});

module.exports = router;
