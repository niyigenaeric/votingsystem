const crypto = require('crypto');
const express = require('express');
const fs = require('fs/promises');
const path = require('path');
const multer = require('multer');
const pool = require('../db/connection');
const { addAuditLog } = require('../db/audit');
const { getTally } = require('../db/tally');
const { closeExpiredPositions } = require('../db/election');
const { stripLocationMetadata } = require('../db/imagePrivacy');
const { parseKigaliDateTime } = require('../db/schedule');
const { CAMPUSES, canonical } = require('../db/campuses');
const { MAX_MANIFESTO_LENGTH, isValidManifesto } = require('../db/candidateRules');
const { verifyToken, requireRole } = require('../middleware/auth');

const router = express.Router();
const DIR = path.resolve(process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads', 'candidates'));
const REG_RE = /^22[2-5]0[0-9]{5}$/;
const candidateUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024, fieldSize: 40000, fields: 5, files: 1 }
}).single('image');
const ext = b => (b.length > 2 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) ? 'jpg'
    : b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ? 'png'
        : (b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') ? 'webp' : null;
const wrap = fn => (req, res) => fn(req, res).catch(e => {
    console.error(e.code || '', e.sqlMessage || e.message);
    res.status(500).json({ message: 'Server error. Please try again or contact the administrator.' });
});
const ENTRY_CLOSED = { message: 'Candidate entry is closed for this position because it was closed by an admin or its deadline passed.' };

function parseCandidateUpload(req, res, next) {
    candidateUpload(req, res, error => {
        if (!error) return next();
        if (error instanceof multer.MulterError && error.code === 'LIMIT_UNEXPECTED_FILE') {
            return res.status(400).json({ message: 'Candidate image upload is invalid.' });
        }
        const message = error.code === 'LIMIT_FILE_SIZE'
            ? 'Candidate image must be 5 MB or smaller.'
            : error.code === 'LIMIT_FIELD_VALUE'
                ? 'A candidate information field is too long.'
                : 'Candidate image upload is invalid.';
        res.status(400).json({ message });
    });
}

async function sanitizeImage(buffer) {
    const clean = stripLocationMetadata(buffer).buffer;
    if (clean.length > 5 * 1024 * 1024) {
        const error = new Error('Processed image exceeds the 5 MB limit');
        error.code = 'IMAGE_TOO_LARGE';
        throw error;
    }
    return clean;
}

async function removeImage(file) {
    try {
        await fs.unlink(path.join(DIR, path.basename(file)));
    } catch (error) {
        if (error.code !== 'ENOENT') console.error('Candidate image cleanup failed:', error.message);
    }
}

async function candidateEntryState(positionId) {
    const [[position]] = await pool.query(
        `SELECT status, candidate_entry_closed, candidate_entry_deadline, voting_starts_at,
                (candidate_entry_deadline IS NOT NULL AND candidate_entry_deadline <= UTC_TIMESTAMP()) AS deadline_passed,
                (voting_starts_at IS NOT NULL AND voting_starts_at <= UTC_TIMESTAMP()) AS voting_start_reached
         FROM positions WHERE id = ?`,
        [positionId]
    );
    if (!position) return null;
    return {
        closed: position.status === 'closed' || !!position.candidate_entry_closed || !!position.deadline_passed
            || !!position.voting_start_reached,
        deadline: position.candidate_entry_deadline,
        votingStartsAt: position.voting_starts_at
    };
}

async function getElectionStatus() {
    await closeExpiredPositions();
    const [positions] = await pool.query('SELECT status FROM positions WHERE archived_at IS NULL');
    if (!positions.length || positions.every(position => position.status === 'setup')) return 'setup';
    if (positions.every(position => position.status === 'closed')) return 'closed';
    if (positions.every(position => position.status === 'open')) return 'open';
    return 'mixed';
}

router.get('/candidates', verifyToken, requireRole('admin', 'auditor'), wrap(async (req, res) => {
    await closeExpiredPositions();
    const [pos] = await pool.query(
        `SELECT id, title, campus, status, results_published, candidate_entry_closed, archived_at,
                CONCAT(DATE_FORMAT(DATE_ADD(voting_starts_at, INTERVAL 2 HOUR), '%Y-%m-%dT%H:%i:%s'), '+02:00') AS voting_starts_at,
                CONCAT(DATE_FORMAT(DATE_ADD(voting_ends_at, INTERVAL 2 HOUR), '%Y-%m-%dT%H:%i:%s'), '+02:00') AS voting_ends_at,
                CONCAT(DATE_FORMAT(DATE_ADD(candidate_entry_deadline, INTERVAL 2 HOUR), '%Y-%m-%dT%H:%i:%s'), '+02:00') AS candidate_entry_deadline,
                (candidate_entry_deadline IS NOT NULL AND candidate_entry_deadline <= UTC_TIMESTAMP()) AS candidate_entry_expired,
                (voting_starts_at IS NOT NULL AND voting_starts_at <= UTC_TIMESTAMP()) AS voting_start_reached,
                (status = 'setup' AND voting_starts_at > UTC_TIMESTAMP()) AS can_edit_candidates
         FROM positions ORDER BY archived_at IS NOT NULL, id`
    );
    const [c] = await pool.query(
        'SELECT id, position_id, full_name, reg_number, image_path, manifesto FROM candidates ORDER BY full_name'
    );
    res.json({
        status: await getElectionStatus(),
        positions: pos.map(p => ({
            id: p.id, title: p.title, campus: p.campus || null, status: p.status, published: !!p.results_published,
            archived: !!p.archived_at,
            candidateEntryDeadline: p.candidate_entry_deadline,
            votingStartsAt: p.voting_starts_at,
            votingEndsAt: p.voting_ends_at,
            candidateEntryClosed: p.status === 'closed' || !!p.candidate_entry_closed
                || !!p.candidate_entry_expired || !!p.voting_start_reached || !!p.archived_at,
            votingStartReached: !!p.voting_start_reached,
            canEditCandidates: !!p.can_edit_candidates,
            candidates: c.filter(x => x.position_id === p.id).map(x => ({
                id: x.id, name: x.full_name, regNumber: x.reg_number, imageUrl: x.image_path, manifesto: x.manifesto
            }))
        }))
    });
}));

router.post('/positions/candidate-entry', verifyToken, requireRole('admin'), wrap(async (req, res) => {
    const title = typeof req.body.title === 'string' ? req.body.title.trim() : '';
    const deadline = parseKigaliDateTime(req.body.deadline);
    const votingStart = parseKigaliDateTime(req.body.votingStart);
    const votingEnd = parseKigaliDateTime(req.body.votingEnd);
    const allCampuses = req.body.allCampuses === true;
    const campus = req.body.campus ? canonical(req.body.campus) : '';
    if (req.body.campus && !campus) return res.status(400).json({ message: 'Choose a valid campus' });
    if (!title || title.length > 100) return res.status(400).json({ message: 'Position name is required (100 characters maximum)' });
    if (!deadline || !votingStart || !votingEnd) {
        return res.status(400).json({ message: 'Enter valid candidate-entry, voting start, and voting end dates' });
    }
    const [[deadlineCheck]] = await pool.query(
        `SELECT ? > UTC_TIMESTAMP() AS deadline_future, ? > UTC_TIMESTAMP() AS voting_future,
                ? <= ? AS deadline_before_vote, ? < ? AS start_before_end`,
        [deadline, votingStart, deadline, votingStart, votingStart, votingEnd]
    );
    if (!deadlineCheck.deadline_future) return res.status(400).json({ message: 'The candidate-entry deadline must be in the future' });
    if (!deadlineCheck.voting_future) return res.status(400).json({ message: 'The voting start date must be in the future' });
    if (!deadlineCheck.deadline_before_vote) return res.status(400).json({ message: 'Candidate entry must end before or at the voting start time' });
    if (!deadlineCheck.start_before_end) return res.status(400).json({ message: 'The voting end date must be after the scheduled start time' });

    const campuses = allCampuses ? CAMPUSES : [campus];
    const connection = await pool.getConnection();
    const scheduled = [];
    try {
        await connection.beginTransaction();
        for (const campusName of campuses) {
            const [[archivedPosition]] = await connection.query(
                'SELECT id FROM positions WHERE title = ? AND campus = ? AND archived_at IS NOT NULL FOR UPDATE',
                [title, campusName]
            );
            if (archivedPosition) {
                await connection.rollback();
                return res.status(409).json({
                    message: 'A position with this name and campus is archived. Restore it before scheduling it again.'
                });
            }
            await connection.query(
                'INSERT IGNORE INTO positions (title, campus) VALUES (?, ?)',
                [title, campusName]
            );
            const [[position]] = await connection.query(
                'SELECT id, status, candidate_entry_closed FROM positions WHERE title = ? AND campus = ? AND archived_at IS NULL FOR UPDATE',
                [title, campusName]
            );
            if (!position || position.status === 'closed' || position.candidate_entry_closed) {
                await connection.rollback();
                return res.status(409).json(ENTRY_CLOSED);
            }
            const [updated] = await connection.query(
                `UPDATE positions
                 SET candidate_entry_deadline = ?, voting_starts_at = ?, voting_ends_at = ?
                 WHERE id = ? AND status = 'setup' AND archived_at IS NULL AND candidate_entry_closed = 0
                   AND (candidate_entry_deadline IS NULL OR candidate_entry_deadline > UTC_TIMESTAMP())
                   AND (voting_starts_at IS NULL OR voting_starts_at > UTC_TIMESTAMP())
                   AND ? > UTC_TIMESTAMP() AND ? > UTC_TIMESTAMP()`,
                [deadline, votingStart, votingEnd, position.id, deadline, votingStart]
            );
            if (!updated.affectedRows) {
                const [[current]] = await connection.query(
                    `SELECT candidate_entry_deadline, voting_starts_at FROM positions WHERE id = ?`,
                    [position.id]
                );
                if (!current || !current.candidate_entry_deadline || !current.voting_starts_at) {
                    await connection.rollback();
                    return res.status(409).json(ENTRY_CLOSED);
                }
            }
            scheduled.push({ id: Number(position.id), campus: campusName || null });
        }
        await connection.commit();
    } catch (error) {
        await connection.rollback();
        throw error;
    } finally {
        connection.release();
    }
    for (const position of scheduled) {
        await addAuditLog('POSITION_SCHEDULE_SET', req.user.regNumber,
            `position=${position.id}, title=${title}, campus=${position.campus || 'university-wide'}, candidateDeadline=${deadline}, votingStart=${votingStart}, votingEnd=${votingEnd}`);
    }
    res.status(200).json({ id: scheduled[0].id, positions: scheduled, title, deadline: req.body.deadline, votingStartsAt: req.body.votingStart, votingEndsAt: req.body.votingEnd });
}));

router.post('/candidates', verifyToken, requireRole('admin'),
    parseCandidateUpload,
    wrap(async (req, res) => {
        const body = req.body || {};
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        const position = typeof body.position === 'string' ? body.position.trim() : '';
        const manifesto = typeof body.manifesto === 'string' ? body.manifesto.trim() : '';
        const positionId = Number(body.positionId);
        const reg = typeof body.regNumber === 'string' ? body.regNumber.trim() : '';
        if (!Number.isSafeInteger(positionId) || positionId < 1) return res.status(400).json({ message: 'Choose a valid position' });
        if (!name || name.length > 100) return res.status(400).json({ message: 'Name is required (100 characters maximum)' });
        if (position.length > 100) return res.status(400).json({ message: 'Position name is invalid' });
        if (!isValidManifesto(manifesto)) {
            return res.status(400).json({ message: 'A candidate manifesto is required (10,000 characters maximum).' });
        }
        if (reg && !REG_RE.test(reg)) return res.status(400).json({ message: 'Registration number must look like 223007576, or leave it empty' });
        if (!req.file || !ext(req.file.buffer)) return res.status(400).json({ message: 'Choose a valid JPEG, PNG or WebP image' });
        if (reg) {
            const [stu] = await pool.query("SELECT id FROM students WHERE reg_number = ? AND role = 'voter'", [reg]);
            if (!stu.length) return res.status(400).json({ message: 'This registration number is not on the eligible list' });
        }

        const [[p]] = await pool.query('SELECT id, title, campus, archived_at FROM positions WHERE id = ?', [positionId]);
        if (!p) return res.status(404).json({ message: 'Choose the position and set its candidate-entry deadline first' });
        if (p.archived_at) return res.status(409).json({ message: 'This position is archived' });

        if (p.campus && !reg) return res.status(400).json({ message: 'A registration number is required for a campus position' });
        if (p.campus) {
            const [[st]] = await pool.query(`SELECT campus FROM students WHERE reg_number = ? AND role = 'voter'`, [reg]);
            if (!st || st.campus !== p.campus) return res.status(400).json({ message: 'This student is not registered on the ' + p.campus + ' campus' });
        }
        const entryState = await candidateEntryState(p.id);
        if (!entryState) return res.status(404).json({ message: 'Position not found' });
        if (entryState.closed) return res.status(409).json(ENTRY_CLOSED);
        if (!entryState.deadline) return res.status(409).json({ message: 'Set a candidate-entry deadline before adding candidates' });
        const [duplicates] = await pool.query(
            'SELECT id FROM candidates WHERE position_id = ? AND full_name = ?',
            [p.id, name]
        );
        if (duplicates.length) {
            return res.status(409).json({ message: 'A candidate with this name is already in this position' });
        }

        let cleanImage;
        try {
            cleanImage = await sanitizeImage(req.file.buffer);
        } catch (error) {
            if (error.code === 'IMAGE_TOO_LARGE') return res.status(400).json({ message: error.message });
            return res.status(400).json({ message: 'The image could not be decoded. Choose a valid JPEG, PNG or WebP image.' });
        }
        const file = crypto.randomUUID() + '.' + ext(req.file.buffer);
        await fs.mkdir(DIR, { recursive: true });
        await fs.writeFile(path.join(DIR, file), cleanImage, { flag: 'wx' });
        let id;
        try {
            const [r] = await pool.query(
                `INSERT INTO candidates (full_name, reg_number, position_id, image_path, manifesto)
                 SELECT ?, ?, id, ?, ? FROM positions
                 WHERE id = ? AND status = 'setup' AND archived_at IS NULL AND candidate_entry_closed = 0
                   AND candidate_entry_deadline > UTC_TIMESTAMP() AND voting_starts_at > UTC_TIMESTAMP()`,
                [name, reg || null, '/uploads/candidates/' + file, manifesto, p.id]
            );
            if (!r.affectedRows) {
                await removeImage(file);
                return res.status(409).json(ENTRY_CLOSED);
            }
            id = r.insertId;
        } catch (e) {
            await removeImage(file);
            if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ message: 'This student is already a candidate' });
            throw e;
        }
        await addAuditLog('CANDIDATE_ADDED', req.user.regNumber,
            'candidate=' + id + ', reg=' + (reg || 'none') + ', position=' + p.id + ', title=' + p.title);
        res.status(201).json({ id });
    }));

