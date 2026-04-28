/**
 * subjectController.js
 *
 * updateSubject fix: findUnique moved outside $transaction.
 * Prisma interactive transactions don't reliably support findUnique
 * inside them in all versions — running it after the transaction
 * completes is simpler and guaranteed to work.
 *
 * Place this file at: src/controllers/subjectController.js
 */

const prisma = require("../utils/prisma");

// ─────────────────────────────────────────────
// Get all subjects
// ─────────────────────────────────────────────
const getAllSubjects = async (req, res) => {
  try {
    const subjects = await prisma.subject.findMany({
      include: {
        teachers: {
          include: {
            teacher: { select: { id: true, name: true, email: true } },
          },
        },
        enrollments: { include: { student: true } },
        schedules: true,
      },
      orderBy: { name: "asc" },
    });
    res.json(subjects);
  } catch (error) {
    console.error("Error fetching subjects:", error);
    res
      .status(500)
      .json({ message: "Failed to fetch subjects", error: error.message });
  }
};

// ─────────────────────────────────────────────
// Get subjects for a specific teacher
// ─────────────────────────────────────────────
const getTeacherSubjects = async (req, res) => {
  try {
    const teacherId = req.user.userId;
    const subjects = await prisma.subject.findMany({
      where: { teachers: { some: { teacherId } } },
      include: {
        teachers: {
          include: { teacher: { select: { id: true, name: true } } },
        },
        enrollments: { include: { student: true } },
        schedules: { orderBy: [{ dayOfWeek: "asc" }, { startTime: "asc" }] },
      },
      orderBy: { name: "asc" },
    });
    res.json(subjects);
  } catch (error) {
    console.error("Error fetching teacher subjects:", error);
    res
      .status(500)
      .json({ message: "Failed to fetch subjects", error: error.message });
  }
};

// ─────────────────────────────────────────────
// Create new subject
// Schedules are NOT set here — they are managed per section
// in the Enrollment tab via enrollSectionWithSchedule.
// ─────────────────────────────────────────────
const createSubject = async (req, res) => {
  try {
    const { name, code, description, teacherIds } = req.body;

    if (!name || !code) {
      return res.status(400).json({ message: "Name and code are required" });
    }

    const existingSubject = await prisma.subject.findUnique({
      where: { code },
    });
    if (existingSubject) {
      return res.status(400).json({ message: "Subject code already exists" });
    }

    const subject = await prisma.subject.create({
      data: {
        name,
        code,
        description,
        teachers: teacherIds
          ? { create: teacherIds.map((teacherId) => ({ teacherId })) }
          : undefined,
      },
      include: {
        teachers: {
          include: { teacher: { select: { id: true, name: true } } },
        },
        schedules: true,
      },
    });

    console.log("Subject created:", subject.name);
    res.status(201).json({ message: "Subject created successfully", subject });
  } catch (error) {
    console.error("Error creating subject:", error);
    res
      .status(500)
      .json({ message: "Failed to create subject", error: error.message });
  }
};

// ─────────────────────────────────────────────
// Update subject
// PUT /api/subjects/:id
//
// Updates name, code, description only.
// Schedules are managed per section via enrollSectionWithSchedule.
// ─────────────────────────────────────────────
const updateSubject = async (req, res) => {
  try {
    const subjectId = parseInt(req.params.id);
    const { name, code, description } = req.body;

    if (!name || !code) {
      return res
        .status(400)
        .json({ message: "Subject name and code are required" });
    }

    const existing = await prisma.subject.findUnique({
      where: { id: subjectId },
    });
    if (!existing) {
      return res.status(404).json({ message: "Subject not found" });
    }

    if (code.trim().toUpperCase() !== existing.code) {
      const codeConflict = await prisma.subject.findFirst({
        where: { code: code.trim().toUpperCase(), NOT: { id: subjectId } },
      });
      if (codeConflict) {
        return res.status(400).json({
          message: `Subject code "${code}" is already used by another subject.`,
        });
      }
    }

    await prisma.subject.update({
      where: { id: subjectId },
      data: {
        name: name.trim(),
        code: code.trim().toUpperCase(),
        description: description ? description.trim() : null,
      },
    });

    const updatedSubject = await prisma.subject.findUnique({
      where: { id: subjectId },
      include: {
        teachers: {
          include: {
            teacher: { select: { id: true, name: true, email: true } },
          },
        },
        enrollments: { include: { student: true } },
        schedules: true,
      },
    });

    console.log(
      `[Subject] ✅ Updated: ${updatedSubject.name} (${updatedSubject.code})`,
    );
    res.json({
      message: `Subject "${updatedSubject.name}" updated successfully`,
      subject: updatedSubject,
    });
  } catch (error) {
    console.error("[Subject] Update error:", error.message);
    res
      .status(500)
      .json({ message: "Failed to update subject", error: error.message });
  }
};

