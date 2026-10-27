const crypto = require('crypto');
const express = require('express');
const pool = require('../db/connection');
const { addAuditLog } = require('../db/audit');
const { getTally } = require('../db/tally');
const { closeExpiredPositions } = require('../db/election');
const { voteRejection } = require('../db/votingRules');
const { newVoteId } = require('../db/voteId');
const { verifyToken, requireRole } = require('../middleware/auth');

const router = express.Router();

router.get('/ballot', verifyToken, requireRole('voter'), async (req, res) => {
    try {
        await closeExpiredPositions();
        const [[me]] = await pool.query('SELECT campus, is_activated FROM students WHERE id = ?', [req.user.id]);
        if (!me || !me.is_activated) return res.status(403).json({ message: 'An activated voter account is required.' });
        if (!me.campus) return res.status(403).json({ message: 'Your campus is not set. Contact an election administrator before voting.' });

        const [receipts] = await pool.query(
            'SELECT position_id FROM voter_receipts WHERE student_id = ?',
            [req.user.id]
        );
        const votedPositionIds = receipts.map(receipt => Number(receipt.position_id));
        const tally = await getTally();
        const [positions] = await pool.query(
            `SELECT id, campus, DATE_FORMAT(DATE_ADD(voting_starts_at, INTERVAL 2 HOUR), '%Y-%m-%dT%H:%i') AS voting_starts_at,
                    DATE_FORMAT(DATE_ADD(voting_ends_at, INTERVAL 2 HOUR), '%Y-%m-%dT%H:%i') AS voting_ends_at
             FROM positions`
        );
        const positionById = new Map(positions.map(position => [Number(position.id), position]));
        const visiblePositions = tally.positions.filter(position => {
            const schedule = positionById.get(Number(position.id));
            return schedule && (!schedule.campus || schedule.campus === me.campus);
        });
        const [images] = await pool.query('SELECT id, image_path FROM candidates');
        const imageById = new Map(images.map(candidate => [String(candidate.id), candidate.image_path]));
        res.json({
            positions: visiblePositions.map(position => {
                const schedule = positionById.get(Number(position.id));
                const candidates = position.status === 'closed' && position.published
                    ? position.candidates.map(candidate => ({
                        id: candidate.id,
                        name: candidate.name,
                        votes: candidate.votes
                    }))
                    : votedPositionIds.includes(Number(position.id))
                        ? []
                        : position.status === 'open'
                            ? position.candidates.map(candidate => ({
                            id: candidate.id,
                            name: candidate.name,
                            imageUrl: imageById.get(String(candidate.id))
                        }))
                            : [];
                return {
                    id: position.id,
                    title: position.title,
                    status: position.status,
                    published: position.published,
                    votingStartsAt: schedule.voting_starts_at,
                    votingEndsAt: schedule.voting_ends_at,
                    hasVoted: votedPositionIds.includes(Number(position.id)),
                    candidates
                };
            })
        });
    } catch (error) {
        console.error(error.message);
        res.status(500).json({ message: 'Could not load the ballot' });
    }
});

router.post('/positions/:id/vote', verifyToken, requireRole('voter'), async (req, res) => {
    const positionId = Number(req.params.id);
    const candidateId = Number(req.body && req.body.candidateId);
    if (!Number.isSafeInteger(positionId) || positionId < 1 || !Number.isSafeInteger(candidateId) || candidateId < 1) {
        return res.status(400).json({ message: 'Choose a valid position and candidate.' });
    }

    const receiptCode = crypto.randomBytes(16).toString('hex').toUpperCase();
    const receiptHash = crypto.createHash('sha256').update(receiptCode).digest('hex');
    const connection = await pool.getConnection();
    let committed = false;
    try {
        await connection.beginTransaction();
        const [[student]] = await connection.query(
            `SELECT campus, is_activated FROM students WHERE id = ? AND role = 'voter' FOR UPDATE`,
            [req.user.id]
        );
        const [[position]] = await connection.query(
            `SELECT id, title, campus, status,
                    (voting_starts_at IS NOT NULL AND voting_starts_at <= UTC_TIMESTAMP()) AS start_reached,
                    (voting_ends_at IS NOT NULL AND voting_ends_at > UTC_TIMESTAMP()) AS end_not_reached
             FROM positions WHERE id = ? FOR UPDATE`,
            [positionId]
        );
        let candidate = null;
        if (position) {
            const [candidateRows] = await connection.query(
                'SELECT id FROM candidates WHERE id = ? AND position_id = ?',
                [candidateId, positionId]
            );
            candidate = candidateRows[0];
        }
        let receipt = null;
        if (position) {
            const [receiptRows] = await connection.query(
                'SELECT id FROM voter_receipts WHERE student_id = ? AND position_id = ?',
                [req.user.id, positionId]
            );
            receipt = receiptRows[0];
        }
        const rejection = voteRejection({
            student,
            position,
            candidate,
            startReached: !!(position && position.start_reached),
            endNotReached: !!(position && position.end_not_reached),
            alreadyVoted: !!receipt
        });
        if (rejection) {
            await connection.rollback();
            return res.status(rejection.status).json({ message: rejection.message });
        }
        for (let attempt = 1; ; attempt++) {
            try {
                await connection.query(
                    'INSERT INTO votes (id, position_id, candidate_id) VALUES (?, ?, ?)',
                    [newVoteId(), positionId, candidateId]
                );
                break;
            } catch (insertError) {
                if (insertError.code !== 'ER_DUP_ENTRY' || attempt >= 3) throw insertError;
            }
        }
        await connection.query(
            'INSERT INTO voter_receipts (student_id, position_id, receipt_hash) VALUES (?, ?, ?)',
            [req.user.id, positionId, receiptHash]
        );
        await connection.commit();
        committed = true;
        let message = 'Your vote has been recorded.';
        try {
            await addAuditLog('VOTE_CAST', 'voter', `position=${positionId}`);
        } catch (auditError) {
            console.error('Vote was recorded but its audit entry could not be written:', auditError.message);
            message = 'Your vote was recorded, but its audit entry could not be written. Contact an election administrator.';
        }
        res.status(201).json({ message, receiptCode });
    } catch (error) {
        if (!committed) {
            try { await connection.rollback(); } catch (rollbackError) {
                console.error('Vote transaction rollback failed:', rollbackError.message);
            }
        }
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ message: 'You have already voted for this position.' });
        }
        console.error(error.message);
        res.status(500).json({ message: 'Could not record your vote.' });
    } finally {
        connection.release();
    }
});

module.exports = router;
