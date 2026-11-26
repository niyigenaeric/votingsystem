const crypto = require('crypto');
const express = require('express');
const fs = require('fs/promises');
const path = require('path');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const pool = require('../db/connection');
const { addAuditLog, lockAuditLog, appendAuditLog, releaseAuditLogLock } = require('../db/audit');
const { getTally } = require('../db/tally');
const { closeExpiredPositions } = require('../db/election');
const { stripLocationMetadata } = require('../db/imagePrivacy');
const { parseKigaliDateTime } = require('../db/schedule');
const { CAMPUSES, canonical } = require('../db/campuses');
const { MAX_MANIFESTO_LENGTH, canRescheduleCandidateEntry, canReschedulePosition, isValidManifesto } = require('../db/candidateRules');
const { hashPublishedResults } = require('../db/resultIntegrity');
const { verifyToken, requireRole } = require('../middleware/auth');
const { parsePositionVoterCsv } = require('../db/positionVoterCsv');

const router = express.Router();
const cloudinaryConfigured = Boolean(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET);
if (cloudinaryConfigured) {
    cloudinary.config({
        cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
        api_key: process.env.CLOUDINARY_API_KEY,
        api_secret: process.env.CLOUDINARY_API_SECRET
    });
}
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
const ENTRY_CLOSED = { message: 'Candidate entry is unavailable. Refresh the position and check its status and schedule.' };

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

