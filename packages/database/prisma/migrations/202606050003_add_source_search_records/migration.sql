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

  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE UNIQUE INDEX `SourceSearchRecord_sourceId_externalId_key` ON `SourceSearchRecord`(`sourceId`, `externalId`);
CREATE INDEX `SourceSearchRecord_sourceId_idx` ON `SourceSearchRecord`(`sourceId`);
CREATE INDEX `SourceSearchRecord_providerType_idx` ON `SourceSearchRecord`(`providerType`);
CREATE INDEX `SourceSearchRecord_status_idx` ON `SourceSearchRecord`(`status`);
CREATE INDEX `SourceSearchRecord_title_idx` ON `SourceSearchRecord`(`title`);
CREATE INDEX `SourceSearchRecord_createdAt_idx` ON `SourceSearchRecord`(`createdAt`);

ALTER TABLE `SourceSearchRecord`
  ADD CONSTRAINT `SourceSearchRecord_sourceId_fkey`
  FOREIGN KEY (`sourceId`) REFERENCES `Source`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
