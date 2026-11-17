const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname));

// rooms[roomId] = { state: 'waiting' | 'countdown' | 'playing', players: { [socketId]: playerObj } }
const rooms = {};

function sanitizeStats(stats) {
    if (!stats) return { atk: 12, spd: 4.0, maxHp: 100, mainColor: '#00a2e8' };
    return {
        atk: Math.min(30, Math.max(5, Number(stats.atk) || 12)),
        spd: Math.min(7.0, Math.max(2.0, Number(stats.spd) || 4.0)),
        maxHp: Math.min(200, Math.max(40, Number(stats.maxHp) || 100)),
        mainColor: typeof stats.mainColor === 'string' ? stats.mainColor : '#00a2e8'
    };
}

function sanitizeRoomId(raw) {
    if (typeof raw !== 'string') return '';
    return raw.trim().slice(0, 20);
}

// 全員が準備OKかチェックしてカウントダウンを開始する判定
function checkAllReadyAndStart(roomId) {
    const room = rooms[roomId];
    if (!room || room.state !== 'waiting') return;

    const playerIds = Object.keys(room.players);
    if (playerIds.length < 2) return; // 2人以上必要

    const allReady = playerIds.every(id => room.players[id].isReady);
    if (!allReady) return;

    // カウントダウンフェーズへ移行
    room.state = 'countdown';

    // 対戦開始時の初期配置（1人目は左、2人目は右、それ以降はランダム）
    playerIds.forEach((id, index) => {
        const p = room.players[id];
        p.isDead = false;
        p.shieldUntil = 0;
        p.hp = p.maxHp;
        if (index === 0) {
            p.x = 60;
            p.y = 176;
            p.facing = 'right';
        } else if (index === 1) {
            p.x = 292;
            p.y = 176;
            p.facing = 'left';
        } else {
            p.x = Math.floor(Math.random() * 260) + 40;
            p.y = Math.floor(Math.random() * 260) + 40;
            p.facing = 'down';
        }
    });

    io.to(roomId).emit('currentPlayers', room.players);
    io.to(roomId).emit('matchCountdown', { seconds: 3 });

    setTimeout(() => {
        if (rooms[roomId] && rooms[roomId].state === 'countdown') {
            rooms[roomId].state = 'playing';
            io.to(roomId).emit('matchStart');
        }
    }, 3000);
}