// ─────────────────────────────────────────────
// Delete subject — manual cascade
// ─────────────────────────────────────────────
const deleteSubject = async (req, res) => {
  try {
    const subjectId = parseInt(req.params.id);

    const subject = await prisma.subject.findUnique({
      where: { id: subjectId },
      select: { id: true, name: true, code: true },
    });
    if (!subject) {
      return res.status(404).json({ message: "Subject not found" });
    }

    console.log(`[Subject] Deleting: ${subject.name} (${subject.code})`);

    const sessions = await prisma.attendanceSession.findMany({
      where: { subjectId },
      select: { id: true },
    });
    const sessionIds = sessions.map((s) => s.id);

    if (sessionIds.length > 0) {
      await prisma.attendanceRecord.deleteMany({
        where: { sessionId: { in: sessionIds } },
      });
    }
    await prisma.attendanceSession.deleteMany({ where: { subjectId } });
    await prisma.enrollment.deleteMany({ where: { subjectId } });
    await prisma.subjectTeacher.deleteMany({ where: { subjectId } });
    await prisma.subjectSchedule.deleteMany({ where: { subjectId } });
    await prisma.subject.delete({ where: { id: subjectId } });

    console.log(`[Subject] ✅ Deleted: ${subject.name}`);
    res.json({ message: `Subject "${subject.name}" deleted successfully` });
  } catch (error) {
    console.error("[Subject] Delete error:", error.message);
    res
      .status(500)
      .json({ message: "Failed to delete subject", error: error.message });
  }
};

// ─────────────────────────────────────────────
// Assign teacher to subject
// ─────────────────────────────────────────────
const assignTeacher = async (req, res) => {
  try {
    const { subjectId, teacherId } = req.body;
    if (!subjectId || !teacherId) {
      return res
        .status(400)
        .json({ message: "Subject ID and Teacher ID are required" });
    }
    const assignment = await prisma.subjectTeacher.create({
      data: { subjectId: parseInt(subjectId), teacherId: parseInt(teacherId) },
    });
    res
      .status(201)
      .json({ message: "Teacher assigned successfully", assignment });
  } catch (error) {
    if (error.code === "P2002") {
      return res
        .status(400)
        .json({ message: "Teacher already assigned to this subject" });
    }
    console.error("Error assigning teacher:", error);
    res
      .status(500)
      .json({ message: "Failed to assign teacher", error: error.message });
  }
};

// ─────────────────────────────────────────────
// Remove teacher from subject
// ─────────────────────────────────────────────
const removeTeacher = async (req, res) => {
  try {
    const { subjectId, teacherId } = req.body;
    if (!subjectId || !teacherId) {
      return res
        .status(400)
        .json({ message: "Subject ID and Teacher ID are required" });
    }
    await prisma.subjectTeacher.deleteMany({
      where: { subjectId: parseInt(subjectId), teacherId: parseInt(teacherId) },
    });
    res.json({ message: "Teacher removed successfully" });
  } catch (error) {
    console.error("Error removing teacher:", error);
    res
      .status(500)
      .json({ message: "Failed to remove teacher", error: error.message });
  }
};

