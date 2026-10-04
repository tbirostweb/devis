-- Durcissement sécurité (audit 04/10/2026). Migration additive uniquement : aucune colonne supprimée,
-- aucune donnée réécrite. Sauvegarder la base avant `prisma migrate deploy` (voir docs/DOKPLOY.md).

-- AlterTable
ALTER TABLE `User` ADD COLUMN `totpLastCounter` INTEGER NULL;

-- AlterTable
ALTER TABLE `Invoice` ADD COLUMN `abbySyncState` VARCHAR(191) NULL;
ALTER TABLE `Invoice` ADD COLUMN `abbySyncLockedUntil` DATETIME(3) NULL;

-- AlterTable
ALTER TABLE `CalendarEntry` ADD COLUMN `lastEventAt` DATETIME(3) NULL;

-- CreateTable
CREATE TABLE `TotpRecoveryCode` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `codeHash` VARCHAR(191) NOT NULL,
    `usedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `TotpRecoveryCode_codeHash_key`(`codeHash`),
    INDEX `TotpRecoveryCode_userId_idx`(`userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `TotpRecoveryCode` ADD CONSTRAINT `TotpRecoveryCode_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
