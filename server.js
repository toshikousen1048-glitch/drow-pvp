const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname));

const rooms = {};
const MAX_PLAYERS_PER_ROOM = 4;
const INITIAL_STOCKS = 1;

// 960x720 アリーナ設定
const ARENA_WIDTH = 960;
const ARENA_TOP = 28;
const ARENA_HEIGHT = 720;
const ARENA_CENTER_X = ARENA_WIDTH / 2; // 480
const ARENA_CENTER_Y = (ARENA_TOP + ARENA_HEIGHT) / 2; // 374
const CHAR_SIZE = 48;

// 壊せない固定障害物（岩ブロック・index.html と完全同期）
const STATIC_OBSTACLES = [
    { id: 'obs_1', x: 190, y: 150, w: 52, h: 52 },
    { id: 'obs_2', x: 718, y: 150, w: 52, h: 52 },
    { id: 'obs_3', x: 190, y: 546, w: 52, h: 52 },
    { id: 'obs_4', x: 718, y: 546, w: 52, h: 52 },
    { id: 'obs_5', x: 454, y: 210, w: 52, h: 52 },
    { id: 'obs_6', x: 454, y: 486, w: 52, h: 52 },
    { id: 'obs_7', x: 300, y: 348, w: 52, h: 52 },
    { id: 'obs_8', x: 608, y: 348, w: 52, h: 52 }
];

// 4隅の初期スポーン地点（960x720 アリーナ対応）
const SPAWN_POINTS = [
    { x: 64,  y: 64,  facing: 'right' },
    { x: 848, y: 624, facing: 'left'  },
    { x: 848, y: 64,  facing: 'left'  },
    { x: 64,  y: 624, facing: 'right' }
];

// 人数に応じたBOSS最大HPスケーリング（ソロはテンポ重視で540、マルチは人数比例で増加）
const BOSS_HP_BY_PLAYERS = {
    1: 540,
    2: 1100,
    3: 1550,
    4: 2000
};

// 報酬ポイント定数（サーバー基準で一括計算）
const REWARD_PVP_WIN = 450;
const REWARD_PVP_KO = 100;
const REWARD_BOSS_CLEAR = 650;
const REWARD_BOSS_CONTRIBUTION_POOL = 200; // 与ダメージ割合に応じて配分
const REWARD_BOSS_MVP = 150;

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
    return valid.includes(raw) ? raw : 'B';
}

// ==========================================
// 🛡️ 不正対策ヘルパー（クライアント送信イベントの検証）
// ==========================================
const VALID_FACING = ['up', 'down', 'left', 'right'];
const BOSS_SPIRAL_DAMAGE = 12;       // 渦巻き弾幕の1発ダメージ（サーバー固定値）
const CREDIT_TTL_MS = { shot: 4000, melee: 1500 };
const MELEE_MAX_DIST_PVP = 150;      // 近接ヒット時の攻撃者-対象の中心間距離の上限（実際の判定は約60px、遅延ぶんの余裕込み）
const MELEE_BOSS_EXTRA_DIST = 150;   // 近接ヒット時の「ボス半径＋この値」を上限にする

function createPlayerGuards() {
    return { buckets: {}, credits: { shot: [], melee: [] }, nextShieldAt: 0, lastMoveAt: 0 };
}

// トークンバケット方式のレート制限（短時間のバースト2回まで許容し、ラグによる誤判定を減らす）
function takeToken(p, key, refillMs, capacity) {
    const now = Date.now();
    const b = p.buckets[key] || (p.buckets[key] = { tokens: capacity, last: now });
    b.tokens = Math.min(capacity, b.tokens + (now - b.last) / refillMs);
    b.last = now;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
}

// 「攻撃した実績（クレジット）」：playerAttack を受理したぶんだけ、後続のダメージ報告を受け付ける
function addCredit(p, type) {
    const list = p.credits[type];
    const now = Date.now();
    while (list.length && list[0] < now) list.shift();
    list.push(now + CREDIT_TTL_MS[type]);
    if (list.length > 6) list.shift();
}

function useCredit(p, type) {
    const list = p.credits[type];
    if (!list) return false;
    const now = Date.now();
    while (list.length && list[0] < now) list.shift();
    if (list.length === 0) return false;
    list.shift();
    return true;
}

function sanitizeHitType(raw) {
    return raw === 'melee' ? 'melee' : (raw === 'shot' ? 'shot' : null);
}

function playerCenter(p) {
    return { x: p.x + CHAR_SIZE / 2, y: p.y + CHAR_SIZE / 2 };
}

function overlapsStaticObstacle(x, y, size, pad) {
    const left = x + pad, right = x + size - pad, top = y + pad, bottom = y + size - pad;
    for (const obs of STATIC_OBSTACLES) {
        if (left < obs.x + obs.w && right > obs.x && top < obs.y + obs.h && bottom > obs.y) return true;
    }
    return false;
}

function createBossState(playerCount) {
    const count = Math.min(4, Math.max(1, playerCount || 1));
    const maxHp = BOSS_HP_BY_PLAYERS[count] || 540;
    return {
        name: 'VOID TYPHOON',
        x: ARENA_CENTER_X,
        y: 175,
        radius: 44,
        hp: maxHp,
        maxHp: maxHp,
        phase: 1,
        spiralAngle: 0,
        vortexActive: false,
        pulseCharging: false,
        initialPlayerCount: count
    };
}