// ─────────────────────────────────────────────
// Enroll single student
// ─────────────────────────────────────────────
const enrollStudent = async (req, res) => {
  try {
    const { subjectId, studentId } = req.body;
    if (!subjectId || !studentId) {
      return res
        .status(400)
        .json({ message: "Subject ID and Student ID are required" });
    }
    const enrollment = await prisma.enrollment.create({
      data: { subjectId: parseInt(subjectId), studentId: parseInt(studentId) },
    });
    res
      .status(201)
      .json({ message: "Student enrolled successfully", enrollment });
  } catch (error) {
    if (error.code === "P2002") {
      return res
        .status(400)
        .json({ message: "Student already enrolled in this subject" });
    }
    console.error("Error enrolling student:", error);
    res
      .status(500)
      .json({ message: "Failed to enroll student", error: error.message });
  }
};

// ─────────────────────────────────────────────
// Enroll entire section
// ─────────────────────────────────────────────
const enrollSection = async (req, res) => {
  try {
    const { subjectId, section } = req.body;
    if (!subjectId || !section) {
      return res
        .status(400)
        .json({ message: "subjectId and section are required" });
    }

    const parsedSubjectId = parseInt(subjectId);
    const subject = await prisma.subject.findUnique({
      where: { id: parsedSubjectId },
      select: { id: true, name: true },
    });
    if (!subject) return res.status(404).json({ message: "Subject not found" });

    const students = await prisma.student.findMany({
      where: { section },
      select: { id: true },
    });
    if (students.length === 0) {
      return res
        .status(404)
        .json({ message: `No students found in section "${section}"` });
    }

    const existing = await prisma.enrollment.findMany({
      where: { subjectId: parsedSubjectId },
      select: { studentId: true },
    });
    const alreadyEnrolled = new Set(existing.map((e) => e.studentId));
    const toEnroll = students.filter((s) => !alreadyEnrolled.has(s.id));
    const skipped = students.length - toEnroll.length;

    if (toEnroll.length === 0) {
      return res.status(200).json({
        message: `All ${students.length} students in "${section}" are already enrolled.`,
        enrolled: 0,
        skipped,
        total: students.length,
      });
    }

    await prisma.enrollment.createMany({
      data: toEnroll.map((s) => ({
        subjectId: parsedSubjectId,
        studentId: s.id,
      })),
      skipDuplicates: true,
    });

    res.status(201).json({
      message: `${toEnroll.length} student(s) from "${section}" enrolled into "${subject.name}". ${skipped} already enrolled.`,
      enrolled: toEnroll.length,
      skipped,
      total: students.length,
    });
  } catch (error) {
    console.error("Error enrolling section:", error);
    res
      .status(500)
      .json({ message: "Failed to enroll section", error: error.message });
  }
};

