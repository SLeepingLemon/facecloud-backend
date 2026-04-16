/**
 * piRoutes.js
 * Routes exclusively for the Raspberry Pi device.
 * Authentication uses a shared device API key header (X-Device-Key)
 * instead of JWT — the Pi is a device, not a human user.
 *
 * Place this file at: src/routes/piRoutes.js
 */

const express = require("express");
const router = express.Router();
const piController = require("../controllers/piController");

// ─────────────────────────────────────────────
// Device key middleware
// Pi must send header:  X-Device-Key: <PI_DEVICE_KEY from .env>
// ─────────────────────────────────────────────
const authenticatePi = (req, res, next) => {
  const key = req.headers["x-device-key"];
  const expected = process.env.PI_DEVICE_KEY;

  // DEBUG — logs what the Pi actually sends vs what .env has
  console.log("[PI AUTH] Received key :", JSON.stringify(key));
  console.log("[PI AUTH] Expected key :", JSON.stringify(expected));
  console.log("[PI AUTH] Match        :", key === expected);

  if (!key || key !== expected) {
    console.warn("[PI] Rejected — invalid or missing device key");
    return res.status(401).json({ message: "Unauthorized device" });
  }
  next();
};

// ─────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────

/**
 * GET /api/pi/active-subject?codes=CPE305,CPE401
 *
 * Pi sends its configured subject codes (comma-separated).
 * Backend checks which one has an active schedule RIGHT NOW,
 * auto-creates the session if needed, and returns session info.
 *
 * Pi calls this on startup and every 30 seconds.
 */
router.get("/active-subject", authenticatePi, piController.getActiveSubject);

/**
 * GET /api/pi/schedules?codes=T1TE,CPE305
 *
 * Returns all schedules for the given subject codes in schedule.csv
 * format (day, start, end, section, subject, subject_code).
 * The Pi writes this to schedule.csv on startup and periodically,
 * keeping the local file in sync with the web app.
 */
router.get("/schedules", authenticatePi, piController.getSchedules);

/**
 * POST /api/pi/recognize
 *
 * Pi sends a recognition event after a confident face match.
 * Body: { datasetName, confidence, sessionId, timestamp }
 */
router.post("/recognize", authenticatePi, piController.handleRecognition);

/**
 * POST /api/pi/register-student
 *
 * Called by register_student.py after face capture completes.
 * Creates the student record in the web app database automatically.
 * Body: { studentId, surname, firstName, middleInitial, section, datasetName }
 */
router.post("/register-student", authenticatePi, piController.registerStudent);

/**
 * GET /api/pi/sections-list
 * Returns current valid sections from the DB.
 * register_student.py calls this on startup.
 */
router.get("/sections-list", authenticatePi, piController.getSectionsList);

/**
 * GET /api/pi/all-subjects
 * Returns all subject codes in the system.
 * Bridge fetches this on startup so SUBJECT_CODES
 * never needs to be hardcoded.
 */
router.get("/all-subjects", authenticatePi, piController.getAllSubjectCodes);

/**
 * GET /api/pi/session-at-time?codes=T1TE&timestamp=2026-04-13T09:05:00Z
 * Returns the session that was active at the given timestamp.
 * Used by the offline queue drain to replay missed scans correctly.
 */
router.get("/session-at-time", authenticatePi, piController.getSessionAtTime);

module.exports = router;