function overlapsObstacleOrWall(room, x, y, size) {
    const pad = 4;
    const left = x + pad;
    const right = x + size - pad;
    const top = y + pad;
    const bottom = y + size - pad;

    for (const obs of STATIC_OBSTACLES) {
        if (left < obs.x + obs.w && right > obs.x && top < obs.y + obs.h && bottom > obs.y) {
            return true;
        }
    }
    if (room && Array.isArray(room.walls)) {
        for (const w of room.walls) {
            if (left < w.x + w.w && right > w.x && top < w.y + w.h && bottom > w.y) {
                return true;
            }
        }
    }
    return false;
}

function findSafePosition(room, size) {
    for (let attempt = 0; attempt < 60; attempt++) {
        const x = Math.floor(Math.random() * (ARENA_WIDTH - size - 48)) + 24;
        const y = Math.floor(Math.random() * (ARENA_HEIGHT - ARENA_TOP - size - 48)) + ARENA_TOP + 24;

        if (overlapsObstacleOrWall(room, x, y, size)) continue;

        if (room.mode === 'boss' && room.boss) {
            if (Math.hypot((x + size / 2) - room.boss.x, (y + size / 2) - room.boss.y) < 120) continue;
        }

        let overlap = false;
        for (const id in room.players) {
            const p = room.players[id];
            if (p.isEliminated || p.isDead) continue;
            if (Math.abs((p.x + 24) - (x + size / 2)) < 75 && Math.abs((p.y + 24) - (y + size / 2)) < 75) {
                overlap = true;
                break;
            }
        }
        if (overlap) continue;

        for (const it of room.items) {
            if (Math.abs(it.x - (x + size / 2)) < 45 && Math.abs(it.y - (y + size / 2)) < 45) {
                overlap = true;
                break;
            }
        }
        if (!overlap) return { x, y };
    }

    return { x: 64, y: 64 };
}

function registerBossTimeout(room, fn, delayMs) {
    if (!room) return null;
    if (!Array.isArray(room.bossPendingTimeouts)) {
        room.bossPendingTimeouts = [];
    }
    const timerId = setTimeout(() => {
        if (room && Array.isArray(room.bossPendingTimeouts)) {
            room.bossPendingTimeouts = room.bossPendingTimeouts.filter(id => id !== timerId);
        }
        fn();
    }, delayMs);
    room.bossPendingTimeouts.push(timerId);
    return timerId;
}

function startGimmickLoop(roomId) {
    stopGimmickLoop(roomId);
    const room = rooms[roomId];
    if (!room) return;

    const currentMatchId = room.matchId;

    // 壊せる壁（ステージ拡大に合わせてPvPは8個まで、BOSS戦は4個まで）
    room.wallTimer = setInterval(() => {
        const r = rooms[roomId];
        if (!r || r.state !== 'playing' || r.matchId !== currentMatchId) {
            stopGimmickLoop(roomId);
            return;
        }
        const maxWalls = r.mode === 'boss' ? 4 : 8;
        if (r.walls.length < maxWalls) {
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
                io.to(roomId).emit('gimmicksUpdated', { walls: r.walls, items: r.items });
            }
        }
    }, 8500);

    // アイテム生成（ステージ拡大に合わせて同時出現上限を少し増加）
    const ITEM_TYPES = ['speed', 'heal', 'power'];
    room.itemTimer = setInterval(() => {
        const r = rooms[roomId];
        if (!r || r.state !== 'playing' || r.matchId !== currentMatchId) {
            stopGimmickLoop(roomId);
            return;
        }
        const maxItems = r.mode === 'boss' ? 6 : 5;
        if (r.items.length < maxItems) {
            const itemPos = findSafePosition(r, 24);
            if (itemPos) {
                const chosenType = ITEM_TYPES[Math.floor(Math.random() * ITEM_TYPES.length)];
                r.items.push({
                    id: 'i_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
                    type: chosenType,
                    x: itemPos.x + 12,
                    y: itemPos.y + 12
                });
                io.to(roomId).emit('gimmicksUpdated', { walls: r.walls, items: r.items });
            }
        }
    }, room.mode === 'boss' ? 8000 : 11000);

    // BOSS戦モードのAI＆攻撃ループ
    if (room.mode === 'boss') {
        startBossAILoop(roomId, currentMatchId);
    }
}

