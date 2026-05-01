/**
 * authController.js
 *
 * Updated: registerByAdmin now accepts and validates a
 * pre-formatted faculty name (e.g. "Engr. Juan R. Dela Cruz").
 * The name is assembled by the frontend from separate fields
 * (title, firstName, middleInitial, lastName) before being sent.
 *
 * The User model's single "name" column is kept — no migration needed.
 * Format stored: "Engr. Juan R. Dela Cruz" or "Dr. Maria Santos"
 *
 * Place this file at: src/controllers/authController.js
 */

const jwt = require("jsonwebtoken");
const prisma = require("../utils/prisma");
const { OAuth2Client } = require("google-auth-library");

// Google OAuth2 client — verifies ID tokens from the frontend
// GOOGLE_CLIENT_ID must be set in your .env file
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// Valid title prefixes
const VALID_TITLES = ["Engr.", "Dr.", "Prof.", "Mr.", "Ms.", "Mrs."];

// ─────────────────────────────────────────────
// Admin-only: create TEACHER or ADMIN account
// Accepts either:
//   A) Pre-formatted name:  { name, email, role }
//   B) Split name fields:   { title, firstName, middleInitial, lastName, email, role }
//      → assembled into:   "Engr. Juan R. Dela Cruz"
// All accounts authenticate via Google SSO — no password stored.
// ─────────────────────────────────────────────
const registerByAdmin = async (req, res) => {
  try {
    const {
      // Split name fields (new)
      title,
      firstName,
      middleInitial,
      lastName,
      // Fallback: pre-formatted name (legacy)
      name: rawName,
      // Common fields
      email,
      role,
    } = req.body;

    // ── Validate required common fields ──
    if (!email || !role) {
      return res
        .status(400)
        .json({ message: "Email and role are required" });
    }

    if (!["ADMIN", "TEACHER"].includes(role)) {
      return res.status(400).json({ message: "Role must be ADMIN or TEACHER" });
    }

    // ── Build the name ──
    let name;

    if (firstName && lastName) {
      // New split-field path
      if (!title) {
        return res
          .status(400)
          .json({ message: "Title (Engr., Dr., etc.) is required" });
      }

      if (!VALID_TITLES.includes(title)) {
        return res.status(400).json({
          message: `Invalid title. Must be one of: ${VALID_TITLES.join(", ")}`,
        });
      }

      // Format: "Engr. Juan R. Dela Cruz"
      const mi = middleInitial ? ` ${middleInitial.trim().toUpperCase()}.` : "";
      name = `${title} ${firstName.trim()}${mi} ${lastName.trim()}`;
    } else if (rawName) {
      // Legacy path — name sent pre-formatted
      name = rawName.trim();
    } else {
      return res.status(400).json({
        message:
          "Either provide (title, firstName, lastName) or a pre-formatted name",
      });
    }

    if (!name) {
      return res.status(400).json({ message: "Name cannot be empty" });
    }

    // ── Check for duplicate email ──
    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      return res
        .status(400)
        .json({ message: "An account with this email already exists" });
    }

    const user = await prisma.user.create({
      data: { name, email, role },
    });

    console.log(
      `✅ ${role} account created by admin: ${user.email} — ${user.name}`,
    );
    res.status(201).json({
      message: `${role} account created successfully`,
      name: user.name,
      role: user.role,
    });
  } catch (error) {
    console.error("❌ Admin registration error:", error);
    res
      .status(500)
      .json({ message: "Registration failed", error: error.message });
  }
};

// ─────────────────────────────────────────────
// Get all users (Admin only)
// ─────────────────────────────────────────────
const getAllUsers = async (req, res) => {
  try {
    const users = await prisma.user.findMany({
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        createdAt: true,
      },
      orderBy: { name: "asc" },
    });
    res.json(users);
  } catch (error) {
    console.error("❌ Error fetching users:", error);
    res
      .status(500)
      .json({ message: "Failed to fetch users", error: error.message });
  }
};

