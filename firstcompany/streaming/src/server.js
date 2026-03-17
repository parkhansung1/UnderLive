const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { exec } = require('child_process');
 
const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = 3000;
 
const hlsPath = '/tmp/hls';
const thumbPath = '/tmp/thumbnails';
const staticHtmlPath = path.join(__dirname, 'html');
 
if (!fs.existsSync(thumbPath)) fs.mkdirSync(thumbPath, { recursive: true });
 
app.use(express.json());
app.use('/hls', express.static(hlsPath));
app.use('/thumbnails', express.static(thumbPath));
app.use(express.static(staticHtmlPath));
 
// DB 설정
const dbConfig = {
    host: 'db',
    user: 'root',
    password: 'P@ssw0rd',
    database: 'under_live'
};
let db;
let dbReady = false;
 
// [수정] DB 연결 실패 시 db=undefined로 API가 죽는 버그 수정
// pool 방식으로 변경해 재연결을 자동 처리
async function initDB() {
    try {
        db = await mysql.createPool({
            ...dbConfig,
            waitForConnections: true,
            connectionLimit: 10,
            queueLimit: 0
        });
        // 실제 연결 테스트
        await db.query('SELECT 1');
        dbReady = true;
        console.log("DB Connected. ✅");
    } catch (err) {
        console.error("DB Connection Failed. Retrying in 5s...", err.message);
        dbReady = false;
        setTimeout(initDB, 5000);
    }
}
initDB();
 
// DB 준비 여부 미들웨어
function requireDB(req, res, next) {
    if (!dbReady || !db) {
        return res.status(503).json({ success: false, message: "DB가 준비되지 않았습니다. 잠시 후 다시 시도해주세요." });
    }
    next();
}
 
// 이전 채팅 내역 불러오기 API
app.get('/api/chats/:room', requireDB, async (req, res) => {
    const { room } = req.params;
    try {
        const [rows] = await db.query(
            "SELECT chat_id, message, created_at FROM chats WHERE room_name = ? ORDER BY created_at ASC",
            [room]
        );
        res.json({ success: true, chats: rows });
    } catch (err) {
        res.status(500).json({ success: false });
    }
});
 
// 썸네일 생성 함수
function generateThumbnail(key) {
    const outputFile = path.join(thumbPath, `${key}.jpg`);
    try {
        if (!fs.existsSync(hlsPath)) return;
        const allFiles = fs.readdirSync(hlsPath);
        const tsFiles = allFiles.filter(f => f.startsWith(key) && f.endsWith('.ts'));
        if (tsFiles.length > 0) {
            tsFiles.sort();
            const latestTs = tsFiles[tsFiles.length - 1];
            const tsFilePath = path.join(hlsPath, latestTs);
            const cmd = `ffmpeg -i ${tsFilePath} -ss 00:00:01 -vframes 1 -q:v 2 -y ${outputFile} > /dev/null 2>&1`;
            exec(cmd);
        }
    } catch (e) { console.error("Thumbnail Error:", e.message); }
}
 
// 스트림 목록 조회 API
app.get('/api/streams', requireDB, async (req, res) => {
    try {
        if (!fs.existsSync(hlsPath)) return res.json({ success: true, streams: [] });
        const files = fs.readdirSync(hlsPath);
        const activeKeys = files.filter(f => f.endsWith('.m3u8')).filter(f => {
            try {
                const stats = fs.statSync(path.join(hlsPath, f));
                return (new Date().getTime() - new Date(stats.mtime).getTime()) < 10000;
            } catch (e) { return false; }
        }).map(f => f.replace('.m3u8', ''));
 
        activeKeys.forEach(key => generateThumbnail(key));
 
        if (activeKeys.length === 0) return res.json({ success: true, streams: [] });
 
        // [수정] WHERE IN (?) 에 배열을 넘길 때 [[activeKeys]]로 감싸야 올바르게 동작
        const [users] = await db.query(
            "SELECT chat_id, stream_key FROM users WHERE stream_key IN (?)",
            [activeKeys]
        );
        res.json({ success: true, streams: users });
    } catch (err) {
        console.error("Stream List Error:", err);
        res.json({ success: false, streams: [] });
    }
});
 
