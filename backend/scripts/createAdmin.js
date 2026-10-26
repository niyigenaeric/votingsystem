require('dotenv').config();
const bcrypt = require('bcryptjs');
const pool = require('../db/connection');
const { addAuditLog } = require('../db/audit');

async function main() {
    const [reg, name, email, password] = process.argv.slice(2);
    if (!reg || !name || !email || !password) {
        console.log('Usage: node scripts/createAdmin.js <regNumber> "<full name>" <email> "<password>"');
        process.exit(1);
    }
    if (password.length < 10) {
        console.log('Password must be at least 10 characters.');
        process.exit(1);
    }
    const hash = await bcrypt.hash(password, 12);
    await pool.query(
        `INSERT INTO students (reg_number, full_name, contact_email, password_hash, role, is_activated)
     VALUES (?, ?, ?, ?, 'admin', TRUE)`,
        [reg, name, email, hash]
    );
    await addAuditLog('ADMIN_CREATED', 'system', `Admin ${reg} created`);
    console.log('Admin created successfully.');
    process.exit(0);
}

main().catch(err => {
    console.error('Failed:', err.message);
    process.exit(1);
});