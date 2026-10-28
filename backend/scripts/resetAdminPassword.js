require('dotenv').config();
const bcrypt = require('bcryptjs');
const pool = require('../db/connection');
const { addAuditLog } = require('../db/audit');

async function main() {
  const [username, password] = process.argv.slice(2);
  if (!username || !password || password.length < 10) {
    console.log('Usage: node scripts/resetAdminPassword.js <username> "<password, at least 10 characters>"');
    process.exit(1);
  }
  const hash = await bcrypt.hash(password, 12);
  const [result] = await pool.query(
    `UPDATE students
     SET password_hash = ?, failed_attempts = 0, locked_until = NULL
     WHERE username = ? AND role = 'admin'`,
    [hash, username]
  );
  if (result.affectedRows === 0) {
    console.log('No admin found with that username.');
    process.exit(1);
  }
  await addAuditLog('ADMIN_PASSWORD_RESET', 'system', `Password reset for ${username}`);
  console.log('Password reset. You can sign in now.');
  process.exit(0);
}

main().catch(err => { console.error('Failed:', err.message); process.exit(1); });
