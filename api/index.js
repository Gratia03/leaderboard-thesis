import { Redis } from '@upstash/redis';

const redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const DATA_KEY = 'data_skripsi_kelas';

function updateRanks(data) {
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
        // Cache data di browser selama 10 detik, dan di CDN selama 60 detik
        // stale-while-revalidate memungkinkan data lama ditampilkan sambil fetch data baru di background
        res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=30');
        return res.status(200).json(data || []);
    }

    if (req.method === 'POST') {
        const { nama, pembimbing1, score1, pembimbing2, score2, avatar, judul } = req.body;
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
        return res.status(200).json(currentData);
    }

    if (req.method === 'DELETE') {
        const { index } = req.query;
        let currentData = (await redis.get(DATA_KEY)) || [];
        if (index >= 0 && index < currentData.length) {
            currentData.splice(index, 1);
            currentData = updateRanks(currentData);
            await redis.set(DATA_KEY, JSON.stringify(currentData));
            return res.status(200).json(currentData);
        }
        return res.status(400).json({ error: 'Index tidak valid' });
    }

    if (req.method === 'PUT') {
        const { index, nama, pembimbing1, score1, pembimbing2, score2, avatar, judul, reset } = req.body;
        
        if (reset) {
            return res.status(400).json({ error: 'Reset disabled for new structure' });
        }

        let currentData = (await redis.get(DATA_KEY)) || [];
        if (index >= 0 && index < currentData.length) {
            const total = parseInt(score1 || 0) + parseInt(score2 || 0);
            const item = currentData[index];
            currentData[index] = { 
                ...item,
                nama, 
                pembimbing1, 
                score1: parseInt(score1 || 0), 
                pembimbing2, 
                score2: parseInt(score2 || 0), 
                total,
                avatar: avatar !== undefined ? avatar : item.avatar,
                judul: judul !== undefined ? judul : item.judul
            };
            
            currentData = updateRanks(currentData);
            await redis.set(DATA_KEY, JSON.stringify(currentData));
            return res.status(200).json(currentData);
        }
        return res.status(400).json({ error: 'Index tidak valid' });
    }

    return res.status(405).json({ error: 'Method not allowed' });
}
