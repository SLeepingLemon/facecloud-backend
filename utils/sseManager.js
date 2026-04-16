/**
 * sseManager.js
 *
 * Manages Server-Sent Events (SSE) connections for the FaceCloud system.
 *
 * What this does:
 * - Keeps track of which browser tabs are currently watching which session
 * - When the Pi scans a face and marks a student, the backend calls broadcast()
 * - Every browser tab watching that session instantly receives the update
 * - The TeacherDashboard updates the student row in real time without page refresh
 *
 * How SSE works in simple terms:
 * - The browser opens a connection to /api/attendance/stream/:sessionId
 * - That connection stays open (like a one-way live feed)
 * - The server pushes messages down that connection whenever something changes
 * - The browser receives them and updates the UI
 *
 * Place this file at: src/utils/sseManager.js
 * (Create the utils folder inside src if it does not exist yet)
 */

// clients is a Map where:
//   key   = sessionId (number)
//   value = Set of Express response objects (one per open browser tab)
const clients = new Map();

// ─────────────────────────────────────────────
// addClient
// Called when a browser tab connects to the SSE stream.
// ─────────────────────────────────────────────

const addClient = (sessionId, res) => {
  if (!clients.has(sessionId)) {
    clients.set(sessionId, new Set());
  }

  clients.get(sessionId).add(res);

  console.log(
    `[SSE] Browser connected to session ${sessionId}. ` +
      `Active viewers: ${clients.get(sessionId).size}`,
  );
};

// ─────────────────────────────────────────────
// removeClient
// Called when the browser tab closes or navigates away.
// ─────────────────────────────────────────────

const removeClient = (sessionId, res) => {
  if (!clients.has(sessionId)) return;

  clients.get(sessionId).delete(res);

  // Clean up the map entry if no viewers remain
  if (clients.get(sessionId).size === 0) {
    clients.delete(sessionId);
  }

  console.log(`[SSE] Browser disconnected from session ${sessionId}`);
};

// ─────────────────────────────────────────────
// broadcast
// Called by piController and attendanceController
// whenever an attendance record changes.
//
// Parameters:
//   sessionId — which session this update belongs to
//   event     — event name the browser listens for, e.g.:
//                 "attendance_update"  — a student status changed
//                 "session_started"    — Pi auto-created a new session
//                 "session_ended"      — session closed, absents assigned
//   data      — any object, will be JSON stringified and sent
// ─────────────────────────────────────────────

const broadcast = (sessionId, event, data) => {
  if (!clients.has(sessionId)) {
    // No browsers watching this session right now — that is fine
    return;
  }

  // SSE message format (must follow this exact format):
  //   event: <event_name>\n
  //   data: <json_string>\n
  //   \n   (blank line = end of message)
  const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

  const viewers = clients.get(sessionId);

  viewers.forEach((res) => {
    try {
      res.write(message);
    } catch (err) {
      // Connection was broken — remove this client silently
      console.error(
        `[SSE] Failed to write to client, removing: ${err.message}`,
      );
      viewers.delete(res);
    }
  });

  console.log(
    `[SSE] Broadcast "${event}" → session ${sessionId} ` +
      `(${viewers.size} viewer${viewers.size !== 1 ? "s" : ""})`,
  );
};

module.exports = { addClient, removeClient, broadcast };
