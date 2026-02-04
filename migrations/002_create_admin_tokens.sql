-- Migration: Create AdminTokens table for storing LinkedIn admin authorization
-- Run this against Azure SQL Database

IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'AdminTokens')
BEGIN
    CREATE TABLE dbo.AdminTokens (
        id              BIGINT IDENTITY(1,1) PRIMARY KEY,
        tokenType       VARCHAR(50) NOT NULL UNIQUE,  -- e.g., 'linkedin_admin'
        accessToken     VARCHAR(2000) NOT NULL,
        refreshToken    VARCHAR(2000),
        expiresAt       DATETIMEOFFSET NOT NULL,
        refreshExpiresAt DATETIMEOFFSET,
        updatedAt       DATETIMEOFFSET DEFAULT SYSDATETIMEOFFSET()
    );
END
GO
