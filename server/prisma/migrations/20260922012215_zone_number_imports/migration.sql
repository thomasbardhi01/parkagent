-- CreateTable
CREATE TABLE "zone_number_imports" (
    "zone_id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "method" TEXT NOT NULL,
    "source_name" TEXT NOT NULL,
    "imported_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "zone_number_imports_pkey" PRIMARY KEY ("zone_id")
);