// ─────────────────────────────────────────────
// Google SSO — POST /api/auth/google
// Body: { credential } — the Google ID token from the frontend
//
// Flow:
//   1. Verify the ID token with Google's servers
//   2. Extract email from the verified payload
//   3. Look up user by email in our database
//   4. If found → issue our JWT (same format as password login)
//   5. If not found → 403 (admin must create account first)
//
// Google SSO does NOT auto-create accounts.
// Admin must register the user first — this preserves role control.
// ─────────────────────────────────────────────
const googleAuth = async (req, res) => {
  try {
    const { credential } = req.body;

    if (!credential) {
      return res
        .status(400)
        .json({ message: "Google credential token is required" });
    }

    if (!process.env.GOOGLE_CLIENT_ID) {
      return res
        .status(500)
        .json({ message: "Google SSO is not configured on this server" });
    }

    // Verify the token with Google — this confirms it's genuine
    let payload;
    try {
      const ticket = await googleClient.verifyIdToken({
        idToken: credential,
        audience: process.env.GOOGLE_CLIENT_ID,
      });
      payload = ticket.getPayload();
    } catch (verifyError) {
      console.error(
        "❌ Google token verification failed:",
        verifyError.message,
      );
      return res
        .status(401)
        .json({ message: "Invalid or expired Google token" });
    }

    const { email, name: googleName, email_verified } = payload;

    if (!email_verified) {
      return res
        .status(401)
        .json({ message: "Google account email is not verified" });
    }

    // Look up user by email in our database
    const user = await prisma.user.findUnique({ where: { email } });

    if (!user) {
      return res.status(403).json({
        message:
          "No account found for this Google email. Please contact your administrator to create an account.",
        email,
      });
    }

    // Issue our JWT — same format as password login
    const token = jwt.sign(
      { userId: user.id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: "1d" },
    );

    console.log(`✅ Google SSO login: ${email} — ${user.role}`);
    res.json({
      token,
      role: user.role,
      name: user.name,
      message: "Login successful",
    });
  } catch (error) {
    console.error("❌ Google SSO error:", error);
    res
      .status(500)
      .json({ message: "Google login failed", error: error.message });
  }
};

// ─────────────────────────────────────────────
// Update user — name and/or email
// PUT /api/auth/users/:id
// Admin only
// ─────────────────────────────────────────────
const updateUser = async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    const { name, email } = req.body;

    if (!name && !email) {
      return res
        .status(400)
        .json({ message: "Provide at least a name or email to update" });
    }

    // Check user exists
    const existing = await prisma.user.findUnique({ where: { id: userId } });
    if (!existing) {
      return res.status(404).json({ message: "User not found" });
    }

    // Check email conflict if email is changing
    if (email && email.trim().toLowerCase() !== existing.email.toLowerCase()) {
      const conflict = await prisma.user.findUnique({
        where: { email: email.trim().toLowerCase() },
      });
      if (conflict) {
        return res
          .status(400)
          .json({ message: "This email is already used by another account" });
      }
    }

    const data = {};
    if (name) data.name = name.trim();
    if (email) data.email = email.trim().toLowerCase();

    const updated = await prisma.user.update({
      where: { id: userId },
      data,
      select: { id: true, name: true, email: true, role: true },
    });

    console.log(`✅ User updated: ${updated.email} — ${updated.name}`);
    res.json({ message: "User updated successfully", user: updated });
  } catch (error) {
    console.error("❌ Update user error:", error);
    res
      .status(500)
      .json({ message: "Failed to update user", error: error.message });
  }
};

// ─────────────────────────────────────────────
// Delete user
// DELETE /api/auth/users/:id
// Admin only — cannot delete own account
// ─────────────────────────────────────────────
const deleteUser = async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    const requesterId = req.user.userId;

    if (userId === requesterId) {
      return res
        .status(400)
        .json({ message: "You cannot delete your own account" });
    }

    const existing = await prisma.user.findUnique({ where: { id: userId } });
    if (!existing) {
      return res.status(404).json({ message: "User not found" });
    }

    // Remove teacher assignments from subjects first
    await prisma.subjectTeacher.deleteMany({ where: { teacherId: userId } });

    await prisma.user.delete({ where: { id: userId } });

    console.log(`✅ User deleted: ${existing.email}`);
    res.json({ message: `Account for ${existing.name} deleted successfully` });
  } catch (error) {
    console.error("❌ Delete user error:", error);
    res
      .status(500)
      .json({ message: "Failed to delete user", error: error.message });
  }
};

module.exports = {
  registerByAdmin,
  googleAuth,
  getAllUsers,
  updateUser,
  deleteUser,
  VALID_TITLES,
};
