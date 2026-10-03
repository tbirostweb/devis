-- AlterTable
ALTER TABLE `User` ADD COLUMN `role` VARCHAR(191) NOT NULL DEFAULT 'admin';
ALTER TABLE `User` ADD COLUMN `referrerId` VARCHAR(191) NULL;

-- CreateIndex
CREATE INDEX `User_referrerId_idx` ON `User`(`referrerId`);

-- AddForeignKey
ALTER TABLE `User` ADD CONSTRAINT `User_referrerId_fkey` FOREIGN KEY (`referrerId`) REFERENCES `Referrer`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