function resolveCandidateImageUrl(imagePath) {
    if (!imagePath) return imagePath || null;
    if (/^https?:\/\//i.test(imagePath)) return imagePath;
    return `${process.env.APP_BASE_URL || 'http://localhost:5000'}${imagePath}`;
}

async function uploadCandidateImage(buffer) {
    if (cloudinaryConfigured) {
        const result = await new Promise((resolve, reject) => {
            const stream = cloudinary.uploader.upload_stream({
                folder: 'voting-system/candidates',
                resource_type: 'image',
                transformation: [{ quality: 'auto', fetch_format: 'auto' }]
            }, (error, response) => {
                if (error) return reject(error);
                resolve(response);
            });
            stream.end(buffer);
        });
        return { imageUrl: result.secure_url, publicId: result.public_id };
    }
    const file = `${crypto.randomUUID()}.${ext(buffer)}`;
    await fs.mkdir(DIR, { recursive: true });
    const imagePath = '/uploads/candidates/' + file;
    await fs.writeFile(path.join(DIR, file), buffer, { flag: 'wx' });
    return { imageUrl: imagePath, publicId: null };
}

async function removeImage(imagePath, publicId) {
    if (cloudinaryConfigured && publicId) {
        try {
            await cloudinary.uploader.destroy(publicId, { resource_type: 'image' });
        } catch (error) {
            console.error('Candidate Cloudinary cleanup failed:', error.message);
        }
        return;
    }
    if (!imagePath) return;
    try {
        await fs.unlink(path.join(DIR, path.basename(imagePath)));
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
    const votingStartReached = !!position.voting_start_reached;
    const entryManuallyClosed = !!position.candidate_entry_closed;
    const deadlinePassed = !!position.deadline_passed;
    return {
        closed: position.status === 'closed' || entryManuallyClosed || deadlinePassed || votingStartReached,
        message: position.status === 'closed'
            ? 'This position is closed and cannot accept candidates.'
            : votingStartReached
                ? 'Candidate details are locked because the scheduled voting start has passed.'
                : entryManuallyClosed
                    ? 'Candidate entry was closed by an administrator. Set a new deadline before voting begins to reopen it.'
                    : deadlinePassed
                        ? 'The candidate-entry deadline passed. Set a new future deadline before voting begins.'
                        : null,
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
                position_voter_list_uploaded_at,
                (SELECT COUNT(*) FROM position_voters WHERE position_id = positions.id) AS voter_list_count,
                CONCAT(DATE_FORMAT(DATE_ADD(voting_starts_at, INTERVAL 2 HOUR), '%Y-%m-%dT%H:%i:%s'), '+02:00') AS voting_starts_at,
                CONCAT(DATE_FORMAT(DATE_ADD(voting_ends_at, INTERVAL 2 HOUR), '%Y-%m-%dT%H:%i:%s'), '+02:00') AS voting_ends_at,
                CONCAT(DATE_FORMAT(DATE_ADD(candidate_entry_deadline, INTERVAL 2 HOUR), '%Y-%m-%dT%H:%i:%s'), '+02:00') AS candidate_entry_deadline,
                (candidate_entry_deadline IS NOT NULL AND candidate_entry_deadline <= UTC_TIMESTAMP()) AS candidate_entry_expired,
                (voting_starts_at IS NOT NULL AND voting_starts_at <= UTC_TIMESTAMP()) AS voting_start_reached,
                (status = 'setup' AND voting_starts_at > UTC_TIMESTAMP()) AS can_edit_candidates,
                EXISTS(
                    SELECT 1 FROM candidates position_candidates
                    JOIN votes ON votes.candidate_id = position_candidates.id
                    WHERE position_candidates.position_id = positions.id
                ) AS has_votes
         FROM positions ORDER BY archived_at IS NOT NULL, id`
    );
    const [c] = await pool.query(
        'SELECT id, position_id, full_name, reg_number, image_path, image_public_id, manifesto FROM candidates ORDER BY full_name'
    );
    res.json({
        status: await getElectionStatus(),
        positions: pos.map(p => ({
            id: p.id, title: p.title, campus: p.campus || null, status: p.status, published: !!p.results_published,
            archived: !!p.archived_at,
            voterListCount: Number(p.voter_list_count),
            voterListUploadedAt: p.position_voter_list_uploaded_at,
            candidateEntryDeadline: p.candidate_entry_deadline,
            votingStartsAt: p.voting_starts_at,
            votingEndsAt: p.voting_ends_at,
            candidateEntryClosed: p.status === 'closed' || !!p.candidate_entry_closed
                || !!p.candidate_entry_expired || !!p.voting_start_reached || !!p.archived_at,
            votingStartReached: !!p.voting_start_reached,
            canEditCandidates: !!p.can_edit_candidates && !p.archived_at,
            canReschedule: canReschedulePosition({
                status: p.status,
                archived: !!p.archived_at,
                hasVotes: !!p.has_votes
            }),
            candidates: c.filter(x => x.position_id === p.id).map(x => ({
                id: x.id, name: x.full_name, regNumber: x.reg_number, imageUrl: resolveCandidateImageUrl(x.image_path), manifesto: x.manifesto
            }))
        }))
    });
}));

router.post('/positions/:id/voter-list', verifyToken, requireRole('admin'),
    express.text({ type: ['text/csv', 'text/plain'], limit: '1mb' }),
    wrap(async (req, res) => {
        const id = Number.parseInt(req.params.id, 10);
        if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ message: 'Position ID is invalid.' });
        if (typeof req.body !== 'string') return res.status(400).json({ message: 'Send the CSV as text/csv.' });
        const parsed = parsePositionVoterCsv(req.body);
        if (parsed.error) return res.status(400).json({ message: parsed.error });
        if (parsed.received > 5000) return res.status(400).json({ message: 'Maximum 5000 voter emails per position.' });
        if (parsed.invalid.length) {
            return res.status(400).json({
                message: 'The position voter CSV was not uploaded. Correct every row and try again.',
                invalidLines: parsed.invalid.slice(0, 20)
            });
        }

        const connection = await pool.getConnection();
        let auditLockAcquired = false;
        try {
            await connection.beginTransaction();
            const [[position]] = await connection.query(
                `SELECT id, title, campus, status, archived_at
                 FROM positions WHERE id = ? FOR UPDATE`,
                [id]
            );
            if (!position) {
                await connection.rollback();
                return res.status(404).json({ message: 'Position not found.' });
            }
            if (position.archived_at || position.status !== 'setup') {
                await connection.rollback();
                return res.status(409).json({ message: 'The voter list can only be uploaded or replaced before this position opens.' });
            }

            const [students] = await connection.query(
                `SELECT id, contact_email, campus FROM students
                 WHERE role = 'voter' AND LOWER(contact_email) IN (?)`,
                [parsed.emails]
            );
            const studentsByEmail = new Map(students.map(student => [student.contact_email.trim().toLowerCase(), student]));
            const invalidLines = [];
            const matchedStudents = [];
            parsed.emails.forEach((email, index) => {
                const student = studentsByEmail.get(email);
                if (!student) {
                    invalidLines.push(`Line ${index + 2}: email is not on the official eligible voter roster`);
                } else if (position.campus && position.campus !== student.campus) {
                    invalidLines.push(`Line ${index + 2}: voter is not on the official roster for this position's campus`);
                } else {
                    matchedStudents.push(student);
                }
            });
            if (invalidLines.length) {
                await connection.rollback();
                return res.status(400).json({
                    message: 'The position voter CSV was not uploaded. Correct every row and try again.',
                    invalidLines: invalidLines.slice(0, 20)
                });
            }

            await connection.query('DELETE FROM position_voters WHERE position_id = ?', [id]);
            await connection.query(
                'INSERT INTO position_voters (position_id, student_id) VALUES ?',
                [matchedStudents.map(student => [id, student.id])]
            );
            await connection.query(
                'UPDATE positions SET position_voter_list_uploaded_at = UTC_TIMESTAMP() WHERE id = ? AND status = ?',
                [id, 'setup']
            );
            await lockAuditLog(connection);
            auditLockAcquired = true;
            await appendAuditLog(connection, 'POSITION_VOTER_LIST_UPLOADED', req.user.regNumber,
                `position=${id}, title=${position.title}, eligibleEmails=${matchedStudents.length}`);
            await connection.commit();
            res.json({ positionId: id, eligibleVoters: matchedStudents.length });
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            if (auditLockAcquired) await releaseAuditLogLock(connection);
            connection.release();
        }
    }));

