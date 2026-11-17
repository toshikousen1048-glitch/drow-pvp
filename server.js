const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname));

const players = {};

function sanitizeStats(stats) {
    if (!stats) return { atk: 12, spd: 4.0, maxHp: 100, mainColor: '#00a2e8' };
    return {
        atk: Math.min(30, Math.max(5, Number(stats.atk) || 12)),
        spd: Math.min(7.0, Math.max(2.0, Number(stats.spd) || 4.0)),
        maxHp: Math.min(200, Math.max(40, Number(stats.maxHp) || 100)),
        mainColor: typeof stats.mainColor === 'string' ? stats.mainColor : '#00a2e8'
    };
}

io.on('connection', (socket) => {
    console.log(`プレイヤーが接続しました: ${socket.id}`);

    const startX = Math.floor(Math.random() * 300) + 30;
    const startY = Math.floor(Math.random() * 300) + 30;

    players[socket.id] = {
        id: socket.id,
        x: startX,
        y: startY,
        facing: 'right',
        characterData: null,
        stats: { atk: 12, spd: 4.0, maxHp: 100, mainColor: '#00a2e8' },
        hp: 100,
        maxHp: 100,
        isDead: false,
        shieldUntil: 0
    };

    io.emit('currentPlayers', players);

    socket.on('playerMovement', (data) => {
        const p = players[socket.id];
        if (p && !p.isDead) {
            p.x = data.x;
            p.y = data.y;
            p.facing = data.facing || p.facing;
            socket.broadcast.emit('playerMoved', {
                id: socket.id,
                x: p.x,
                y: p.y,
                facing: p.facing
            });
        }
    });

    // ドット絵とステータスの更新（配列直接でもオブジェクト形式でも両対応）
    socket.on('updateCharacter', (payload) => {
        const p = players[socket.id];
        if (p && payload) {
            const actualGrid = Array.isArray(payload) ? payload : payload.gridData;
            p.characterData = actualGrid;

            if (!Array.isArray(payload) && payload.stats) {
                const cleanStats = sanitizeStats(payload.stats);
                const hpRatio = p.maxHp > 0 ? p.hp / p.maxHp : 1;
                p.stats = cleanStats;
                p.maxHp = cleanStats.maxHp;
                if (!p.isDead) {
                    p.hp = Math.max(1, Math.round(p.maxHp * hpRatio));
                }
            }

            io.emit('characterUpdated', {
                id: socket.id,
                characterData: p.characterData,
                stats: p.stats,
                hp: p.hp,
                maxHp: p.maxHp
            });
        }
    });

    socket.on('activateShield', () => {
        const p = players[socket.id];
        if (p && !p.isDead) {
            const duration = 1200;
            p.shieldUntil = Date.now() + duration;
            io.emit('playerShielded', {
                id: socket.id,
                duration: duration
            });
        }
    });

    socket.on('playerAttack', (attackData) => {
        const p = players[socket.id];
        if (p && !p.isDead) {
            socket.broadcast.emit('remoteAttack', {
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

    socket.on('applyDamage', (hitData) => {
        const attacker = players[socket.id];
        const target = players[hitData.targetId];

        if (!attacker || !target || attacker.isDead || target.isDead) return;

        if (Date.now() < target.shieldUntil) {
            io.emit('attackBlocked', {
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

        io.emit('playerDamaged', {
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
            io.emit('playerKO', {
                targetId: target.id,
                attackerId: attacker.id
            });

            setTimeout(() => {
                if (players[target.id]) {
                    players[target.id].isDead = false;
                    players[target.id].hp = players[target.id].maxHp;
                    players[target.id].x = Math.floor(Math.random() * 300) + 30;
                    players[target.id].y = Math.floor(Math.random() * 300) + 30;
                    io.emit('playerRespawn', players[target.id]);
                }
            }, 3000);
        }
    });

    socket.on('disconnect', () => {
        console.log(`プレイヤーが切断しました: ${socket.id}`);
        delete players[socket.id];
        io.emit('disconnectPlayer', socket.id);
    });
});

const PORT = process.env.PORT || 3002;
server.listen(PORT, () => {
    console.log(`最新バトルサーバー起動中: http://localhost:${PORT}`);
});