router.delete('/candidates/:id', verifyToken, requireRole('admin'), wrap(async (req, res) => {
    const id = Number.parseInt(req.params.id, 10);
    const [rows] = await pool.query(
        `SELECT c.reg_number, c.image_path, p.id AS position_id
         FROM candidates c JOIN positions p ON p.id = c.position_id WHERE c.id = ?`,
        [id]
    );
    if (!rows.length) return res.status(404).json({ message: 'Candidate not found' });
    const [deleted] = await pool.query(
        `DELETE c FROM candidates c JOIN positions p ON p.id = c.position_id
         WHERE c.id = ? AND p.status = 'setup' AND p.voting_starts_at > UTC_TIMESTAMP()`,
        [id]
    );
    if (!deleted.affectedRows) {
        const [[position]] = await pool.query(
            `SELECT status, (voting_starts_at IS NULL OR voting_starts_at <= UTC_TIMESTAMP()) AS edit_window_closed
             FROM positions WHERE id = ?`,
            [rows[0].position_id]
        );
        if (position && (position.status !== 'setup' || position.edit_window_closed)) {
            return res.status(409).json({ message: 'Candidates can only be changed before the scheduled voting start time' });
        }
        return res.status(404).json({ message: 'Candidate not found' });
    }
    await removeImage(path.basename(rows[0].image_path));
    await addAuditLog('CANDIDATE_REMOVED', req.user.regNumber, 'candidate=' + id + ', reg=' + rows[0].reg_number);
    res.json({ message: 'Candidate removed' });
}));

