// routes/sync.js
// Sync trigger and status endpoints

const express = require("express");
const { runFullSync, getSyncLogs, hasAdminTokenConfigured, MOCK_MODE } = require("../services/linkedinSync");

const router = express.Router();

// POST /api/sync/trigger
// Manually trigger a LinkedIn sync
router.post("/trigger", async (req, res) => {
  try {
    // Check if sync is possible
    if (!MOCK_MODE && !hasAdminTokenConfigured()) {
      return res.status(400).json({
        error: "LinkedIn API credentials not configured. Enable LINKEDIN_MOCK_MODE=true for testing.",
      });
    }

    console.log("[Sync] Manual sync triggered");
    const result = await runFullSync();

    if (result.success) {
      res.json({
        ok: true,
        message: "Sync completed successfully",
        postsProcessed: result.postsProcessed,
        engagementsFound: result.engagementsFound,
        mockMode: MOCK_MODE,
      });
    } else {
      res.status(500).json({
        ok: false,
        error: result.error,
        postsProcessed: result.postsProcessed,
        engagementsFound: result.engagementsFound,
      });
    }
  } catch (err) {
    console.error("[Sync] Trigger failed:", err.message);
    res.status(500).json({ error: "Sync failed: " + err.message });
  }
});

// GET /api/sync/status
// Get recent sync logs
router.get("/status", async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit || 10), 50);
    const logs = await getSyncLogs(limit);

    res.json({
      logs,
      mockMode: MOCK_MODE,
      hasCredentials: hasAdminTokenConfigured(),
    });
  } catch (err) {
    console.error("[Sync] Status query failed:", err.message);
    res.status(500).json({ error: "Failed to fetch sync status" });
  }
});

module.exports = router;
