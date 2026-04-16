/*
  Warnings:

  - A unique constraint covering the columns `[datasetName]` on the table `students` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "students" ADD COLUMN     "datasetName" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "students_datasetName_key" ON "students"("datasetName");
