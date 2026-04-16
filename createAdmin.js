const bcrypt = require("bcrypt");
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

async function createAdmin() {
  try {
    console.log("Creating admin user...");

    const hashedPassword = await bcrypt.hash("admin123", 10);

    const admin = await prisma.user.create({
      data: {
        name: "Admin User",
        email: "admin@example.com",
        password: hashedPassword,
        role: "ADMIN",
      },
    });

    console.log("✅ Admin created successfully!");
    console.log("📧 Email:", admin.email);
    console.log("🔑 Password: admin123");
    console.log("👤 Role:", admin.role);
    console.log("\nYou can now login with these credentials.");
  } catch (error) {
    if (error.code === "P2002") {
      console.log("⚠️  Admin user already exists!");
      console.log("Use email: admin@example.com");
      console.log("Password: admin123");
    } else {
      console.error("❌ Error creating admin:", error.message);
    }
  } finally {
    await prisma.$disconnect();
  }
}

createAdmin();