router.put('/candidates/:id', verifyToken, requireRole('admin'),
    parseCandidateUpload,
    wrap(async (req, res) => {
        const id = Number.parseInt(req.params.id, 10);
        const body = req.body || {};
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        const manifesto = typeof body.manifesto === 'string' ? body.manifesto.trim() : '';
        if (!name || name.length > 100) return res.status(400).json({ message: 'Name is required (100 characters maximum)' });
        if (!isValidManifesto(manifesto)) {
            return res.status(400).json({ message: 'A candidate manifesto is required (10,000 characters maximum).' });
        }
        const [rows] = await pool.query(
            `SELECT c.image_path, p.id AS position_id, p.status, p.voting_starts_at,
                    (p.voting_starts_at IS NOT NULL AND p.voting_starts_at > UTC_TIMESTAMP()) AS before_voting_start
             FROM candidates c JOIN positions p ON p.id = c.position_id WHERE c.id = ?`,
            [id]
        );
        if (!rows.length) return res.status(404).json({ message: 'Candidate not found' });
        if (rows[0].status !== 'setup' || !rows[0].before_voting_start) {
            return res.status(409).json({ message: 'Candidates can only be edited before the scheduled voting start time' });
        }
        let imagePath = rows[0].image_path, file = null;
        if (req.file) {
            if (!ext(req.file.buffer)) return res.status(400).json({ message: 'Choose a valid JPEG, PNG or WebP image' });
            let cleanImage;
            try {
                cleanImage = await sanitizeImage(req.file.buffer);
            } catch (error) {
                if (error.code === 'IMAGE_TOO_LARGE') return res.status(400).json({ message: error.message });
                return res.status(400).json({ message: 'The image could not be decoded. Choose a valid JPEG, PNG or WebP image.' });
            }
            file = crypto.randomUUID() + '.' + ext(req.file.buffer);
            await fs.mkdir(DIR, { recursive: true });
            await fs.writeFile(path.join(DIR, file), cleanImage, { flag: 'wx' });
            imagePath = '/uploads/candidates/' + file;
        }
        try {
            const [updated] = await pool.query(
                `UPDATE candidates c JOIN positions p ON p.id = c.position_id
                 SET c.full_name = ?, c.image_path = ?, c.manifesto = ?
                 WHERE c.id = ? AND p.status = 'setup' AND p.voting_starts_at > UTC_TIMESTAMP()`,
                [name, imagePath, manifesto, id]
            );
            if (!updated.affectedRows) {
                if (file) await removeImage(file);
                return res.status(409).json(ENTRY_CLOSED);
            }
        } catch (e) {
            if (file) await removeImage(file);
            throw e;
        }
        if (file) await removeImage(path.basename(rows[0].image_path));
        await addAuditLog('CANDIDATE_UPDATED', req.user.regNumber,
            'candidate=' + id + (file ? ', photo replaced' : '') + ', manifesto updated');
        res.json({ message: 'Candidate updated' });
    }));

