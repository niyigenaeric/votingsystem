require('dotenv').config();
const pool = require('../db/connection');

const VERSION = '20261026_kigali_utc_schedule';

async function hasTable(table) {
    const [[result]] = await pool.query(
        'SELECT COUNT(*) AS count FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?',
        [table]
    );
    return Number(result.count) > 0;
}

async function ensureColumn(table, name, definition) {
    const [columns] = await pool.query(`SHOW COLUMNS FROM \`${table}\``);
    if (!columns.some(column => column.Field === name)) {
        await pool.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${name}\` ${definition}`);
    }
}

async function ensureIndex(table, name, columns, unique = false) {
    const [indexes] = await pool.query(`SHOW INDEX FROM \`${table}\``);
    if (indexes.some(index => index.Key_name === name)) return;
    const clause = unique ? 'UNIQUE ' : '';
    const names = columns.map(column => `\`${column}\``).join(', ');
    await pool.query(`ALTER TABLE \`${table}\` ADD ${clause}INDEX \`${name}\` (${names})`);
}

async function main() {
    for (const table of ['students', 'positions', 'candidates', 'votes']) {
        if (!(await hasTable(table))) throw new Error(`Required table "${table}" is missing. Import schema.sql first.`);
    }
    const [existingPositionColumns] = await pool.query('SHOW COLUMNS FROM positions');
    const existingPositionColumnNames = new Set(existingPositionColumns.map(column => column.Field));
    if (existingPositionColumnNames.has('status')) {
        const endCondition = existingPositionColumnNames.has('voting_ends_at') ? 'voting_ends_at IS NULL' : '1 = 1';
        const [openWithoutEnd] = await pool.query(
            `SELECT id, title FROM positions WHERE status = 'open' AND ${endCondition} LIMIT 10`
        );
        if (openWithoutEnd.length) {
            throw new Error(
                'Open positions need an approved voting_ends_at UTC value before migration. Add the column and set an end time for each open position, then rerun the migration.'
            );
        }
    }

    await ensureColumn('students', 'campus', 'VARCHAR(50) NULL');
    await ensureColumn('students', 'role', "ENUM('voter','admin','auditor') NOT NULL DEFAULT 'voter'");
    await ensureColumn('students', 'is_activated', 'TINYINT(1) NOT NULL DEFAULT 0');
    await ensureColumn('students', 'password_hash', 'VARCHAR(255) NULL');
    await ensureColumn('students', 'failed_attempts', 'INT UNSIGNED NOT NULL DEFAULT 0');
    await ensureColumn('students', 'locked_until', 'DATETIME NULL');
    for (const column of ['reg_number', 'contact_email']) {
        const [[duplicates]] = await pool.query(
            `SELECT COUNT(*) AS count FROM (
                SELECT \`${column}\`
                FROM students
                GROUP BY \`${column}\`
                HAVING COUNT(*) > 1
            ) AS duplicate_accounts`
        );
        if (Number(duplicates.count)) {
            throw new Error(`Duplicate students.${column} values exist. Resolve them before enforcing account uniqueness.`);
        }
    }
    await ensureIndex('students', 'uq_students_reg_number', ['reg_number'], true);
    await ensureIndex('students', 'uq_students_email', ['contact_email'], true);

    await ensureColumn('positions', 'campus', "VARCHAR(50) NOT NULL DEFAULT ''");
    await pool.query("UPDATE positions SET campus = '' WHERE campus IS NULL");
    await pool.query("ALTER TABLE positions MODIFY campus VARCHAR(50) NOT NULL DEFAULT ''");
    await ensureColumn('positions', 'status', "ENUM('setup','open','closed') NOT NULL DEFAULT 'setup'");
    await ensureColumn('positions', 'candidate_entry_deadline', 'DATETIME NULL');
    await ensureColumn('positions', 'candidate_entry_closed', 'TINYINT(1) NOT NULL DEFAULT 0');
    await ensureColumn('positions', 'voting_starts_at', 'DATETIME NULL');
    await ensureColumn('positions', 'voting_ends_at', 'DATETIME NULL');
    await ensureColumn('positions', 'results_published', 'TINYINT(1) NOT NULL DEFAULT 0');
    await ensureColumn('positions', 'published_at', 'DATETIME NULL');
    await ensureColumn('positions', 'results_hash', 'CHAR(64) NULL');

    const [positionIndexes] = await pool.query('SHOW INDEX FROM positions');
    const groupedIndexes = new Map();
    positionIndexes.forEach(index => {
        const entries = groupedIndexes.get(index.Key_name) || [];
        entries.push(index);
        groupedIndexes.set(index.Key_name, entries);
    });
    for (const [name, indexes] of groupedIndexes) {
        if (name !== 'PRIMARY' && Number(indexes[0].Non_unique) === 0
            && indexes.length === 1 && indexes[0].Column_name === 'title') {
            await pool.query(`ALTER TABLE positions DROP INDEX \`${name.replace(/`/g, '``')}\``);
        }
    }
    await ensureIndex('positions', 'uq_positions_title_campus', ['title', 'campus'], true);
    await ensureIndex('positions', 'idx_positions_status_end', ['status', 'voting_ends_at']);

    await ensureColumn('candidates', 'reg_number', 'VARCHAR(20) NULL');
    await ensureColumn('candidates', 'position_id', 'INT NULL');
    await ensureColumn('candidates', 'image_path', 'VARCHAR(255) NULL');
    await ensureIndex('candidates', 'uq_candidates_id_position', ['id', 'position_id'], true);
    await ensureIndex('candidates', 'uq_candidates_position_reg', ['position_id', 'reg_number'], true);

    const [[studentId]] = await pool.query('SHOW COLUMNS FROM students LIKE "id"');
    if (!studentId || !studentId.Type) throw new Error('Could not determine the students.id database type.');
    await pool.query(`CREATE TABLE IF NOT EXISTS voter_accounts (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        reg_number VARCHAR(20) NOT NULL,
        full_name VARCHAR(100) NOT NULL,
        email VARCHAR(150) NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        failed_attempts INT UNSIGNED NOT NULL DEFAULT 0,
        locked_until DATETIME NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_voter_accounts_reg_number (reg_number),
        UNIQUE KEY uq_voter_accounts_email (email)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    await pool.query(`INSERT IGNORE INTO voter_accounts
        (reg_number, full_name, email, password_hash, failed_attempts, locked_until)
        SELECT reg_number, full_name, contact_email, password_hash, failed_attempts, locked_until
        FROM students
        WHERE role = 'voter' AND is_activated = 1 AND password_hash IS NOT NULL`);
    if (await hasTable('voter_registration_requests')) {
        const [requestColumns] = await pool.query('SHOW COLUMNS FROM voter_registration_requests');
        if (requestColumns.some(column => column.Field === 'password_hash')) {
            await pool.query(`INSERT IGNORE INTO voter_accounts (reg_number, full_name, email, password_hash)
                SELECT s.reg_number, r.requested_full_name, r.requested_email, r.password_hash
                FROM voter_registration_requests r
                JOIN students s ON s.id = r.student_id
                WHERE r.status = 'pending' AND r.password_hash IS NOT NULL`);
            await pool.query('ALTER TABLE voter_registration_requests MODIFY password_hash VARCHAR(255) NULL');
            await pool.query('UPDATE voter_registration_requests SET password_hash = NULL');
        }
    }
    await pool.query(`CREATE TABLE IF NOT EXISTS voter_receipts (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        student_id ${studentId.Type} NOT NULL,
        position_id INT NOT NULL,
        receipt_hash CHAR(64) NOT NULL,
        UNIQUE KEY uq_voter_receipt_student_position (student_id, position_id),
        UNIQUE KEY uq_voter_receipt_hash (receipt_hash),
        KEY idx_voter_receipts_position (position_id),
        CONSTRAINT fk_voter_receipts_student FOREIGN KEY (student_id) REFERENCES students(id)
            ON UPDATE CASCADE ON DELETE RESTRICT,
        CONSTRAINT fk_voter_receipts_position FOREIGN KEY (position_id) REFERENCES positions(id)
            ON UPDATE CASCADE ON DELETE RESTRICT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

    if (!(await hasTable('otp_codes'))) {
        await pool.query(`CREATE TABLE otp_codes (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
            student_id ${studentId.Type} NOT NULL,
            purpose ENUM('activation', 'admin_login') NOT NULL DEFAULT 'activation',
            code_hash VARCHAR(255) NOT NULL,
            attempts TINYINT UNSIGNED NOT NULL DEFAULT 0,
            expires_at DATETIME NOT NULL,
            used TINYINT(1) NOT NULL DEFAULT 0,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            KEY idx_otp_student_purpose_expiry (student_id, purpose, expires_at, used),
            CONSTRAINT fk_otp_codes_student FOREIGN KEY (student_id) REFERENCES students(id)
                ON UPDATE CASCADE ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    } else {
        await ensureColumn('otp_codes', 'purpose', "ENUM('activation','admin_login') NOT NULL DEFAULT 'activation'");
        await ensureColumn('otp_codes', 'attempts', 'TINYINT UNSIGNED NOT NULL DEFAULT 0');
        await ensureIndex('otp_codes', 'idx_otp_student_purpose_expiry', ['student_id', 'purpose', 'expires_at', 'used']);
    }

    await pool.query(`CREATE TABLE IF NOT EXISTS audit_log (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        event_type VARCHAR(64) NOT NULL,
        actor VARCHAR(100) NOT NULL,
        details TEXT NOT NULL,
        prev_hash CHAR(64) NOT NULL,
        entry_hash CHAR(64) NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        KEY idx_audit_log_created (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    await pool.query(`CREATE TABLE IF NOT EXISTS app_migrations (
        version VARCHAR(100) NOT NULL PRIMARY KEY,
        applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

    const [[migration]] = await pool.query('SELECT version FROM app_migrations WHERE version = ?', [VERSION]);
    if (!migration) {
        const connection = await pool.getConnection();
        try {
            await connection.beginTransaction();
            await connection.query(`UPDATE positions
                SET candidate_entry_deadline = DATE_SUB(candidate_entry_deadline, INTERVAL 2 HOUR),
                    voting_starts_at = DATE_SUB(voting_starts_at, INTERVAL 2 HOUR)
                WHERE candidate_entry_deadline IS NOT NULL OR voting_starts_at IS NOT NULL`);
            await connection.query('INSERT INTO app_migrations (version) VALUES (?)', [VERSION]);
            await connection.commit();
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }
        console.log('Existing Kigali-local schedule values converted to UTC storage.');
    }
    console.log('Database schema migration completed.');
}

main()
    .catch(error => {
        console.error('Database schema migration failed:', error.message);
        process.exitCode = 1;
    })
    .finally(() => pool.end());
