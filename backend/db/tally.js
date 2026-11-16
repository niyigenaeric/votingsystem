const pool = require('./connection');
const { verifyPublishedResults } = require('./resultIntegrity');

async function getTally({ includeArchived = true } = {}) {
    const [pos] = await pool.query(
        `SELECT id, title, status, results_published, published_at, results_hash, archived_at
         FROM positions ${includeArchived ? '' : 'WHERE archived_at IS NULL'} ORDER BY id`
    );
    const [cands] = await pool.query('SELECT id, position_id, full_name FROM candidates ORDER BY full_name');
    const counts = new Map();
    if (pos.some(position => position.status === 'closed')) {
        const [v] = await pool.query('SELECT candidate_id, COUNT(*) AS n FROM votes GROUP BY candidate_id');
        v.forEach(r => counts.set(String(r.candidate_id), Number(r.n)));
    }
    const status = !pos.length || pos.every(position => position.status === 'setup')
        ? 'setup'
        : pos.every(position => position.status === 'closed')
            ? 'closed'
            : pos.every(position => position.status === pos[0].status)
                ? pos[0].status
                : 'mixed';
    return {
        status,
        published: pos.length > 0 && pos.every(position => !!position.results_published),
        positions: pos.map(p => ({
            id: p.id,
            title: p.title,
            status: p.status,
            published: !!p.results_published,
            archived: !!p.archived_at,
            publishedAt: p.published_at,
            hash: p.results_hash,
            candidates: cands.filter(c => c.position_id === p.id).map(c => ({
                id: c.id,
                name: c.full_name,
                votes: p.status === 'closed' ? (counts.get(String(c.id)) || 0) : null
            })),
            integrity: p.results_published
                ? (p.status === 'closed' && verifyPublishedResults(
                    p.results_hash,
                    p.id,
                    p.title,
                    cands.filter(c => c.position_id === p.id).map(c => ({
                        id: c.id,
                        votes: counts.get(String(c.id)) || 0
                    })).sort((a, b) => Number(a.id) - Number(b.id))
                ) ? 'verified' : 'mismatch')
                : null
        }))
    };
}

module.exports = { getTally };