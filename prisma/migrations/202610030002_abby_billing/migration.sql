-- AlterTable
ALTER TABLE `Client` ADD COLUMN `abbyClientId` VARCHAR(191) NULL;

-- AlterTable
ALTER TABLE `Invoice` ADD COLUMN `abbyInvoiceId` VARCHAR(191) NULL;
ALTER TABLE `Invoice` ADD COLUMN `abbyNumber` VARCHAR(191) NULL;
ALTER TABLE `Invoice` ADD COLUMN `abbyStatus` VARCHAR(191) NULL;
ALTER TABLE `Invoice` ADD COLUMN `abbyTest` BOOLEAN NULL;
ALTER TABLE `Invoice` ADD COLUMN `abbyQuoteKey` VARCHAR(191) NULL;
ALTER TABLE `Invoice` ADD COLUMN `abbyPdfFetchedAt` DATETIME(3) NULL;
ALTER TABLE `Invoice` ADD COLUMN `lastSyncedAt` DATETIME(3) NULL;

-- CreateIndex
CREATE UNIQUE INDEX `Invoice_abbyInvoiceId_key` ON `Invoice`(`abbyInvoiceId`);
CREATE UNIQUE INDEX `Invoice_abbyQuoteKey_key` ON `Invoice`(`abbyQuoteKey`);