function startBossAILoop(roomId, matchId) {
    const room = rooms[roomId];
    if (!room || !room.boss) return;

    let tick = 0;
    // 移動＆渦潮ティック（200msごと）
    room.bossMoveTimer = setInterval(() => {
        const r = rooms[roomId];
        if (!r || r.state !== 'playing' || r.matchId !== matchId || !r.boss) {
            stopGimmickLoop(roomId);
            return;
        }
        const boss = r.boss;
        tick++;

        const activePlayerCount = Object.keys(r.players).length;
        const isSolo = activePlayerCount <= 1;

        // 生きている一番近いプレイヤーを探す
        let nearest = null;
        let minDist = Infinity;
        for (const id in r.players) {
            const p = r.players[id];
            if (p.isDead || p.isEliminated) continue;
            const d = Math.hypot((p.x + 24) - boss.x, (p.y + 24) - boss.y);
            if (d < minDist) {
                minDist = d;
                nearest = p;
            }
        }

        if (nearest && !boss.pulseCharging) {
            const angle = Math.atan2((nearest.y + 24) - boss.y, (nearest.x + 24) - boss.x);
            let moveSpd;
            if (boss.phase === 2) {
                moveSpd = isSolo ? 4.0 : 3.6;
            } else {
                moveSpd = isSolo ? 2.8 : 2.4;
            }
            if (boss.vortexActive) {
                moveSpd *= 0.65;
            }

            boss.x += Math.cos(angle) * moveSpd;
            boss.y += Math.sin(angle) * moveSpd;

            // アリーナ中央エリア内に収める（960x720対応）
            boss.x = Math.max(95, Math.min(ARENA_WIDTH - 95, boss.x));
            boss.y = Math.max(ARENA_TOP + 85, Math.min(ARENA_HEIGHT - 95, boss.y));
        }

        // 5ティック（1秒）ごとに渦潮コア接触ダメージ判定
        if (tick % 5 === 0) {
            for (const id in r.players) {
                const p = r.players[id];
                if (p.isDead || p.isEliminated) continue;
                const d = Math.hypot((p.x + 24) - boss.x, (p.y + 24) - boss.y);
                if (d < boss.radius + 14) {
                    const vortexDmg = boss.vortexActive ? 12 : 8;
                    applyBossDamageToPlayer(roomId, p, vortexDmg, 'vortex', matchId);
                }
            }
        }

        io.to(roomId).emit('bossStateUpdated', boss);
    }, 200);

    // 攻撃パターン発動ループ
    let attackCount = 0;
    const scheduleNextAttack = () => {
        const r = rooms[roomId];
        if (!r || r.state !== 'playing' || r.matchId !== matchId || !r.boss) return;

        const interval = r.boss.phase === 2 ? 1950 : 2450;
        r.bossAttackTimer = setTimeout(() => {
            const cur = rooms[roomId];
            if (!cur || cur.state !== 'playing' || cur.matchId !== matchId || !cur.boss) return;

            executeBossAttack(roomId, attackCount, matchId);
            attackCount++;
            scheduleNextAttack();
        }, interval);
    };

    scheduleNextAttack();
}

function executeBossAttack(roomId, count, matchId) {
    const room = rooms[roomId];
    if (!room || room.state !== 'playing' || room.matchId !== matchId || !room.boss) return;
    const boss = room.boss;

    const allPlayerCount = Math.min(4, Math.max(1, Object.keys(room.players).length));
    const alivePlayers = Object.values(room.players).filter(p => !p.isDead && !p.isEliminated);
    if (alivePlayers.length === 0) return;

    const target = alivePlayers[Math.floor(Math.random() * alivePlayers.length)];
    const targetCx = target.x + 24;
    const targetCy = target.y + 24;

    const patternIdx = count % 4;

    if (patternIdx === 0) {
        // パターン1: 渦巻き弾幕（Spiral Barrage）
        const baseCount = boss.phase === 2 ? 11 : 9;
        const extraBulletsByPlayers = (allPlayerCount - 1) * 3;
        const bulletCount = baseCount + extraBulletsByPlayers;

        boss.spiralAngle = (boss.spiralAngle + 0.45) % (Math.PI * 2);
        room.lastSpiralAt = Date.now();
        io.to(roomId).emit('bossAttackEvent', {
            type: 'spiral',
            x: boss.x,
            y: boss.y,
            count: bulletCount,
            baseAngle: boss.spiralAngle,
            speed: boss.phase === 2 ? 4.6 : 3.9,
            damage: BOSS_SPIRAL_DAMAGE
        });
    } else if (patternIdx === 1) {
        // パターン2: 闇の雷スラッシュ（ステージ拡大に合わせて射程を 360 -> 480 に調整）
        const angle = Math.atan2(targetCy - boss.y, targetCx - boss.x);
        const length = 480;
        const endX = boss.x + Math.cos(angle) * length;
        const endY = boss.y + Math.sin(angle) * length;
        const warnDuration = boss.phase === 2 ? 680 : 750;

        io.to(roomId).emit('bossAttackEvent', {
            type: 'slash_warn',
            x1: boss.x,
            y1: boss.y,
            x2: endX,
            y2: endY,
            warnDuration
        });

        registerBossTimeout(room, () => {
            const cur = rooms[roomId];
            if (!cur || cur.state !== 'playing' || cur.matchId !== matchId || !cur.boss) return;

            io.to(roomId).emit('bossAttackEvent', {
                type: 'slash_fire',
                x1: boss.x,
                y1: boss.y,
                x2: endX,
                y2: endY,
                damage: 20
            });

            for (const id in cur.players) {
                const p = cur.players[id];
                if (p.isDead || p.isEliminated) continue;
                const distToLine = pointToSegmentDistance(p.x + 24, p.y + 24, boss.x, boss.y, endX, endY);
                if (distToLine < 28) {
                    applyBossDamageToPlayer(roomId, p, 20, 'slash', matchId);
                }
            }
        }, warnDuration);
    } else if (patternIdx === 2) {
        // パターン3: 吸引＆渦潮フィールド（Vortex Pull）
        const duration = boss.phase === 2 ? 3400 : 3800;
        boss.vortexActive = true;
        io.to(roomId).emit('bossAttackEvent', {
            type: 'vortex',
            active: true,
            duration,
            pullStrength: boss.phase === 2 ? 1.95 : 1.55
        });

        registerBossTimeout(room, () => {
            if (rooms[roomId] && rooms[roomId].matchId === matchId && rooms[roomId].boss) {
                rooms[roomId].boss.vortexActive = false;
            }
        }, duration);
    } else if (patternIdx === 3) {
        // パターン4: ブラックホール収縮パルス（ステージ拡大に合わせて半径を 225 / 195 に調整）
        boss.pulseCharging = true;
        const pulseRadius = boss.phase === 2 ? 225 : 195;
        const chargeDuration = boss.phase === 2 ? 800 : 900;

        io.to(roomId).emit('bossAttackEvent', {
            type: 'pulse_warn',
            x: boss.x,
            y: boss.y,
            radius: pulseRadius,
            chargeDuration
        });

        registerBossTimeout(room, () => {
            const cur = rooms[roomId];
            if (!cur || cur.state !== 'playing' || cur.matchId !== matchId || !cur.boss) return;
            cur.boss.pulseCharging = false;

            io.to(roomId).emit('bossAttackEvent', {
                type: 'pulse_fire',
                x: cur.boss.x,
                y: cur.boss.y,
                radius: pulseRadius,
                damage: 26
            });

            for (const id in cur.players) {
                const p = cur.players[id];
                if (p.isDead || p.isEliminated) continue;
                const d = Math.hypot((p.x + 24) - cur.boss.x, (p.y + 24) - cur.boss.y);
                if (d <= pulseRadius) {
                    applyBossDamageToPlayer(roomId, p, 26, 'pulse', matchId);
                }
            }
        }, chargeDuration);
    }
}