router.put('/positions/:id', verifyToken, requireRole('admin'), wrap(async (req, res) => {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ message: 'Position ID is invalid' });
    const title = typeof req.body.title === 'string' ? req.body.title.trim() : '';
    const campus = typeof req.body.campus === 'string' && req.body.campus.trim()
        ? canonical(req.body.campus)
        : '';
    const deadline = parseKigaliDateTime(req.body.deadline);
    const votingStart = parseKigaliDateTime(req.body.votingStart);
    const votingEnd = parseKigaliDateTime(req.body.votingEnd);
    if (!title || title.length > 100) {
        return res.status(400).json({ message: 'Position name is required (100 characters maximum)' });
    }
    if (req.body.campus && !campus) return res.status(400).json({ message: 'Choose a valid campus' });
    if (typeof req.body.campus !== 'string') return res.status(400).json({ message: 'Choose a valid campus' });
    if (!deadline || !votingStart || !votingEnd) {
        return res.status(400).json({ message: 'Enter valid candidate-entry, voting start, and voting end dates' });
    }

    const connection = await pool.getConnection();
    let auditLockAcquired = false;
    try {
        await connection.beginTransaction();
        const [[position]] = await connection.query(
            `SELECT id, title, campus, status, candidate_entry_deadline, voting_starts_at, voting_ends_at,
                    position_voter_list_uploaded_at,
                    archived_at, (voting_starts_at IS NOT NULL AND voting_starts_at <= UTC_TIMESTAMP()) AS start_reached,
                    EXISTS(
                        SELECT 1 FROM candidates position_candidates
                        JOIN votes ON votes.candidate_id = position_candidates.id
                        WHERE position_candidates.position_id = positions.id
                    ) AS has_votes
             FROM positions WHERE id = ? FOR UPDATE`,
            [id]
        );
        if (!position) {
            await connection.rollback();
            return res.status(404).json({ message: 'Position not found' });
        }
        if (!canReschedulePosition({
            status: position.status,
            archived: !!position.archived_at,
            hasVotes: !!position.has_votes
        })) {
            await connection.rollback();
            return res.status(409).json({
                message: 'The schedule can only be changed before voting is opened and before any votes are recorded.'
            });
        }
        if (position.start_reached
            && (title !== position.title || campus !== (position.campus || ''))) {
            await connection.rollback();
            return res.status(409).json({
                message: 'The scheduled start has passed. You may change the dates, but position name and campus are locked.'
            });
        }

        const [[scheduleCheck]] = await connection.query(
            `SELECT ? > UTC_TIMESTAMP() AS deadline_future, ? > UTC_TIMESTAMP() AS voting_future,
                    ? <= ? AS deadline_before_vote, ? < ? AS start_before_end`,
            [deadline, votingStart, deadline, votingStart, votingStart, votingEnd]
        );
        if (!scheduleCheck.deadline_future) {
            await connection.rollback();
            return res.status(400).json({ message: 'The candidate-entry deadline must be in the future' });
        }
        if (!scheduleCheck.voting_future) {
            await connection.rollback();
            return res.status(400).json({ message: 'The voting start date must be in the future' });
        }
        if (!scheduleCheck.deadline_before_vote) {
            await connection.rollback();
            return res.status(400).json({ message: 'Candidate entry must end before or at the voting start time' });
        }
        if (!scheduleCheck.start_before_end) {
            await connection.rollback();
            return res.status(400).json({ message: 'The voting end date must be after the scheduled start time' });
        }

        const [[duplicate]] = await connection.query(
            'SELECT id FROM positions WHERE title = ? AND campus = ? AND id <> ? FOR UPDATE',
            [title, campus, id]
        );
        if (duplicate) {
            await connection.rollback();
            return res.status(409).json({ message: 'Another position already uses this name and campus' });
        }

        const campusChanged = campus !== (position.campus || '');
        if (campusChanged) {
            await connection.query('DELETE FROM position_voters WHERE position_id = ?', [id]);
        }
        await connection.query(
            `UPDATE positions
             SET title = ?, campus = ?, candidate_entry_deadline = ?, voting_starts_at = ?, voting_ends_at = ?,
                 position_voter_list_uploaded_at = CASE WHEN ? THEN NULL ELSE position_voter_list_uploaded_at END
             WHERE id = ? AND status = 'setup' AND archived_at IS NULL`,
            [title, campus, deadline, votingStart, votingEnd, campusChanged, id]
        );
        await lockAuditLog(connection);
        auditLockAcquired = true;
        await appendAuditLog(connection, 'POSITION_UPDATED', req.user.regNumber,
            `position=${id}, fromTitle=${position.title}, fromCampus=${position.campus || 'university-wide'}, title=${title}, campus=${campus || 'university-wide'}, voterListReset=${campusChanged}, candidateDeadline=${deadline}, votingStart=${votingStart}, votingEnd=${votingEnd}`);
        await connection.commit();
        res.json({ id, title, campus: campus || null });
    } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') {
            await connection.rollback();
            return res.status(409).json({ message: 'Another position already uses this name and campus' });
        }
        await connection.rollback();
        throw error;
    } finally {
        if (auditLockAcquired) await releaseAuditLogLock(connection);
        connection.release();
    }
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
    let auditLockAcquired = false;
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
                `INSERT INTO positions (title, campus) VALUES (?, ?)
                 ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)`,
                [title, campusName]
            );
            const [[position]] = await connection.query(
                `SELECT id, status, candidate_entry_closed,
                        (voting_starts_at IS NOT NULL AND voting_starts_at <= UTC_TIMESTAMP()) AS voting_start_reached
                 FROM positions WHERE title = ? AND campus = ? AND archived_at IS NULL FOR UPDATE`,
                [title, campusName]
            );
            if (!position) {
                const [[matchingPosition]] = await connection.query(
                    'SELECT archived_at FROM positions WHERE title = ? AND campus = ? FOR UPDATE',
                    [title, campusName]
                );
                await connection.rollback();
                if (matchingPosition && matchingPosition.archived_at) {
                    return res.status(409).json({
                        message: 'This position is archived. Restore it from Archived elections before adding candidates.'
                    });
                }
                console.error('Candidate schedule could not find active position after insert', {
                    title,
                    campus: campusName || 'university-wide'
                });
                return res.status(409).json({
                    message: `Could not find or create an active position for "${title}" at ${campusName || 'all campuses'}. Check that the position name and campus are correct. If this keeps happening, ask an administrator to check the database.`
                });
            }
            if (!canRescheduleCandidateEntry({
                status: position.status,
                votingStartReached: !!position.voting_start_reached
            })) {
                await connection.rollback();
                const message = position.status === 'closed'
                    ? 'This position is closed and cannot accept candidates.'
                    : position.status === 'open'
                        ? 'Voting is open; candidate details can no longer be changed.'
                        : 'Candidate details are locked because the scheduled voting start has passed.';
                return res.status(409).json({ message });
            }
            const [updated] = await connection.query(
                `UPDATE positions
                 SET candidate_entry_deadline = ?, voting_starts_at = ?, voting_ends_at = ?,
                     candidate_entry_closed = 0
                 WHERE id = ? AND status = 'setup' AND archived_at IS NULL
                   AND (voting_starts_at IS NULL OR voting_starts_at > UTC_TIMESTAMP())
                   AND ? > UTC_TIMESTAMP() AND ? > UTC_TIMESTAMP()`,
                [deadline, votingStart, votingEnd, position.id, deadline, votingStart]
            );
            if (!updated.affectedRows) {
                const [[current]] = await connection.query(
                    `SELECT status, candidate_entry_closed,
                            (voting_starts_at > UTC_TIMESTAMP()) AS voting_start_future,
                            (candidate_entry_deadline = ?) AS deadline_matches,
                            (voting_starts_at = ?) AS voting_start_matches,
                            (voting_ends_at = ?) AS voting_end_matches
                     FROM positions WHERE id = ?`,
                    [deadline, votingStart, votingEnd, position.id]
                );
                if (!current || current.status !== 'setup' || current.candidate_entry_closed
                    || !current.voting_start_future || !current.deadline_matches
                    || !current.voting_start_matches || !current.voting_end_matches) {
                    await connection.rollback();
                    return res.status(409).json({
                        message: 'The candidate schedule could not be updated. Refresh the page and check that voting has not started.'
                    });
                }
            }
            scheduled.push({ id: Number(position.id), campus: campusName || null });
        }
        await lockAuditLog(connection);
        auditLockAcquired = true;
        for (const position of scheduled) {
            await appendAuditLog(connection, 'POSITION_SCHEDULE_SET', req.user.regNumber,
                `position=${position.id}, title=${title}, campus=${position.campus || 'university-wide'}, candidateDeadline=${deadline}, votingStart=${votingStart}, votingEnd=${votingEnd}`);
        }
        await connection.commit();
    } catch (error) {
        await connection.rollback();
        throw error;
    } finally {
        if (auditLockAcquired) await releaseAuditLogLock(connection);
        connection.release();
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

        if (p.campus && reg) {
            const [[st]] = await pool.query(`SELECT campus FROM students WHERE reg_number = ? AND role = 'voter'`, [reg]);
            if (!st || st.campus !== p.campus) return res.status(400).json({ message: 'This student is not registered on the ' + p.campus + ' campus' });
        }
        const entryState = await candidateEntryState(p.id);
        if (!entryState) return res.status(404).json({ message: 'Position not found' });
        if (entryState.closed) return res.status(409).json({ message: entryState.message || ENTRY_CLOSED.message });
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
        let uploadedImage = null;
        try {
            uploadedImage = await uploadCandidateImage(cleanImage);
        } catch (error) {
            console.error('Candidate upload failed:', error.message);
            return res.status(500).json({ message: 'The image could not be uploaded. Please try again.' });
        }
        const connection = await pool.getConnection();
        let auditLockAcquired = false;
        let candidateId = null;
        try {
            await connection.beginTransaction();
            const [inserted] = await connection.query(
                `INSERT INTO candidates (full_name, reg_number, position_id, image_path, image_public_id, manifesto)
                 VALUES (?, ?, ?, ?, ?, ?)` ,
                [name, reg || null, p.id, uploadedImage.imageUrl, uploadedImage.publicId, manifesto]
            );
            candidateId = inserted.insertId;
            await lockAuditLog(connection);
            auditLockAcquired = true;
            await appendAuditLog(connection, 'CANDIDATE_ADDED', req.user.regNumber,
                'candidate=' + candidateId + ', position=' + p.id + ', reg=' + (reg || 'none'));
            await connection.commit();
        } catch (error) {
            await connection.rollback();
            if (uploadedImage) await removeImage(uploadedImage.imageUrl, uploadedImage.publicId);
            if (error.code === 'ER_DUP_ENTRY') {
                return res.status(409).json({ message: 'A candidate with this registration number already exists in this position.' });
            }
            throw error;
        } finally {
            if (auditLockAcquired) await releaseAuditLogLock(connection);
            connection.release();
        }
        res.status(201).json({ id: candidateId });
    }));

