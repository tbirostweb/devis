ALTER TABLE `Subscription` ADD COLUMN `vatBps` INTEGER NOT NULL DEFAULT 0;
ALTER TABLE `Subscription` ADD CONSTRAINT `Subscription_vat_check` CHECK (`vatBps` BETWEEN 0 AND 10000);
