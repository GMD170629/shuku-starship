-- CreateTable
CREATE TABLE `User` (
    `id` VARCHAR(191) NOT NULL,
    `email` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `passwordHash` VARCHAR(191) NOT NULL,
    `role` VARCHAR(191) NOT NULL DEFAULT 'admin',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `User_email_key`(`email`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Session` (
    `id` VARCHAR(191) NOT NULL,
    `tokenHash` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `Session_tokenHash_key`(`tokenHash`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `MonitorFolder` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `rootPath` VARCHAR(191) NOT NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    `ignorePatterns` TEXT NULL,
    `ignoreHidden` BOOLEAN NOT NULL DEFAULT true,
    `minFileSizeBytes` INTEGER NOT NULL DEFAULT 10240,
    `description` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `MonitorFolder_rootPath_key`(`rootPath`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Source` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `kind` VARCHAR(191) NOT NULL,
    `providerType` VARCHAR(191) NOT NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    `priority` INTEGER NOT NULL DEFAULT 100,
    `config` JSON NULL,
    `credentialsKey` VARCHAR(191) NULL,
    `capabilities` JSON NULL,
    `rateLimit` JSON NULL,
    `lastTestAt` DATETIME(3) NULL,
    `lastTestStatus` VARCHAR(191) NULL,
    `lastError` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `Source_enabled_idx`(`enabled`),
    INDEX `Source_kind_idx`(`kind`),
    INDEX `Source_providerType_idx`(`providerType`),
    INDEX `Source_priority_idx`(`priority`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `SourceSearchRecord` (
    `id` VARCHAR(191) NOT NULL,
    `sourceId` VARCHAR(191) NOT NULL,
    `providerType` VARCHAR(191) NOT NULL,
    `externalId` VARCHAR(191) NOT NULL,
    `title` VARCHAR(191) NOT NULL,
    `subtitle` VARCHAR(191) NULL,
    `author` VARCHAR(191) NULL,
    `description` TEXT NULL,
    `coverUrl` VARCHAR(191) NULL,
    `externalUrl` VARCHAR(191) NULL,
    `format` VARCHAR(191) NULL,
    `size` VARCHAR(191) NULL,
    `language` VARCHAR(191) NULL,
    `publishedAt` DATETIME(3) NULL,
    `downloadAvailable` BOOLEAN NOT NULL DEFAULT false,
    `downloadMeta` JSON NULL,
    `raw` JSON NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'new',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `SourceSearchRecord_sourceId_idx`(`sourceId`),
    INDEX `SourceSearchRecord_providerType_idx`(`providerType`),
    INDEX `SourceSearchRecord_status_idx`(`status`),
    INDEX `SourceSearchRecord_title_idx`(`title`),
    INDEX `SourceSearchRecord_createdAt_idx`(`createdAt`),
    UNIQUE INDEX `SourceSearchRecord_sourceId_externalId_key`(`sourceId`, `externalId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `DownloadTask` (
    `id` VARCHAR(191) NOT NULL,
    `sourceId` VARCHAR(191) NULL,
    `searchRecordId` VARCHAR(191) NULL,
    `bookId` VARCHAR(191) NULL,
    `type` VARCHAR(191) NOT NULL,
    `status` VARCHAR(191) NOT NULL,
    `displayName` VARCHAR(191) NOT NULL,
    `remoteRef` JSON NULL,
    `savePath` VARCHAR(191) NULL,
    `filePath` VARCHAR(191) NULL,
    `errorMessage` TEXT NULL,
    `progress` DOUBLE NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `DownloadTask_sourceId_idx`(`sourceId`),
    INDEX `DownloadTask_searchRecordId_idx`(`searchRecordId`),
    INDEX `DownloadTask_bookId_idx`(`bookId`),
    INDEX `DownloadTask_type_idx`(`type`),
    INDEX `DownloadTask_status_createdAt_idx`(`status`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `LibraryWork` (
    `id` VARCHAR(191) NOT NULL,
    `monitorFolderId` VARCHAR(191) NULL,
    `origin` ENUM('MANUAL', 'WATCH') NOT NULL DEFAULT 'MANUAL',
    `title` VARCHAR(191) NOT NULL,
    `normalizedTitle` VARCHAR(191) NOT NULL,
    `author` VARCHAR(191) NULL,
    `normalizedAuthor` VARCHAR(191) NULL,
    `description` TEXT NULL,
    `workType` ENUM('COMIC', 'EPUB', 'PDF') NOT NULL,
    `status` ENUM('WANT', 'READING', 'FINISHED') NOT NULL DEFAULT 'WANT',
    `publicationStatus` ENUM('UNKNOWN', 'ONGOING', 'COMPLETED', 'HIATUS', 'CANCELLED') NOT NULL DEFAULT 'UNKNOWN',
    `trackingStatus` ENUM('NOT_TRACKING', 'TRACKING', 'PAUSED', 'IGNORED') NOT NULL DEFAULT 'NOT_TRACKING',
    `localLatestVolume` DOUBLE NULL,
    `localLatestChapter` DOUBLE NULL,
    `localLatestTitle` VARCHAR(191) NULL,
    `localLatestAt` DATETIME(3) NULL,
    `tags` TEXT NOT NULL,
    `seriesName` VARCHAR(191) NULL,
    `seriesIndex` DOUBLE NULL,
    `publishedYear` INTEGER NULL,
    `metadataQuality` INTEGER NOT NULL DEFAULT 0,
    `organizeStatus` ENUM('PENDING', 'REVIEWING', 'APPLIED', 'DISMISSED', 'FAILED') NOT NULL DEFAULT 'REVIEWING',
    `coverPath` VARCHAR(191) NULL,
    `coverStatus` ENUM('PENDING', 'READY', 'FAILED') NOT NULL DEFAULT 'PENDING',
    `hidden` BOOLEAN NOT NULL DEFAULT false,
    `organized` BOOLEAN NOT NULL DEFAULT false,
    `primaryEditionId` VARCHAR(191) NULL,
    `mergeKey` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `LibraryWork_workType_idx`(`workType`),
    INDEX `LibraryWork_publicationStatus_idx`(`publicationStatus`),
    INDEX `LibraryWork_trackingStatus_idx`(`trackingStatus`),
    INDEX `LibraryWork_title_idx`(`title`),
    INDEX `LibraryWork_normalizedTitle_idx`(`normalizedTitle`),
    INDEX `LibraryWork_normalizedAuthor_idx`(`normalizedAuthor`),
    INDEX `LibraryWork_seriesName_idx`(`seriesName`),
    INDEX `LibraryWork_publishedYear_idx`(`publishedYear`),
    INDEX `LibraryWork_organizeStatus_idx`(`organizeStatus`),
    INDEX `LibraryWork_hidden_idx`(`hidden`),
    INDEX `LibraryWork_organized_idx`(`organized`),
    INDEX `LibraryWork_monitorFolderId_idx`(`monitorFolderId`),
    UNIQUE INDEX `LibraryWork_mergeKey_key`(`mergeKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `LibraryEdition` (
    `id` VARCHAR(191) NOT NULL,
    `workId` VARCHAR(191) NOT NULL,
    `monitorFolderId` VARCHAR(191) NULL,
    `origin` ENUM('MANUAL', 'WATCH') NOT NULL DEFAULT 'MANUAL',
    `format` ENUM('COMIC', 'EPUB', 'PDF') NOT NULL,
    `versionName` VARCHAR(191) NOT NULL,
    `versionKey` VARCHAR(191) NOT NULL,
    `sourceGroupKey` VARCHAR(191) NULL,
    `description` TEXT NULL,
    `language` VARCHAR(191) NULL,
    `publisher` VARCHAR(191) NULL,
    `publishedAt` VARCHAR(191) NULL,
    `identifier` VARCHAR(191) NULL,
    `isbn` VARCHAR(191) NULL,
    `importStatus` ENUM('PENDING', 'PARSING', 'COMPLETED', 'FAILED') NOT NULL DEFAULT 'PENDING',
    `importError` TEXT NULL,
    `sizeBytes` BIGINT NOT NULL DEFAULT 0,
    `pageCount` INTEGER NULL,
    `chapterCount` INTEGER NULL,
    `coverPath` VARCHAR(191) NULL,
    `coverStatus` ENUM('PENDING', 'READY', 'FAILED') NOT NULL DEFAULT 'PENDING',
    `primary` BOOLEAN NOT NULL DEFAULT false,
    `hidden` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `LibraryEdition_workId_primary_idx`(`workId`, `primary`),
    INDEX `LibraryEdition_format_idx`(`format`),
    INDEX `LibraryEdition_identifier_idx`(`identifier`),
    INDEX `LibraryEdition_isbn_idx`(`isbn`),
    INDEX `LibraryEdition_sourceGroupKey_idx`(`sourceGroupKey`),
    INDEX `LibraryEdition_monitorFolderId_idx`(`monitorFolderId`),
    UNIQUE INDEX `LibraryEdition_workId_versionKey_key`(`workId`, `versionKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `LibraryVolume` (
    `id` VARCHAR(191) NOT NULL,
    `editionId` VARCHAR(191) NOT NULL,
    `title` VARCHAR(191) NOT NULL,
    `volumeIndex` DOUBLE NULL,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,
    `pageCount` INTEGER NULL,
    `chapterCount` INTEGER NULL,
    `coverPath` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `LibraryVolume_editionId_sortOrder_idx`(`editionId`, `sortOrder`),
    INDEX `LibraryVolume_editionId_volumeIndex_idx`(`editionId`, `volumeIndex`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `LibraryFile` (
    `id` VARCHAR(191) NOT NULL,
    `editionId` VARCHAR(191) NOT NULL,
    `volumeId` VARCHAR(191) NULL,
    `path` VARCHAR(191) NOT NULL,
    `filePathHash` VARCHAR(191) NULL,
    `fingerprint` VARCHAR(191) NULL,
    `fullHash` VARCHAR(191) NULL,
    `hashStatus` ENUM('FULL', 'PARTIAL_PENDING', 'FAILED') NOT NULL DEFAULT 'FAILED',
    `mtimeMs` BIGINT NOT NULL DEFAULT 0,
    `kind` ENUM('COMIC', 'EPUB', 'PDF') NOT NULL,
    `mimeType` VARCHAR(191) NOT NULL,
    `sizeBytes` BIGINT NOT NULL DEFAULT 0,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `LibraryFile_path_key`(`path`),
    UNIQUE INDEX `LibraryFile_filePathHash_key`(`filePathHash`),
    UNIQUE INDEX `LibraryFile_fullHash_key`(`fullHash`),
    INDEX `LibraryFile_editionId_sortOrder_idx`(`editionId`, `sortOrder`),
    INDEX `LibraryFile_volumeId_sortOrder_idx`(`volumeId`, `sortOrder`),
    INDEX `LibraryFile_fingerprint_idx`(`fingerprint`),
    INDEX `LibraryFile_fullHash_idx`(`fullHash`),
    INDEX `LibraryFile_sizeBytes_mtimeMs_idx`(`sizeBytes`, `mtimeMs`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ImportTask` (
    `id` VARCHAR(191) NOT NULL,
    `monitorFolderId` VARCHAR(191) NULL,
    `workId` VARCHAR(191) NULL,
    `editionId` VARCHAR(191) NULL,
    `volumeId` VARCHAR(191) NULL,
    `origin` ENUM('MANUAL', 'WATCH') NOT NULL,
    `status` ENUM('PENDING', 'PARSING', 'COMPLETED', 'FAILED') NOT NULL DEFAULT 'PENDING',
    `originalName` VARCHAR(191) NULL,
    `sourcePath` VARCHAR(191) NOT NULL,
    `contentHash` VARCHAR(191) NULL,
    `progress` INTEGER NOT NULL DEFAULT 0,
    `duplicate` BOOLEAN NOT NULL DEFAULT false,
    `duration` INTEGER NOT NULL DEFAULT 0,
    `errorSummary` TEXT NULL,
    `message` VARCHAR(191) NULL,
    `startedAt` DATETIME(3) NULL,
    `finishedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ImportTask_monitorFolderId_status_idx`(`monitorFolderId`, `status`),
    INDEX `ImportTask_status_createdAt_idx`(`status`, `createdAt`),
    INDEX `ImportTask_contentHash_idx`(`contentHash`),
    INDEX `ImportTask_workId_idx`(`workId`),
    INDEX `ImportTask_editionId_idx`(`editionId`),
    INDEX `ImportTask_volumeId_idx`(`volumeId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `OrganizeJob` (
    `id` VARCHAR(191) NOT NULL,
    `workId` VARCHAR(191) NOT NULL,
    `editionId` VARCHAR(191) NULL,
    `importTaskId` VARCHAR(191) NULL,
    `status` ENUM('PENDING', 'REVIEWING', 'APPLIED', 'DISMISSED', 'FAILED') NOT NULL DEFAULT 'REVIEWING',
    `issueCodes` TEXT NOT NULL,
    `summary` TEXT NULL,
    `errorSummary` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `OrganizeJob_workId_status_idx`(`workId`, `status`),
    INDEX `OrganizeJob_editionId_idx`(`editionId`),
    INDEX `OrganizeJob_importTaskId_idx`(`importTaskId`),
    INDEX `OrganizeJob_status_updatedAt_idx`(`status`, `updatedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `MetadataSuggestion` (
    `id` VARCHAR(191) NOT NULL,
    `jobId` VARCHAR(191) NOT NULL,
    `field` VARCHAR(191) NOT NULL,
    `currentValue` TEXT NULL,
    `suggestedValue` TEXT NOT NULL,
    `source` VARCHAR(191) NOT NULL,
    `confidence` DOUBLE NOT NULL DEFAULT 0,
    `reason` TEXT NOT NULL,
    `status` ENUM('PENDING', 'APPLIED', 'DISMISSED') NOT NULL DEFAULT 'PENDING',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `MetadataSuggestion_jobId_status_idx`(`jobId`, `status`),
    INDEX `MetadataSuggestion_field_idx`(`field`),
    INDEX `MetadataSuggestion_source_idx`(`source`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `DuplicateCandidate` (
    `id` VARCHAR(191) NOT NULL,
    `jobId` VARCHAR(191) NOT NULL,
    `targetWorkId` VARCHAR(191) NOT NULL,
    `reasons` TEXT NOT NULL,
    `confidence` DOUBLE NOT NULL DEFAULT 0,
    `suggestedAction` VARCHAR(191) NOT NULL,
    `status` ENUM('PENDING', 'APPLIED', 'DISMISSED') NOT NULL DEFAULT 'PENDING',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `DuplicateCandidate_jobId_status_idx`(`jobId`, `status`),
    INDEX `DuplicateCandidate_targetWorkId_idx`(`targetWorkId`),
    INDEX `DuplicateCandidate_suggestedAction_idx`(`suggestedAction`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ImportLog` (
    `id` VARCHAR(191) NOT NULL,
    `importTaskId` VARCHAR(191) NOT NULL,
    `level` VARCHAR(191) NOT NULL DEFAULT 'info',
    `message` TEXT NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ImportLog_importTaskId_createdAt_idx`(`importTaskId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `SystemEvent` (
    `id` VARCHAR(191) NOT NULL,
    `level` VARCHAR(191) NOT NULL DEFAULT 'info',
    `source` VARCHAR(191) NOT NULL,
    `actorType` VARCHAR(191) NOT NULL DEFAULT 'system',
    `actorId` VARCHAR(191) NULL,
    `action` VARCHAR(191) NOT NULL,
    `targetType` VARCHAR(191) NULL,
    `targetId` VARCHAR(191) NULL,
    `message` TEXT NOT NULL,
    `metadata` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `SystemEvent_level_createdAt_idx`(`level`, `createdAt`),
    INDEX `SystemEvent_source_createdAt_idx`(`source`, `createdAt`),
    INDEX `SystemEvent_actorType_createdAt_idx`(`actorType`, `createdAt`),
    INDEX `SystemEvent_action_createdAt_idx`(`action`, `createdAt`),
    INDEX `SystemEvent_targetType_targetId_idx`(`targetType`, `targetId`),
    INDEX `SystemEvent_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ReaderPreference` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `readerType` VARCHAR(191) NOT NULL,
    `settings` TEXT NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ReaderPreference_userId_idx`(`userId`),
    UNIQUE INDEX `ReaderPreference_userId_readerType_key`(`userId`, `readerType`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `SystemSetting` (
    `key` VARCHAR(191) NOT NULL,
    `value` TEXT NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`key`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ExternalMetadataCache` (
    `id` VARCHAR(191) NOT NULL,
    `provider` VARCHAR(191) NOT NULL,
    `queryKey` VARCHAR(191) NOT NULL,
    `rawJson` TEXT NOT NULL,
    `expiresAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ExternalMetadataCache_provider_expiresAt_idx`(`provider`, `expiresAt`),
    UNIQUE INDEX `ExternalMetadataCache_provider_queryKey_key`(`provider`, `queryKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Shelf` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `description` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `Shelf_updatedAt_idx`(`updatedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ShelfWork` (
    `shelfId` VARCHAR(191) NOT NULL,
    `workId` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ShelfWork_workId_idx`(`workId`),
    INDEX `ShelfWork_shelfId_createdAt_idx`(`shelfId`, `createdAt`),
    PRIMARY KEY (`shelfId`, `workId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `LibraryReadingUnit` (
    `id` VARCHAR(191) NOT NULL,
    `editionId` VARCHAR(191) NOT NULL,
    `volumeId` VARCHAR(191) NULL,
    `fileId` VARCHAR(191) NULL,
    `unitType` VARCHAR(191) NOT NULL,
    `title` VARCHAR(191) NOT NULL,
    `href` VARCHAR(191) NOT NULL,
    `mediaType` VARCHAR(191) NULL,
    `sortOrder` INTEGER NOT NULL,
    `width` INTEGER NULL,
    `height` INTEGER NULL,
    `size` BIGINT NULL,
    `metadataJson` TEXT NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `LibraryReadingUnit_editionId_sortOrder_idx`(`editionId`, `sortOrder`),
    INDEX `LibraryReadingUnit_editionId_unitType_idx`(`editionId`, `unitType`),
    INDEX `LibraryReadingUnit_volumeId_sortOrder_idx`(`volumeId`, `sortOrder`),
    INDEX `LibraryReadingUnit_fileId_sortOrder_idx`(`fileId`, `sortOrder`),
    UNIQUE INDEX `LibraryReadingUnit_volumeId_unitType_sortOrder_key`(`volumeId`, `unitType`, `sortOrder`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `LibraryMetadata` (
    `id` VARCHAR(191) NOT NULL,
    `editionId` VARCHAR(191) NOT NULL,
    `source` VARCHAR(191) NOT NULL,
    `rawJson` TEXT NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `LibraryMetadata_editionId_idx`(`editionId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `LibraryReadingProgress` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `workId` VARCHAR(191) NOT NULL,
    `editionId` VARCHAR(191) NOT NULL,
    `volumeId` VARCHAR(191) NULL,
    `readerType` VARCHAR(191) NOT NULL,
    `position` VARCHAR(191) NOT NULL DEFAULT '0',
    `page` INTEGER NULL,
    `percent` DOUBLE NOT NULL DEFAULT 0,
    `extra` TEXT NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `LibraryReadingProgress_workId_idx`(`workId`),
    INDEX `LibraryReadingProgress_editionId_idx`(`editionId`),
    INDEX `LibraryReadingProgress_volumeId_idx`(`volumeId`),
    UNIQUE INDEX `LibraryReadingProgress_userId_editionId_volumeId_key`(`userId`, `editionId`, `volumeId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `Session` ADD CONSTRAINT `Session_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SourceSearchRecord` ADD CONSTRAINT `SourceSearchRecord_sourceId_fkey` FOREIGN KEY (`sourceId`) REFERENCES `Source`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `LibraryWork` ADD CONSTRAINT `LibraryWork_monitorFolderId_fkey` FOREIGN KEY (`monitorFolderId`) REFERENCES `MonitorFolder`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `LibraryEdition` ADD CONSTRAINT `LibraryEdition_workId_fkey` FOREIGN KEY (`workId`) REFERENCES `LibraryWork`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `LibraryEdition` ADD CONSTRAINT `LibraryEdition_monitorFolderId_fkey` FOREIGN KEY (`monitorFolderId`) REFERENCES `MonitorFolder`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `LibraryVolume` ADD CONSTRAINT `LibraryVolume_editionId_fkey` FOREIGN KEY (`editionId`) REFERENCES `LibraryEdition`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `LibraryFile` ADD CONSTRAINT `LibraryFile_editionId_fkey` FOREIGN KEY (`editionId`) REFERENCES `LibraryEdition`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `LibraryFile` ADD CONSTRAINT `LibraryFile_volumeId_fkey` FOREIGN KEY (`volumeId`) REFERENCES `LibraryVolume`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ImportTask` ADD CONSTRAINT `ImportTask_monitorFolderId_fkey` FOREIGN KEY (`monitorFolderId`) REFERENCES `MonitorFolder`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ImportTask` ADD CONSTRAINT `ImportTask_workId_fkey` FOREIGN KEY (`workId`) REFERENCES `LibraryWork`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ImportTask` ADD CONSTRAINT `ImportTask_editionId_fkey` FOREIGN KEY (`editionId`) REFERENCES `LibraryEdition`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ImportTask` ADD CONSTRAINT `ImportTask_volumeId_fkey` FOREIGN KEY (`volumeId`) REFERENCES `LibraryVolume`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `OrganizeJob` ADD CONSTRAINT `OrganizeJob_workId_fkey` FOREIGN KEY (`workId`) REFERENCES `LibraryWork`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `OrganizeJob` ADD CONSTRAINT `OrganizeJob_editionId_fkey` FOREIGN KEY (`editionId`) REFERENCES `LibraryEdition`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `OrganizeJob` ADD CONSTRAINT `OrganizeJob_importTaskId_fkey` FOREIGN KEY (`importTaskId`) REFERENCES `ImportTask`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `MetadataSuggestion` ADD CONSTRAINT `MetadataSuggestion_jobId_fkey` FOREIGN KEY (`jobId`) REFERENCES `OrganizeJob`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `DuplicateCandidate` ADD CONSTRAINT `DuplicateCandidate_jobId_fkey` FOREIGN KEY (`jobId`) REFERENCES `OrganizeJob`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `DuplicateCandidate` ADD CONSTRAINT `DuplicateCandidate_targetWorkId_fkey` FOREIGN KEY (`targetWorkId`) REFERENCES `LibraryWork`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ImportLog` ADD CONSTRAINT `ImportLog_importTaskId_fkey` FOREIGN KEY (`importTaskId`) REFERENCES `ImportTask`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ReaderPreference` ADD CONSTRAINT `ReaderPreference_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ShelfWork` ADD CONSTRAINT `ShelfWork_shelfId_fkey` FOREIGN KEY (`shelfId`) REFERENCES `Shelf`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ShelfWork` ADD CONSTRAINT `ShelfWork_workId_fkey` FOREIGN KEY (`workId`) REFERENCES `LibraryWork`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `LibraryReadingUnit` ADD CONSTRAINT `LibraryReadingUnit_editionId_fkey` FOREIGN KEY (`editionId`) REFERENCES `LibraryEdition`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `LibraryReadingUnit` ADD CONSTRAINT `LibraryReadingUnit_volumeId_fkey` FOREIGN KEY (`volumeId`) REFERENCES `LibraryVolume`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `LibraryReadingUnit` ADD CONSTRAINT `LibraryReadingUnit_fileId_fkey` FOREIGN KEY (`fileId`) REFERENCES `LibraryFile`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `LibraryMetadata` ADD CONSTRAINT `LibraryMetadata_editionId_fkey` FOREIGN KEY (`editionId`) REFERENCES `LibraryEdition`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `LibraryReadingProgress` ADD CONSTRAINT `LibraryReadingProgress_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `LibraryReadingProgress` ADD CONSTRAINT `LibraryReadingProgress_workId_fkey` FOREIGN KEY (`workId`) REFERENCES `LibraryWork`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `LibraryReadingProgress` ADD CONSTRAINT `LibraryReadingProgress_editionId_fkey` FOREIGN KEY (`editionId`) REFERENCES `LibraryEdition`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `LibraryReadingProgress` ADD CONSTRAINT `LibraryReadingProgress_volumeId_fkey` FOREIGN KEY (`volumeId`) REFERENCES `LibraryVolume`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
