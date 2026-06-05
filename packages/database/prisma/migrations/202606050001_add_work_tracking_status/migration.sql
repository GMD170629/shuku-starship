ALTER TABLE `LibraryWork`
  ADD COLUMN `publicationStatus` ENUM('UNKNOWN', 'ONGOING', 'COMPLETED', 'HIATUS', 'CANCELLED') NOT NULL DEFAULT 'UNKNOWN',
  ADD COLUMN `trackingStatus` ENUM('NOT_TRACKING', 'TRACKING', 'PAUSED', 'IGNORED') NOT NULL DEFAULT 'NOT_TRACKING',
  ADD COLUMN `localLatestVolume` DOUBLE NULL,
  ADD COLUMN `localLatestChapter` DOUBLE NULL,
  ADD COLUMN `localLatestTitle` VARCHAR(191) NULL,
  ADD COLUMN `localLatestAt` DATETIME(3) NULL;

CREATE INDEX `LibraryWork_publicationStatus_idx` ON `LibraryWork`(`publicationStatus`);
CREATE INDEX `LibraryWork_trackingStatus_idx` ON `LibraryWork`(`trackingStatus`);
