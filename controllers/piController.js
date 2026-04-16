/**
 * piController.js
 *
 * Bug fixed: autoCloseExpiredSessions() now compares current time
 * against session.scheduledEnd directly — NOT against the subject's
 * schedule rows.
 *
 * Why this matters with multiple schedules:
 *   Subject CPE305 has two schedules today:
 *     Schedule A: 08:00 – 10:00
 *     Schedule B: 13:00 – 15:00
 *
 *   OLD (buggy): At 10:01, checks ALL of today's schedules.
 *     Finds Schedule A ended (10:00 < 10:01) → closes the session.
 *     BUT if it's now 13:30 and Session B is ongoing, the same check
 *     would also find Schedule A ended and wrongly close Session B.
 *
 *   NEW (fixed): Each session stores its own scheduledEnd when created.
 *     At 10:01 → Session A's scheduledEnd is 10:00 → close it. ✅
 *     At 13:30 → Session B's scheduledEnd is 15:00 → leave it open. ✅
 *     The session's own scheduledEnd is the single source of truth.
 *
 * Place this file at: src/controllers/piController.js
 */

const prisma = require("../utils/prisma");
const { broadcast } = require("../utils/sseManager");

const MIN_CONFIDENCE = parseFloat(process.env.PI_MIN_CONFIDENCE || "0.62");
const LATE_THRESHOLD_MIN = parseInt(process.env.LATE_THRESHOLD_MINUTES || "15");

// ─────────────────────────────────────────────
// Helper — format display name from separate fields
// Output: "DELA CRUZ, Juan R."
// ─────────────────────────────────────────────
function formatDisplayName(student) {
  const mi = student.middleInitial
    ? ` ${student.middleInitial.trim().toUpperCase()}.`
    : "";
  return `${student.surname.trim().toUpperCase()}, ${student.firstName.trim()}${mi}`;
}

// ─────────────────────────────────────────────
// Helper — convert Date to "HH:MM" string
// ─────────────────────────────────────────────
// ─────────────────────────────────────────────
// Timezone helpers
//
// IMPORTANT: All schedule comparisons use the SERVER'S LOCAL TIME.
// If your backend runs on Windows with Philippine timezone (UTC+8)
// this works correctly. If the server is UTC, schedules set in the
// web app (which uses local browser time) will be off by 8 hours.
//
// The TZ_OFFSET_HOURS constant below lets you correct for this.
// Set it to 0 if server and web app are in the same timezone.
// Set it to 8 if server is UTC but schedules are set in UTC+8.
// ─────────────────────────────────────────────
// TZ_OFFSET_HOURS — auto-detected from TZ environment variable.
// On Render (UTC server) with Philippine schedules (UTC+8), this is 8.
// Setting TZ=Asia/Manila in Render env vars makes this 0.
// If TZ env var is set, we rely on the OS timezone (preferred).
// If not, we fall back to manual offset — set PI_TZ_OFFSET in .env if needed.
const TZ_OFFSET_HOURS = parseInt(process.env.PI_TZ_OFFSET || "0");

function getLocalNow() {
  const now = new Date();
  if (TZ_OFFSET_HOURS === 0) return now;
  return new Date(now.getTime() + TZ_OFFSET_HOURS * 60 * 60 * 1000);
}

