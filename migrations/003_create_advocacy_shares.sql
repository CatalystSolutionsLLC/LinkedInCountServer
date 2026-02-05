-- Migration 003: Add AdvocacyShares table + new columns on LinkedInPosts
-- Run against Azure SQL: LinkedInEngagement database

-- Add source and mediaUrl columns to LinkedInPosts
IF COL_LENGTH('dbo.LinkedInPosts', 'source') IS NULL
BEGIN
    ALTER TABLE dbo.LinkedInPosts ADD source VARCHAR(20) DEFAULT 'sync';
END
GO

IF COL_LENGTH('dbo.LinkedInPosts', 'mediaUrl') IS NULL
BEGIN
    ALTER TABLE dbo.LinkedInPosts ADD mediaUrl NVARCHAR(2048) NULL;
END
GO

-- Create AdvocacyShares table
IF OBJECT_ID('dbo.AdvocacyShares', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.AdvocacyShares (
        id          BIGINT IDENTITY(1,1) PRIMARY KEY,
        postId      VARCHAR(255) NOT NULL,
        userSub     VARCHAR(100) NOT NULL,
        sharedAt    DATETIMEOFFSET DEFAULT SYSDATETIMEOFFSET(),

        CONSTRAINT FK_AdvocacyShares_Post FOREIGN KEY (postId)
            REFERENCES dbo.LinkedInPosts(postId),
        CONSTRAINT UQ_AdvocacyShares_User_Post UNIQUE (postId, userSub)
    );
END
GO
