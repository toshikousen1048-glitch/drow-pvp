const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname));

// rooms[roomId] = { state, players, walls, items, gimmickTimer }
const rooms = {};
const MAX_PLAYERS_PER_ROOM = 4;
const INITIAL_STOCKS = 3;

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

function sanitizeName(raw) {
    if (typeof raw !== 'string') return 'NoName';
    const trimmed = raw.trim().slice(0, 12);
    return trimmed || 'NoName';
}

function sanitizeRank(raw) {
    const valid = ['C', 'B', 'A', 'S'];
    return valid.includes(raw) ? raw : 'C';
}

const SPAWN_POINTS = [
    { x: 45,  y: 45,  facing: 'right' },
    { x: 305, y: 305, facing: 'left'  },
    { x: 305, y: 45,  facing: 'left'  },
    { x: 45,  y: 305, facing: 'right' }
];

// プレイヤーや既存の壁・アイテムと重ならない安全な座標を探す関数
function findSafePosition(room, size) {
    for (let attempt = 0; attempt < 30; attempt++) {
        // 40pxグリッドに沿った綺麗な座標にする
        const gx = Math.floor(Math.random() * 8) + 1; // 1〜8 (40〜320)
        const gy = Math.floor(Math.random() * 8) + 1;
        const x = gx * 40;
        const y = gy * 40;

        let overlap = false;

        // プレイヤーとの距離チェック（埋まり防止）
        for (const id in room.players) {
            const p = room.players[id];
            if (p.isEliminated) continue;
            if (Math.abs((p.x + 24) - (x + size / 2)) < 64 && Math.abs((p.y + 24) - (y + size / 2)) < 64) {
                overlap = true;
                break;
            }
        }
        if (overlap) continue;

        // 既存の壁との重複チェック
        for (const w of room.walls) {
            if (Math.abs(w.x - x) < 40 && Math.abs(w.y - y) < 40) {
                overlap = true;
                break;
            }
        }
        if (overlap) continue;

        // 既存のアイテムとの重複チェック
        for (const it of room.items) {
            if (Math.abs(it.x - (x + 20)) < 36 && Math.abs(it.y - (y + 20)) < 36) {
                overlap = true;
                break;
            }
        }
        if (!overlap) return { x, y };
    }
    return null;
}

// 10秒ごとのギミック（壁＆スピードアップアイテム）生成ループ
function startGimmickLoop(roomId) {
    stopGimmickLoop(roomId);
    const room = rooms[roomId];
    if (!room) return;

    room.gimmickTimer = setInterval(() => {
        if (!rooms[roomId] || rooms[roomId].state !== 'playing') {
            stopGimmickLoop(roomId);
            return;
        }
        const r = rooms[roomId];

        // 1. 壁の生成（フィールド上最大5個まで）
        if (r.walls.length < 5) {
            const wallPos = findSafePosition(r, 40);
            if (wallPos) {
                const newWall = {
                    id: 'w_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
                    x: wallPos.x,
                    y: wallPos.y,
                    w: 40,
                    h: 40,
                    hp: 30,
                    maxHp: 30
                };
                r.walls.push(newWall);
            }
        }

        // 2. スピードアップアイテムの生成（フィールド上最大2個まで）
        if (r.items.length < 2) {
            const itemPos = findSafePosition(r, 24);
            if (itemPos) {
                const newItem = {
                    id: 'i_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
                    type: 'speed',
                    x: itemPos.x + 20, // 中心座標
                    y: itemPos.y + 20
                };
                r.items.push(newItem);
            }
        }

        io.to(roomId).emit('gimmicksUpdated', {
            walls: r.walls,
            items: r.items
        });
    }, 10000); // 10秒ごとに実行
}

function stopGimmickLoop(roomId) {
    const room = rooms[roomId];
    if (room && room.gimmickTimer) {
        clearInterval(room.gimmickTimer);
        room.gimmickTimer = null;
    }
}

