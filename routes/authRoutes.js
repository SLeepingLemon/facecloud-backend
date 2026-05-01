/**
 * authRoutes.js
 * Authentication routes.
 * Updated: added /register-admin route (requires ADMIN JWT).
 *
 * Place this file at: src/routes/authRoutes.js
 */

const express = require("express");
const router = express.Router();
const {
  registerByAdmin,
  googleAuth,
  getAllUsers,
  updateUser,
  deleteUser,
} = require("../controllers/authController");
const { authenticate, authorize } = require("../middleware/authMiddleware");

// Protected — admin creates any role account (used by ManageUsers page)
router.post(
  "/register-admin",
  authenticate,
  authorize(["ADMIN"]),
  registerByAdmin,
);

// Public — Google SSO login
// Body: { credential } — ID token from Google's sign-in button
router.post("/google", googleAuth);

// Protected — list all users (for teacher assignment dropdowns etc.)
router.get("/users", authenticate, authorize(["ADMIN"]), getAllUsers);

// Protected — update user name / email (admin only)
router.put("/users/:id", authenticate, authorize(["ADMIN"]), updateUser);

// Protected — delete user (admin only, cannot delete self)
router.delete("/users/:id", authenticate, authorize(["ADMIN"]), deleteUser);

module.exports = router;
