-- CreateTable
CREATE TABLE `CalendarEntry` (
    `id` VARCHAR(191) NOT NULL,
    `source` VARCHAR(191) NOT NULL DEFAULT 'manual',
    `title` VARCHAR(191) NOT NULL,
    `detail` TEXT NULL,
    `date` VARCHAR(191) NOT NULL,
    `time` VARCHAR(191) NULL,
    `endTime` VARCHAR(191) NULL,
    `status` VARCHAR(191) NULL,
    `externalId` VARCHAR(191) NULL,
    `attendeeName` VARCHAR(191) NULL,
    `attendeeEmail` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `CalendarEntry_externalId_key`(`externalId`),
    INDEX `CalendarEntry_date_source_idx`(`date`, `source`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