function pointToSegmentDistance(px, py, x1, y1, x2, y2) {
    const l2 = (x2 - x1) ** 2 + (y2 - y1) ** 2;
    if (l2 === 0) return Math.hypot(px - x1, py - y1);
    let t = ((px - x1) * (x2 - x1) + (py - y1) * (y2 - y1)) / l2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (x1 + t * (x2 - x1)), py - (y1 + t * (y2 - y1)));
}

function applyBossDamageToPlayer(roomId, target, damage, attackType, matchId) {
    const room = rooms[roomId];
    if (!room || room.state !== 'playing' || room.matchId !== matchId) return;
    if (!target || target.isDead || target.isEliminated) return;

    // 盾（バリア）を展開中ならブロック成功！
    if (Date.now() < target.shieldUntil) {
        io.to(roomId).emit('attackBlocked', {
            targetId: target.id,
            attackerId: 'BOSS',
            knockbackDir: 'down',
            type: attackType
        });
        return;
    }

    target.hp = Math.max(0, target.hp - damage);
    io.to(roomId).emit('playerDamaged', {
        targetId: target.id,
        attackerId: 'BOSS',
        damage: damage,
        hp: target.hp,
        maxHp: target.maxHp,
        knockbackDir: 'down',
        type: attackType
    });

    if (target.hp <= 0) {
        handlePlayerKO(roomId, target, null, matchId);
    }
}

function stopGimmickLoop(roomId) {
    const room = rooms[roomId];
    if (!room) return;
    if (room.wallTimer) { clearInterval(room.wallTimer); room.wallTimer = null; }
    if (room.itemTimer) { clearInterval(room.itemTimer); room.itemTimer = null; }
    if (room.bossMoveTimer) { clearInterval(room.bossMoveTimer); room.bossMoveTimer = null; }
    if (room.bossAttackTimer) { clearTimeout(room.bossAttackTimer); room.bossAttackTimer = null; }
    if (Array.isArray(room.bossPendingTimeouts)) {
        for (const tid of room.bossPendingTimeouts) {
            clearTimeout(tid);
        }
        room.bossPendingTimeouts = [];
    }
}

function saveSessionRecord(room, playerObj) {
    if (!room || !playerObj || !playerObj.clientKey) return;
    room.sessionRecords[playerObj.clientKey] = {
        wins: playerObj.wins || 0,
        points: playerObj.points || 0
    };
}

function handlePlayerKO(roomId, target, attacker, matchIdAtKO) {
    const room = rooms[roomId];
    if (!room || room.state !== 'playing' || room.matchId !== matchIdAtKO) return;
    if (target.isDead || target.isEliminated) return;

    target.isDead = true;
    target.shieldUntil = 0;
    target.speedBoostUntil = 0;
    target.powerBoostUntil = 0;
    target.stocks = Math.max(0, target.stocks - 1);

    const koBonus = attacker ? REWARD_PVP_KO : 0;
    if (attacker) {
        attacker.points = (attacker.points || 0) + koBonus;
        saveSessionRecord(room, attacker);
    }

    const targetId = target.id;

    if (target.stocks <= 0) {
        target.isEliminated = true;
        let survivalBonus = 0;
        if (room.mode === 'pvp') {
            const aliveCount = Object.values(room.players).filter(pl => !pl.isEliminated).length;
            if (aliveCount === 1) survivalBonus = 100;
            else if (aliveCount === 2) survivalBonus = 50;
        }

        if (survivalBonus > 0) {
            target.points = (target.points || 0) + survivalBonus;
        }
        saveSessionRecord(room, target);

        io.to(roomId).emit('playerKO', {
            targetId: targetId,
            attackerId: attacker ? attacker.id : 'BOSS',
            stocks: 0,
            isEliminated: true,
            koBonus: koBonus,
            survivalBonus: survivalBonus,
            attackerPoints: attacker ? attacker.points : 0,
            targetPoints: target.points
        });

        checkMatchWinner(roomId);
    } else {
        io.to(roomId).emit('playerKO', {
            targetId: targetId,
            attackerId: attacker ? attacker.id : 'BOSS',
            stocks: target.stocks,
            isEliminated: false,
            koBonus: koBonus,
            survivalBonus: 0,
            attackerPoints: attacker ? attacker.points : 0,
            targetPoints: target.points
        });

        setTimeout(() => {
            const currentR = rooms[roomId];
            if (currentR && currentR.state === 'playing' && currentR.matchId === matchIdAtKO && currentR.players[targetId]) {
                const respawnTarget = currentR.players[targetId];
                if (!respawnTarget.isEliminated && respawnTarget.isDead) {
                    respawnTarget.isDead = false;
                    respawnTarget.hp = respawnTarget.maxHp;
                    const safeSpawn = findSafePosition(currentR, CHAR_SIZE);
                    respawnTarget.x = safeSpawn.x;
                    respawnTarget.y = safeSpawn.y;
                    io.to(roomId).emit('playerRespawn', {
                        id: respawnTarget.id,
                        hp: respawnTarget.hp,
                        x: respawnTarget.x,
                        y: respawnTarget.y
                    });
                }
            }
        }, 2000);
    }
}

