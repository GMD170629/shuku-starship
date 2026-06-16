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
