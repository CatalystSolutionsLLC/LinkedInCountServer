// services/linkedinSync.js
// LinkedIn sync service for fetching posts and engagements

const axios = require("axios");
const { sql, getPool } = require("../db");

const POST_CLIENT_ID = process.env.POST_CLIENT_ID;
const POST_CLIENT_SECRET = process.env.POST_CLIENT_SECRET;
const LINKEDIN_ORG_URN = process.env.LINKEDIN_ORG_URN || "urn:li:organization:30474";
const LINKEDIN_API_VERSION = process.env.LINKEDIN_API_VERSION || "202501";
const MOCK_MODE = process.env.LINKEDIN_MOCK_MODE === "true";

// Get admin token from database (stored via OAuth authorization flow)
async function getAdminToken() {
  const pool = await getPool();
  const result = await pool.request()
    .input("tokenType", sql.VarChar, "linkedin_admin")
    .query(`
      SELECT accessToken, expiresAt, refreshToken
      FROM dbo.AdminTokens
      WHERE tokenType = @tokenType
    `);

  if (result.recordset.length === 0) {
    throw new Error("No admin token found. Please authorize at /admin/linkedin/authorize");
  }

  const token = result.recordset[0];
  const now = new Date();
  const expiresAt = new Date(token.expiresAt);

  if (expiresAt < now) {
    // Token expired - try to refresh
    if (token.refreshToken) {
      return await refreshAdminToken(token.refreshToken);
    }
    throw new Error("Admin token expired. Please re-authorize at /admin/linkedin/authorize");
  }

  return token.accessToken;
}

// Refresh the admin token
async function refreshAdminToken(refreshToken) {
  console.log("[Sync] Refreshing admin token...");

  const form = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: POST_CLIENT_ID,
    client_secret: POST_CLIENT_SECRET,
  });

  const { data } = await axios.post(
    "https://www.linkedin.com/oauth/v2/accessToken",
    form,
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
  );

  // Update token in database
  const pool = await getPool();
  const r = pool.request();
  r.input("tokenType", sql.VarChar, "linkedin_admin");
  r.input("accessToken", sql.VarChar, data.access_token);
  r.input("refreshToken", sql.VarChar, data.refresh_token || refreshToken);
  r.input("expiresAt", sql.DateTimeOffset, new Date(Date.now() + (data.expires_in * 1000)));

  await r.query(`
    UPDATE dbo.AdminTokens
    SET accessToken = @accessToken,
        refreshToken = @refreshToken,
        expiresAt = @expiresAt,
        updatedAt = SYSDATETIMEOFFSET()
    WHERE tokenType = @tokenType
  `);

  console.log("[Sync] Admin token refreshed successfully");
  return data.access_token;
}

function hasAdminTokenConfigured() {
  return !!(POST_CLIENT_ID && POST_CLIENT_SECRET);
}

// Generate mock data for testing without API access
function generateMockData(pool) {
  return {
    posts: [
      {
        id: "urn:li:share:mock001",
        commentary: "Excited to announce our latest product launch!",
        author: LINKEDIN_ORG_URN,
        visibility: "PUBLIC",
        publishedAt: Date.now() - 86400000 * 2,
      },
      {
        id: "urn:li:share:mock002",
        commentary: "We're hiring! Join our amazing team.",
        author: LINKEDIN_ORG_URN,
        visibility: "PUBLIC",
        publishedAt: Date.now() - 86400000 * 5,
      },
      {
        id: "urn:li:share:mock003",
        commentary: "Great quarter results - thank you team!",
        author: LINKEDIN_ORG_URN,
        visibility: "PUBLIC",
        publishedAt: Date.now() - 86400000 * 10,
      },
    ],
    // Mock engagements will be populated from actual users in the database
    async getEngagements(postId, users) {
      const engagements = [];
      const reactionTypes = ["LIKE", "CELEBRATE", "SUPPORT", "LOVE", "INSIGHTFUL", "FUNNY"];

      // Randomly assign some users as having reacted/commented
      for (const user of users) {
        if (Math.random() > 0.6) {
          engagements.push({
            type: "REACTION",
            actor: user.sub,
            reactionType: reactionTypes[Math.floor(Math.random() * reactionTypes.length)],
            createdAt: Date.now() - Math.floor(Math.random() * 86400000 * 7),
          });
        }
        if (Math.random() > 0.8) {
          engagements.push({
            type: "COMMENT",
            actor: user.sub,
            text: "Great post!",
            createdAt: Date.now() - Math.floor(Math.random() * 86400000 * 7),
          });
        }
      }
      return engagements;
    },
  };
}

