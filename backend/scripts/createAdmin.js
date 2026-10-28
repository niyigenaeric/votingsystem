require('dotenv').config();
const bcrypt = require('bcryptjs');
const pool = require('../db/connection');
const { addAuditLog } = require('../db/audit');

async function main() {
    const [username, name, email, universityPosition, password] = process.argv.slice(2);
    if (!username || !username.trim() || !name || !name.trim() || !email || !email.trim()
        || !universityPosition || !universityPosition.trim() || !password) {
        console.log('Usage: node scripts/createAdmin.js <username> "<full name>" <email> "<university position>" "<password>"');
        process.exit(1);
    }
    if (username.trim().length > 20) {
        console.log('Username must be 20 characters or fewer.');
        process.exit(1);
    }
    if (universityPosition.trim().length > 100) {
        console.log('University position must be 100 characters or fewer.');
        process.exit(1);
    }
    if (password.length < 10) {
        console.log('Password must be at least 10 characters.');
        process.exit(1);
    }
    const hash = await bcrypt.hash(password, 12);
    const normalizedUsername = username.trim();
    await pool.query(
        `INSERT INTO students
         (reg_number, username, full_name, contact_email, university_position, password_hash, role, is_activated)
         VALUES (?, ?, ?, ?, ?, ?, 'admin', TRUE)`,
        [normalizedUsername, normalizedUsername, name.trim(), email.trim().toLowerCase(), universityPosition.trim(), hash]
    );
    await addAuditLog('ADMIN_CREATED', 'system', `Admin ${normalizedUsername} created`);
    console.log('Admin created successfully.');
    process.exit(0);
}

main().catch(err => {
    console.error('Failed:', err.message);
    process.exit(1);
});