function checkAllReadyAndStart(roomId) {
    const room = rooms[roomId];
    if (!room || room.state !== 'waiting') return;

    const playerIds = Object.keys(room.players);
    if (playerIds.length < 2) return;

    const allReady = playerIds.every(id => room.players[id].isReady);
    if (!allReady) return;

    room.state = 'countdown';
    room.walls = [];
    room.items = [];

    playerIds.forEach((id, index) => {
        const p = room.players[id];
        const spawn = SPAWN_POINTS[index % SPAWN_POINTS.length];
        p.isDead = false;
        p.isEliminated = false;
        p.stocks = INITIAL_STOCKS;
        p.shieldUntil = 0;
        p.speedBoostUntil = 0;
        p.hp = p.maxHp;
        p.x = spawn.x;
        p.y = spawn.y;
        p.facing = spawn.facing;
    });

    io.to(roomId).emit('currentPlayers', room.players);
    io.to(roomId).emit('gimmicksUpdated', { walls: [], items: [] });
    io.to(roomId).emit('matchCountdown', { seconds: 3 });

    setTimeout(() => {
        if (rooms[roomId] && rooms[roomId].state === 'countdown') {
            rooms[roomId].state = 'playing';
            io.to(roomId).emit('matchStart');
            startGimmickLoop(roomId);
        }
    }, 3000);
}

function checkMatchWinner(roomId) {
    const room = rooms[roomId];
    if (!room || room.state !== 'playing') return;

    const playerIds = Object.keys(room.players);
    const survivors = playerIds.filter(id => !room.players[id].isEliminated);

    if (survivors.length <= 1) {
        room.state = 'result';
        stopGimmickLoop(roomId);
        const winnerId = survivors.length === 1 ? survivors[0] : null;

        if (winnerId && room.players[winnerId]) {
            room.players[winnerId].wins = (room.players[winnerId].wins || 0) + 1;
            room.players[winnerId].points = (room.players[winnerId].points || 0) + 300;
        }

        const winnerObj = winnerId ? room.players[winnerId] : null;
        io.to(roomId).emit('matchResult', {
            winner: winnerObj,
            players: room.players
        });
    }
}

