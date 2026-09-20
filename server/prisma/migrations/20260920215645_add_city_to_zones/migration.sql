-- AlterTable
ALTER TABLE "zone_loads" ADD COLUMN     "city" TEXT NOT NULL DEFAULT 'nyc';

-- AlterTable
ALTER TABLE "zones" ADD COLUMN     "city" TEXT NOT NULL DEFAULT 'nyc';
