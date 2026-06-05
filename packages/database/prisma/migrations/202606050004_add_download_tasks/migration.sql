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

  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE INDEX `DownloadTask_sourceId_idx` ON `DownloadTask`(`sourceId`);
CREATE INDEX `DownloadTask_searchRecordId_idx` ON `DownloadTask`(`searchRecordId`);
CREATE INDEX `DownloadTask_bookId_idx` ON `DownloadTask`(`bookId`);
CREATE INDEX `DownloadTask_type_idx` ON `DownloadTask`(`type`);
CREATE INDEX `DownloadTask_status_createdAt_idx` ON `DownloadTask`(`status`, `createdAt`);
