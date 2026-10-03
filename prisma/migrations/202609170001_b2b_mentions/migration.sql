-- AlterTable
ALTER TABLE `Quote` ADD COLUMN `proClient` BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE `Invoice` ADD COLUMN `proClient` BOOLEAN NOT NULL DEFAULT false;
