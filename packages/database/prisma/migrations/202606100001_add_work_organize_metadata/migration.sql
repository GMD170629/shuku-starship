ALTER TABLE `LibraryWork`
  ADD COLUMN `seriesName` VARCHAR(191) NULL,
  ADD COLUMN `seriesIndex` DOUBLE NULL,
  ADD COLUMN `publishedYear` INTEGER NULL,
  ADD COLUMN `metadataQuality` INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN `organizeStatus` ENUM('PENDING', 'REVIEWING', 'APPLIED', 'DISMISSED', 'FAILED') NOT NULL DEFAULT 'REVIEWING',
  ADD COLUMN `organized` BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX `LibraryWork_seriesName_idx` ON `LibraryWork`(`seriesName`);
CREATE INDEX `LibraryWork_publishedYear_idx` ON `LibraryWork`(`publishedYear`);
CREATE INDEX `LibraryWork_organizeStatus_idx` ON `LibraryWork`(`organizeStatus`);
CREATE INDEX `LibraryWork_organized_idx` ON `LibraryWork`(`organized`);
