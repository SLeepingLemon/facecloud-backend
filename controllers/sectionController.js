/**
 * sectionController.js
 * Manages the sections list — the single source of truth
 * for all valid sections across the web app and Pi.
 *
 * Place at: src/controllers/sectionController.js
 */

const prisma = require("../utils/prisma");

// Default sections — seeded on first fetch if table is empty
const DEFAULT_SECTIONS = [
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

// ─────────────────────────────────────────────
// Seed default sections if table is empty
// Called once on first GET /api/sections
// ─────────────────────────────────────────────
async function seedIfEmpty() {
  const count = await prisma.section.count();
  if (count === 0) {
    await prisma.section.createMany({
      data: DEFAULT_SECTIONS.map((name) => ({ name })),
      skipDuplicates: true,
    });
    console.log("[Sections] Seeded default sections");
  }
}

// ─────────────────────────────────────────────
// GET /api/sections
// Returns all sections ordered alphabetically
// ─────────────────────────────────────────────
const getSections = async (req, res) => {
  try {
    await seedIfEmpty();
    const sections = await prisma.section.findMany({
      orderBy: { name: "asc" },
    });
    res.json(sections.map((s) => s.name));
  } catch (error) {
    console.error("Error fetching sections:", error);
    res
      .status(500)
      .json({ message: "Failed to fetch sections", error: error.message });
  }
};

// ─────────────────────────────────────────────
// POST /api/sections
// Body: { name }
// Admin adds a new section
// ─────────────────────────────────────────────
const createSection = async (req, res) => {
  try {
    const { name } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ message: "Section name is required" });
    }

    const normalized = name.trim().toUpperCase();

    const existing = await prisma.section.findUnique({
      where: { name: normalized },
    });
    if (existing) {
      return res
        .status(409)
        .json({ message: `Section "${normalized}" already exists` });
    }

    const section = await prisma.section.create({ data: { name: normalized } });
    console.log(`[Sections] Created: ${section.name}`);
    res.status(201).json({ message: "Section created", section });
  } catch (error) {
    console.error("Error creating section:", error);
    res
      .status(500)
      .json({ message: "Failed to create section", error: error.message });
  }
};

// ─────────────────────────────────────────────
// DELETE /api/sections/:name
// Admin removes a section
// Blocked if students are still assigned to it
// ─────────────────────────────────────────────
const deleteSection = async (req, res) => {
  try {
    const name = decodeURIComponent(req.params.name).trim().toUpperCase();

    // Block deletion if students are in this section
    const studentCount = await prisma.student.count({
      where: { section: name },
    });
    if (studentCount > 0) {
      return res.status(400).json({
        message: `Cannot delete section "${name}" — ${studentCount} student(s) are still assigned to it.`,
        tip: "Move or delete those students first.",
      });
    }

    const existing = await prisma.section.findUnique({ where: { name } });
    if (!existing) {
      return res.status(404).json({ message: `Section "${name}" not found` });
    }

    await prisma.section.delete({ where: { name } });
    console.log(`[Sections] Deleted: ${name}`);
    res.json({ message: `Section "${name}" deleted` });
  } catch (error) {
    console.error("Error deleting section:", error);
    res
      .status(500)
      .json({ message: "Failed to delete section", error: error.message });
  }
};

module.exports = {
  getSections,
  createSection,
  deleteSection,
  DEFAULT_SECTIONS,
};