// Fetch company posts from LinkedIn API
async function fetchPosts(token, count = 50) {
  const { data } = await axios.get("https://api.linkedin.com/rest/posts", {
    params: { q: "author", author: LINKEDIN_ORG_URN, count },
    headers: {
      Authorization: `Bearer ${token}`,
      "X-Restli-Protocol-Version": "2.0.0",
      "LinkedIn-Version": LINKEDIN_API_VERSION,
    },
  });
  return Array.isArray(data?.elements) ? data.elements : [];
}

// Fetch reactions for a post
async function fetchReactions(token, postUrn) {
  try {
    const encodedUrn = encodeURIComponent(postUrn);
    const { data } = await axios.get(
      `https://api.linkedin.com/rest/reactions/(entity:${encodedUrn})`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Restli-Protocol-Version": "2.0.0",
          "LinkedIn-Version": LINKEDIN_API_VERSION,
        },
      }
    );
    return Array.isArray(data?.elements) ? data.elements : [];
  } catch (err) {
    console.error(`Failed to fetch reactions for ${postUrn}:`, err.message);
    return [];
  }
}

// Fetch comments for a post
async function fetchComments(token, postUrn) {
  try {
    const encodedUrn = encodeURIComponent(postUrn);
    const { data } = await axios.get(
      `https://api.linkedin.com/rest/socialActions/${encodedUrn}/comments`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Restli-Protocol-Version": "2.0.0",
          "LinkedIn-Version": LINKEDIN_API_VERSION,
        },
      }
    );
    return Array.isArray(data?.elements) ? data.elements : [];
  } catch (err) {
    console.error(`Failed to fetch comments for ${postUrn}:`, err.message);
    return [];
  }
}

// Get all employee URNs from the users table
async function getEmployeeUrns(pool) {
  const result = await pool.request().query("SELECT sub FROM dbo.users");
  return new Set(result.recordset.map((r) => r.sub));
}

// Upsert a post to the database
async function upsertPost(pool, post) {
  const r = pool.request();
  r.input("postId", sql.VarChar(255), post.id);
  r.input("text", sql.NVarChar, post.commentary || post.text || null);
  r.input("author", sql.VarChar, post.author || null);
  r.input("visibility", sql.VarChar, post.visibility || null);
  r.input(
    "publishedAt",
    sql.DateTimeOffset,
    post.publishedAt ? new Date(Number(post.publishedAt)) : null
  );

  await r.query(`
    MERGE dbo.LinkedInPosts AS target
    USING (SELECT @postId AS postId) AS source
    ON target.postId = source.postId
    WHEN MATCHED THEN
      UPDATE SET text=@text, author=@author, visibility=@visibility,
                 publishedAt=@publishedAt, syncedAt=SYSDATETIMEOFFSET()
    WHEN NOT MATCHED THEN
      INSERT (postId, text, author, visibility, publishedAt)
      VALUES (@postId, @text, @author, @visibility, @publishedAt);
  `);
}

// Upsert an engagement to the database
async function upsertEngagement(pool, postId, userSub, type, reactionType, commentText, engagedAt) {
  const r = pool.request();
  r.input("postId", sql.VarChar(255), postId);
  r.input("userSub", sql.VarChar(100), userSub);
  r.input("engagementType", sql.VarChar(20), type);
  r.input("reactionType", sql.VarChar(20), reactionType || null);
  r.input("commentText", sql.NVarChar(sql.MAX), commentText || null);
  r.input("engagedAt", sql.DateTimeOffset, engagedAt ? new Date(engagedAt) : null);

  await r.query(`
    MERGE dbo.PostEngagements AS target
    USING (
      SELECT @postId AS postId, @userSub AS userSub,
             @engagementType AS engagementType, ISNULL(@reactionType, '') AS reactionTypeKey
    ) AS source
    ON target.postId = source.postId
       AND target.userSub = source.userSub
       AND target.engagementType = source.engagementType
       AND ISNULL(target.reactionType, '') = source.reactionTypeKey
    WHEN MATCHED THEN
      UPDATE SET commentText=@commentText, engagedAt=@engagedAt, syncedAt=SYSDATETIMEOFFSET()
    WHEN NOT MATCHED THEN
      INSERT (postId, userSub, engagementType, reactionType, commentText, engagedAt)
      VALUES (@postId, @userSub, @engagementType, @reactionType, @commentText, @engagedAt);
  `);
}

