/**
 * attendanceController.js
 *
 * Added: createSession  — POST /api/attendance/session
 *        endSession      — PUT  /api/attendance/session/:sessionId/end
 *
 * These two endpoints allow a teacher to manually start/end a session
 * for testing purposes while the Raspberry Pi is not yet connected.
 * The Pi still drives sessions automatically in production.
 *
 * Fixed: getOngoingSession orderBy changed from { name: "asc" }
 *        (no longer exists) to { surname: "asc" }.
 *
 * Place this file at: src/controllers/attendanceController.js
 */

const { addClient, removeClient, broadcast } = require("../utils/sseManager");
const prisma = require("../utils/prisma");

// ─────────────────────────────────────────────
// SSE Stream
// GET /api/attendance/stream/:sessionId?token=<jwt>
// ─────────────────────────────────────────────
const streamSession = (req, res) => {
  const sessionId = parseInt(req.params.sessionId);

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  res.write(`event: connected\ndata: ${JSON.stringify({ sessionId })}\n\n`);

  addClient(sessionId, res);

  const heartbeat = setInterval(() => {
    try {
      res.write(": heartbeat\n\n");
    } catch {
      clearInterval(heartbeat);
    }
  }, 25000);

  req.on("close", () => {
    clearInterval(heartbeat);
    removeClient(sessionId, res);
  });
};

// ─────────────────────────────────────────────
// Get ongoing session for a subject
// GET /api/attendance/session/:subjectId?section=BSCPE3-1
// section is optional — if omitted returns any ONGOING session (admin use)
// ─────────────────────────────────────────────
const getOngoingSession = async (req, res) => {
  try {
    const { subjectId } = req.params;
    const { section } = req.query;

    const where = { subjectId: parseInt(subjectId), status: "ONGOING" };
    if (section) where.section = section;

    const session = await prisma.attendanceSession.findFirst({
      where,
      include: {
        records: {
          include: { student: true },
          orderBy: { student: { surname: "asc" } },
        },
        subject: true,
      },
    });

    // ── Auto-close check ──
    // If the session exists but its scheduledEnd has passed, close it now.
    // This handles the case where the Pi is offline or hasn't polled yet —
    // the TeacherDashboard will always show the correct state regardless.
    if (session && session.scheduledEnd) {
      const now = new Date();
      const scheduledEnd = new Date(session.scheduledEnd);

      if (now > scheduledEnd) {
        console.log(
          `[Session] Auto-closing expired session ${session.id} — scheduledEnd was ${scheduledEnd.toLocaleTimeString()}`,
        );

        // Mark all PENDING (unscanned) students as ABSENT
        // Only targets PENDING — never overwrites PRESENT or LATE
        await prisma.attendanceRecord.updateMany({
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
          data: { status: "COMPLETED", actualEnd: now },
        });

        // Notify TeacherDashboard via SSE
        broadcast(session.id, "session_ended", {
          sessionId: session.id,
          endedAt: now,
        });

        // Return null — session is now closed, no active session
        return res.json(null);
      }
    }

    res.json(session);
  } catch (error) {
    console.error("Error fetching ongoing session:", error);
    res
      .status(500)
      .json({ message: "Failed to fetch session", error: error.message });
  }
};

