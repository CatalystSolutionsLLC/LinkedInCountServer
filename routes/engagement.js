// routes/engagement.js
// Leaderboard and engagement tracking endpoints

const express = require("express");
const { sql, getPool } = require("../db");

const router = express.Router();

// GET /api/engagement/leaderboard
// Returns employee engagement scores ranked by total
router.get("/leaderboard", async (req, res) => {
  try {
    const pool = await getPool();

    // Optional period filter: week, month, quarter, all
    const period = req.query.period || "all";
    let dateFilter = "";

    if (period === "week") {
      dateFilter = "AND pe.engagedAt >= DATEADD(day, -7, GETUTCDATE())";
    } else if (period === "month") {
      dateFilter = "AND pe.engagedAt >= DATEADD(month, -1, GETUTCDATE())";
    } else if (period === "quarter") {
      dateFilter = "AND pe.engagedAt >= DATEADD(month, -3, GETUTCDATE())";
    }

    const result = await pool.request().query(`
      SELECT
        u.sub,
        COALESCE(NULLIF(u.name,''), CONCAT(COALESCE(u.firstName,''), ' ', COALESCE(u.lastName,''))) AS name,
        u.picture,
        u.email,
        COUNT(CASE WHEN pe.engagementType = 'REACTION' THEN 1 END) AS reactions,
        COUNT(CASE WHEN pe.engagementType = 'COMMENT' THEN 1 END) AS comments,
        COUNT(pe.id) AS total
      FROM dbo.users u
      LEFT JOIN dbo.PostEngagements pe ON u.sub COLLATE SQL_Latin1_General_CP1_CI_AS = pe.userSub ${dateFilter}
      GROUP BY u.sub, u.name, u.firstName, u.lastName, u.picture, u.email
      ORDER BY total DESC, reactions DESC, comments DESC;
    `);

    res.json(result.recordset);
  } catch (err) {
    console.error("Leaderboard query failed:", err.message);
    res.status(500).json({ error: "Failed to fetch leaderboard" });
  }
});

// GET /api/engagement/user/:sub
// Returns engagement history for a specific user
router.get("/user/:sub", async (req, res) => {
  try {
    const pool = await getPool();
    const r = pool.request();
    r.input("userSub", sql.VarChar, req.params.sub);

    const result = await r.query(`
      SELECT
        pe.id,
        pe.postId,
        pe.engagementType,
        pe.reactionType,
        pe.commentText,
        pe.engagedAt,
        lp.text AS postText,
        lp.publishedAt AS postPublishedAt
      FROM dbo.PostEngagements pe
      JOIN dbo.LinkedInPosts lp ON pe.postId = lp.postId
      WHERE pe.userSub = @userSub COLLATE SQL_Latin1_General_CP1_CI_AS
      ORDER BY pe.engagedAt DESC;
    `);

    res.json(result.recordset);
  } catch (err) {
    console.error("User engagement query failed:", err.message);
    res.status(500).json({ error: "Failed to fetch user engagements" });
  }
});

// GET /api/engagement/stats
// Returns overall engagement statistics
router.get("/stats", async (req, res) => {
  try {
    const pool = await getPool();

    const result = await pool.request().query(`
      SELECT
        (SELECT COUNT(*) FROM dbo.users) AS totalEmployees,
        (SELECT COUNT(DISTINCT userSub) FROM dbo.PostEngagements) AS engagedEmployees,
        (SELECT COUNT(*) FROM dbo.LinkedInPosts) AS totalPosts,
        (SELECT COUNT(*) FROM dbo.PostEngagements WHERE engagementType = 'REACTION') AS totalReactions,
        (SELECT COUNT(*) FROM dbo.PostEngagements WHERE engagementType = 'COMMENT') AS totalComments;
    `);

    res.json(result.recordset[0]);
  } catch (err) {
    console.error("Stats query failed:", err.message);
    res.status(500).json({ error: "Failed to fetch stats" });
  }
});

module.exports = router;