router.get('/results', verifyToken, requireRole('admin', 'auditor'), wrap(async (req, res) => {
    await closeExpiredPositions();
    res.json(await getTally());
}));

router.post('/positions/:id/archive', verifyToken, requireRole('admin'), wrap(async (req, res) => {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ message: 'Position ID is invalid' });
    const [[position]] = await pool.query(
        'SELECT title, status, archived_at FROM positions WHERE id = ?',
        [id]
    );
    if (!position) return res.status(404).json({ message: 'Position not found' });
    if (position.archived_at) return res.status(409).json({ message: 'Position is already archived' });
    if (position.status !== 'closed') {
        return res.status(409).json({ message: 'Only closed positions can be archived' });
    }
    const [updated] = await pool.query(
        `UPDATE positions SET archived_at = UTC_TIMESTAMP()
         WHERE id = ? AND status = 'closed' AND archived_at IS NULL`,
        [id]
    );
    if (!updated.affectedRows) return res.status(409).json({ message: 'Position state changed; refresh and try again' });
    await addAuditLog('POSITION_ARCHIVED', req.user.regNumber, `position=${id}, title=${position.title}`);
    res.json({ id, archived: true });
}));

router.post('/positions/:id/restore', verifyToken, requireRole('admin'), wrap(async (req, res) => {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ message: 'Position ID is invalid' });
    const [[position]] = await pool.query(
        'SELECT title, status, archived_at FROM positions WHERE id = ?',
        [id]
    );
    if (!position) return res.status(404).json({ message: 'Position not found' });
    if (!position.archived_at) return res.status(409).json({ message: 'Position is not archived' });
    if (position.status !== 'closed') return res.status(409).json({ message: 'Only closed positions can be restored from archive' });
    const [updated] = await pool.query(
        `UPDATE positions SET archived_at = NULL
         WHERE id = ? AND status = 'closed' AND archived_at IS NOT NULL`,
        [id]
    );
    if (!updated.affectedRows) return res.status(409).json({ message: 'Position state changed; refresh and try again' });
    await addAuditLog('POSITION_RESTORED', req.user.regNumber, `position=${id}, title=${position.title}`);
    res.json({ id, archived: false });
}));