// ─────────────────────────────────────────────
// Enroll entire section with a per-section schedule
// POST /api/subjects/enroll-section-schedule
// Body: { subjectId, section, schedules: [{dayOfWeek, startTime, endTime}] }
// ─────────────────────────────────────────────
const enrollSectionWithSchedule = async (req, res) => {
  try {
    const { subjectId, section, schedules } = req.body;
    if (!subjectId || !section) {
      return res
        .status(400)
        .json({ message: "subjectId and section are required" });
    }
    if (!schedules || schedules.length === 0) {
      return res
        .status(400)
        .json({ message: "At least one schedule is required" });
    }

    for (const s of schedules) {
      if (
        s.dayOfWeek === undefined ||
        s.dayOfWeek === null ||
        !s.startTime ||
        !s.endTime
      ) {
        return res.status(400).json({
          message: "Each schedule must have a day, start time, and end time",
        });
      }
      if (s.startTime >= s.endTime) {
        return res.status(400).json({
          message: `Start time must be before end time (${s.startTime} – ${s.endTime})`,
        });
      }
    }

    const parsedSubjectId = parseInt(subjectId);
    const subject = await prisma.subject.findUnique({
      where: { id: parsedSubjectId },
      select: { id: true, name: true },
    });
    if (!subject) return res.status(404).json({ message: "Subject not found" });

    // Check section isn't already enrolled (has schedules for this subject)
    const existingSchedules = await prisma.subjectSchedule.findFirst({
      where: { subjectId: parsedSubjectId, section },
    });
    if (existingSchedules) {
      return res.status(400).json({
        message: `Section "${section}" is already enrolled in this subject.`,
      });
    }

    const students = await prisma.student.findMany({
      where: { section },
      select: { id: true },
    });

    // Enroll students (skip already enrolled)
    const existing = await prisma.enrollment.findMany({
      where: { subjectId: parsedSubjectId },
      select: { studentId: true },
    });
    const alreadyEnrolled = new Set(existing.map((e) => e.studentId));
    const toEnroll = students.filter((s) => !alreadyEnrolled.has(s.id));

    if (toEnroll.length > 0) {
      await prisma.enrollment.createMany({
        data: toEnroll.map((s) => ({
          subjectId: parsedSubjectId,
          studentId: s.id,
        })),
        skipDuplicates: true,
      });
    }

    // Create section-specific schedules
    await prisma.subjectSchedule.createMany({
      data: schedules.map((s) => ({
        subjectId: parsedSubjectId,
        section,
        dayOfWeek: parseInt(s.dayOfWeek),
        startTime: s.startTime,
        endTime: s.endTime,
      })),
      skipDuplicates: true,
    });

    console.log(
      `[Subject] ✅ Section "${section}" enrolled into "${subject.name}" with ${schedules.length} schedule(s), ${toEnroll.length} new students`,
    );
    const studentMsg =
      students.length === 0
        ? "No students in section yet."
        : `${toEnroll.length} new student(s) added.`;
    res.status(201).json({
      message: `Section "${section}" enrolled into "${subject.name}". ${studentMsg} ${schedules.length} schedule(s) created.`,
      enrolled: toEnroll.length,
      skipped: students.length - toEnroll.length,
    });
  } catch (error) {
    console.error("Error enrolling section with schedule:", error);
    res
      .status(500)
      .json({ message: "Failed to enroll section", error: error.message });
  }
};

// ─────────────────────────────────────────────
// Remove an entire section from a subject
// POST /api/subjects/remove-section
// Body: { subjectId, section }
// Removes enrollments for students in that section + removes section schedules
// ─────────────────────────────────────────────
const removeSectionFromSubject = async (req, res) => {
  try {
    const { subjectId, section } = req.body;
    if (!subjectId || !section) {
      return res
        .status(400)
        .json({ message: "subjectId and section are required" });
    }

    const parsedSubjectId = parseInt(subjectId);

    // Find all students in the section
    const students = await prisma.student.findMany({
      where: { section },
      select: { id: true },
    });
    const studentIds = students.map((s) => s.id);

    // Remove their enrollments from this subject
    const removed = await prisma.enrollment.deleteMany({
      where: { subjectId: parsedSubjectId, studentId: { in: studentIds } },
    });

    // Remove all schedules for this section from the subject
    const deletedScheds = await prisma.subjectSchedule.deleteMany({
      where: { subjectId: parsedSubjectId, section },
    });

    console.log(
      `[Subject] ✅ Section "${section}" removed — ${removed.count} enrollments, ${deletedScheds.count} schedules deleted`,
    );
    res.json({
      message: `Section "${section}" removed. ${removed.count} enrollment(s) and ${deletedScheds.count} schedule(s) deleted.`,
    });
  } catch (error) {
    console.error("Error removing section:", error);
    res
      .status(500)
      .json({ message: "Failed to remove section", error: error.message });
  }
};

// ─────────────────────────────────────────────
// Remove student enrollment
// ─────────────────────────────────────────────
const removeEnrollment = async (req, res) => {
  try {
    const { subjectId, studentId } = req.body;
    await prisma.enrollment.deleteMany({
      where: { subjectId: parseInt(subjectId), studentId: parseInt(studentId) },
    });
    res.json({ message: "Student removed from subject successfully" });
  } catch (error) {
    console.error("Error removing enrollment:", error);
    res
      .status(500)
      .json({ message: "Failed to remove enrollment", error: error.message });
  }
};

module.exports = {
  getAllSubjects,
  getTeacherSubjects,
  createSubject,
  updateSubject,
  deleteSubject,
  assignTeacher,
  removeTeacher,
  enrollStudent,
  enrollSection,
  enrollSectionWithSchedule,
  removeSectionFromSubject,
  removeEnrollment,
};