// ─────────────────────────────────────────────
// Manually start a session
// POST /api/attendance/session
// Body: { subjectId, section?, durationMinutes? }
//
// section filters which students are added and which schedule to match.
// ─────────────────────────────────────────────
const createSession = async (req, res) => {
  try {
    const { subjectId, section, durationMinutes = 120 } = req.body;

    if (!subjectId) {
      return res.status(400).json({ message: "subjectId is required" });
    }

    const parsedSubjectId = parseInt(subjectId);

    // Check the subject exists — include schedules to find correct end time
    const subject = await prisma.subject.findUnique({
      where: { id: parsedSubjectId },
      include: {
        enrollments: { include: { student: true } },
        schedules: true,
      },
    });
    if (!subject) {
      return res.status(404).json({ message: "Subject not found" });
    }

    // Check if there is already an ongoing session for this subject+section.
    // section: null means "no section" — always filter explicitly so a session
    // for BSCPE3-1 cannot block creation for BSCPE3-2 (or vice versa).
    const existing = await prisma.attendanceSession.findFirst({
      where: {
        subjectId: parsedSubjectId,
        status: "ONGOING",
        section: section || null,
      },
    });
    if (existing) {
      return res.status(400).json({
        message: "A session is already ongoing for this subject.",
        sessionId: existing.id,
      });
    }

    const now = new Date();
    const today = now.getDay(); // 0=Sun … 6=Sat
    const nowHHMM = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

    // ── Find the best matching schedule ──
    //
    // Priority order:
    //   1. A schedule for TODAY whose time window contains NOW exactly
    //      (on-time start — most common case)
    //   2. A schedule for TODAY with the closest start time to NOW
    //      (early or late start — teacher outside exact window)
    //   3. Any schedule regardless of day
    //      (off-day manual session — e.g. makeup class on Wednesday
    //       when subject only has Saturday schedule)
    //   4. No schedule found — fall back to now + durationMinutes
    //
    // This ensures scheduledStart/scheduledEnd always reflect the
    // intended class time, not when the teacher clicked the button.
    // LATE calculation and autoClose both depend on these values.

    const schedulesForToday = subject.schedules.filter(
      (s) => s.dayOfWeek === today && (!section || s.section === section),
    );

    // Helper — convert "HH:MM" to total minutes for arithmetic
    const toMins = (hhmm) => {
      const [h, m] = hhmm.split(":").map(Number);
      return h * 60 + m;
    };

    const nowMins = toMins(nowHHMM);

    let bestSchedule = null;

    if (schedulesForToday.length > 0) {
      // First try: exact match (now is within the window)
      bestSchedule =
        schedulesForToday.find(
          (s) => toMins(s.startTime) <= nowMins && toMins(s.endTime) >= nowMins,
        ) || null;

      // Second try: closest start time to now (early/late start)
      if (!bestSchedule) {
        bestSchedule = schedulesForToday.reduce((closest, s) => {
          const distThis = Math.abs(toMins(s.startTime) - nowMins);
          const distClosest = Math.abs(toMins(closest.startTime) - nowMins);
          return distThis < distClosest ? s : closest;
        });
      }
    }

    let scheduledStart;
    let scheduledEnd;

    if (bestSchedule) {
      // Found a schedule for today — use its exact times
      scheduledStart = new Date(`${dateStr}T${bestSchedule.startTime}:00`);
      scheduledEnd = new Date(`${dateStr}T${bestSchedule.endTime}:00`);
      console.log(
        `[Session] Using schedule: ${bestSchedule.startTime}–${bestSchedule.endTime}`,
      );
    } else {
      // No schedule for today at all (off-day makeup class, or no schedules set)
      // Use now as start so students who arrive on time get PRESENT,
      // not LATE with hundreds of minutes vs a different day's start time.
      scheduledStart = now;
      scheduledEnd = new Date(now.getTime() + durationMinutes * 60 * 1000);
      console.log(
        `[Session] Off-day session — using now (${nowHHMM}) + ${durationMinutes}min`,
      );
    }

    // Create session with correct schedule times
    const session = await prisma.attendanceSession.create({
      data: {
        subjectId: parsedSubjectId,
        section: section || null,
        date: now,
        scheduledStart: scheduledStart,
        scheduledEnd: scheduledEnd,
        actualStart: now,
        status: "ONGOING",
      },
    });

    // Pre-populate attendance records — filter by section if provided
    const enrolledStudents = section
      ? subject.enrollments.filter((e) => e.student.section === section)
      : subject.enrollments;

    if (enrolledStudents.length > 0) {
      await prisma.attendanceRecord.createMany({
        data: enrolledStudents.map((e) => ({
          sessionId: session.id,
          studentId: e.studentId,
          status: "PENDING",
        })),
        skipDuplicates: true,
      });
    }

    // Fetch full session with records for response
    const fullSession = await prisma.attendanceSession.findUnique({
      where: { id: session.id },
      include: {
        records: {
          include: { student: true },
          orderBy: { student: { surname: "asc" } },
        },
        subject: true,
      },
    });

    console.log(
      `[Session] ✅ MANUAL START — ${subject.name}${section ? ` [${section}]` : ""} | ` +
        `${enrolledStudents.length} students | ` +
        `scheduled ${scheduledStart.toLocaleTimeString()}–${scheduledEnd.toLocaleTimeString()} | ` +
        `actual start: ${now.toLocaleTimeString()}`,
    );

    // Notify any open TeacherDashboard tabs via SSE
    broadcast(fullSession.id, "session_started", {
      sessionId: fullSession.id,
      subjectId: parsedSubjectId,
      scheduledStart,
      scheduledEnd,
    });

    res.status(201).json({ message: "Session started", session: fullSession });
  } catch (error) {
    console.error("Error creating session:", error);
    res
      .status(500)
      .json({ message: "Failed to start session", error: error.message });
  }
};

