CREATE UNIQUE INDEX `LibraryReadingProgress_userId_editionId_volumeId_key`
    ON `LibraryReadingProgress`(`userId`, `editionId`, `volumeId`);

ALTER TABLE `LibraryReadingProgress` DROP INDEX `LibraryReadingProgress_userId_editionId_key`;
