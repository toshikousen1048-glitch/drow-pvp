const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname));

// rooms[roomId] = { state, players, sessionRecords, walls, items, wallTimer, itemTimer }
const rooms = {};
const MAX_PLAYERS_PER_ROOM = 4;
const INITIAL_STOCKS = 3;

function sanitizeStats(stats) {
    if (!stats) return { atk: 12, spd: 4.0, maxHp: 100, mainColor: '#00a2e8' };
    return {
        atk: Math.min(35, Math.max(5, Number(stats.atk) || 12)),
        spd: Math.min(7.5, Math.max(2.0, Number(stats.spd) || 4.0)),
        maxHp: Math.min(220, Math.max(40, Number(stats.maxHp) || 100)),
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

function findSafePosition(room, size) {
    for (let attempt = 0; attempt < 30; attempt++) {
        const gx = Math.floor(Math.random() * 8) + 1;
        const gy = Math.floor(Math.random() * 8) + 1;
        const x = gx * 40;
        const y = gy * 40;

        let overlap = false;

        for (const id in room.players) {
            const p = room.players[id];
            if (p.isEliminated) continue;
            if (Math.abs((p.x + 24) - (x + size / 2)) < 64 && Math.abs((p.y + 24) - (y + size / 2)) < 64) {
                overlap = true;
                break;
            }
        }
        if (overlap) continue;

        for (const w of room.walls) {
            if (Math.abs(w.x - x) < 40 && Math.abs(w.y - y) < 40) {
                overlap = true;
                break;
            }
        }
        if (overlap) continue;

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

function startGimmickLoop(roomId) {
    stopGimmickLoop(roomId);
    const room = rooms[roomId];
    if (!room) return;

    room.wallTimer = setInterval(() => {
        if (!rooms[roomId] || rooms[roomId].state !== 'playing') {
            stopGimmickLoop(roomId);
            return;
        }
        const r = rooms[roomId];
        if (r.walls.length < 5) {
            const wallPos = findSafePosition(r, 40);
            if (wallPos) {
                r.walls.push({
                    id: 'w_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
                    x: wallPos.x,
                    y: wallPos.y,
                    w: 40,
                    h: 40,
                    hp: 30,
                    maxHp: 30
                });
                io.to(roomId).emit('gimmicksUpdated', {
                    walls: r.walls,
                    items: r.items
                });
            }
        }
    }, 10000);

    const ITEM_TYPES = ['speed', 'heal', 'power'];
    room.itemTimer = setInterval(() => {
        if (!rooms[roomId] || rooms[roomId].state !== 'playing') {
            stopGimmickLoop(roomId);
            return;
        }
        const r = rooms[roomId];
        if (r.items.length < 3) {
            const itemPos = findSafePosition(r, 24);
            if (itemPos) {
                const chosenType = ITEM_TYPES[Math.floor(Math.random() * ITEM_TYPES.length)];
                r.items.push({
                    id: 'i_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
                    type: chosenType,
                    x: itemPos.x + 20,
                    y: itemPos.y + 20
                });
                io.to(roomId).emit('gimmicksUpdated', {
                    walls: r.walls,
                    items: r.items
                });
            }
        }
    }, 15000);
}

function stopGimmickLoop(roomId) {
    const room = rooms[roomId];
    if (!room) return;
    if (room.wallTimer) {
        clearInterval(room.wallTimer);
        room.wallTimer = null;
    }
    if (room.itemTimer) {
        clearInterval(room.itemTimer);
        room.itemTimer = null;
    }
}

// 【修正①】ルーム内セッション戦績の保存ヘルパー
function saveSessionRecord(room, playerObj) {
    if (!room || !playerObj || !playerObj.clientKey) return;
    room.sessionRecords[playerObj.clientKey] = {
        wins: playerObj.wins || 0,
        points: playerObj.points || 0
    };
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
        p.powerBoostUntil = 0;
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
        const winBonus = 300;

        if (winnerId && room.players[winnerId]) {
            room.players[winnerId].wins = (room.players[winnerId].wins || 0) + 1;
            room.players[winnerId].points = (room.players[winnerId].points || 0) + winBonus;
            saveSessionRecord(room, room.players[winnerId]);
        }

        const winnerObj = winnerId ? room.players[winnerId] : null;
        // 【修正①】優勝者IDと今回の優勝ボーナス値を明示して送信
        io.to(roomId).emit('matchResult', {
            winner: winnerObj,
            winnerId: winnerId,
            winBonus: winnerId ? winBonus : 0,
            players: room.players
        });
    }
}

// 【修正③】退室・切断時の共通クリーンアップ処理
function handlePlayerExit(socket, roomId) {
    if (!roomId || !rooms[roomId]) return;
    const room = rooms[roomId];
    const leavingPlayer = room.players[socket.id];
    if (!leavingPlayer) return;

    const wasEliminated = Boolean(leavingPlayer.isEliminated);
    saveSessionRecord(room, leavingPlayer);

    delete room.players[socket.id];
    io.to(roomId).emit('disconnectPlayer', socket.id);

    const remainingIds = Object.keys(room.players);
    if (remainingIds.length === 0) {
        stopGimmickLoop(roomId);
        delete rooms[roomId];
        return;
    }

    if (room.state === 'playing') {
        // すでに敗退済みの観戦者が抜けただけなら勝敗判定を走らせない
        if (!wasEliminated) {
            checkMatchWinner(roomId);
        }
    } else if (room.state === 'countdown') {
        // カウントダウン中に2人未満になったら待機室へ戻す
        if (remainingIds.length < 2) {
            room.state = 'waiting';
            for (const id of remainingIds) {
                room.players[id].isReady = false;
            }
            io.to(roomId).emit('roomStateSync', {
                state: 'waiting',
                players: room.players,
                walls: [],
                items: []
            });
        }
    }
    // room.state === 'waiting' または 'result' の場合は状態を維持（リザルト画面を強制終了させない）
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
            handlePlayerExit(socket, currentRoom);
        }

        currentRoom = roomId;
        socket.join(roomId);
        if (!rooms[roomId]) {
            rooms[roomId] = {
                state: 'waiting',
                players: {},
                sessionRecords: {},
                walls: [],
                items: [],
                wallTimer: null,
                itemTimer: null
            };
        }

        const room = rooms[roomId];
        const cleanStats = sanitizeStats(payload.stats);
        const clientKey = typeof payload.clientKey === 'string' && payload.clientKey
            ? payload.clientKey.slice(0, 40)
            : socket.id;

        // 【修正①】同一ルームに再入室した場合は過去のセッション戦績（wins/points）を引き継ぐ
        const prevRecord = room.sessionRecords[clientKey] || { wins: 0, points: 0 };

        room.players[socket.id] = {
            id: socket.id,
            clientKey: clientKey,
            name: sanitizeName(payload.name),
            rank: sanitizeRank(payload.rank),
            title: typeof payload.title === 'string' ? payload.title.slice(0, 16) : '',
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
            powerBoostUntil: 0,
            isReady: false,
            wins: prevRecord.wins,
            points: prevRecord.points
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
            room.players[id].powerBoostUntil = 0;
            room.players[id].hp = room.players[id].maxHp;
            saveSessionRecord(room, room.players[id]);
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
            handlePlayerExit(socket, leftRoom);
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
            const duration = 5000;
            p.speedBoostUntil = Date.now() + duration;
            io.to(currentRoom).emit('itemEffectApplied', {
                id: socket.id,
                type: 'speed',
                duration: duration
            });
        } else if (item.type === 'heal') {
            const healAmount = 40;
            p.hp = Math.min(p.maxHp, p.hp + healAmount);
            io.to(currentRoom).emit('itemEffectApplied', {
                id: socket.id,
                type: 'heal',
                hp: p.hp,
                maxHp: p.maxHp,
                healAmount: healAmount
            });
        } else if (item.type === 'power') {
            const duration = 5000;
            p.powerBoostUntil = Date.now() + duration;
            io.to(currentRoom).emit('itemEffectApplied', {
                id: socket.id,
                type: 'power',
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
            if (payload.title !== undefined) p.title = String(payload.title).slice(0, 16);

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
                title: p.title,
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
            const isPowered = Date.now() < p.powerBoostUntil;
            socket.to(currentRoom).emit('remoteAttack', {
                attackerId: socket.id,
                type: attackData.type,
                x: attackData.x,
                y: attackData.y,
                facing: attackData.facing,
                color: isPowered ? '#ff2222' : p.stats.mainColor,
                spd: boostedSpd,
                isPowered: isPowered
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

        const typeMultiplier = hitData.type === 'melee' ? 1.3 : 1.0;
        const powerMultiplier = Date.now() < attacker.powerBoostUntil ? 1.5 : 1.0;
        const damage = Math.round(attacker.stats.atk * typeMultiplier * powerMultiplier);

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
            target.powerBoostUntil = 0;
            target.stocks = Math.max(0, target.stocks - 1);

            const koBonus = 100;
            attacker.points = (attacker.points || 0) + koBonus;
            saveSessionRecord(room, attacker);

            const targetId = target.id;
            const roomAtKO = currentRoom;

            if (target.stocks <= 0) {
                target.isEliminated = true;
                const aliveCount = Object.values(room.players).filter(pl => !pl.isEliminated).length;
                let survivalBonus = 0;
                if (aliveCount === 1) survivalBonus = 100;
                else if (aliveCount === 2) survivalBonus = 50;

                if (survivalBonus > 0) {
                    target.points = (target.points || 0) + survivalBonus;
                }
                saveSessionRecord(room, target);

                // 【修正①】KOボーナスと生存順位ボーナスを明示して送信
                io.to(roomAtKO).emit('playerKO', {
                    targetId: targetId,
                    attackerId: attacker.id,
                    stocks: 0,
                    isEliminated: true,
                    koBonus: koBonus,
                    survivalBonus: survivalBonus,
                    attackerPoints: attacker.points,
                    targetPoints: target.points
                });

                checkMatchWinner(roomAtKO);
            } else {
                io.to(roomAtKO).emit('playerKO', {
                    targetId: targetId,
                    attackerId: attacker.id,
                    stocks: target.stocks,
                    isEliminated: false,
                    koBonus: koBonus,
                    survivalBonus: 0,
                    attackerPoints: attacker.points,
                    targetPoints: target.points
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
            handlePlayerExit(socket, currentRoom);
            currentRoom = null;
        }
    });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
    console.log(`完全版バトルサーバー起動中: http://localhost:${PORT}`);
});
