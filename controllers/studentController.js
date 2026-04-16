/**
 * studentController.js
 *
 * Functions:
 *   getAllStudents   — fetch all students ordered by surname
 *   createStudent   — add one student, auto-generates datasetName
 *   updateStudent   — update fields, re-generates datasetName if surname changes
 *   deleteStudent   — delete one student
 *   bulkImport      — POST /api/students/bulk-import
 *                     Accepts an array of student rows parsed from CSV.
 *                     Validates, generates datasetName, skips duplicates,
 *                     and returns a detailed summary.
 *
 * Place this file at: src/controllers/studentController.js
 */

const prisma = require("../utils/prisma");

// ─────────────────────────────────────────────
// Constants — must match register_student.py and ManageClasses.jsx
// ─────────────────────────────────────────────
// Sections are now managed in the DB via sectionController.
const { DEFAULT_SECTIONS } = require("./sectionController");

async function getValidSections() {
  try {
    const sections = await prisma.section.findMany({
      orderBy: { name: "asc" },
    });
    if (sections.length > 0) return sections.map((s) => s.name);
    return DEFAULT_SECTIONS;
  } catch {
    return DEFAULT_SECTIONS;
  }
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────
function generateDatasetName(surname, studentId) {
  try {
    const parts = studentId.split("-");
    const last5 = parts[1].slice(-5);
    return `${surname.trim().toUpperCase()}_${last5}`;
  } catch {
    return null;
  }
}

function formatDisplayName(surname, firstName, middleInitial) {
  const mi = middleInitial ? ` ${middleInitial.trim().toUpperCase()}.` : "";
  return `${surname.trim().toUpperCase()}, ${firstName.trim()}${mi}`;
}

// ─────────────────────────────────────────────
// Get all students
// ─────────────────────────────────────────────
const getAllStudents = async (req, res) => {
  try {
    const students = await prisma.student.findMany({
      orderBy: [{ surname: "asc" }, { firstName: "asc" }],
    });
    res.json(students);
  } catch (error) {
    console.error("Error fetching students:", error);
    res
      .status(500)
      .json({ message: "Failed to fetch students", error: error.message });
  }
};

// ─────────────────────────────────────────────
// Create one student
// ─────────────────────────────────────────────
const createStudent = async (req, res) => {
  try {
    const { studentId, surname, firstName, middleInitial, section } = req.body;

    if (!studentId || !surname || !firstName || !section) {
      return res
        .status(400)
        .json({
          message: "studentId, surname, firstName, and section are required",
        });
    }

    const validSections = await getValidSections();
    if (!validSections.includes(section)) {
      return res
        .status(400)
        .json({
          message: `Invalid section. Must be one of: ${validSections.join(", ")}`,
        });
    }

    const idParts = studentId.split("-");
    if (idParts.length < 2 || idParts[1].length < 1) {
      return res
        .status(400)
        .json({
          message: "Invalid Student ID format. Expected: YYYY-NNNNN-MN-N",
        });
    }

    const existingById = await prisma.student.findUnique({
      where: { studentId },
    });
    if (existingById) {
      return res
        .status(400)
        .json({ message: "A student with this Student ID already exists" });
    }

    const datasetName = generateDatasetName(surname, studentId);
    if (!datasetName) {
      return res
        .status(400)
        .json({
          message: "Could not generate dataset name. Check Student ID format.",
        });
    }

    const existingByDataset = await prisma.student.findUnique({
      where: { datasetName },
    });
    if (existingByDataset) {
      return res
        .status(400)
        .json({
          message: `Dataset name "${datasetName}" is already registered.`,
        });
    }

    const student = await prisma.student.create({
      data: {
        studentId: studentId.trim(),
        surname: surname.trim().toUpperCase(),
        firstName: firstName.trim(),
        middleInitial: middleInitial
          ? middleInitial.trim().toUpperCase()
          : null,
        section: section.trim(),
        datasetName,
      },
    });

    const displayName = formatDisplayName(
      student.surname,
      student.firstName,
      student.middleInitial,
    );
    console.log(
      `[Student] Created: ${displayName} | ${student.studentId} | ${student.datasetName}`,
    );

    res
      .status(201)
      .json({
        message: "Student created successfully",
        student,
        displayName,
        datasetName,
      });
  } catch (error) {
    console.error("Error creating student:", error);
    res
      .status(500)
      .json({ message: "Failed to create student", error: error.message });
  }
};

// ─────────────────────────────────────────────
// Update student
// ─────────────────────────────────────────────
const updateStudent = async (req, res) => {
  try {
    const { id } = req.params;
    const { surname, firstName, middleInitial, section } = req.body;

    if (section) {
      const validSections = await getValidSections();
      if (!validSections.includes(section)) {
        return res
          .status(400)
          .json({
            message: `Invalid section. Must be one of: ${validSections.join(", ")}`,
          });
      }
    }

    const current = await prisma.student.findUnique({
      where: { id: parseInt(id) },
    });
    if (!current) return res.status(404).json({ message: "Student not found" });

    const newSurname = surname ? surname.trim().toUpperCase() : current.surname;
    const newDatasetName = generateDatasetName(newSurname, current.studentId);

    if (newDatasetName && newDatasetName !== current.datasetName) {
      const conflict = await prisma.student.findFirst({
        where: { datasetName: newDatasetName, NOT: { id: parseInt(id) } },
      });
      if (conflict) {
        return res
          .status(400)
          .json({
            message: `Dataset name "${newDatasetName}" is already used by another student.`,
          });
      }
    }

    const student = await prisma.student.update({
      where: { id: parseInt(id) },
      data: {
        ...(surname && { surname: surname.trim().toUpperCase() }),
        ...(firstName && { firstName: firstName.trim() }),
        ...(middleInitial !== undefined && {
          middleInitial: middleInitial
            ? middleInitial.trim().toUpperCase()
            : null,
        }),
        ...(section && { section }),
        datasetName: newDatasetName,
      },
    });

    res.json({ message: "Student updated successfully", student });
  } catch (error) {
    console.error("Error updating student:", error);
    res
      .status(500)
      .json({ message: "Failed to update student", error: error.message });
  }
};

// ─────────────────────────────────────────────
// Delete student
// ─────────────────────────────────────────────
const deleteStudent = async (req, res) => {
  try {
    const { id } = req.params;
    await prisma.student.delete({ where: { id: parseInt(id) } });
    res.json({ message: "Student deleted successfully" });
  } catch (error) {
    console.error("Error deleting student:", error);
    res
      .status(500)
      .json({ message: "Failed to delete student", error: error.message });
  }
};

// ─────────────────────────────────────────────
// Bulk import from CSV
// POST /api/students/bulk-import
//
// Body: { students: [ { student_id, surname, firstname, middle_init, section, dataset_name }, ... ] }
//
// The frontend parses the CSV and sends the rows as JSON.
// Each row is validated, datasetName is generated/verified,
// duplicates are skipped, and a summary is returned.
// ─────────────────────────────────────────────
const bulkImport = async (req, res) => {
  try {
    const { students: rows } = req.body;

    if (!rows || !Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ message: "No student rows provided" });
    }

    console.log(`[BulkImport] Starting import of ${rows.length} row(s)`);

    const results = {
      imported: [],
      skipped: [],
      errors: [],
    };

    for (const row of rows) {
      const studentId = (row["student_id"] || row["studentId"] || "").trim();
      const surname = (row["surname"] || "").trim().toUpperCase();
      const firstName = (row["firstname"] || row["firstName"] || "").trim();
      const middleInitial =
        (
          row["middle_init"] ||
          row["middle_initial"] ||
          row["middleInitial"] ||
          ""
        )
          .trim()
          .toUpperCase() || null;
      const section = (row["section"] || "").trim();
      const csvDataset = (
        row["dataset_name"] ||
        row["datasetName"] ||
        ""
      ).trim();

      const displayName =
        surname && firstName
          ? formatDisplayName(surname, firstName, middleInitial)
          : studentId;

      // ── Validate required fields ──
      if (!studentId || !surname || !firstName || !section) {
        results.errors.push({
          row: displayName || studentId,
          reason:
            "Missing required field (student_id, surname, firstname, or section)",
        });
        continue;
      }

      // ── Validate student ID format ──
      const idParts = studentId.split("-");
      if (idParts.length < 2 || !idParts[1]) {
        results.errors.push({
          row: displayName,
          reason: `Invalid Student ID format: "${studentId}"`,
        });
        continue;
      }

      // ── Validate section ──
      const validSections = await getValidSections();
      if (!validSections.includes(section)) {
        results.errors.push({
          row: displayName,
          reason: `Unknown section "${section}"`,
        });
        continue;
      }

      // ── Generate dataset name ──
      const generated = generateDatasetName(surname, studentId);
      const finalDataset = generated || csvDataset || null;

      // ── Check duplicate student ID ──
      const existingById = await prisma.student.findUnique({
        where: { studentId },
      });
      if (existingById) {
        results.skipped.push({
          row: displayName,
          reason: "Student ID already exists",
        });
        continue;
      }

      // ── Check duplicate dataset name ──
      if (finalDataset) {
        const existingByDataset = await prisma.student.findUnique({
          where: { datasetName: finalDataset },
        });
        if (existingByDataset) {
          results.skipped.push({
            row: displayName,
            reason: `Dataset name "${finalDataset}" already used`,
          });
          continue;
        }
      }

      // ── Insert ──
      try {
        const student = await prisma.student.create({
          data: {
            studentId,
            surname,
            firstName,
            middleInitial: middleInitial || null,
            section,
            datasetName: finalDataset,
          },
        });
        results.imported.push({
          name: displayName,
          studentId,
          datasetName: finalDataset,
          section,
        });
        console.log(`[BulkImport] ✅ ${displayName} | ${studentId}`);
      } catch (err) {
        results.errors.push({ row: displayName, reason: err.message });
      }
    }

    console.log(
      `[BulkImport] Done — imported: ${results.imported.length}, skipped: ${results.skipped.length}, errors: ${results.errors.length}`,
    );

    res.status(200).json({
      message: `Import complete. ${results.imported.length} imported, ${results.skipped.length} skipped, ${results.errors.length} errors.`,
      imported: results.imported.length,
      skipped: results.skipped.length,
      errors: results.errors.length,
      details: results,
    });
  } catch (error) {
    console.error("[BulkImport] Error:", error);
    res
      .status(500)
      .json({ message: "Bulk import failed", error: error.message });
  }
};

module.exports = {
  getAllStudents,
  createStudent,
  updateStudent,
  deleteStudent,
  bulkImport,

  formatDisplayName,
};