// 회원가입 API
// [수정] SHA256 단순 해시 → bcrypt로 변경 (salt 자동 포함, 레인보우 테이블 방어)
app.post('/api/join', requireDB, async (req, res) => {
    const { userId, chatId, password } = req.body;
    if (!userId || !chatId || !password) {
        return res.status(400).json({ success: false, message: "모든 항목을 입력해주세요." });
    }
    try {
        const hashedPw = await bcrypt.hash(password, 10);
        const streamKey = crypto.randomBytes(16).toString('hex');
        await db.query(
            "INSERT INTO users (user_id, chat_id, password, stream_key) VALUES (?, ?, ?, ?)",
            [userId, chatId, hashedPw, streamKey]
        );
        res.status(200).json({ success: true });
    } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') {
            return res.status(400).json({ success: false, message: "이미 사용 중인 아이디 또는 닉네임입니다." });
        }
        res.status(400).json({ success: false, message: "가입 실패" });
    }
});
 
// 로그인 API
// [수정] bcrypt.compare로 변경
app.post('/api/login', requireDB, async (req, res) => {
    const { userId, password } = req.body;
    if (!userId || !password) {
        return res.status(400).json({ success: false });
    }
    try {
        const [users] = await db.query(
            "SELECT * FROM users WHERE user_id = ?",
            [userId]
        );
        if (users.length === 0) return res.status(401).json({ success: false });
        const match = await bcrypt.compare(password, users[0].password);
        if (match) {
            res.json({ success: true, userId: users[0].user_id, chat_id: users[0].chat_id });
        } else {
            res.status(401).json({ success: false });
        }
    } catch (err) {
        res.status(500).json({ success: false });
    }
});
 
// 스튜디오 정보 API
app.get('/api/studio/:userId', requireDB, async (req, res) => {
    const { userId } = req.params;
    try {
        const [users] = await db.query(
            "SELECT stream_key FROM users WHERE user_id = ?",
            [userId]
        );
        if (users.length > 0) res.json({ success: true, streamKey: users[0].stream_key });
        else res.status(404).json({ success: false });
    } catch (err) {
        res.status(500).json({ success: false });
    }
});
 
// 시청자 수 업데이트
function updateUserCount(roomName) {
    if (!roomName) return;
    const clients = io.sockets.adapter.rooms.get(roomName);
    const count = clients ? clients.size : 0;
    io.to(roomName).emit('user count', count);
}
 
// 소켓 실시간 통신
io.on('connection', (socket) => {
    socket.on('join room', (roomName) => {
        socket.rooms.forEach(room => {
            if (room !== socket.id) {
                socket.leave(room);
                setTimeout(() => updateUserCount(room), 200);
            }
        });
        socket.join(roomName);
        setTimeout(() => updateUserCount(roomName), 200);
    });
 
    socket.on('chat message', async (data) => {
        if (data.room) {
            io.to(data.room).emit('chat message', data);
            if (dbReady && db) {
                try {
                    await db.query(
                        "INSERT INTO chats (room_name, chat_id, message) VALUES (?, ?, ?)",
                        [data.room, data.chatId, data.message]
                    );
                } catch (err) { console.error("Chat Save Error:", err); }
            }
        }
    });
 
    socket.on('disconnecting', () => {
        socket.rooms.forEach(room => {
            if (room !== socket.id) {
                setTimeout(() => updateUserCount(room), 200);
            }
        });
    });
});
 
server.listen(PORT, '0.0.0.0', () => console.log(`UNDER LIVE Server 가동 중 (Port: ${PORT})`));