router.delete('/candidates/:id', verifyToken, requireRole('admin'), wrap(async (req, res) => {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ message: 'Candidate ID is invalid' });
    const connection = await pool.getConnection();
    let auditLockAcquired = false;
    let candidate;
    try {
        await connection.beginTransaction();
        const [[row]] = await connection.query(
            `SELECT c.reg_number, c.image_path, c.image_public_id, p.id AS position_id, p.status,
                    (p.voting_starts_at IS NULL OR p.voting_starts_at <= UTC_TIMESTAMP()) AS edit_window_closed
             FROM candidates c JOIN positions p ON p.id = c.position_id
             WHERE c.id = ? FOR UPDATE`,
            [id]
        );
        if (!row) {
            await connection.rollback();
            return res.status(404).json({ message: 'Candidate not found' });
        }
        if (row.status !== 'setup' || row.edit_window_closed) {
            await connection.rollback();
            return res.status(409).json({ message: 'Candidates can only be changed before the scheduled voting start time' });
        }
        candidate = row;
        await connection.query('DELETE FROM candidates WHERE id = ?', [id]);
        await lockAuditLog(connection);
        auditLockAcquired = true;
        await appendAuditLog(connection, 'CANDIDATE_REMOVED', req.user.regNumber, 'candidate=' + id + ', reg=' + row.reg_number);
        await connection.commit();
    } catch (error) {
        await connection.rollback();
        throw error;
    } finally {
        if (auditLockAcquired) await releaseAuditLogLock(connection);
        connection.release();
    }
    await removeImage(candidate.image_path, candidate.image_public_id);
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
            `SELECT c.image_path, c.image_public_id, p.id AS position_id, p.status, p.voting_starts_at,
                    (p.voting_starts_at IS NOT NULL AND p.voting_starts_at > UTC_TIMESTAMP()) AS before_voting_start
             FROM candidates c JOIN positions p ON p.id = c.position_id WHERE c.id = ?`,
            [id]
        );
        if (!rows.length) return res.status(404).json({ message: 'Candidate not found' });
        if (rows[0].status !== 'setup' || !rows[0].before_voting_start) {
            return res.status(409).json({ message: 'Candidates can only be edited before the scheduled voting start time' });
        }
        let imagePath = rows[0].image_path;
        let imagePublicId = rows[0].image_public_id;
        if (req.file) {
            if (!ext(req.file.buffer)) return res.status(400).json({ message: 'Choose a valid JPEG, PNG or WebP image' });
            let cleanImage;
            try {
                cleanImage = await sanitizeImage(req.file.buffer);
            } catch (error) {
                if (error.code === 'IMAGE_TOO_LARGE') return res.status(400).json({ message: error.message });
                return res.status(400).json({ message: 'The image could not be decoded. Choose a valid JPEG, PNG or WebP image.' });
            }
            try {
                const uploaded = await uploadCandidateImage(cleanImage);
                imagePath = uploaded.imageUrl;
                imagePublicId = uploaded.publicId;
            } catch (error) {
                console.error('Candidate replacement upload failed:', error.message);
                return res.status(500).json({ message: 'The image could not be uploaded. Please try again.' });
            }
        }
        try {
            const [updated] = await pool.query(
                `UPDATE candidates c JOIN positions p ON p.id = c.position_id
                 SET c.full_name = ?, c.image_path = ?, c.image_public_id = ?, c.manifesto = ?
                 WHERE c.id = ? AND p.status = 'setup' AND p.voting_starts_at > UTC_TIMESTAMP()`,
                [name, imagePath, imagePublicId, manifesto, id]
            );
            if (!updated.affectedRows) {
                if (req.file) await removeImage(imagePath, imagePublicId);
                return res.status(409).json(ENTRY_CLOSED);
            }
        } catch (e) {
            if (req.file) await removeImage(imagePath, imagePublicId);
            throw e;
        }
        if (req.file) await removeImage(rows[0].image_path, rows[0].image_public_id);
        await addAuditLog('CANDIDATE_UPDATED', req.user.regNumber,
            'candidate=' + id + (req.file ? ', photo replaced' : '') + ', manifesto updated');
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