router.post('/positions/:id/status', verifyToken, requireRole('admin'), wrap(async (req, res) => {
    await closeExpiredPositions();
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ message: 'Position ID is invalid' });
    const next = req.body && req.body.status;
    const [[position]] = await pool.query('SELECT title, status FROM positions WHERE id = ?', [id]);
    if (!position) return res.status(404).json({ message: 'Position not found' });
    if (!((position.status === 'setup' && next === 'open') || (position.status === 'open' && next === 'closed'))) {
        return res.status(409).json({ message: 'This position cannot make that status change' });
    }
    if (next === 'open') {
        const [[schedule]] = await pool.query(
            `SELECT voting_starts_at, voting_ends_at,
                    (voting_starts_at IS NOT NULL AND voting_starts_at <= UTC_TIMESTAMP()) AS start_reached,
                    (voting_ends_at IS NOT NULL AND voting_ends_at > UTC_TIMESTAMP()) AS end_not_reached
             FROM positions WHERE id = ?`,
            [id]
        );
        if (!schedule.voting_starts_at) {
            return res.status(409).json({ message: 'Set a voting start date for this position before opening voting' });
        }
        if (!schedule.start_reached) {
            return res.status(409).json({ message: 'Voting cannot open before its scheduled start time' });
        }
        if (!schedule.end_not_reached) {
            return res.status(409).json({ message: 'The scheduled voting end time has passed' });
        }
        const [[result]] = await pool.query('SELECT COUNT(*) AS total FROM candidates WHERE position_id = ?', [id]);
        if (!result.total) return res.status(400).json({ message: 'Add at least one candidate before opening this position' });
    }
    const [result] = await pool.query(
        `UPDATE positions SET status = ? WHERE id = ? AND status = ?
         AND (? <> 'open' OR voting_ends_at > UTC_TIMESTAMP())`,
        [next, id, position.status]
    );
    if (!result.affectedRows) return res.status(409).json({ message: 'Position status changed; refresh and try again' });
    await addAuditLog('POSITION_' + next.toUpperCase(), req.user.regNumber, `position=${id}, title=${position.title}`);
    res.json({ id, status: next });
}));