// Create a sync log entry
async function createSyncLog(pool, status) {
  const r = pool.request();
  r.input("status", sql.VarChar, status);
  const result = await r.query(`
    INSERT INTO dbo.SyncLog (status)
    OUTPUT INSERTED.id
    VALUES (@status);
  `);
  return result.recordset[0].id;
}

// Update sync log
async function updateSyncLog(pool, logId, status, postsProcessed, engagementsFound, errorMessage) {
  const r = pool.request();
  r.input("id", sql.BigInt, logId);
  r.input("status", sql.VarChar, status);
  r.input("postsProcessed", sql.Int, postsProcessed);
  r.input("engagementsFound", sql.Int, engagementsFound);
  r.input("errorMessage", sql.NVarChar, errorMessage || null);
  await r.query(`
    UPDATE dbo.SyncLog
    SET status=@status, postsProcessed=@postsProcessed, engagementsFound=@engagementsFound,
        errorMessage=@errorMessage, completedAt=SYSDATETIMEOFFSET()
    WHERE id=@id;
  `);
}

// Main sync function
async function runFullSync() {
  const pool = await getPool();
  const logId = await createSyncLog(pool, "RUNNING");

  let postsProcessed = 0;
  let engagementsFound = 0;

  try {
    console.log(`[Sync] Starting sync (mock mode: ${MOCK_MODE})`);

    // Get employee URNs for matching
    const employeeUrns = await getEmployeeUrns(pool);
    const users = MOCK_MODE
      ? (await pool.request().query("SELECT sub, name FROM dbo.users")).recordset
      : [];

    if (MOCK_MODE) {
      // Use mock data
      const mock = generateMockData(pool);

      for (const post of mock.posts) {
        await upsertPost(pool, post);
        postsProcessed++;

        const engagements = await mock.getEngagements(post.id, users);
        for (const eng of engagements) {
          await upsertEngagement(
            pool,
            post.id,
            eng.actor,
            eng.type,
            eng.reactionType || null,
            eng.text || null,
            eng.createdAt
          );
          engagementsFound++;
        }
      }
    } else {
      // Real LinkedIn API sync using admin token
      if (!hasAdminTokenConfigured()) {
        throw new Error("LinkedIn API credentials not configured");
      }

      const token = await getAdminToken();
      const posts = await fetchPosts(token);

      for (const post of posts) {
        await upsertPost(pool, post);
        postsProcessed++;

        // Fetch reactions
        const reactions = await fetchReactions(token, post.id);
        for (const reaction of reactions) {
          const actorUrn = reaction.actor;
          if (employeeUrns.has(actorUrn)) {
            await upsertEngagement(
              pool,
              post.id,
              actorUrn,
              "REACTION",
              reaction.reactionType,
              null,
              reaction.created?.time
            );
            engagementsFound++;
          }
        }

        // Fetch comments
        const comments = await fetchComments(token, post.id);
        for (const comment of comments) {
          const actorUrn = comment.actor;
          if (employeeUrns.has(actorUrn)) {
            await upsertEngagement(
              pool,
              post.id,
              actorUrn,
              "COMMENT",
              null,
              comment.message?.text,
              comment.created?.time
            );
            engagementsFound++;
          }
        }
      }
    }

    await updateSyncLog(pool, logId, "SUCCESS", postsProcessed, engagementsFound, null);
    console.log(`[Sync] Completed: ${postsProcessed} posts, ${engagementsFound} engagements`);

    return { success: true, postsProcessed, engagementsFound };
  } catch (err) {
    console.error("[Sync] Failed:", err.message);
    await updateSyncLog(pool, logId, "FAILED", postsProcessed, engagementsFound, err.message);
    return { success: false, error: err.message, postsProcessed, engagementsFound };
  }
}

// Get recent sync logs
async function getSyncLogs(limit = 10) {
  const pool = await getPool();
  const r = pool.request();
  r.input("limit", sql.Int, limit);
  const result = await r.query(`
    SELECT TOP (@limit) id, status, postsProcessed, engagementsFound, errorMessage, startedAt, completedAt
    FROM dbo.SyncLog
    ORDER BY startedAt DESC;
  `);
  return result.recordset;
}

module.exports = {
  runFullSync,
  getSyncLogs,
  hasAdminTokenConfigured,
  MOCK_MODE,
};
