const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

// ─────────────────────────────────────────────
// ✏️  EDIT THIS — your Google account email
// ─────────────────────────────────────────────
const ADMIN_EMAIL = "franklinbeldad1@gmail.com"; // ← change to your Google email
const ADMIN_NAME = "Franklin Beldad"; // ← change to your name
// ─────────────────────────────────────────────

async function createAdmin() {
  try {
    console.log("Creating admin user...");

    const admin = await prisma.user.create({
      data: {
        name: ADMIN_NAME,
        email: ADMIN_EMAIL,
        password: null, // Google SSO users have no password
        role: "ADMIN",
      },
    });

    console.log("✅ Admin created successfully!");
    console.log("📧 Email:", admin.email);
    console.log("👤 Role:", admin.role);
    console.log("\nLog in using the Google Sign-In button with this email.");
  } catch (error) {
    if (error.code === "P2002") {
      console.log("⚠️  Admin already exists for:", ADMIN_EMAIL);
    } else {
      console.error("❌ Error creating admin:", error.message);
    }
  } finally {
    await prisma.$disconnect();
  }
}

createAdmin();