router.delete('/positions/:id', verifyToken, requireRole('admin'), wrap(async (req, res) => {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ message: 'Position ID is invalid' });

    const connection = await pool.getConnection();
    let auditLockAcquired = false;
    let position;
    let imagePaths;
    try {
        await connection.beginTransaction();
        const [[lockedPosition]] = await connection.query(
            'SELECT id, title, campus, status FROM positions WHERE id = ? FOR UPDATE',
            [id]
        );
        if (!lockedPosition) {
            await connection.rollback();
            return res.status(404).json({ message: 'Position not found' });
        }
        position = lockedPosition;
        if (position.status === 'open') {
            await connection.rollback();
            return res.status(409).json({ message: 'Close voting before deleting this position. Positions with ballots should be archived instead.' });
        }

        const [[ballots]] = await connection.query(
            `SELECT
                (SELECT COUNT(*) FROM votes WHERE position_id = ?) AS votes,
                (SELECT COUNT(*) FROM voter_receipts WHERE position_id = ?) AS receipts`,
            [id, id]
        );
        if (Number(ballots.votes) || Number(ballots.receipts)) {
            await connection.rollback();
            return res.status(409).json({
                message: 'This position has recorded ballots or voter receipts and cannot be deleted. Archive it to preserve the election record.'
            });
        }

        const [candidates] = await connection.query(
            'SELECT image_path FROM candidates WHERE position_id = ? FOR UPDATE',
            [id]
        );
        imagePaths = candidates.map(candidate => candidate.image_path);
        await connection.query('DELETE FROM candidates WHERE position_id = ?', [id]);
        const [deleted] = await connection.query('DELETE FROM positions WHERE id = ?', [id]);
        if (!deleted.affectedRows) {
            await connection.rollback();
            return res.status(409).json({ message: 'Position changed while deleting. Refresh and try again.' });
        }
        await lockAuditLog(connection);
        auditLockAcquired = true;
        await appendAuditLog(connection, 'POSITION_DELETED', req.user.regNumber,
            `position=${id}, title=${position.title}, campus=${position.campus || 'university-wide'}`);
        await connection.commit();
    } catch (error) {
        await connection.rollback();
        if (error.code === 'ER_ROW_IS_REFERENCED_2') {
            return res.status(409).json({
                message: 'This position has election records and cannot be deleted. Archive it to preserve its history.'
            });
        }
        throw error;
    } finally {
        if (auditLockAcquired) await releaseAuditLogLock(connection);
        connection.release();
    }

    for (const imagePath of imagePaths) await removeImage(path.basename(imagePath));
    res.json({ id, deleted: true });
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
        const [[voterList]] = await pool.query(
            'SELECT COUNT(*) AS total FROM position_voters WHERE position_id = ?', [id]
        );
        if (!Number(voterList.total)) {
            return res.status(400).json({ message: 'Upload a position-specific voter email CSV before opening this position.' });
        }
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
    const connection = await pool.getConnection();
    let auditLockAcquired = false;
    try {
        await connection.beginTransaction();
        const [[position]] = await connection.query(
            'SELECT title, status, results_published FROM positions WHERE id = ? FOR UPDATE',
            [id]
        );
        if (!position) {
            await connection.rollback();
            return res.status(404).json({ message: 'Position not found' });
        }
        if (position.status !== 'closed') {
            await connection.rollback();
            return res.status(409).json({ message: 'Close this position before publishing its results' });
        }
        if (position.results_published) {
            await connection.rollback();
            return res.status(409).json({ message: 'Results for this position are already published' });
        }
        const [tally] = await connection.query(
            `SELECT c.id, COUNT(v.id) AS votes
             FROM candidates c LEFT JOIN votes v ON v.candidate_id = c.id AND v.position_id = ?
             WHERE c.position_id = ?
             GROUP BY c.id ORDER BY c.id`,
            [id, id]
        );
        const hash = hashPublishedResults(id, position.title, tally.map(row => ({ id: row.id, votes: row.votes })));
        const [updated] = await connection.query(
            'UPDATE positions SET results_published = 1, published_at = UTC_TIMESTAMP(), results_hash = ? WHERE id = ? AND status = ? AND results_published = 0',
            [hash, id, 'closed']
        );
        if (!updated.affectedRows) {
            await connection.rollback();
            return res.status(409).json({ message: 'Results are already published' });
        }
        await lockAuditLog(connection);
        auditLockAcquired = true;
        await appendAuditLog(
            connection,
            'POSITION_RESULTS_PUBLISHED',
            req.user.regNumber,
            `position=${id}, title=${position.title}, sha256=${hash}`
        );
        await connection.commit();
        res.json({ id, published: true, hash });
    } catch (error) {
        await connection.rollback();
        throw error;
    } finally {
        if (auditLockAcquired) await releaseAuditLogLock(connection);
        connection.release();
    }
}));

router.use((err, req, res, next) => {
    if (err.type === 'entity.too.large') return res.status(413).json({ message: 'Image must be 5 MB or smaller' });
    if (err.code === 'IMAGE_TOO_LARGE') return res.status(400).json({ message: err.message });
    next(err);
});

module.exports = router;