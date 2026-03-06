import { Redis } from '@upstash/redis';

const redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const DATA_KEY = 'data_skripsi_kelas';
const LOCK_KEY = `${DATA_KEY}:lock`;
const LOCK_TTL = 5; // seconds

async function withLock(fn) {
    const lockValue = `${Date.now()}-${Math.random()}`;

    // Atomic: set only if key doesn't exist (NX), auto-expire (EX)
    const acquired = await redis.set(LOCK_KEY, lockValue, { nx: true, ex: LOCK_TTL });
    if (!acquired) {
        const err = new Error('LOCKED');
        err.code = 'LOCKED';
        throw err;
    }

    try {
        return await fn();
    } finally {
        // Only release lock if we still own it (prevents releasing another process's lock)
        const current = await redis.get(LOCK_KEY);
        if (current === lockValue) {
            await redis.del(LOCK_KEY);
        }
    }
}

function updateRanks(data) {
    // Assign ID ke item lama yang belum punya
    data.forEach(item => {
        if (!item.id) item.id = Date.now().toString() + '-' + Math.random().toString(36).slice(2, 7);
    });

    // Simpan rank sebelumnya
    const beforeSort = data.map((item, idx) => ({ id: item.id || item.nama, rank: idx }));
    
    // Urutkan ulang
    data.sort((a, b) => b.total - a.total);
    
    // Hitung perubahan rank
    data.forEach((item, idx) => {
        const prev = beforeSort.find(b => b.id === (item.id || item.nama));
        if (prev) {
            item.rankChange = prev.rank - idx; // Positif berarti naik (rank lebih kecil)
        } else {
            item.rankChange = 0;
        }
    });
    return data;
}

export default async function handler(req, res) {
    if (req.method === 'GET') {
        const data = await redis.get(DATA_KEY);
        res.setHeader('Cache-Control', 'no-store');
        return res.status(200).json(data || []);
    }

    if (req.method === 'POST') {
        const { nama, pembimbing1, score1, pembimbing2, score2, avatar, judul } = req.body;
        try {
            const result = await withLock(async () => {
                let currentData = (await redis.get(DATA_KEY)) || [];
                const total = parseInt(score1 || 0) + parseInt(score2 || 0);
                currentData.push({
                    id: Date.now().toString(),
                    nama,
                    pembimbing1,
                    score1: parseInt(score1 || 0),
                    pembimbing2,
                    score2: parseInt(score2 || 0),
                    total,
                    avatar: avatar || null,
                    judul: judul || '',
                    rankChange: 0
                });
                currentData = updateRanks(currentData);
                await redis.set(DATA_KEY, JSON.stringify(currentData));
                return currentData;
            });
            return res.status(200).json(result);
        } catch (e) {
            if (e.code === 'LOCKED') return res.status(409).json({ code: 'CONCURRENT_UPDATE', message: 'Server sedang digunakan, coba lagi dalam 1-2 detik.' });
            throw e;
        }
    }

    if (req.method === 'DELETE') {
        const { id } = req.query;
        try {
            const result = await withLock(async () => {
                let currentData = (await redis.get(DATA_KEY)) || [];
                const itemIndex = currentData.findIndex(item => item.id === id);
                if (itemIndex === -1) {
                    const err = new Error('NOT_FOUND');
                    err.code = 'NOT_FOUND';
                    throw err;
                }
                currentData.splice(itemIndex, 1);
                currentData = updateRanks(currentData);
                await redis.set(DATA_KEY, JSON.stringify(currentData));
                return currentData;
            });
            return res.status(200).json(result);
        } catch (e) {
            if (e.code === 'LOCKED') return res.status(409).json({ code: 'CONCURRENT_UPDATE', message: 'Server sedang digunakan, coba lagi dalam 1-2 detik.' });
            if (e.code === 'NOT_FOUND') return res.status(404).json({ code: 'NOT_FOUND', message: 'Data tidak ditemukan.' });
            throw e;
        }
    }

    if (req.method === 'PUT') {
        const { id, nama, pembimbing1, score1, pembimbing2, score2, avatar, judul } = req.body;
        try {
            const result = await withLock(async () => {
                let currentData = (await redis.get(DATA_KEY)) || [];
                const itemIndex = currentData.findIndex(item => item.id === id || item.nama === id);
                if (itemIndex === -1) {
                    const err = new Error('NOT_FOUND');
                    err.code = 'NOT_FOUND';
                    throw err;
                }
                const total = parseInt(score1 || 0) + parseInt(score2 || 0);
                const existing = currentData[itemIndex];
                currentData[itemIndex] = {
                    ...existing,
                    nama,
                    pembimbing1,
                    score1: parseInt(score1 || 0),
                    pembimbing2,
                    score2: parseInt(score2 || 0),
                    total,
                    avatar: avatar !== undefined ? avatar : existing.avatar,
                    judul: judul !== undefined ? judul : existing.judul
                };
                currentData = updateRanks(currentData);
                await redis.set(DATA_KEY, JSON.stringify(currentData));
                return currentData;
            });
            return res.status(200).json(result);
        } catch (e) {
            if (e.code === 'LOCKED') return res.status(409).json({ code: 'CONCURRENT_UPDATE', message: 'Server sedang digunakan, coba lagi dalam 1-2 detik.' });
            if (e.code === 'NOT_FOUND') return res.status(404).json({ code: 'NOT_FOUND', message: 'Data tidak ditemukan.' });
            throw e;
        }
    }

    return res.status(405).json({ error: 'Method not allowed' });
}
