/**
 * importStudents.js — FaceCloud Bulk Student Import
 *
 * HOW TO USE:
 *   Step 1 — Copy students.csv from Pi to PC:
 *     scp pi@192.168.1.X:/home/pi/FaceCloudV2/database/students.csv C:\Users\YourName\Desktop\students.csv
 *
 *   Step 2 — Edit CSV_PATH below.
 *
 *   Step 3 — Install dependency (one time):
 *     npm install csv-parse
 *
 *   Step 4 — Run from your backend project folder:
 *     node importStudents.js
 *
 * Safe to re-run — students already in the database are skipped.
 */

require("dotenv").config();
const fs = require("fs");
const { PrismaClient } = require("@prisma/client");

let parse;
try {
  ({ parse } = require("csv-parse/sync"));
} catch {
  console.error("❌ csv-parse not found. Run: npm install csv-parse");
  process.exit(1);
}

const prisma = new PrismaClient();

// ─────────────────────────────────────────────
// EDIT THIS — path to your students.csv
// Windows:  "C:\\Users\\YourName\\Desktop\\students.csv"
// Mac/Linux: "/home/yourname/Desktop/students.csv"
// ─────────────────────────────────────────────
const CSV_PATH = "C:\\Users\\camil\\OneDrive\\Desktop\\students.csv";

const VALID_SECTIONS = [
  "BSCPE1-7",
  "BSCPE2-1",
  "BSCPE3-1",
  "BSCPE3-3",
  "BSCPE3-4",
  "BSCPE3-7",
  "BSCPE4-1",
  "BSCOE4-1P",
  "BSCOE4-3P",
  "TEST_SECTION",
];

function generateDatasetName(surname, studentId) {
  try {
    const parts = studentId.split("-");
    const last5 = parts[1].slice(-5);
    return `${surname.trim().toUpperCase()}_${last5}`;
  } catch {
    return null;
  }
}

function formatDisplay(surname, firstName, mi) {
  const miPart = mi ? ` ${mi.trim().toUpperCase()}.` : "";
  return `${surname.trim().toUpperCase()}, ${firstName.trim()}${miPart}`;
}

async function run() {
  console.log("\n╔══════════════════════════════════════════╗");
  console.log("║   FaceCloud — Bulk Student Import        ║");
  console.log("╚══════════════════════════════════════════╝\n");

  if (!fs.existsSync(CSV_PATH)) {
    console.error(`❌ File not found: ${CSV_PATH}`);
    console.error("   Edit CSV_PATH at the top of this script.");
    process.exit(1);
  }

  const raw = fs.readFileSync(CSV_PATH, "utf-8");
  let rows;
  try {
    rows = parse(raw, { columns: true, skip_empty_lines: true, trim: true });
  } catch (err) {
    console.error("❌ Failed to parse CSV:", err.message);
    process.exit(1);
  }

  console.log(`📄 CSV loaded — ${rows.length} rows\n`);

  const required = ["student_id", "surname", "firstname", "section"];
  const headers = Object.keys(rows[0] || {});
  const missing = required.filter((c) => !headers.includes(c));
  if (missing.length > 0) {
    console.error(`❌ CSV missing columns: ${missing.join(", ")}`);
    console.error(`   Found: ${headers.join(", ")}`);
    process.exit(1);
  }

  let imported = 0,
    skipped = 0,
    errors = 0;
  const skippedList = [],
    errorList = [];

  for (const row of rows) {
    const studentId = (row["student_id"] || "").trim();
    const surname = (row["surname"] || "").trim().toUpperCase();
    const firstName = (row["firstname"] || "").trim();
    const middleInitial =
      (row["middle_init"] || row["middle_initial"] || "")
        .trim()
        .toUpperCase() || null;
    const section = (row["section"] || "").trim();
    const csvDataset = (row["dataset_name"] || "").trim();

    const display =
      surname && firstName
        ? formatDisplay(surname, firstName, middleInitial)
        : studentId;

    if (!studentId || !surname || !firstName || !section) {
      errorList.push(`${display} — missing required field`);
      errors++;
      continue;
    }

    const idParts = studentId.split("-");
    if (idParts.length < 2 || !idParts[1]) {
      errorList.push(`${display} — invalid ID format: "${studentId}"`);
      errors++;
      continue;
    }

    if (!VALID_SECTIONS.includes(section)) {
      errorList.push(`${display} — unknown section "${section}"`);
      errors++;
      continue;
    }

    const datasetName =
      generateDatasetName(surname, studentId) || csvDataset || null;

    const existingById = await prisma.student.findUnique({
      where: { studentId },
    });
    if (existingById) {
      skippedList.push(`${display} (${studentId}) — already in database`);
      skipped++;
      continue;
    }

    if (datasetName) {
      const existingByDs = await prisma.student.findUnique({
        where: { datasetName },
      });
      if (existingByDs) {
        skippedList.push(
          `${display} — dataset name "${datasetName}" already used`,
        );
        skipped++;
        continue;
      }
    }

    try {
      await prisma.student.create({
        data: {
          studentId,
          surname,
          firstName,
          middleInitial,
          section,
          datasetName,
        },
      });
      console.log(`  ✅ ${display.padEnd(36)} | ${studentId} | ${section}`);
      imported++;
    } catch (err) {
      errorList.push(`${display} — DB error: ${err.message}`);
      errors++;
    }
  }

  console.log("\n╔══════════════════════════════════════════╗");
  console.log("║   Summary                                ║");
  console.log("╠══════════════════════════════════════════╣");
  console.log(`║   ✅ Imported : ${String(imported).padEnd(25)}║`);
  console.log(`║   ⏭  Skipped  : ${String(skipped).padEnd(25)}║`);
  console.log(`║   ❌ Errors   : ${String(errors).padEnd(25)}║`);
  console.log("╚══════════════════════════════════════════╝");

  if (skippedList.length > 0) {
    console.log("\n⏭  Skipped:");
    skippedList.forEach((s) => console.log(`   · ${s}`));
  }
  if (errorList.length > 0) {
    console.log("\n❌ Errors:");
    errorList.forEach((e) => console.log(`   · ${e}`));
  }

  if (imported > 0) {
    console.log(
      `\n✅ ${imported} students added. Next: enroll them in subjects via Manage Classes → Enrollments.`,
    );
  } else {
    console.log("\nℹ️  No new students to import.");
  }

  await prisma.$disconnect();
}

run().catch((err) => {
  console.error("❌ Fatal:", err.message);
  prisma.$disconnect();
  process.exit(1);
});