function checkAllReadyAndStart(roomId) {
    const room = rooms[roomId];
    if (!room || room.state !== 'waiting') return;

    const playerIds = Object.keys(room.players);
    // PvPは2人以上必須、BOSS戦は1人から開始可能
    const minRequired = room.mode === 'boss' ? 1 : 2;
    if (playerIds.length < minRequired) return;

    const allReady = playerIds.every(id => room.players[id].isReady);
    if (!allReady) return;

    room.state = 'countdown';
    room.matchId = (room.matchId || 0) + 1;
    const startingMatchId = room.matchId;
    room.walls = [];
    room.items = [];
    room.boss = room.mode === 'boss' ? createBossState(playerIds.length) : null;

    playerIds.forEach((id, index) => {
        const p = room.players[id];
        const spawn = SPAWN_POINTS[index % SPAWN_POINTS.length];
        p.isDead = false;
        p.isEliminated = false;
        p.stocks = INITIAL_STOCKS;
        p.shieldUntil = 0;
        p.speedBoostUntil = 0;
        p.powerBoostUntil = 0;
        p.bossDamageDealt = 0;
        p.lastEarnedPoints = 0;
        p.lastPointBreakdown = null;
        Object.assign(p, createPlayerGuards());
        p.hp = p.maxHp;
        p.x = spawn.x;
        p.y = spawn.y;
        p.facing = spawn.facing;
    });

    io.to(roomId).emit('currentPlayers', room.players);
    io.to(roomId).emit('gimmicksUpdated', { walls: [], items: [] });
    if (room.mode === 'boss') {
        io.to(roomId).emit('bossStateUpdated', room.boss);
    }
    io.to(roomId).emit('matchCountdown', { seconds: 3, mode: room.mode });

    setTimeout(() => {
        const r = rooms[roomId];
        if (r && r.state === 'countdown' && r.matchId === startingMatchId) {
            r.state = 'playing';
            io.to(roomId).emit('matchStart', { mode: r.mode, boss: r.boss });
            startGimmickLoop(roomId);
        }
    }, 3000);
}

function checkMatchWinner(roomId) {
    const room = rooms[roomId];
    if (!room || room.state !== 'playing') return;

    const playerIds = Object.keys(room.players);
    const survivors = playerIds.filter(id => !room.players[id].isEliminated);

    if (room.mode === 'boss') {
        // BOSS討伐成功判定（討伐成功時のみクリア報酬・貢献度報酬・MVP報酬をサーバー基準で計算）
        if (room.boss && room.boss.hp <= 0) {
            room.state = 'result';
            stopGimmickLoop(roomId);

            let mvpId = null;
            let maxDmg = -1;
            let totalDamageDealt = 0;

            playerIds.forEach(id => {
                const dmg = room.players[id].bossDamageDealt || 0;
                totalDamageDealt += dmg;
                if (dmg > maxDmg) {
                    maxDmg = dmg;
                    mvpId = id;
                }
            });

            if (maxDmg <= 0) {
                mvpId = null;
            }

            const rewardsByPlayer = {};

            playerIds.forEach(id => {
                const p = room.players[id];
                const dmg = p.bossDamageDealt || 0;
                const dmgRatio = totalDamageDealt > 0 ? (dmg / totalDamageDealt) : (1 / Math.max(1, playerIds.length));
                const contributionBonus = Math.round(REWARD_BOSS_CONTRIBUTION_POOL * dmgRatio);
                const mvpBonus = (id === mvpId) ? REWARD_BOSS_MVP : 0;
                const totalEarned = REWARD_BOSS_CLEAR + contributionBonus + mvpBonus;

                p.wins = (p.wins || 0) + 1;
                p.points = (p.points || 0) + totalEarned;
                p.lastEarnedPoints = totalEarned;
                p.lastPointBreakdown = {
                    clearBonus: REWARD_BOSS_CLEAR,
                    contributionBonus: contributionBonus,
                    mvpBonus: mvpBonus,
                    damageRatioPercent: Math.round(dmgRatio * 100),
                    totalEarned: totalEarned
                };

                rewardsByPlayer[id] = p.lastPointBreakdown;
                saveSessionRecord(room, p);
            });

            io.to(roomId).emit('matchResult', {
                mode: 'boss',
                bossCleared: true,
                mvpId: mvpId,
                clearBonus: REWARD_BOSS_CLEAR,
                contributionPool: REWARD_BOSS_CONTRIBUTION_POOL,
                mvpBonus: REWARD_BOSS_MVP,
                rewardsByPlayer: rewardsByPlayer,
                players: room.players
            });
            return;
        }

        // プレイヤー全滅判定（討伐失敗時は貢献度ポイントを加算しない）
        if (survivors.length === 0) {
            room.state = 'result';
            stopGimmickLoop(roomId);

            const rewardsByPlayer = {};
            playerIds.forEach(id => {
                const p = room.players[id];
                p.lastEarnedPoints = 0;
                p.lastPointBreakdown = {
                    clearBonus: 0,
                    contributionBonus: 0,
                    mvpBonus: 0,
                    damageRatioPercent: 0,
                    totalEarned: 0
                };
                rewardsByPlayer[id] = p.lastPointBreakdown;
                saveSessionRecord(room, p);
            });

            io.to(roomId).emit('matchResult', {
                mode: 'boss',
                bossCleared: false,
                mvpId: null,
                clearBonus: 0,
                contributionPool: 0,
                mvpBonus: 0,
                rewardsByPlayer: rewardsByPlayer,
                players: room.players
            });
        }
        return;
    }

    // 通常PvPの勝敗判定（勝利ボーナス増量：450Pt）
    if (survivors.length <= 1) {
        room.state = 'result';
        stopGimmickLoop(roomId);
        const winnerId = survivors.length === 1 ? survivors[0] : null;
        const rewardsByPlayer = {};

        playerIds.forEach(id => {
            const p = room.players[id];
            const earned = (id === winnerId) ? REWARD_PVP_WIN : 0;
            if (id === winnerId) {
                p.wins = (p.wins || 0) + 1;
                p.points = (p.points || 0) + earned;
            }
            p.lastEarnedPoints = earned;
            p.lastPointBreakdown = { totalEarned: earned };
            rewardsByPlayer[id] = p.lastPointBreakdown;
            saveSessionRecord(room, p);
        });

        const winnerObj = winnerId ? room.players[winnerId] : null;
        io.to(roomId).emit('matchResult', {
            mode: 'pvp',
            winner: winnerObj,
            winnerId: winnerId,
            winBonus: winnerId ? REWARD_PVP_WIN : 0,
            rewardsByPlayer: rewardsByPlayer,
            players: room.players
        });
    }
}

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
        if (!wasEliminated) {
            checkMatchWinner(roomId);
        }
    } else if (room.state === 'countdown') {
        const minReq = room.mode === 'boss' ? 1 : 2;
        if (remainingIds.length < minReq) {
            room.state = 'waiting';
            for (const id of remainingIds) {
                room.players[id].isReady = false;
            }
            io.to(roomId).emit('roomStateSync', {
                state: 'waiting',
                mode: room.mode,
                players: room.players,
                walls: [],
                items: [],
                staticObstacles: STATIC_OBSTACLES,
                boss: null
            });
        }
    }
}

