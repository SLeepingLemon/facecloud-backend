/**
 * apiRoutes.js
 *
 * All API routes for the FaceCloud system.
 * Added: POST /students/bulk-import — bulk insert students from CSV upload.
 *
 * CRITICAL ROUTE ORDER RULE:
 * Fixed-string routes MUST come before parameterized routes (/:id).
 * e.g. /students/bulk-import must be declared before /students/:id
 *
 * Place this file at: src/routes/apiRoutes.js
 */

const express = require("express");
const router = express.Router();
const jwt = require("jsonwebtoken");
const { authenticate, authorize } = require("../middleware/authMiddleware");
const prisma = require("../utils/prisma");

const studentController = require("../controllers/studentController");
const subjectController = require("../controllers/subjectController");
const attendanceController = require("../controllers/attendanceController");
const sectionController = require("../controllers/sectionController");

// ─────────────────────────────────────────────
// STATS — Admin Dashboard counters
// ─────────────────────────────────────────────
router.get("/stats", authenticate, authorize(["ADMIN"]), async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const [teacherCount, studentCount, subjectCount, todaySessionCount] =
      await Promise.all([
        prisma.user.count({ where: { role: "TEACHER" } }),
        prisma.student.count(),
        prisma.subject.count(),
        prisma.attendanceSession.count({
          where: { date: { gte: today, lt: tomorrow } },
        }),
      ]);

    res.json({
      teachers: teacherCount,
      students: studentCount,
      subjects: subjectCount,
      todaySessions: todaySessionCount,
    });
  } catch (error) {
    console.error("Error fetching stats:", error);
    res
      .status(500)
      .json({ message: "Failed to fetch stats", error: error.message });
  }
});

// ─────────────────────────────────────────────
// SECTIONS
// ─────────────────────────────────────────────
router.get("/sections", authenticate, sectionController.getSections);
router.post(
  "/sections",
  authenticate,
  authorize(["ADMIN"]),
  sectionController.createSection,
);
router.delete(
  "/sections/:name",
  authenticate,
  authorize(["ADMIN"]),
  sectionController.deleteSection,
);

// ─────────────────────────────────────────────
// STUDENTS
//
// ORDER: fixed-string routes BEFORE /:id
//   /students/bulk-import  must come before  /students/:id
// ─────────────────────────────────────────────

// Fixed-string student routes
router.get(
  "/students",
  authenticate,
  authorize(["ADMIN"]),
  studentController.getAllStudents,
);
router.post(
  "/students/bulk-import",
  authenticate,
  authorize(["ADMIN"]),
  studentController.bulkImport,
);
router.post(
  "/students",
  authenticate,
  authorize(["ADMIN"]),
  studentController.createStudent,
);

// Parameterized student routes (LAST)
router.put(
  "/students/:id",
  authenticate,
  authorize(["ADMIN"]),
  studentController.updateStudent,
);
router.delete(
  "/students/:id",
  authenticate,
  authorize(["ADMIN"]),
  studentController.deleteStudent,
);

// ─────────────────────────────────────────────
// SUBJECTS
//
// ORDER: fixed-string routes BEFORE /:id
// ─────────────────────────────────────────────

router.get(
  "/subjects/teacher",
  authenticate,
  authorize(["TEACHER"]),
  subjectController.getTeacherSubjects,
);
router.get("/subjects", authenticate, subjectController.getAllSubjects);

router.post(
  "/subjects/assign-teacher",
  authenticate,
  authorize(["ADMIN"]),
  subjectController.assignTeacher,
);
router.post(
  "/subjects/remove-teacher",
  authenticate,
  authorize(["ADMIN"]),
  subjectController.removeTeacher,
);
router.post(
  "/subjects/enroll-student",
  authenticate,
  authorize(["ADMIN"]),
  subjectController.enrollStudent,
);
router.post(
  "/subjects/enroll-section",
  authenticate,
  authorize(["ADMIN"]),
  subjectController.enrollSection,
);
router.post(
  "/subjects",
  authenticate,
  authorize(["ADMIN"]),
  subjectController.createSubject,
);

router.delete(
  "/subjects/remove-enrollment",
  authenticate,
  authorize(["ADMIN"]),
  subjectController.removeEnrollment,
);

// Parameterized subject routes (LAST)
router.put(
  "/subjects/:id",
  authenticate,
  authorize(["ADMIN"]),
  subjectController.updateSubject,
);
router.delete(
  "/subjects/:id",
  authenticate,
  authorize(["ADMIN"]),
  subjectController.deleteSubject,
);

// ─────────────────────────────────────────────
// ATTENDANCE
// ─────────────────────────────────────────────

// SSE Stream — token via query param (EventSource can't set headers)
router.get(
  "/attendance/stream/:sessionId",
  (req, res, next) => {
    const token = req.query.token;
    if (!token) return res.status(401).json({ message: "No token provided" });
    try {
      req.user = jwt.verify(token, process.env.JWT_SECRET);
      next();
    } catch {
      return res.status(401).json({ message: "Invalid token" });
    }
  },
  attendanceController.streamSession,
);

router.post(
  "/attendance/session",
  authenticate,
  authorize(["TEACHER", "ADMIN"]),
  attendanceController.createSession,
);

router.put(
  "/attendance/session/:sessionId/end",
  authenticate,
  authorize(["TEACHER", "ADMIN"]),
  attendanceController.endSession,
);

router.get(
  "/attendance/session/:subjectId",
  authenticate,
  authorize(["TEACHER", "ADMIN"]),
  attendanceController.getOngoingSession,
);

router.put(
  "/attendance/record/:recordId",
  authenticate,
  authorize(["TEACHER", "ADMIN"]),
  attendanceController.updateAttendance,
);

router.get(
  "/attendance/report/:subjectId",
  authenticate,
  authorize(["TEACHER", "ADMIN"]),
  attendanceController.getSubjectReport,
);

module.exports = router;