// ─────────────────────────────────────────────
// [TEMPORARY] Manually end a session
// PUT /api/attendance/session/:sessionId/end
//
// Marks session COMPLETED, sets actualEnd,
// and marks remaining ABSENT records as ABSENT
// (they stay as-is — just finalises the session).
// ─────────────────────────────────────────────
const endSession = async (req, res) => {
  try {
    const sessionId = parseInt(req.params.sessionId);
    const { notes } = req.body;

    const session = await prisma.attendanceSession.findUnique({
      where: { id: sessionId },
    });
    if (!session) {
      return res.status(404).json({ message: "Session not found" });
    }
    if (session.status !== "ONGOING") {
      return res
        .status(400)
        .json({ message: `Session is already ${session.status}` });
    }

    const now = new Date();

    const [updated] = await prisma.$transaction([
      prisma.attendanceRecord.updateMany({
        where: { sessionId, status: "PENDING" },
        data: {
          status: "ABSENT",
          remarks: "Not scanned — manually ended by teacher",
        },
      }),
      prisma.attendanceSession.update({
        where: { id: sessionId },
        data: {
          status: "COMPLETED",
          actualEnd: now,
          endNote: notes?.trim() || null,
        },
      }),
    ]);

    console.log(
      `[Session] ✅ MANUAL END — Session ${sessionId} | ${updated.count} student(s) marked ABSENT`,
    );

    // Notify open dashboards via SSE
    broadcast(sessionId, "session_ended", { sessionId, endedAt: now });

    res.json({ message: "Session ended successfully" });
  } catch (error) {
    console.error("Error ending session:", error);
    res
      .status(500)
      .json({ message: "Failed to end session", error: error.message });
  }
};

// ─────────────────────────────────────────────
// Teacher manual override on a single record
// PUT /api/attendance/record/:recordId
// ─────────────────────────────────────────────
const updateAttendance = async (req, res) => {
  try {
    const { recordId } = req.params;
    const { status, remarks } = req.body;

    if (!status) {
      return res.status(400).json({ message: "Status is required" });
    }
    if (!["PRESENT", "LATE", "ABSENT", "PENDING"].includes(status)) {
      return res
        .status(400)
        .json({ message: "Status must be PRESENT, LATE, or ABSENT" });
    }

    const record = await prisma.attendanceRecord.update({
      where: { id: parseInt(recordId) },
      data: {
        status,
        remarks: remarks || null,
        arrivalTime: status !== "ABSENT" ? new Date() : null,
      },
      include: { student: true },
    });

    broadcast(record.sessionId, "attendance_update", {
      sessionId: record.sessionId,
      record,
      markedBy: "teacher_override",
    });

    res.json({ message: "Attendance updated successfully", record });
  } catch (error) {
    console.error("Error updating attendance:", error);
    res
      .status(500)
      .json({ message: "Failed to update attendance", error: error.message });
  }
};

// ─────────────────────────────────────────────
// Attendance report
// GET /api/attendance/report/:subjectId?section=BSCPE3-1
// section is optional — if omitted returns all sections combined
// ─────────────────────────────────────────────
const getSubjectReport = async (req, res) => {
  try {
    const { subjectId } = req.params;
    const { startDate, endDate, section } = req.query;

    const whereClause = {
      subjectId: parseInt(subjectId),
      status: "COMPLETED",
    };

    if (section) whereClause.section = section;

    if (startDate && endDate) {
      whereClause.date = {
        gte: new Date(startDate),
        lte: new Date(endDate + "T23:59:59"),
      };
    }

    const sessions = await prisma.attendanceSession.findMany({
      where: whereClause,
      include: { records: { include: { student: true } } },
      orderBy: { date: "desc" },
    });

    const enrollmentWhere = { subjectId: parseInt(subjectId) };
    if (section) enrollmentWhere.student = { section };

    const enrollments = await prisma.enrollment.findMany({
      where: enrollmentWhere,
      include: { student: true },
    });

    const report = enrollments.map((enrollment) => {
      const studentRecords = sessions.flatMap((s) =>
        s.records.filter((r) => r.studentId === enrollment.studentId),
      );

      const total = sessions.length;
      const present = studentRecords.filter(
        (r) => r.status === "PRESENT",
      ).length;
      const late = studentRecords.filter((r) => r.status === "LATE").length;
      const absent = studentRecords.filter(
        (r) => r.status === "ABSENT" || r.status === "PENDING",
      ).length;
      const rate = total > 0 ? Math.round(((present + late) / total) * 100) : 0;

      return {
        student: enrollment.student,
        totalSessions: total,
        present,
        late,
        absent,
        attendanceRate: rate,
      };
    });

    res.json({ sessions, report });
  } catch (error) {
    console.error("Error fetching report:", error);
    res
      .status(500)
      .json({ message: "Failed to fetch report", error: error.message });
  }
};

module.exports = {
  streamSession,
  getOngoingSession,
  createSession,
  endSession,
  updateAttendance,
  getSubjectReport,
};