io.on('connection', (socket) => {
    console.log(`クライアントが接続しました: ${socket.id}`);
    let currentRoom = null;

    socket.on('joinRoom', (payload) => {
        const roomId = sanitizeRoomId(payload && payload.roomId);
        if (!roomId) return;

        // 自分自身は人数に数えない（同じ部屋への再参加で満員扱いされるのを防ぐ）
        const occupied = rooms[roomId]
            ? Object.keys(rooms[roomId].players).filter(id => id !== socket.id).length
            : 0;
        if (occupied >= MAX_PLAYERS_PER_ROOM) {
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
                mode: payload.mode === 'boss' ? 'boss' : 'pvp',
                matchId: 0,
                players: {},
                sessionRecords: {},
                walls: [],
                items: [],
                boss: null,
                wallTimer: null,
                itemTimer: null,
                bossMoveTimer: null,
                bossAttackTimer: null,
                bossPendingTimeouts: []
            };
        }

        const room = rooms[roomId];
        const cleanStats = sanitizeStats(payload.stats);
        let clientKey = typeof payload.clientKey === 'string' && payload.clientKey
            ? payload.clientKey.slice(0, 40)
            : socket.id;
        // 同じ clientKey の別接続（別タブなど）が同室にいる場合は、戦績の共有を避けるため別キーにする
        if (Object.values(room.players).some(other => other.clientKey === clientKey && other.id !== socket.id)) {
            clientKey = clientKey.slice(0, 30) + '_' + socket.id.slice(0, 8);
        }

        const prevRecord = room.sessionRecords[clientKey] || { wins: 0, points: 0 };

        room.players[socket.id] = {
            id: socket.id,
            clientKey: clientKey,
            name: sanitizeName(payload.name),
            rank: sanitizeRank(payload.rank),
            title: typeof payload.title === 'string' ? payload.title.slice(0, 16) : '',
            x: ARENA_CENTER_X - 24,
            y: ARENA_CENTER_Y - 24,
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
            bossDamageDealt: 0,
            lastEarnedPoints: 0,
            lastPointBreakdown: null,
            isReady: false,
            wins: prevRecord.wins,
            points: prevRecord.points,
            ...createPlayerGuards()
        };

        io.to(roomId).emit('roomStateSync', {
            state: room.state,
            mode: room.mode,
            players: room.players,
            walls: room.walls,
            items: room.items,
            staticObstacles: STATIC_OBSTACLES,
            boss: room.boss
        });
    });

    // ロビーでのモード切替（PvP / BOSS協力戦）
    socket.on('changeRoomMode', (newMode) => {
        if (!currentRoom || !rooms[currentRoom]) return;
        const room = rooms[currentRoom];
        if (room.state !== 'waiting') return;

        room.mode = newMode === 'boss' ? 'boss' : 'pvp';
        for (const id in room.players) {
            room.players[id].isReady = false;
        }
        io.to(currentRoom).emit('roomStateSync', {
            state: room.state,
            mode: room.mode,
            players: room.players,
            walls: room.walls,
            items: room.items,
            staticObstacles: STATIC_OBSTACLES,
            boss: null
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
        room.boss = null;
        for (const id in room.players) {
            room.players[id].isReady = false;
            room.players[id].isDead = false;
            room.players[id].isEliminated = false;
            room.players[id].stocks = INITIAL_STOCKS;
            room.players[id].shieldUntil = 0;
            room.players[id].speedBoostUntil = 0;
            room.players[id].powerBoostUntil = 0;
            room.players[id].bossDamageDealt = 0;
            room.players[id].lastEarnedPoints = 0;
            room.players[id].lastPointBreakdown = null;
            room.players[id].hp = room.players[id].maxHp;
            saveSessionRecord(room, room.players[id]);
        }
        io.to(currentRoom).emit('roomStateSync', {
            state: room.state,
            mode: room.mode,
            players: room.players,
            walls: [],
            items: [],
            staticObstacles: STATIC_OBSTACLES,
            boss: null
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
        if (room.state !== 'playing' || !data) return;

        const p = room.players[socket.id];
        if (p && !p.isDead && !p.isEliminated) {
            const now = Date.now();
            const maxX = ARENA_WIDTH - CHAR_SIZE;
            const maxY = ARENA_HEIGHT - CHAR_SIZE;
            let nx = Math.max(0, Math.min(maxX, Number(data.x) || 0));
            let ny = Math.max(ARENA_TOP, Math.min(maxY, Number(data.y) || ARENA_TOP));

            // 速度チェック：前回の受理からの経過時間で動ける距離を超えたら、超えた分は切り捨てる
            // （クライアントは60回/秒・1回あたり spd px 動く。ブースト・渦潮の引き寄せ・ノックバックぶんの余裕込み）
            const dt = Math.min(1500, Math.max(16, now - (p.lastMoveAt || now)));
            const boosted = now < p.speedBoostUntil + 500;
            const perSec = (p.stats.spd * (boosted ? 1.4 : 1) + (room.mode === 'boss' ? 2.2 : 0)) * 60;
            const budget = perSec * (dt / 1000) * 1.3 + 64;
            const dist = Math.hypot(nx - p.x, ny - p.y);
            if (dist > budget) {
                const ratio = budget / dist;
                nx = p.x + (nx - p.x) * ratio;
                ny = p.y + (ny - p.y) * ratio;
            }

            // 固定障害物（岩）の中には入れない（クライアントより緩い判定で、正規プレイの誤判定を避ける）
            if (overlapsStaticObstacle(nx, ny, CHAR_SIZE, 12)) {
                nx = p.x;
                ny = p.y;
            }

            p.lastMoveAt = now;
            p.x = nx;
            p.y = ny;
            p.facing = VALID_FACING.includes(data.facing) ? data.facing : p.facing;
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

        const p = room.players[socket.id];
        const hitType = sanitizeHitType(data && data.type);
        if (!p || p.isDead || p.isEliminated || !hitType) return;

        const wallIndex = room.walls.findIndex(w => w.id === data.wallId);
        if (wallIndex === -1) return;
        if (!useCredit(p, hitType)) return;

        const dmg = hitType === 'melee' ? 20 : 10;
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
            io.to(currentRoom).emit('itemEffectApplied', { id: socket.id, type: 'speed', duration });
        } else if (item.type === 'heal') {
            const healAmount = 40;
            p.hp = Math.min(p.maxHp, p.hp + healAmount);
            io.to(currentRoom).emit('itemEffectApplied', { id: socket.id, type: 'heal', hp: p.hp, maxHp: p.maxHp, healAmount });
        } else if (item.type === 'power') {
            const duration = 5000;
            p.powerBoostUntil = Date.now() + duration;
            io.to(currentRoom).emit('itemEffectApplied', { id: socket.id, type: 'power', duration });
        }

        io.to(currentRoom).emit('gimmicksUpdated', { walls: room.walls, items: room.items });
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
            const now = Date.now();
            // クライアントのクールダウンは4000ms。通信ゆらぎの余裕を見て3200msでサーバー側も制限
            if (now < p.nextShieldAt) return;
            p.nextShieldAt = now + 3200;
            const duration = 1200;
            p.shieldUntil = now + duration;
            io.to(currentRoom).emit('playerShielded', { id: socket.id, duration });
        }
    });

    socket.on('playerAttack', (attackData) => {
        if (!currentRoom || !rooms[currentRoom]) return;
        const room = rooms[currentRoom];
        if (room.state !== 'playing' || !attackData) return;

        const p = room.players[socket.id];
        const hitType = sanitizeHitType(attackData.type);
        if (!p || p.isDead || p.isEliminated || !hitType) return;

        // 連射制限（クライアントのクールダウン: 弾450ms / 斬撃600ms。バースト2回まで許容）
        const allowed = hitType === 'melee'
            ? takeToken(p, 'melee', 520, 2)
            : takeToken(p, 'shot', 400, 2);
        if (!allowed) return;
        addCredit(p, hitType);

        // 発射位置はサーバー上の位置から大きくズレていたらサーバー位置を採用
        const c = playerCenter(p);
        let ox = Number(attackData.x);
        let oy = Number(attackData.y);
        if (!Number.isFinite(ox) || !Number.isFinite(oy) || Math.hypot(ox - c.x, oy - c.y) > 100) {
            ox = c.x;
            oy = c.y;
        }
        const facing = VALID_FACING.includes(attackData.facing) ? attackData.facing : p.facing;

        const boostedSpd = Date.now() < p.speedBoostUntil ? p.stats.spd * 1.4 : p.stats.spd;
        const isPowered = Date.now() < p.powerBoostUntil;
        socket.to(currentRoom).emit('remoteAttack', {
            attackerId: socket.id,
            type: hitType,
            x: ox,
            y: oy,
            facing: facing,
            color: isPowered ? '#ff2222' : p.stats.mainColor,
            spd: boostedSpd,
            isPowered: isPowered
        });
    });

    // BOSSへのダメージ処理
    socket.on('damageBoss', (hitData) => {
        if (!currentRoom || !rooms[currentRoom]) return;
        const room = rooms[currentRoom];
        if (room.state !== 'playing' || room.mode !== 'boss' || !room.boss) return;

        const attacker = room.players[socket.id];
        if (!attacker || attacker.isDead || attacker.isEliminated) return;

        const hitType = sanitizeHitType(hitData && hitData.type);
        if (!hitType || room.boss.hp <= 0) return;

        // 近接は攻撃者がボスの近くにいる場合のみ有効（弾は軌道を追跡しないため距離制限なし）
        if (hitType === 'melee') {
            const c = playerCenter(attacker);
            if (Math.hypot(c.x - room.boss.x, c.y - room.boss.y) > room.boss.radius + MELEE_BOSS_EXTRA_DIST) return;
        }
        if (!useCredit(attacker, hitType)) return;

        const typeMultiplier = hitType === 'melee' ? 1.35 : 1.0;
        const powerMultiplier = Date.now() < attacker.powerBoostUntil ? 1.5 : 1.0;
        const damage = Math.round(attacker.stats.atk * typeMultiplier * powerMultiplier);

        room.boss.hp = Math.max(0, room.boss.hp - damage);
        attacker.bossDamageDealt = (attacker.bossDamageDealt || 0) + damage;

        // HP50%以下で第2形態（テンポ重視モード）へ移行
        if (room.boss.phase === 1 && room.boss.hp <= room.boss.maxHp * 0.5) {
            room.boss.phase = 2;
        }

        io.to(roomIdFromSocket(currentRoom)).emit('bossDamaged', {
            attackerId: attacker.id,
            damage: damage,
            hp: room.boss.hp,
            maxHp: room.boss.maxHp,
            phase: room.boss.phase
        });

        if (room.boss.hp <= 0) {
            checkMatchWinner(currentRoom);
        }
    });

    // BOSSの弾に当たったときの処理
    socket.on('bossProjectileHit', (data) => {
        if (!currentRoom || !rooms[currentRoom]) return;
        const room = rooms[currentRoom];
        if (room.state !== 'playing' || room.mode !== 'boss') return;

        const p = room.players[socket.id];
        if (!p || p.isDead || p.isEliminated) return;

        // ダメージ値はクライアントの申告を使わず、サーバー固定値を使う。直近に渦巻き弾幕が発射されていない場合は無効
        if (!room.lastSpiralAt || Date.now() - room.lastSpiralAt > 6000) return;
        applyBossDamageToPlayer(currentRoom, p, BOSS_SPIRAL_DAMAGE, 'spiral', room.matchId);
    });

    // PvPモードでのプレイヤー間ダメージ（BOSS戦ではフレンドリーファイア無し）
    socket.on('applyDamage', (hitData) => {
        if (!currentRoom || !rooms[currentRoom]) return;
        const room = rooms[currentRoom];
        if (room.state !== 'playing' || room.mode === 'boss') return;

        const attacker = room.players[socket.id];
        const hitType = sanitizeHitType(hitData && hitData.type);
        const target = hitData ? room.players[hitData.targetId] : null;

        if (!attacker || !target || !hitType || attacker.id === target.id) return;
        if (attacker.isDead || attacker.isEliminated || target.isDead || target.isEliminated) return;

        // 近接は攻撃者と対象が近い場合のみ有効（弾は軌道を追跡しないため距離制限なし）
        if (hitType === 'melee') {
            const a = playerCenter(attacker);
            const t = playerCenter(target);
            if (Math.hypot(a.x - t.x, a.y - t.y) > MELEE_MAX_DIST_PVP) return;
        }
        if (!useCredit(attacker, hitType)) return;
        const knockDir = VALID_FACING.includes(hitData.facing) ? hitData.facing : attacker.facing;

        if (Date.now() < target.shieldUntil) {
            io.to(currentRoom).emit('attackBlocked', {
                targetId: target.id,
                attackerId: attacker.id,
                knockbackDir: knockDir,
                type: hitType
            });
            return;
        }

        const typeMultiplier = hitType === 'melee' ? 1.3 : 1.0;
        const powerMultiplier = Date.now() < attacker.powerBoostUntil ? 1.5 : 1.0;
        const damage = Math.round(attacker.stats.atk * typeMultiplier * powerMultiplier);

        target.hp = Math.max(0, target.hp - damage);

        io.to(currentRoom).emit('playerDamaged', {
            targetId: target.id,
            attackerId: attacker.id,
            damage: damage,
            hp: target.hp,
            maxHp: target.maxHp,
            knockbackDir: knockDir,
            type: hitType
        });

        if (target.hp <= 0) {
            handlePlayerKO(currentRoom, target, attacker, room.matchId);
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

function roomIdFromSocket(roomId) {
    return roomId;
}

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
    console.log(`完全版バトルサーバー起動中: http://localhost:${PORT}`);
});
