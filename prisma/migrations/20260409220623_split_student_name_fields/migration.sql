/*
  Warnings:

  - You are about to drop the column `name` on the `students` table. All the data in the column will be lost.
  - Added the required column `firstName` to the `students` table without a default value. This is not possible if the table is not empty.
  - Added the required column `surname` to the `students` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "students" DROP COLUMN "name",
ADD COLUMN     "firstName" TEXT NOT NULL,
ADD COLUMN     "middleInitial" TEXT,
ADD COLUMN     "surname" TEXT NOT NULL;
