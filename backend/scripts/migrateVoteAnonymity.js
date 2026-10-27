require('dotenv').config();
const pool = require('../db/connection');

const VERSION = '20261027_vote_anonymity';

async function main() {
    if (!process.argv.includes('--confirm-backup')) {
        throw new Error('Take a database backup first, then run again with --confirm-backup.');
    }

    await pool.query(`CREATE TABLE IF NOT EXISTS app_migrations (
        version VARCHAR(100) NOT NULL PRIMARY KEY,
        applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    const [[done]] = await pool.query('SELECT version FROM app_migrations WHERE version = ?', [VERSION]);
    if (done) {
        console.log('This migration was already applied.');
        return;
    }

    const [tables] = await pool.query(
        `SELECT TABLE_NAME AS name
         FROM information_schema.TABLES
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('votes', 'voter_receipts')`
    );
    const existingTables = new Set(tables.map(table => table.name));
    for (const table of ['votes', 'voter_receipts']) {
        if (!existingTables.has(table)) throw new Error(`Required table "${table}" is missing.`);
    }

    const [triggers] = await pool.query(
        `SELECT TRIGGER_NAME AS name, EVENT_OBJECT_TABLE AS tableName
         FROM information_schema.TRIGGERS
         WHERE TRIGGER_SCHEMA = DATABASE() AND EVENT_OBJECT_TABLE IN ('votes', 'voter_receipts')`
    );
    if (triggers.length) {
        throw new Error('Triggers touch the vote tables. Review and drop them first: '
            + triggers.map(trigger => `${trigger.name} on ${trigger.tableName}`).join(', '));
    }

    const [voteColumns] = await pool.query('SHOW COLUMNS FROM votes');
    const hasVoteColumn = name => voteColumns.some(column => column.Field === name);
    const idColumn = voteColumns.find(column => column.Field === 'id');
    if (!idColumn || !/^char\(32\)$/i.test(idColumn.Type)) {
        throw new Error('Unexpected votes.id type: ' + (idColumn ? idColumn.Type : 'missing')
            + '. Send me SHOW CREATE TABLE votes.');
    }

    if (hasVoteColumn('anonymous_id')) {
        const [[used]] = await pool.query('SELECT COUNT(anonymous_id) AS filled FROM votes');
        console.log(`Dropping votes.anonymous_id (${used.filled} rows had a value).`);
        await pool.query('ALTER TABLE votes DROP COLUMN anonymous_id');
    }
    if (hasVoteColumn('created_at')) await pool.query('ALTER TABLE votes DROP COLUMN created_at');

    const [receiptColumns] = await pool.query('SHOW COLUMNS FROM voter_receipts');
    if (receiptColumns.some(column => column.Field === 'created_at')) {
        await pool.query('ALTER TABLE voter_receipts DROP COLUMN created_at');
    }

    await pool.query('UPDATE votes SET id = LOWER(HEX(RANDOM_BYTES(16)))');
    await pool.query('OPTIMIZE TABLE votes');
    await pool.query('OPTIMIZE TABLE voter_receipts');
    await pool.query('INSERT INTO app_migrations (version) VALUES (?)', [VERSION]);
    console.log('Vote anonymity migration completed.');
}

main()
    .catch(error => {
        console.error('Vote anonymity migration failed:', error.message);
        process.exitCode = 1;
    })
    .finally(() => pool.end());
