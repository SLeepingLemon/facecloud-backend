/**
 * server.js
 * Main Express application entry point.
 * Updated to include:
 *  - Pi device routes (/api/pi/...)
 *  - SSE-compatible CORS headers
 *  - Graceful shutdown
 *
 * Place this file at: src/server.js (or root, wherever it currently lives)
 */

require("dotenv").config();
const express = require("express");

const cors = require("cors");

const authRoutes = require("./routes/authRoutes");
const apiRoutes = require("./routes/apiRoutes");
const piRoutes = require("./routes/piRoutes");

const app = express();
const PORT = process.env.PORT || 5000;

// ─────────────────────────────────────────────
// CORS
// Allow SSE connections from the Vite dev server.
// In production, replace the origin with your actual domain.
// ─────────────────────────────────────────────
app.use(
  cors({
    origin: process.env.FRONTEND_URL || "http://localhost:5173",
    credentials: true,
    // These headers are required for SSE to work correctly
    exposedHeaders: ["Content-Type", "Cache-Control", "Connection"],
  }),
);

// ─────────────────────────────────────────────
// Body parsing
// ─────────────────────────────────────────────
app.use(express.json());

// ─────────────────────────────────────────────
// Request logger — only logs meaningful events
// Skips polling routes that fire every 10-30s
// to keep the terminal clean and readable.
// ─────────────────────────────────────────────
const SILENT_ROUTES = [
  "/api/pi/active-subject", // Pi polls every 15-30s
  "/api/pi/schedules", // Pi schedule sync
  "/api/attendance/session/", // Dashboard detection poll (every 10s)
  "/api/attendance/stream/", // SSE heartbeat
  "/api/health", // health checks
];

app.use((req, res, next) => {
  const isSilent = SILENT_ROUTES.some((r) => req.path.startsWith(r));
  if (!isSilent) {
    console.log(`${new Date().toISOString()} — ${req.method} ${req.path}`);
  }
  next();
});

// ─────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────
app.use("/api/auth", authRoutes);
app.use("/api/pi", piRoutes); // Raspberry Pi device routes
app.use("/api", apiRoutes); // Web app routes

// Health check
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

// ─────────────────────────────────────────────
// Global error handler
// ─────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error("❌ Unhandled error:", err.stack);
  res
    .status(500)
    .json({ message: "Something went wrong!", error: err.message });
});

// ─────────────────────────────────────────────
// Background job — auto-close expired sessions
//
// Runs every 60 seconds on the server clock.
// Finds every ONGOING session whose scheduledEnd has passed
// and closes it — marks absent students, updates status,
// broadcasts session_ended via SSE to all open dashboards.
//
// This is the PRIMARY close mechanism — it runs on real time,
// not on Pi polls or teacher requests. Sessions always close
// on schedule regardless of whether the Pi is connected.
// ─────────────────────────────────────────────
const prisma = require("./utils/prisma");
const { broadcast } = require("./utils/sseManager");

async function autoCloseExpiredSessions() {
  try {
    const now = new Date();

    // Find all ONGOING sessions whose scheduledEnd has passed
    const expired = await prisma.attendanceSession.findMany({
      where: {
        status: "ONGOING",
        scheduledEnd: { lt: now }, // scheduledEnd < now
      },
      select: { id: true, scheduledEnd: true },
    });

    if (expired.length === 0) return;

    for (const session of expired) {
      // Mark all PENDING (unscanned) students as ABSENT
      // Only touches PENDING records — never overwrites PRESENT or LATE
      const updated = await prisma.attendanceRecord.updateMany({
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

      console.log(
        `[AutoClose] ✅ Session ${session.id} closed — ` +
          `${updated.count} student(s) marked ABSENT`,
      );

      // Notify all open TeacherDashboards via SSE
      broadcast(session.id, "session_ended", {
        sessionId: session.id,
        endedAt: now,
      });
    }
  } catch (err) {
    console.error("[AutoClose] ❌ Error:", err.message);
  }
}

// Run immediately on startup (catches any sessions that expired while server was down)
// then every 60 seconds
autoCloseExpiredSessions();
setInterval(autoCloseExpiredSessions, 60 * 1000);
console.log("⏰ Auto-close job started — checks every 60 seconds");

// ─────────────────────────────────────────────
// Start server
// ─────────────────────────────────────────────
const server = app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`📡 API:    http://localhost:${PORT}/api`);
  console.log(`🩺 Health: http://localhost:${PORT}/api/health`);
  console.log(`🍓 Pi endpoint: POST http://localhost:${PORT}/api/pi/recognize`);
});

// ─────────────────────────────────────────────
// Graceful shutdown (important for SSE connections)
// ─────────────────────────────────────────────
process.on("SIGTERM", () => {
  console.log("SIGTERM received — shutting down gracefully");
  server.close(() => {
    console.log("Server closed");
    process.exit(0);
  });
});

// ─────────────────────────────────────────────
// Prevent unhandled errors from crashing the server
// This is especially important during Pi testing —
// a bad recognition request should NOT kill the server.
// ─────────────────────────────────────────────
process.on("uncaughtException", (err) => {
  console.error("❌ Uncaught Exception (server kept alive):", err.message);
  console.error(err.stack);
});

process.on("unhandledRejection", (reason) => {
  console.error("❌ Unhandled Promise Rejection (server kept alive):", reason);
});

module.exports = app;