io.on('connection', (socket) => {
    console.log(`クライアントが接続しました: ${socket.id}`);
    let currentRoom = null;

    // ルーム入室（最初は待機ロビー状態）
    socket.on('joinRoom', (payload) => {
        const roomId = sanitizeRoomId(payload && payload.roomId);
        if (!roomId) return;

        if (currentRoom && rooms[currentRoom]) {
            socket.leave(currentRoom);
            delete rooms[currentRoom].players[socket.id];
            io.to(currentRoom).emit('disconnectPlayer', socket.id);
            if (Object.keys(rooms[currentRoom].players).length === 0) {
                delete rooms[currentRoom];
            }
        }

        currentRoom = roomId;
        socket.join(roomId);
        if (!rooms[roomId]) {
            rooms[roomId] = { state: 'waiting', players: {} };
        }

        const room = rooms[roomId];
        const cleanStats = sanitizeStats(payload.stats);

        room.players[socket.id] = {
            id: socket.id,
            x: 176,
            y: 176,
            facing: 'right',
            characterData: payload.gridData || null,
            stats: cleanStats,
            hp: cleanStats.maxHp,
            maxHp: cleanStats.maxHp,
            isDead: false,
            shieldUntil: 0,
            isReady: false
        };

        io.to(roomId).emit('roomStateSync', {
            state: room.state,
            players: room.players
        });
    });

    // 準備OKの切り替え
    socket.on('toggleReady', (isReady) => {
        if (!currentRoom || !rooms[currentRoom]) return;
        const room = rooms[currentRoom];
        const p = room.players[socket.id];
        if (!p || room.state !== 'waiting') return;

        p.isReady = Boolean(isReady);
        io.to(currentRoom).emit('playerReadyUpdated', {
            id: socket.id,
            isReady: p.isReady
        });

        checkAllReadyAndStart(currentRoom);
    });

    // 待機ロビーへ戻る（再戦・描き直し用）
    socket.on('returnToLobby', () => {
        if (!currentRoom || !rooms[currentRoom]) return;
        const room = rooms[currentRoom];
        room.state = 'waiting';
        for (const id in room.players) {
            room.players[id].isReady = false;
            room.players[id].isDead = false;
            room.players[id].shieldUntil = 0;
            room.players[id].hp = room.players[id].maxHp;
        }
        io.to(currentRoom).emit('roomStateSync', {
            state: room.state,
            players: room.players
        });
    });

    // ルーム退室
    socket.on('leaveRoom', () => {
        if (currentRoom && rooms[currentRoom]) {
            socket.leave(currentRoom);
            delete rooms[currentRoom].players[socket.id];
            io.to(currentRoom).emit('disconnectPlayer', socket.id);
            if (Object.keys(rooms[currentRoom].players).length === 0) {
                delete rooms[currentRoom];
            } else {
                rooms[currentRoom].state = 'waiting';
                io.to(currentRoom).emit('roomStateSync', {
                    state: 'waiting',
                    players: rooms[currentRoom].players
                });
            }
            currentRoom = null;
        }
    });

    // 移動の同期（試合中のみ）
    socket.on('playerMovement', (data) => {
        if (!currentRoom || !rooms[currentRoom]) return;
        const room = rooms[currentRoom];
        if (room.state !== 'playing') return;

        const p = room.players[socket.id];
        if (p && !p.isDead) {
            p.x = data.x;
            p.y = data.y;
            p.facing = data.facing || p.facing;
            socket.to(currentRoom).emit('playerMoved', {
                id: socket.id,
                x: p.x,
                y: p.y,
                facing: p.facing
            });
        }
    });

    // ドット絵とステータスの更新（待機中のみ編集可能）
    socket.on('updateCharacter', (payload) => {
        if (!currentRoom || !rooms[currentRoom]) return;
        const room = rooms[currentRoom];
        const p = room.players[socket.id];
        if (p && payload && room.state === 'waiting') {
            const actualGrid = Array.isArray(payload) ? payload : payload.gridData;
            p.characterData = actualGrid;

            if (!Array.isArray(payload) && payload.stats) {
                const cleanStats = sanitizeStats(payload.stats);
                p.stats = cleanStats;
                p.maxHp = cleanStats.maxHp;
                p.hp = cleanStats.maxHp;
            }

            io.to(currentRoom).emit('characterUpdated', {
                id: socket.id,
                characterData: p.characterData,
                stats: p.stats,
                hp: p.hp,
                maxHp: p.maxHp
            });
        }
    });

    // バリア展開（試合中のみ）
    socket.on('activateShield', () => {
        if (!currentRoom || !rooms[currentRoom]) return;
        const room = rooms[currentRoom];
        if (room.state !== 'playing') return;

        const p = room.players[socket.id];
        if (p && !p.isDead) {
            const duration = 1200;
            p.shieldUntil = Date.now() + duration;
            io.to(currentRoom).emit('playerShielded', {
                id: socket.id,
                duration: duration
            });
        }
    });

    // 攻撃アクション（試合中のみ）
    socket.on('playerAttack', (attackData) => {
        if (!currentRoom || !rooms[currentRoom]) return;
        const room = rooms[currentRoom];
        if (room.state !== 'playing') return;

        const p = room.players[socket.id];
        if (p && !p.isDead) {
            socket.to(currentRoom).emit('remoteAttack', {
                attackerId: socket.id,
                type: attackData.type,
                x: attackData.x,
                y: attackData.y,
                facing: attackData.facing,
                color: p.stats.mainColor,
                spd: p.stats.spd
            });
        }
    });

    // ダメージ判定の確定（試合中のみ）
    socket.on('applyDamage', (hitData) => {
        if (!currentRoom || !rooms[currentRoom]) return;
        const room = rooms[currentRoom];
        if (room.state !== 'playing') return;

        const attacker = room.players[socket.id];
        const target = room.players[hitData.targetId];

        if (!attacker || !target || attacker.isDead || target.isDead) return;

        if (Date.now() < target.shieldUntil) {
            io.to(currentRoom).emit('attackBlocked', {
                targetId: target.id,
                attackerId: attacker.id,
                knockbackDir: hitData.facing,
                type: hitData.type
            });
            return;
        }

        const multiplier = hitData.type === 'melee' ? 1.3 : 1.0;
        const damage = Math.round(attacker.stats.atk * multiplier);

        target.hp = Math.max(0, target.hp - damage);

        io.to(currentRoom).emit('playerDamaged', {
            targetId: target.id,
            attackerId: attacker.id,
            damage: damage,
            hp: target.hp,
            maxHp: target.maxHp,
            knockbackDir: hitData.facing,
            type: hitData.type
        });

        if (target.hp <= 0) {
            target.isDead = true;
            target.shieldUntil = 0;
            const targetId = target.id;
            const roomAtKO = currentRoom;

            io.to(roomAtKO).emit('playerKO', {
                targetId: targetId,
                attackerId: attacker.id
            });

            setTimeout(() => {
                if (rooms[roomAtKO] && rooms[roomAtKO].state === 'playing' && rooms[roomAtKO].players[targetId]) {
                    rooms[roomAtKO].players[targetId].isDead = false;
                    rooms[roomAtKO].players[targetId].hp = rooms[roomAtKO].players[targetId].maxHp;
                    rooms[roomAtKO].players[targetId].x = Math.floor(Math.random() * 300) + 30;
                    rooms[roomAtKO].players[targetId].y = Math.floor(Math.random() * 300) + 30;
                    io.to(roomAtKO).emit('playerRespawn', rooms[roomAtKO].players[targetId]);
                }
            }, 3000);
        }
    });

    socket.on('disconnect', () => {
        console.log(`クライアントが切断しました: ${socket.id}`);
        if (currentRoom && rooms[currentRoom]) {
            delete rooms[currentRoom].players[socket.id];
            io.to(currentRoom).emit('disconnectPlayer', socket.id);
            if (Object.keys(rooms[currentRoom].players).length === 0) {
                delete rooms[currentRoom];
            } else {
                rooms[currentRoom].state = 'waiting';
                io.to(currentRoom).emit('roomStateSync', {
                    state: 'waiting',
                    players: rooms[currentRoom].players
                });
            }
        }
    });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
    console.log(`ロビー＆カウントダウン対応バトルサーバー起動中: http://localhost:${PORT}`);
});