router.post('/positions/:id/candidate-entry/close', verifyToken, requireRole('admin'), wrap(async (req, res) => {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ message: 'Position ID is invalid' });
    const [[position]] = await pool.query('SELECT title, candidate_entry_closed FROM positions WHERE id = ?', [id]);
    if (!position) return res.status(404).json({ message: 'Position not found' });
    if (position.candidate_entry_closed) return res.status(409).json({ message: 'Candidate entry is already closed for this position' });
    const [updated] = await pool.query(
        'UPDATE positions SET candidate_entry_closed = 1 WHERE id = ? AND candidate_entry_closed = 0',
        [id]
    );
    if (!updated.affectedRows) return res.status(409).json({ message: 'Candidate entry state changed; refresh and try again' });
    await addAuditLog('CANDIDATE_ENTRY_CLOSED', req.user.regNumber, `position=${id}, title=${position.title}`);
    res.json({ id, candidateEntryClosed: true });
}));

router.post('/positions/:id/results/publish', verifyToken, requireRole('admin'), wrap(async (req, res) => {
    await closeExpiredPositions();
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ message: 'Position ID is invalid' });
    const [tally] = await pool.query(
        `SELECT c.id, COUNT(v.id) AS votes
         FROM candidates c LEFT JOIN votes v ON v.candidate_id = c.id AND v.position_id = ?
         WHERE c.position_id = ?
         GROUP BY c.id ORDER BY c.id`,
        [id, id]
    );
    const [[position]] = await pool.query('SELECT title, status, results_published FROM positions WHERE id = ?', [id]);
    if (!position) return res.status(404).json({ message: 'Position not found' });
    if (position.status !== 'closed') return res.status(409).json({ message: 'Close this position before publishing its results' });
    if (position.results_published) return res.status(409).json({ message: 'Results for this position are already published' });
    const hash = crypto.createHash('sha256')
        .update(JSON.stringify([id, position.title, tally.map(row => [row.id, Number(row.votes)])]))
        .digest('hex');
    const [r] = await pool.query(
        'UPDATE positions SET results_published = 1, published_at = UTC_TIMESTAMP(), results_hash = ? WHERE id = ? AND status = ? AND results_published = 0',
        [hash, id, 'closed']
    );
    if (!r.affectedRows) return res.status(409).json({ message: 'Results are already published' });
    await addAuditLog('POSITION_RESULTS_PUBLISHED', req.user.regNumber, `position=${id}, title=${position.title}, sha256=${hash}`);
    res.json({ id, published: true, hash });
}));

router.use((err, req, res, next) => {
    if (err.type === 'entity.too.large') return res.status(413).json({ message: 'Image must be 5 MB or smaller' });
    if (err.code === 'IMAGE_TOO_LARGE') return res.status(400).json({ message: err.message });
    next(err);
});

module.exports = router;