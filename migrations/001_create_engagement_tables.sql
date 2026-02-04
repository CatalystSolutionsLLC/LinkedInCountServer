-- Migration: Create tables for LinkedIn engagement tracking
-- Run this against Azure SQL Database

-- Add syncedAt column to LinkedInPosts if it doesn't exist
IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_NAME = 'LinkedInPosts' AND COLUMN_NAME = 'syncedAt'
)
BEGIN
    ALTER TABLE dbo.LinkedInPosts ADD syncedAt DATETIMEOFFSET DEFAULT SYSDATETIMEOFFSET();
END
GO

-- PostEngagements: Track reactions and comments from employees
IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'PostEngagements')
BEGIN
    CREATE TABLE dbo.PostEngagements (
        id              BIGINT IDENTITY(1,1) PRIMARY KEY,
        postId          VARCHAR(255) NOT NULL,
        userSub         VARCHAR(100) NOT NULL,
        engagementType  VARCHAR(20) NOT NULL,
        reactionType    VARCHAR(20),
        commentText     NVARCHAR(MAX),
        engagedAt       DATETIMEOFFSET,
        syncedAt        DATETIMEOFFSET DEFAULT SYSDATETIMEOFFSET(),
        reactionTypeKey AS ISNULL(reactionType, ''),
        CONSTRAINT FK_PostEngagements_Post FOREIGN KEY (postId) REFERENCES dbo.LinkedInPosts(postId)
    );
END
GO

-- Unique index on PostEngagements
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UQ_PostEngagement')
BEGIN
    CREATE UNIQUE INDEX UQ_PostEngagement ON dbo.PostEngagements(postId, userSub, engagementType, reactionTypeKey);
END
GO

-- SyncLog: Track sync job history
IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'SyncLog')
BEGIN
    CREATE TABLE dbo.SyncLog (
        id              BIGINT IDENTITY(1,1) PRIMARY KEY,
        status          VARCHAR(20) NOT NULL,
        postsProcessed  INT DEFAULT 0,
        engagementsFound INT DEFAULT 0,
        errorMessage    NVARCHAR(MAX),
        startedAt       DATETIMEOFFSET DEFAULT SYSDATETIMEOFFSET(),
        completedAt     DATETIMEOFFSET
    );
END
GO

-- Indexes for common queries
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_PostEngagements_UserSub')
BEGIN
    CREATE INDEX IX_PostEngagements_UserSub ON dbo.PostEngagements(userSub);
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_PostEngagements_EngagedAt')
BEGIN
    CREATE INDEX IX_PostEngagements_EngagedAt ON dbo.PostEngagements(engagedAt);
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_LinkedInPosts_PublishedAt')
BEGIN
    CREATE INDEX IX_LinkedInPosts_PublishedAt ON dbo.LinkedInPosts(publishedAt);
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_SyncLog_StartedAt')
BEGIN
    CREATE INDEX IX_SyncLog_StartedAt ON dbo.SyncLog(startedAt DESC);
END
GO
