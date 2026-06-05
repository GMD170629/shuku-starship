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

  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE INDEX `Source_enabled_idx` ON `Source`(`enabled`);
CREATE INDEX `Source_kind_idx` ON `Source`(`kind`);
CREATE INDEX `Source_providerType_idx` ON `Source`(`providerType`);
CREATE INDEX `Source_priority_idx` ON `Source`(`priority`);