io.on('connection', (socket) => {
    console.log(`クライアントが接続しました: ${socket.id}`);
    let currentRoom = null;

    socket.on('joinRoom', (payload) => {
        const roomId = sanitizeRoomId(payload && payload.roomId);
        if (!roomId) return;

        if (rooms[roomId] && Object.keys(rooms[roomId].players).length >= MAX_PLAYERS_PER_ROOM) {
            socket.emit('roomFull', { roomId });
            return;
        }

        if (currentRoom && rooms[currentRoom]) {
            socket.leave(currentRoom);
            delete rooms[currentRoom].players[socket.id];
            io.to(currentRoom).emit('disconnectPlayer', socket.id);
            if (Object.keys(rooms[currentRoom].players).length === 0) {
                stopGimmickLoop(currentRoom);
                delete rooms[currentRoom];
            }
        }

        currentRoom = roomId;
        socket.join(roomId);
        if (!rooms[roomId]) {
            rooms[roomId] = { state: 'waiting', players: {}, walls: [], items: [], gimmickTimer: null };
        }

        const room = rooms[roomId];
        const cleanStats = sanitizeStats(payload.stats);

        room.players[socket.id] = {
            id: socket.id,
            name: sanitizeName(payload.name),
            rank: sanitizeRank(payload.rank),
            x: 176,
            y: 176,
            facing: 'right',
            characterData: payload.gridData || null,
            stats: cleanStats,
            hp: cleanStats.maxHp,
            maxHp: cleanStats.maxHp,
            stocks: INITIAL_STOCKS,
            isDead: false,
            isEliminated: false,
            shieldUntil: 0,
            speedBoostUntil: 0,
            isReady: false,
            wins: 0,
            points: 0
        };

        io.to(roomId).emit('roomStateSync', {
            state: room.state,
            players: room.players,
            walls: room.walls,
            items: room.items
        });
    });

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

    socket.on('returnToLobby', () => {
        if (!currentRoom || !rooms[currentRoom]) return;
        const room = rooms[currentRoom];
        stopGimmickLoop(currentRoom);
        room.state = 'waiting';
        room.walls = [];
        room.items = [];
        for (const id in room.players) {
            room.players[id].isReady = false;
            room.players[id].isDead = false;
            room.players[id].isEliminated = false;
            room.players[id].stocks = INITIAL_STOCKS;
            room.players[id].shieldUntil = 0;
            room.players[id].speedBoostUntil = 0;
            room.players[id].hp = room.players[id].maxHp;
        }
        io.to(currentRoom).emit('roomStateSync', {
            state: room.state,
            players: room.players,
            walls: [],
            items: []
        });
    });

    socket.on('leaveRoom', () => {
        if (currentRoom && rooms[currentRoom]) {
            const leftRoom = currentRoom;
            socket.leave(leftRoom);
            delete rooms[leftRoom].players[socket.id];
            io.to(leftRoom).emit('disconnectPlayer', socket.id);
            if (Object.keys(rooms[leftRoom].players).length === 0) {
                stopGimmickLoop(leftRoom);
                delete rooms[leftRoom];
            } else if (rooms[leftRoom].state === 'playing') {
                checkMatchWinner(leftRoom);
            } else {
                stopGimmickLoop(leftRoom);
                rooms[leftRoom].state = 'waiting';
                io.to(leftRoom).emit('roomStateSync', {
                    state: 'waiting',
                    players: rooms[leftRoom].players,
                    walls: [],
                    items: []
                });
            }
            currentRoom = null;
        }
    });

    socket.on('playerMovement', (data) => {
        if (!currentRoom || !rooms[currentRoom]) return;
        const room = rooms[currentRoom];
        if (room.state !== 'playing') return;

        const p = room.players[socket.id];
        if (p && !p.isDead && !p.isEliminated) {
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

    // 壁への攻撃ダメージ＆破壊処理
    socket.on('damageWall', (data) => {
        if (!currentRoom || !rooms[currentRoom]) return;
        const room = rooms[currentRoom];
        if (room.state !== 'playing') return;

        const wallIndex = room.walls.findIndex(w => w.id === data.wallId);
        if (wallIndex === -1) return;

        const dmg = data.type === 'melee' ? 20 : 10;
        room.walls[wallIndex].hp -= dmg;

        if (room.walls[wallIndex].hp <= 0) {
            room.walls.splice(wallIndex, 1);
        }

        io.to(currentRoom).emit('gimmicksUpdated', {
            walls: room.walls,
            items: room.items
        });
    });

    // スピードアップアイテム取得処理
    socket.on('collectItem', (data) => {
        if (!currentRoom || !rooms[currentRoom]) return;
        const room = rooms[currentRoom];
        if (room.state !== 'playing') return;

        const p = room.players[socket.id];
        if (!p || p.isDead || p.isEliminated) return;

        const itemIndex = room.items.findIndex(it => it.id === data.itemId);
        if (itemIndex === -1) return;

        const item = room.items[itemIndex];
        room.items.splice(itemIndex, 1);

        if (item.type === 'speed') {
            const duration = 5000; // 5秒間スピードアップ
            p.speedBoostUntil = Date.now() + duration;
            io.to(currentRoom).emit('playerSpeedBoosted', {
                id: socket.id,
                duration: duration
            });
        }

        io.to(currentRoom).emit('gimmicksUpdated', {
            walls: room.walls,
            items: room.items
        });
    });

    socket.on('updateCharacter', (payload) => {
        if (!currentRoom || !rooms[currentRoom]) return;
        const room = rooms[currentRoom];
        const p = room.players[socket.id];
        if (p && payload && room.state === 'waiting') {
            const actualGrid = Array.isArray(payload) ? payload : payload.gridData;
            p.characterData = actualGrid;
            if (payload.name !== undefined) p.name = sanitizeName(payload.name);
            if (payload.rank !== undefined) p.rank = sanitizeRank(payload.rank);

            if (!Array.isArray(payload) && payload.stats) {
                const cleanStats = sanitizeStats(payload.stats);
                p.stats = cleanStats;
                p.maxHp = cleanStats.maxHp;
                p.hp = cleanStats.maxHp;
            }

            io.to(currentRoom).emit('characterUpdated', {
                id: socket.id,
                name: p.name,
                rank: p.rank,
                characterData: p.characterData,
                stats: p.stats,
                hp: p.hp,
                maxHp: p.maxHp
            });
        }
    });

    socket.on('activateShield', () => {
        if (!currentRoom || !rooms[currentRoom]) return;
        const room = rooms[currentRoom];
        if (room.state !== 'playing') return;

        const p = room.players[socket.id];
        if (p && !p.isDead && !p.isEliminated) {
            const duration = 1200;
            p.shieldUntil = Date.now() + duration;
            io.to(currentRoom).emit('playerShielded', {
                id: socket.id,
                duration: duration
            });
        }
    });

    socket.on('playerAttack', (attackData) => {
        if (!currentRoom || !rooms[currentRoom]) return;
        const room = rooms[currentRoom];
        if (room.state !== 'playing') return;

        const p = room.players[socket.id];
        if (p && !p.isDead && !p.isEliminated) {
            const boostedSpd = Date.now() < p.speedBoostUntil ? p.stats.spd * 1.4 : p.stats.spd;
            socket.to(currentRoom).emit('remoteAttack', {
                attackerId: socket.id,
                type: attackData.type,
                x: attackData.x,
                y: attackData.y,
                facing: attackData.facing,
                color: p.stats.mainColor,
                spd: boostedSpd
            });
        }
    });

    socket.on('applyDamage', (hitData) => {
        if (!currentRoom || !rooms[currentRoom]) return;
        const room = rooms[currentRoom];
        if (room.state !== 'playing') return;

        const attacker = room.players[socket.id];
        const target = room.players[hitData.targetId];

        if (!attacker || !target || attacker.isDead || attacker.isEliminated || target.isDead || target.isEliminated) return;

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
            target.speedBoostUntil = 0;
            target.stocks = Math.max(0, target.stocks - 1);
            attacker.points = (attacker.points || 0) + 100;

            const targetId = target.id;
            const roomAtKO = currentRoom;

            if (target.stocks <= 0) {
                target.isEliminated = true;
                const aliveCount = Object.values(room.players).filter(pl => !pl.isEliminated).length;
                if (aliveCount === 1) target.points += 100;
                else if (aliveCount === 2) target.points += 50;

                io.to(roomAtKO).emit('playerKO', {
                    targetId: targetId,
                    attackerId: attacker.id,
                    stocks: 0,
                    isEliminated: true,
                    attackerPoints: attacker.points
                });

                checkMatchWinner(roomAtKO);
            } else {
                io.to(roomAtKO).emit('playerKO', {
                    targetId: targetId,
                    attackerId: attacker.id,
                    stocks: target.stocks,
                    isEliminated: false,
                    attackerPoints: attacker.points
                });

                setTimeout(() => {
                    if (rooms[roomAtKO] && rooms[roomAtKO].state === 'playing' && rooms[roomAtKO].players[targetId]) {
                        const respawnTarget = rooms[roomAtKO].players[targetId];
                        if (!respawnTarget.isEliminated) {
                            respawnTarget.isDead = false;
                            respawnTarget.hp = respawnTarget.maxHp;
                            const safeSpawn = findSafePosition(rooms[roomAtKO], 48) || { x: 176, y: 176 };
                            respawnTarget.x = safeSpawn.x;
                            respawnTarget.y = safeSpawn.y;
                            io.to(roomAtKO).emit('playerRespawn', respawnTarget);
                        }
                    }
                }, 2000);
            }
        }
    });

    socket.on('disconnect', () => {
        console.log(`クライアントが切断しました: ${socket.id}`);
        if (currentRoom && rooms[currentRoom]) {
            const leftRoom = currentRoom;
            delete rooms[leftRoom].players[socket.id];
            io.to(leftRoom).emit('disconnectPlayer', socket.id);
            if (Object.keys(rooms[leftRoom].players).length === 0) {
                stopGimmickLoop(leftRoom);
                delete rooms[leftRoom];
            } else if (rooms[leftRoom].state === 'playing') {
                checkMatchWinner(leftRoom);
            } else {
                stopGimmickLoop(leftRoom);
                rooms[leftRoom].state = 'waiting';
                io.to(leftRoom).emit('roomStateSync', {
                    state: 'waiting',
                    players: rooms[leftRoom].players,
                    walls: [],
                    items: []
                });
            }
        }
    });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
    console.log(`ギミック完全搭載バトルサーバー起動中: http://localhost:${PORT}`);
});