function toHHMM(date) {
  // Zero-pad hours and minutes for reliable string comparison
  const h = String(date.getHours()).padStart(2, "0");
  const m = String(date.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

function todayDayOfWeek() {
  return getLocalNow().getDay();
}

// ─────────────────────────────────────────────
// Helper — build full DateTime objects from a schedule row + today's date
// ─────────────────────────────────────────────
function buildScheduleDateTimes(schedule) {
  const localNow = getLocalNow();
  // Build date string from local time (not UTC)
  const year = localNow.getFullYear();
  const month = String(localNow.getMonth() + 1).padStart(2, "0");
  const day = String(localNow.getDate()).padStart(2, "0");
  const dateStr = `${year}-${month}-${day}`;
  const scheduledStart = new Date(`${dateStr}T${schedule.startTime}:00`);
  const scheduledEnd = new Date(`${dateStr}T${schedule.endTime}:00`);
  return { scheduledStart, scheduledEnd };
}

// ─────────────────────────────────────────────
// autoCloseExpiredSessions
//
// FIX: Uses session.scheduledEnd (stored on the session itself)
// to determine if a session has ended — NOT the subject's schedule rows.
//
// This means:
//   - Session A (08:00–10:00) closes when now > 10:00. ✅
//   - Session B (13:00–15:00) is NOT closed just because 10:00 passed. ✅
//   - Each session is evaluated independently using its own end time.
// ─────────────────────────────────────────────
async function autoCloseExpiredSessions(subjectIds) {
  const now = new Date();

  // Find all ONGOING sessions for these subjects
  const ongoingSessions = await prisma.attendanceSession.findMany({
    where: {
      subjectId: { in: subjectIds },
      status: "ONGOING",
    },
    // No need to include subject.schedules anymore —
    // we use session.scheduledEnd directly
    select: {
      id: true,
      subjectId: true,
      scheduledEnd: true,
    },
  });

  for (const session of ongoingSessions) {
    const sessionScheduledEnd = new Date(session.scheduledEnd);

    // Only close if NOW is past THIS session's own scheduled end time
    if (now > sessionScheduledEnd) {
      console.log(
        `[PI] Auto-closing session ${session.id} — ` +
          `scheduledEnd ${toHHMM(sessionScheduledEnd)} has passed (now ${toHHMM(now)})`,
      );

      // Mark all PENDING (unscanned) students as ABSENT
      // Only targets PENDING — never overwrites PRESENT or LATE
      const updatedRecords = await prisma.attendanceRecord.updateMany({
        where: {
          sessionId: session.id,
          status: "PENDING",
        },
        data: {
          status: "ABSENT",
          remarks: "Not scanned — auto-marked absent at session end",
        },
      });

      // Close the session
      await prisma.attendanceSession.update({
        where: { id: session.id },
        data: {
          status: "COMPLETED",
          actualEnd: now,
        },
      });

      console.log(
        `[PI] ✅ Session ${session.id} closed. ` +
          `${updatedRecords.count} students marked ABSENT.`,
      );

      // Notify the TeacherDashboard via SSE
      broadcast(session.id, "session_ended", {
        sessionId: session.id,
        absentCount: updatedRecords.count,
        endedAt: now,
      });
    }
    // else: session's scheduledEnd hasn't passed yet — leave it ONGOING
  }
}

// ─────────────────────────────────────────────
// GET /api/pi/active-subject?codes=CPE305,CPE401
//
// Called by the Pi every 30 seconds to find the active session.
// Flow:
//   1. Run autoCloseExpiredSessions first (cleanup any finished sessions)
//   2. Find a subject whose schedule window contains NOW
//   3. If session already ONGOING for that subject → return it
//   4. If no session yet → auto-create one with all enrolled students as ABSENT
// ─────────────────────────────────────────────
const getActiveSubject = async (req, res) => {
  try {
    const codesParam = req.query.codes;
    if (!codesParam) {
      return res
        .status(400)
        .json({ message: "Query param 'codes' is required" });
    }

    const codes = codesParam.split(",").map((c) => c.trim().toUpperCase());
    const now = getLocalNow();
    const nowHHMM = toHHMM(now);
    const today = todayDayOfWeek();

    // Only log schedule checks once per minute to avoid terminal spam
    // Still logs on first check and whenever day/hour changes
    const _checkKey = `${today}-${nowHHMM.slice(0, 2)}`; // day + hour
    if (!global._lastScheduleLog || global._lastScheduleLog !== _checkKey) {
      global._lastScheduleLog = _checkKey;
      console.log(
        `[PI] Schedule check — server time: ${nowHHMM} | dayOfWeek: ${today} (0=Sun,6=Sat) | codes: ${codes}`,
      );
    }

    // Fetch all subjects matching the provided codes
    const subjects = await prisma.subject.findMany({
      where: { code: { in: codes } },
      include: { schedules: true, enrollments: true },
    });

    if (subjects.length === 0) {
      return res.status(404).json({
        message:
          "No subjects found for the provided codes. " +
          "Make sure the codes match exactly what is in the web app.",
        codes,
      });
    }

    // Step 1 — Auto-close any sessions that have passed their scheduledEnd
    await autoCloseExpiredSessions(subjects.map((s) => s.id));

    // Step 2 — Find which subject has a schedule active RIGHT NOW
    // Checks: correct day + startTime <= now <= endTime
    let matchedSubject = null;
    let matchedSchedule = null;

    for (const subject of subjects) {
      for (const schedule of subject.schedules) {
        if (
          schedule.dayOfWeek === today &&
          schedule.startTime <= nowHHMM &&
          schedule.endTime >= nowHHMM
        ) {
          matchedSubject = subject;
          matchedSchedule = schedule;
          break;
        }
      }
      if (matchedSubject) break;
    }

    if (!matchedSubject) {
      // Schedule time doesn't match right now — but check if a teacher
      // manually started a session anyway (e.g. outside scheduled hours,
      // or server timezone offset caused the schedule check to fail).
      const manualSession = await prisma.attendanceSession.findFirst({
        where: {
          subjectId: { in: subjects.map((s) => s.id) },
          status: "ONGOING",
        },
        include: {
          records: { include: { student: true } },
          subject: { select: { name: true, code: true } },
        },
        orderBy: { createdAt: "desc" },
      });

      if (manualSession) {
        console.log(
          `[PI] No schedule match but found manual session ${manualSession.id} — returning it`,
        );
        return res.json({
          sessionId: manualSession.id,
          subjectId: manualSession.subjectId,
          subjectName: manualSession.subject.name,
          subjectCode: manualSession.subject.code,
          scheduledStart: manualSession.scheduledStart,
          scheduledEnd: manualSession.scheduledEnd,
          status: manualSession.status,
          enrolledCount: manualSession.records.length,
        });
      }

      return res.status(404).json({
        message: "No active schedule right now",
        currentTime: nowHHMM,
        dayOfWeek: today,
        tip: "Session starts automatically when class time begins.",
      });
    }

    // Build exact DateTime objects for this schedule slot
    const { scheduledStart, scheduledEnd } =
      buildScheduleDateTimes(matchedSchedule);

    // Step 3 — Check if a session is already ONGOING for this subject
    let session = await prisma.attendanceSession.findFirst({
      where: {
        subjectId: matchedSubject.id,
        status: "ONGOING",
      },
      include: {
        records: { include: { student: true } },
        subject: { select: { name: true, code: true } },
      },
    });

    // Step 4 — Auto-create session if none exists yet
    if (!session) {
      console.log(
        `[PI] Auto-creating session for ${matchedSubject.code} ` +
          `(${toHHMM(scheduledStart)} – ${toHHMM(scheduledEnd)})`,
      );

      const enrollments = await prisma.enrollment.findMany({
        where: { subjectId: matchedSubject.id },
        include: { student: true },
      });

      session = await prisma.attendanceSession.create({
        data: {
          subjectId: matchedSubject.id,
          date: now,
          scheduledStart: scheduledStart, // e.g. today at 08:00
          scheduledEnd: scheduledEnd, // e.g. today at 10:00 — THIS is what autoClose uses
          status: "ONGOING",
          actualStart: now,
          records: {
            create: enrollments.map((e) => ({
              studentId: e.studentId,
              status: "PENDING", // starts PENDING, Pi scan upgrades to PRESENT/LATE
            })),
          },
        },
        include: {
          records: { include: { student: true } },
          subject: { select: { name: true, code: true } },
        },
      });

      console.log(
        `[PI] ✅ Session ${session.id} created — ` +
          `${enrollments.length} students pre-loaded as PENDING`,
      );

      // Notify TeacherDashboard that a new session has started
      broadcast(session.id, "session_started", {
        sessionId: session.id,
        subjectId: matchedSubject.id,
        subjectName: matchedSubject.name,
        subjectCode: matchedSubject.code,
        scheduledStart: scheduledStart,
        scheduledEnd: scheduledEnd,
        records: session.records,
      });
    }

    res.json({
      sessionId: session.id,
      subjectId: matchedSubject.id,
      subjectName: session.subject.name,
      subjectCode: session.subject.code,
      scheduledStart: session.scheduledStart,
      scheduledEnd: session.scheduledEnd,
      status: session.status,
      enrolledCount: session.records.length,
    });
  } catch (error) {
    console.error("[PI] getActiveSubject error:", error);
    res.status(500).json({
      message: "Failed to get active subject",
      error: error.message,
    });
  }
};

// ─────────────────────────────────────────────
// POST /api/pi/recognize
// Body: { datasetName, confidence, sessionId, timestamp }
//
// Called by the Pi when a face is confidently recognized.
// During session: only assigns PRESENT or LATE — never ABSENT.
// ABSENT is assigned in bulk at session end by autoCloseExpiredSessions.
// ─────────────────────────────────────────────
const handleRecognition = async (req, res) => {
  try {
    const { datasetName, confidence, sessionId, timestamp } = req.body;

    // Validate required fields
    if (!datasetName || confidence === undefined || !sessionId) {
      return res.status(400).json({
        message: "datasetName, confidence, and sessionId are all required",
      });
    }

    // Reject low-confidence scans
    if (confidence < MIN_CONFIDENCE) {
      console.log(
        `[PI] Low confidence (${confidence}) for "${datasetName}" — rejected`,
      );
      return res.status(200).json({
        accepted: false,
        message: "Confidence below threshold",
        confidence: confidence,
        threshold: MIN_CONFIDENCE,
      });
    }

    // Verify session exists and is still ONGOING
    const session = await prisma.attendanceSession.findUnique({
      where: { id: parseInt(sessionId) },
    });

    if (!session) {
      return res.status(404).json({ message: "Session not found" });
    }

    if (session.status !== "ONGOING") {
      return res.status(400).json({
        message: "Session is no longer active",
        sessionStatus: session.status,
      });
    }

    // Look up student by datasetName (the Pi's face identity key)
    const student = await prisma.student.findUnique({
      where: { datasetName: datasetName },
    });

    if (!student) {
      console.log(`[PI] No student with datasetName: "${datasetName}"`);
      return res.status(404).json({
        message:
          "Student not found. Make sure the student is registered " +
          "in the web app with the correct Dataset Name.",
        datasetName: datasetName,
      });
    }

    const displayName = formatDisplayName(student);

    // Find the student's attendance record for this session
    const existingRecord = await prisma.attendanceRecord.findUnique({
      where: {
        sessionId_studentId: {
          sessionId: parseInt(sessionId),
          studentId: student.id,
        },
      },
    });

    if (!existingRecord) {
      return res.status(404).json({
        message: "Student is not enrolled in this subject",
        student: displayName,
      });
    }

    // Never overwrite a scanned record — PRESENT and LATE are final
    // PENDING → PRESENT or LATE is the only valid transition during a live session
    if (
      existingRecord.status === "PRESENT" ||
      existingRecord.status === "LATE"
    ) {
      console.log(
        `[PI] ${displayName} already ${existingRecord.status} — ignoring duplicate scan`,
      );
      return res.status(200).json({
        accepted: false,
        message: `Already marked as ${existingRecord.status}`,
        studentName: displayName,
        status: existingRecord.status,
      });
    }

    // Calculate PRESENT or LATE
    // Use the Pi's reported timestamp so the result reflects
    // actual scan time, not HTTP arrival time
    const arrivalTime = timestamp ? new Date(timestamp) : new Date();
    const scheduledStart = new Date(session.scheduledStart);
    const minutesLate = Math.floor(
      (arrivalTime - scheduledStart) / (1000 * 60),
    );

    // Anyone who shows up during the session = PRESENT or LATE
    // ABSENT is only assigned at session end — never during a live session
    const status = minutesLate > LATE_THRESHOLD_MIN ? "LATE" : "PRESENT";

    // Update the attendance record
    const updatedRecord = await prisma.attendanceRecord.update({
      where: {
        sessionId_studentId: {
          sessionId: parseInt(sessionId),
          studentId: student.id,
        },
      },
      data: {
        arrivalTime: arrivalTime,
        status: status,
        remarks: `Pi scan — confidence ${(confidence * 100).toFixed(1)}% (+${minutesLate}min)`,
      },
      include: { student: true },
    });

    console.log(
      `[PI] ✅ ${displayName} → ${status} ` +
        `(confidence: ${confidence}, +${minutesLate}min)`,
    );

    // Broadcast live update to TeacherDashboard via SSE
    broadcast(parseInt(sessionId), "attendance_update", {
      sessionId: parseInt(sessionId),
      record: updatedRecord,
      markedBy: "pi",
      minutesLate: minutesLate,
      confidence: confidence,
    });

    res.status(200).json({
      accepted: true,
      studentName: displayName,
      status: status,
      minutesLate: minutesLate,
      arrivalTime: arrivalTime,
    });
  } catch (error) {
    console.error("[PI] handleRecognition error:", error);
    res.status(500).json({
      message: "Failed to process recognition",
      error: error.message,
    });
  }
};

// ─────────────────────────────────────────────
// GET /api/pi/schedules?codes=T1TE,CPE305
//
// Returns all schedules for the given subject codes
// formatted exactly as schedule.csv expects:
//   day, start, end, section, subject, subject_code
//
// The Pi bridge downloads this and writes it to schedule.csv.
// attendance_system.py reads schedule.csv as normal — it never
// needs to know whether the file came from the web app or was
// written manually.
//
// Called on Pi startup and every SYNC_INTERVAL minutes.
// ─────────────────────────────────────────────
const getSchedules = async (req, res) => {
  try {
    const codesParam = req.query.codes;
    if (!codesParam) {
      return res
        .status(400)
        .json({ message: "Query param 'codes' is required" });
    }

    const codes = codesParam.split(",").map((c) => c.trim().toUpperCase());

    // Days array matches Python's datetime.strftime("%A") output
    const DAYS = [
      "Sunday",
      "Monday",
      "Tuesday",
      "Wednesday",
      "Thursday",
      "Friday",
      "Saturday",
    ];

    // Fetch subjects with their schedules, and enrollments to get sections
    const subjects = await prisma.subject.findMany({
      where: { code: { in: codes } },
      include: {
        schedules: true,
        enrollments: {
          include: { student: { select: { section: true } } },
          distinct: ["studentId"],
        },
      },
    });

    if (subjects.length === 0) {
      return res.status(404).json({
        message: `No subjects found for codes: ${codes.join(", ")}`,
      });
    }

    // Build the CSV-compatible rows
    // One row per (schedule × section) combination
    // This matches how schedule.csv is structured in attendance_system.py
    const rows = [];

    for (const subject of subjects) {
      // Get all unique sections enrolled in this subject
      const sections = [
        ...new Set(
          subject.enrollments.map((e) => e.student.section).filter(Boolean),
        ),
      ];

      for (const schedule of subject.schedules) {
        const dayName = DAYS[schedule.dayOfWeek];

        if (sections.length === 0) {
          // No students enrolled — still export schedule with empty section
          // so the Pi knows this subject runs at this time
          rows.push({
            day: dayName,
            start: schedule.startTime,
            end: schedule.endTime,
            section: "",
            subject: subject.name,
            subject_code: subject.code,
          });
        } else {
          for (const section of sections) {
            rows.push({
              day: dayName,
              start: schedule.startTime,
              end: schedule.endTime,
              section: section,
              subject: subject.name,
              subject_code: subject.code,
            });
          }
        }
      }
    }

    console.log(
      `[PI] Schedule sync — ${rows.length} row(s) for codes: ${codes.join(", ")}`,
    );
    res.json({ schedules: rows, count: rows.length });
  } catch (error) {
    console.error("[PI] getSchedules error:", error);
    res
      .status(500)
      .json({ message: "Failed to get schedules", error: error.message });
  }
};

// ─────────────────────────────────────────────
// POST /api/pi/register-student
// Body: { studentId, surname, firstName, middleInitial, section, datasetName }
//
// Called by register_student.py on the Pi after face capture completes.
// Creates the student record in the web app database so the student
// is immediately available for enrollment without manual admin entry.
//
// Uses Pi device key authentication (not JWT) — same as all Pi routes.
// datasetName is accepted from the Pi directly since it was already
// generated during face capture and must match the dataset folder name.
// ─────────────────────────────────────────────
const registerStudent = async (req, res) => {
  try {
    const {
      studentId,
      surname,
      firstName,
      middleInitial,
      section,
      datasetName,
    } = req.body;

    // Validate required fields
    if (!studentId || !surname || !firstName || !section || !datasetName) {
      return res.status(400).json({
        message:
          "studentId, surname, firstName, section, and datasetName are all required",
      });
    }

    // Validate section against DB — always includes newly added sections
    // Falls back to DEFAULT_SECTIONS if DB unavailable
    const { DEFAULT_SECTIONS } = require("./sectionController");
    let validSections = DEFAULT_SECTIONS;
    try {
      const dbSections = await prisma.section.findMany({
        orderBy: { name: "asc" },
      });
      if (dbSections.length > 0) validSections = dbSections.map((s) => s.name);
    } catch {
      /* use defaults */
    }

    if (!validSections.includes(section)) {
      return res.status(400).json({
        message: `Invalid section. Must be one of: ${validSections.join(", ")}`,
      });
    }

    // Validate studentId format (XXXX-XXXXX-MN-X)
    const idParts = studentId.split("-");
    if (idParts.length < 2 || idParts[1].length < 5) {
      return res.status(400).json({
        message: "Invalid studentId format. Expected: XXXX-XXXXX-MN-X",
      });
    }

    // Check for duplicates
    const existingById = await prisma.student.findUnique({
      where: { studentId: studentId.trim() },
    });
    if (existingById) {
      return res.status(409).json({
        message: `Student ID "${studentId}" is already registered.`,
        student: existingById,
      });
    }

    const existingByDataset = await prisma.student.findUnique({
      where: { datasetName: datasetName.trim() },
    });
    if (existingByDataset) {
      return res.status(409).json({
        message: `Dataset name "${datasetName}" is already registered.`,
        student: existingByDataset,
      });
    }

    // Create the student
    const student = await prisma.student.create({
      data: {
        studentId: studentId.trim(),
        surname: surname.trim().toUpperCase(),
        firstName: firstName.trim(),
        middleInitial: middleInitial
          ? middleInitial.trim().toUpperCase()
          : null,
        section: section.trim(),
        datasetName: datasetName.trim(),
      },
    });

    const displayName = `${student.surname}, ${student.firstName}${student.middleInitial ? " " + student.middleInitial + "." : ""}`;
    console.log(
      `[PI] ✅ Student registered: ${displayName} | ${student.studentId} | ${student.datasetName}`,
    );

    res.status(201).json({
      message: "Student registered successfully",
      student,
      displayName,
    });
  } catch (error) {
    console.error("[PI] registerStudent error:", error);
    res.status(500).json({
      message: "Failed to register student",
      error: error.message,
    });
  }
};

// ─────────────────────────────────────────────
// GET /api/pi/sections-list
//
// Called by register_student.py on startup.
// Returns the current list of valid sections from the DB
// so the Pi always has the latest list without code changes.
// ─────────────────────────────────────────────
const getSectionsList = async (req, res) => {
  try {
    const sections = await prisma.section.findMany({
      orderBy: { name: "asc" },
    });

    if (sections.length > 0) {
      return res.json({ sections: sections.map((s) => s.name) });
    }

    // Fall back to defaults if DB is empty
    const { DEFAULT_SECTIONS } = require("./sectionController");
    res.json({ sections: DEFAULT_SECTIONS });
  } catch (error) {
    console.error("[PI] getSectionsList error:", error);
    res
      .status(500)
      .json({ message: "Failed to fetch sections", error: error.message });
  }
};

// ─────────────────────────────────────────────
// GET /api/pi/all-subjects
//
// Returns ALL subject codes in the system.
// Called by the bridge on startup and every SYNC_INTERVAL
// so SUBJECT_CODES never needs to be hardcoded.
//
// The Pi uses these codes for:
//   - GET /api/pi/schedules?codes=... (schedule sync)
//   - GET /api/pi/active-subject?codes=... (session polling)
// ─────────────────────────────────────────────
const getAllSubjectCodes = async (req, res) => {
  try {
    const subjects = await prisma.subject.findMany({
      select: { code: true, name: true },
      orderBy: { code: "asc" },
    });

    const codes = subjects.map((s) => s.code);

    console.log(`[PI] All subject codes: ${codes.join(", ")}`);
    res.json({ codes, count: codes.length });
  } catch (error) {
    console.error("[PI] getAllSubjectCodes error:", error);
    res
      .status(500)
      .json({ message: "Failed to fetch subject codes", error: error.message });
  }
};

// ─────────────────────────────────────────────
// GET /api/pi/session-at-time
// Query: { codes, timestamp }
//
// Called by the offline queue drain when replaying missed scans.
// Returns the session that was ONGOING at the given UTC timestamp
// for any of the provided subject codes.
//
// This ensures replayed records get the correct sessionId and
// accurate LATE/PRESENT calculation based on the original scan time.
// ─────────────────────────────────────────────
const getSessionAtTime = async (req, res) => {
  try {
    const { codes, timestamp } = req.query;

    if (!codes || !timestamp) {
      return res
        .status(400)
        .json({ message: "codes and timestamp are required" });
    }

    const scanTime = new Date(timestamp);
    const codeList = codes.split(",").map((c) => c.trim().toUpperCase());

    if (isNaN(scanTime.getTime())) {
      return res.status(400).json({ message: "Invalid timestamp format" });
    }

    // Find a session that:
    //  - belongs to one of the subject codes
    //  - was ONGOING or COMPLETED (already closed by the time we replay)
    //  - its scheduledStart <= scanTime <= scheduledEnd
    const subjects = await prisma.subject.findMany({
      where: { code: { in: codeList } },
      select: { id: true, code: true, name: true },
    });

    if (subjects.length === 0) {
      return res
        .status(404)
        .json({ message: "No subjects found for provided codes" });
    }

    const session = await prisma.attendanceSession.findFirst({
      where: {
        subjectId: { in: subjects.map((s) => s.id) },
        status: { in: ["ONGOING", "COMPLETED"] },
        scheduledStart: { lte: scanTime },
        scheduledEnd: { gte: scanTime },
      },
      orderBy: { scheduledStart: "desc" },
    });

    if (!session) {
      return res.status(404).json({
        message: "No session found at that time",
        timestamp,
        codes: codeList,
      });
    }

    const subject = subjects.find((s) => s.id === session.subjectId);
    console.log(
      `[PI] Session-at-time: ${timestamp} → session ${session.id} (${subject?.code})`,
    );

    res.json({
      sessionId: session.id,
      subjectId: session.subjectId,
      subjectCode: subject?.code,
      scheduledStart: session.scheduledStart,
      scheduledEnd: session.scheduledEnd,
      status: session.status,
    });
  } catch (error) {
    console.error("[PI] getSessionAtTime error:", error);
    res
      .status(500)
      .json({ message: "Failed to find session", error: error.message });
  }
};

module.exports = {
  getActiveSubject,
  getSchedules,
  getSectionsList,
  getAllSubjectCodes,
  getSessionAtTime,
  handleRecognition,
  registerStudent,
};
