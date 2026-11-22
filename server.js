const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const BossSystem = require('./bosses.js');

// 起動時バリデーション実行（不正定義があれば即座に停止）
BossSystem.validateDefinitions({ throwOnError: true });

const {
    GAME_RULES,
    STATIC_OBSTACLES: RAW_STATIC_OBSTACLES,
    SPECIAL_INK_IDS,
    SPECIAL_INKS,
    ULTRA_SKILLS,
    ULTRA_SKILL_ORDER,
    STAGES,
    DEFAULT_STAGE_NUMBER,
    getStageByNumber,
    getNextStage,
    sanitizeBossId,
    getBossDef,
    createBossInstance,
    determineElementFromPixels,
    getElementMultiplier,
    sanitizeElementId,
    getUltraSkillDef,
    sanitizeUltraSkillId
} = BossSystem;

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname));

const rooms = {};
const profiles = {};

const MAX_PLAYERS_PER_ROOM = GAME_RULES.MAX_PLAYERS;
const INITIAL_STOCKS = 1;

// 960x720 アリーナ設定（bosses.js から一元取得）
const ARENA_WIDTH = GAME_RULES.ARENA.WIDTH;
const ARENA_TOP = GAME_RULES.ARENA.TOP;
const ARENA_HEIGHT = GAME_RULES.ARENA.HEIGHT;
const ARENA_CENTER_X = GAME_RULES.ARENA.CENTER_X;
const ARENA_CENTER_Y = GAME_RULES.ARENA.PLAY_CENTER_Y;
const CHAR_SIZE = GAME_RULES.PLAYER.SIZE;

const STATIC_OBSTACLES = RAW_STATIC_OBSTACLES.map((obs, idx) => ({
    id: `obs_${idx + 1}`,
    x: obs.x,
    y: obs.y,
    w: obs.w,
    h: obs.h
}));

// 4隅の初期スポーン地点（960x720 アリーナ対応）
const SPAWN_POINTS = [
    { x: 64, y: 64, facing: 'right' },
    { x: 848, y: 624, facing: 'left' },
    { x: 848, y: 64, facing: 'left' },
    { x: 64, y: 624, facing: 'right' }
];

// 報酬ポイント定数（サーバー基準で一括計算）
const REWARD_PVP_WIN = 450;
const REWARD_PVP_KO = 100;
const REWARD_BOSS_CONTRIBUTION_POOL = 200;
const REWARD_BOSS_MVP = 150;

const VALID_FACING = ['up', 'down', 'left', 'right'];
const CREDIT_TTL_MS = { shot: 4000, melee: 1500 };

// =========================================================================
// 永続プロファイル管理（ポイント・ステージ解放・インク・必殺技ストック）
// =========================================================================
function createDefaultUltraStocks() {
    const stocks = {};
    for (const skillId of ULTRA_SKILL_ORDER) {
        stocks[skillId] = 0;
    }
    return stocks;
}

function sanitizeClientKey(raw, fallbackId) {
    if (typeof raw === 'string' && raw.trim()) {
        return raw.trim().slice(0, 48);
    }
    return String(fallbackId || 'guest').slice(0, 48);
}

function getOrCreateProfile(clientKey, seedData) {
    const key = sanitizeClientKey(clientKey);
    if (!profiles[key]) {
        const seed = seedData && typeof seedData === 'object' ? seedData : {};
        const maxStageLimit = STAGES.length;
        const initStage = Math.min(maxStageLimit, Math.max(1, Math.floor(Number(seed.maxUnlockedStage) || 1)));
        const initPoints = Math.max(0, Math.min(999999, Math.floor(Number(seed.points) || 0)));

        const initInks = [];
        if (Array.isArray(seed.unlockedInks)) {
            for (const ink of seed.unlockedInks) {
                if (SPECIAL_INK_IDS.includes(ink) && !initInks.includes(ink)) {
                    initInks.push(ink);
                }
            }
        }

        const initStocks = createDefaultUltraStocks();
        if (seed.ultraStocks && typeof seed.ultraStocks === 'object') {
            for (const skillId of ULTRA_SKILL_ORDER) {
                const rawVal = Math.floor(Number(seed.ultraStocks[skillId]) || 0);
                initStocks[skillId] = Math.min(GAME_RULES.GACHA.ULTRA_MAX_STOCK, Math.max(0, rawVal));
            }
        }

        let initEquipped = sanitizeUltraSkillId(seed.equippedUltra);
        if (initEquipped && initStocks[initEquipped] <= 0) {
            initEquipped = null;
        }

        profiles[key] = {
            clientKey: key,
            points: initPoints,
            maxUnlockedStage: initStage,
            unlockedInks: initInks,
            ultraStocks: initStocks,
            equippedUltra: initEquipped,
            wins: Math.max(0, Math.floor(Number(seed.wins) || 0))
        };
    }
    return profiles[key];
}

function serializeProfile(profile) {
    return {
        clientKey: profile.clientKey,
        points: profile.points,
        maxUnlockedStage: profile.maxUnlockedStage,
        unlockedInks: [...profile.unlockedInks],
        ultraStocks: { ...profile.ultraStocks },
        equippedUltra: profile.equippedUltra,
        wins: profile.wins
    };
}

function emitProfileToClient(socket, profile) {
    if (!socket || !profile) return;
    socket.emit('profileUpdated', serializeProfile(profile));
}

function findSocketsByClientKey(clientKey) {
    const matched = [];
    for (const [, s] of io.sockets.sockets) {
        if (s.data && s.data.clientKey === clientKey) {
            matched.push(s);
        }
    }
    return matched;
}

// =========================================================================
// サニタイズ & ガードヘルパー
// =========================================================================
function sanitizeStats(stats) {
    if (!stats) return { atk: 12, spd: 4.0, maxHp: 100, mainColor: '#00a2e8' };
    return {
        atk: Math.min(35, Math.max(5, Number(stats.atk) || 12)),
        spd: Math.min(7.5, Math.max(2.0, Number(stats.spd) || 4.0)),
        maxHp: Math.min(220, Math.max(40, Number(stats.maxHp) || 100)),
        mainColor: typeof stats.mainColor === 'string' ? stats.mainColor.slice(0, 24) : '#00a2e8'
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

function analyzeSpecialInkFromGrid(gridData) {
    if (!Array.isArray(gridData)) return { hasSpecialInk: false, dominantSpecialInk: null };
    const flat = Array.isArray(gridData[0]) ? gridData.flat() : gridData;
    const counts = {};
    let total = 0;
    for (let i = 0; i < flat.length; i++) {
        const token = flat[i];
        if (typeof token === 'string' && Object.prototype.hasOwnProperty.call(SPECIAL_INKS, token)) {
            counts[token] = (counts[token] || 0) + 1;
            total++;
        }
    }
    if (total === 0) return { hasSpecialInk: false, dominantSpecialInk: null };
    let best = null;
    let bestCount = 0;
    for (const id of SPECIAL_INK_IDS) {
        if ((counts[id] || 0) > bestCount) {
            bestCount = counts[id];
            best = id;
        }
    }
    return { hasSpecialInk: true, dominantSpecialInk: best };
}

function createPlayerGuards() {
    return {
        buckets: {},
        credits: { shot: [], melee: [] },
        nextShieldAt: 0,
        lastMoveAt: 0
    };
}

function takeToken(p, key, refillMs, capacity) {
    const now = Date.now();
    const b = p.buckets[key] || (p.buckets[key] = { tokens: capacity, last: now });
    b.tokens = Math.min(capacity, b.tokens + (now - b.last) / refillMs);
    b.last = now;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
}

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

function facingToVector(facing) {
    switch (facing) {
        case 'up': return { dx: 0, dy: -1 };
        case 'down': return { dx: 0, dy: 1 };
        case 'left': return { dx: -1, dy: 0 };
        case 'right':
        default: return { dx: 1, dy: 0 };
    }
}

function pointToSegmentDistance(px, py, x1, y1, x2, y2) {
    const l2 = (x2 - x1) ** 2 + (y2 - y1) ** 2;
    if (l2 === 0) return Math.hypot(px - x1, py - y1);
    let t = ((px - x1) * (x2 - x1) + (py - y1) * (y2 - y1)) / l2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (x1 + t * (x2 - x1)), py - (y1 + t * (y2 - y1)));
}

function overlapsStaticObstacle(x, y, size, pad) {
    const left = x + pad;
    const right = x + size - pad;
    const top = y + pad;
    const bottom = y + size - pad;
    for (const obs of STATIC_OBSTACLES) {
        if (left < obs.x + obs.w && right > obs.x && top < obs.y + obs.h && bottom > obs.y) return true;
    }
    return false;
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

// =========================================================================
// タイマー管理・必殺技タイマー完全破棄
// =========================================================================
function clearPlayerUltraStateAndTimers(p) {
    if (!p) return;
    if (Array.isArray(p.ultraTimers)) {
        for (const tid of p.ultraTimers) {
            clearTimeout(tid);
        }
    }
    p.ultraTimers = [];
    p.ultraState = null;
    p.ultraStateUntil = 0;
    p.absoluteWallUntil = 0;
    p.counterStanceUntil = 0;
    p.ultraActiveTimerId = null;
}

function registerPlayerUltraTimeout(room, p, fn, delayMs) {
    if (!room || !p) return null;
    if (!Array.isArray(p.ultraTimers)) {
        p.ultraTimers = [];
    }
    const timerId = setTimeout(() => {
        if (p && Array.isArray(p.ultraTimers)) {
            p.ultraTimers = p.ultraTimers.filter((id) => id !== timerId);
        }
        fn();
    }, delayMs);
    p.ultraTimers.push(timerId);
    return timerId;
}

function registerBossTimeout(room, fn, delayMs) {
    if (!room) return null;
    if (!Array.isArray(room.bossPendingTimeouts)) {
        room.bossPendingTimeouts = [];
    }
    const timerId = setTimeout(() => {
        if (room && Array.isArray(room.bossPendingTimeouts)) {
            room.bossPendingTimeouts = room.bossPendingTimeouts.filter((id) => id !== timerId);
        }
        fn();
    }, delayMs);
    room.bossPendingTimeouts.push(timerId);
    return timerId;
}

function stopGimmickLoop(roomId) {
    const room = rooms[roomId];
    if (!room) return;
    if (room.countdownTimer) { clearTimeout(room.countdownTimer); room.countdownTimer = null; }
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
    for (const id in room.players) {
        clearPlayerUltraStateAndTimers(room.players[id]);
    }
}

// =========================================================================
// プレイヤー状態シリアライズ & ルーム同期
// =========================================================================
function serializeRoomPlayers(room) {
    const out = {};
    for (const id in room.players) {
        const p = room.players[id];
        out[id] = {
            id: p.id,
            clientKey: p.clientKey,
            name: p.name,
            rank: p.rank,
            title: p.title,
            element: p.element,
            hasSpecialInk: p.hasSpecialInk,
            dominantSpecialInk: p.dominantSpecialInk,
            x: p.x,
            y: p.y,
            facing: p.facing,
            characterData: p.characterData,
            stats: p.stats,
            hp: p.hp,
            maxHp: p.maxHp,
            stocks: p.stocks,
            isDead: p.isDead,
            isEliminated: p.isEliminated,
            shieldUntil: p.shieldUntil,
            absoluteWallUntil: p.absoluteWallUntil,
            counterStanceUntil: p.counterStanceUntil,
            speedBoostUntil: p.speedBoostUntil,
            powerBoostUntil: p.powerBoostUntil,
            ultraSkillId: p.ultraSkillId,
            ultraRemainingUses: p.ultraRemainingUses,
            ultraMaxUses: p.ultraMaxUses,
            ultraCooldownUntil: p.ultraCooldownUntil,
            ultraState: p.ultraState,
            ultraStateUntil: p.ultraStateUntil,
            bossDamageDealt: p.bossDamageDealt,
            lastEarnedPoints: p.lastEarnedPoints,
            lastPointBreakdown: p.lastPointBreakdown,
            isReady: p.isReady,
            wins: p.wins,
            points: p.points
        };
    }
    return out;
}

function getHostMaxUnlockedStage(room) {
    if (!room || !room.hostId || !room.players[room.hostId]) return 1;
    const hostPlayer = room.players[room.hostId];
    const prof = profiles[hostPlayer.clientKey];
    return prof ? prof.maxUnlockedStage : 1;
}

function emitRoomStateSync(roomId) {
    const room = rooms[roomId];
    if (!room) return;
    io.to(roomId).emit('roomStateSync', {
        state: room.state,
        mode: room.mode,
        stageNumber: room.stageNumber,
        stageId: room.stageId,
        bossId: room.bossId,
        hostId: room.hostId,
        hostMaxUnlockedStage: getHostMaxUnlockedStage(room),
        lastMatchCleared: Boolean(room.lastMatchCleared),
        players: serializeRoomPlayers(room),
        walls: room.walls,
        items: room.items,
        staticObstacles: STATIC_OBSTACLES,
        boss: room.boss
    });
}

function syncPlayerEquippedUltraFromProfile(p) {
    if (!p) return;
    const prof = profiles[p.clientKey];
    if (!prof) {
        p.ultraSkillId = null;
        p.ultraRemainingUses = 0;
        p.ultraMaxUses = 0;
        return;
    }
    const equipped = sanitizeUltraSkillId(prof.equippedUltra);
    const stock = equipped ? (prof.ultraStocks[equipped] || 0) : 0;
    if (equipped && stock > 0) {
        p.ultraSkillId = equipped;
        p.ultraMaxUses = stock;
        p.ultraRemainingUses = stock;
    } else {
        p.ultraSkillId = null;
        p.ultraMaxUses = 0;
        p.ultraRemainingUses = 0;
    }
}

// =========================================================================
// ギミックループ & BOSS AI
// =========================================================================
function startGimmickLoop(roomId) {
    const room = rooms[roomId];
    if (!room) return;

    const currentMatchId = room.matchId;

    room.wallTimer = setInterval(() => {
        const r = rooms[roomId];
        if (!r || r.state !== 'playing' || r.matchId !== currentMatchId) {
            return;
        }
        const maxWalls = r.mode === 'boss'
            ? GAME_RULES.OBSTACLES.BREAKABLE_MAX_BOSS
            : GAME_RULES.OBSTACLES.BREAKABLE_MAX_PVP;
        const wallSize = GAME_RULES.OBSTACLES.BREAKABLE_SIZE;
        const wallHp = GAME_RULES.OBSTACLES.BREAKABLE_HP;

        if (r.walls.length < maxWalls) {
            const wallPos = findSafePosition(r, wallSize);
            if (wallPos) {
                r.walls.push({
                    id: 'w_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
                    x: wallPos.x,
                    y: wallPos.y,
                    w: wallSize,
                    h: wallSize,
                    hp: wallHp,
                    maxHp: wallHp
                });
                io.to(roomId).emit('gimmicksUpdated', { walls: r.walls, items: r.items });
            }
        }
    }, 8500);

    const ITEM_TYPES = ['speed', 'heal', 'power'];
    room.itemTimer = setInterval(() => {
        const r = rooms[roomId];
        if (!r || r.state !== 'playing' || r.matchId !== currentMatchId) {
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

    if (room.mode === 'boss') {
        startBossAILoop(roomId, currentMatchId);
    }
}

function startBossAILoop(roomId, matchId) {
    const room = rooms[roomId];
    if (!room || !room.boss) return;

    let tick = 0;

    room.bossMoveTimer = setInterval(() => {
        const r = rooms[roomId];
        if (!r || r.state !== 'playing' || r.matchId !== matchId || !r.boss) {
            return;
        }
        const boss = r.boss;
        const curDef = getBossDef(boss.id);
        tick++;

        const activePlayerCount = Object.keys(r.players).length;
        const isSolo = activePlayerCount <= 1;

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
            let moveSpd = boss.phase === 2
                ? (isSolo ? curDef.moveSpeed.soloP2 : curDef.moveSpeed.multiP2)
                : (isSolo ? curDef.moveSpeed.soloP1 : curDef.moveSpeed.multiP1);

            if (boss.vortexActive) {
                moveSpd *= 0.65;
            }

            boss.x += Math.cos(angle) * moveSpd;
            boss.y += Math.sin(angle) * moveSpd;

            boss.x = Math.max(95, Math.min(ARENA_WIDTH - 95, boss.x));
            boss.y = Math.max(ARENA_TOP + 85, Math.min(ARENA_HEIGHT - 95, boss.y));
        }

        if (tick % 5 === 0) {
            for (const id in r.players) {
                const p = r.players[id];
                if (p.isDead || p.isEliminated) continue;
                const d = Math.hypot((p.x + 24) - boss.x, (p.y + 24) - boss.y);
                if (d < boss.radius + 14) {
                    const vortexDmg = boss.vortexActive ? 12 : 8;
                    applyBossDamageToPlayer(roomId, p, vortexDmg, 'vortex', matchId, boss.element);
                }
            }
        }

        io.to(roomId).emit('bossStateUpdated', boss);
    }, 200);

    let attackCount = 0;
    const scheduleNextAttack = () => {
        const r = rooms[roomId];
        if (!r || r.state !== 'playing' || r.matchId !== matchId || !r.boss) return;

        const curDef = getBossDef(r.boss.id);
        const interval = r.boss.phase === 2 ? curDef.attackIntervalMs.p2 : curDef.attackIntervalMs.p1;
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
    const def = getBossDef(boss.id);

    const allPlayerCount = Math.min(MAX_PLAYERS_PER_ROOM, Math.max(1, Object.keys(room.players).length));
    const alivePlayers = Object.values(room.players).filter((p) => !p.isDead && !p.isEliminated);
    if (alivePlayers.length === 0) return;

    const target = alivePlayers[Math.floor(Math.random() * alivePlayers.length)];
    const targetCx = target.x + 24;
    const targetCy = target.y + 24;

    def.executeAttack({
        room,
        roomId,
        matchId,
        boss,
        allPlayerCount,
        alivePlayers,
        target,
        targetCx,
        targetCy,
        count,
        io,
        getRoom: () => rooms[roomId],
        registerTimeout: registerBossTimeout,
        pointToSegmentDistance,
        applyDamageToPlayer: applyBossDamageToPlayer
    });
}

// =========================================================================
// ダメージ適用・完全反撃・絶対防壁・KO・勝敗判定
// =========================================================================
function applyDamageToBossInternal(roomId, attacker, rawDamage, attackKind, hitTypeLabel) {
    const room = rooms[roomId];
    if (!room || room.state !== 'playing' || room.mode !== 'boss' || !room.boss) return;
    if (!attacker || room.boss.hp <= 0) return;

    const def = getBossDef(room.boss.id);
    const elemMult = getElementMultiplier(attacker.element, room.boss.element);
    const barrierMult = (room.boss.barrierActive && def.barrierDamageMultiplier) ? def.barrierDamageMultiplier : 1.0;
    const finalDamage = Math.max(1, Math.round(rawDamage * elemMult * barrierMult));

    room.boss.hp = Math.max(0, room.boss.hp - finalDamage);
    attacker.bossDamageDealt = (attacker.bossDamageDealt || 0) + finalDamage;

    if (room.boss.phase === 1 && room.boss.hp <= room.boss.maxHp * 0.5) {
        room.boss.phase = 2;
    }

    io.to(roomId).emit('bossDamaged', {
        attackerId: attacker.id,
        damage: finalDamage,
        hp: room.boss.hp,
        maxHp: room.boss.maxHp,
        phase: room.boss.phase,
        blockedByBarrier: Boolean(room.boss.barrierActive),
        elementMultiplier: elemMult,
        attackerElement: attacker.element,
        defenderElement: room.boss.element,
        attackType: hitTypeLabel || attackKind
    });

    if (room.boss.hp <= 0) {
        checkMatchWinner(roomId);
    }
}

function applyDamageToPlayerInternal(roomId, target, attacker, rawDamage, knockDir, hitType, matchId, attackerElement) {
    const room = rooms[roomId];
    if (!room || room.state !== 'playing' || room.matchId !== matchId) return false;
    if (!target || target.isDead || target.isEliminated) return false;

    const now = Date.now();

    // 1. 完全反撃（構え中）チェック
    if (now < target.counterStanceUntil) {
        triggerPerfectCounter(roomId, target, attacker || 'BOSS', matchId);
        return false;
    }

    // 2. 絶対防壁 / 通常バリア Z チェック
    const hasAbsoluteWall = now < target.absoluteWallUntil;
    const hasShield = now < target.shieldUntil;
    if (hasAbsoluteWall || hasShield) {
        io.to(roomId).emit('attackBlocked', {
            targetId: target.id,
            attackerId: attacker && attacker !== 'BOSS' ? attacker.id : 'BOSS',
            knockbackDir: knockDir || 'down',
            type: hitType,
            byAbsoluteWall: hasAbsoluteWall
        });
        return false;
    }

    const atkElem = attackerElement || (attacker && attacker !== 'BOSS' ? attacker.element : 'neutral');
    const elemMult = getElementMultiplier(atkElem, target.element);
    const damage = Math.max(1, Math.round(rawDamage * elemMult));

    target.hp = Math.max(0, target.hp - damage);
    io.to(roomId).emit('playerDamaged', {
        targetId: target.id,
        attackerId: attacker && attacker !== 'BOSS' ? attacker.id : 'BOSS',
        damage,
        hp: target.hp,
        maxHp: target.maxHp,
        knockbackDir: knockDir || 'down',
        type: hitType,
        elementMultiplier: elemMult,
        attackerElement: atkElem,
        defenderElement: target.element
    });

    if (target.hp <= 0) {
        handlePlayerKO(roomId, target, attacker && attacker !== 'BOSS' ? attacker : null, matchId);
    }
    return true;
}

function applyBossDamageToPlayer(roomId, target, damage, attackType, matchId, bossElement) {
    const room = rooms[roomId];
    if (!room || !room.boss) return;
    const elem = bossElement || room.boss.element || 'neutral';
    applyDamageToPlayerInternal(roomId, target, 'BOSS', damage, 'down', attackType, matchId, elem);
}

function triggerPerfectCounter(roomId, counterPlayer, attacker, matchId) {
    const room = rooms[roomId];
    if (!room || room.state !== 'playing' || room.matchId !== matchId) return;
    if (!counterPlayer || counterPlayer.isDead || counterPlayer.isEliminated) return;

    const skill = getUltraSkillDef('perfect_counter');
    if (!skill) return;

    clearPlayerUltraStateAndTimers(counterPlayer);

    const pc = playerCenter(counterPlayer);
    const counterRadius = skill.counterRadius || 210;
    const powerMult = Date.now() < counterPlayer.powerBoostUntil ? 1.5 : 1.0;
    const baseCounterDmg = counterPlayer.stats.atk * skill.damageMultiplier * powerMult;

    io.to(roomId).emit('ultraSkillEvent', {
        playerId: counterPlayer.id,
        skillId: 'perfect_counter',
        phase: 'counter_fire',
        x: pc.x,
        y: pc.y,
        radius: counterRadius,
        facing: counterPlayer.facing,
        element: counterPlayer.element,
        durationMs: 320
    });

    if (room.mode === 'boss' && room.boss && room.boss.hp > 0) {
        const distToBoss = Math.hypot(room.boss.x - pc.x, room.boss.y - pc.y);
        // BOSS攻撃のカウンター時、あるいは反撃範囲＋α内にBOSSがいれば反撃ヒット
        if (attacker === 'BOSS' || distToBoss <= counterRadius + room.boss.radius + 90) {
            applyDamageToBossInternal(roomId, counterPlayer, baseCounterDmg, 'ultra_counter', 'ultra');
        }
    } else if (room.mode === 'pvp') {
        for (const id in room.players) {
            if (id === counterPlayer.id) continue;
            const enemy = room.players[id];
            if (!enemy || enemy.isDead || enemy.isEliminated) continue;
            const ec = playerCenter(enemy);
            const dist = Math.hypot(ec.x - pc.x, ec.y - pc.y);
            if (dist <= counterRadius + 24 || (attacker && attacker !== 'BOSS' && attacker.id === id && dist <= counterRadius + 80)) {
                const knockDir = Math.abs(ec.x - pc.x) >= Math.abs(ec.y - pc.y)
                    ? (ec.x >= pc.x ? 'right' : 'left')
                    : (ec.y >= pc.y ? 'down' : 'up');
                applyDamageToPlayerInternal(roomId, enemy, counterPlayer, baseCounterDmg, knockDir, 'ultra_counter', matchId, counterPlayer.element);
            }
        }
    }
}

function saveSessionRecord(room, playerObj) {
    if (!room || !playerObj || !playerObj.clientKey) return;
    const prof = profiles[playerObj.clientKey];
    if (prof) {
        prof.wins = playerObj.wins || prof.wins;
        prof.points = playerObj.points;
    }
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
    clearPlayerUltraStateAndTimers(target);
    target.stocks = Math.max(0, target.stocks - 1);

    const koBonus = attacker ? REWARD_PVP_KO : 0;
    if (attacker) {
        attacker.points = (attacker.points || 0) + koBonus;
        saveSessionRecord(room, attacker);
        const atkSockets = findSocketsByClientKey(attacker.clientKey);
        for (const s of atkSockets) emitProfileToClient(s, profiles[attacker.clientKey]);
    }

    const targetId = target.id;

    if (target.stocks <= 0) {
        target.isEliminated = true;
        let survivalBonus = 0;
        if (room.mode === 'pvp') {
            const aliveCount = Object.values(room.players).filter((pl) => !pl.isEliminated).length;
            if (aliveCount === 1) survivalBonus = 100;
            else if (aliveCount === 2) survivalBonus = 50;
        }

        if (survivalBonus > 0) {
            target.points = (target.points || 0) + survivalBonus;
        }
        saveSessionRecord(room, target);
        const tgtSockets = findSocketsByClientKey(target.clientKey);
        for (const s of tgtSockets) emitProfileToClient(s, profiles[target.clientKey]);

        io.to(roomId).emit('playerKO', {
            targetId,
            attackerId: attacker ? attacker.id : 'BOSS',
            stocks: 0,
            isEliminated: true,
            koBonus,
            survivalBonus,
            attackerPoints: attacker ? attacker.points : 0,
            targetPoints: target.points
        });

        checkMatchWinner(roomId);
    } else {
        io.to(roomId).emit('playerKO', {
            targetId,
            attackerId: attacker ? attacker.id : 'BOSS',
            stocks: target.stocks,
            isEliminated: false,
            koBonus,
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

// =========================================================================
// ステージ開始・再挑戦時リセット & カウントダウン開始
// =========================================================================
function beginMatchCountdown(roomId) {
    const room = rooms[roomId];
    if (!room) return;

    stopGimmickLoop(roomId);
    room.state = 'countdown';
    room.lastMatchCleared = false;
    room.matchId = (room.matchId || 0) + 1;
    const startingMatchId = room.matchId;

    room.walls = [];
    room.items = [];
    room.lastBossAttackAt = {};

    const stage = getStageByNumber(room.stageNumber);
    room.stageNumber = stage.stageNumber;
    room.stageId = stage.stageId;
    room.bossId = stage.bossId;

    const playerIds = Object.keys(room.players);
    room.boss = room.mode === 'boss' ? createBossInstance(room.bossId, playerIds.length) : null;

    playerIds.forEach((id, index) => {
        const p = room.players[id];
        const spawn = SPAWN_POINTS[index % SPAWN_POINTS.length];
        clearPlayerUltraStateAndTimers(p);
        Object.assign(p, createPlayerGuards());

        p.isDead = false;
        p.isEliminated = false;
        p.stocks = INITIAL_STOCKS;
        p.shieldUntil = 0;
        p.speedBoostUntil = 0;
        p.powerBoostUntil = 0;
        p.bossDamageDealt = 0;
        p.lastEarnedPoints = 0;
        p.lastPointBreakdown = null;
        p.ultraCooldownUntil = 0;
        syncPlayerEquippedUltraFromProfile(p);

        p.hp = p.maxHp;
        p.x = spawn.x;
        p.y = spawn.y;
        p.facing = spawn.facing;
    });

    io.to(roomId).emit('currentPlayers', serializeRoomPlayers(room));
    io.to(roomId).emit('gimmicksUpdated', { walls: [], items: [] });
    if (room.mode === 'boss') {
        io.to(roomId).emit('bossStateUpdated', room.boss);
    }
    io.to(roomId).emit('matchCountdown', {
        seconds: GAME_RULES.COUNTDOWN_SEC,
        mode: room.mode,
        stageNumber: room.stageNumber,
        stageId: room.stageId,
        bossId: room.bossId
    });

    room.countdownTimer = setTimeout(() => {
        const r = rooms[roomId];
        if (r && r.state === 'countdown' && r.matchId === startingMatchId) {
            r.countdownTimer = null;
            r.state = 'playing';
            io.to(roomId).emit('matchStart', {
                mode: r.mode,
                stageNumber: r.stageNumber,
                stageId: r.stageId,
                bossId: r.bossId,
                boss: r.boss
            });
            startGimmickLoop(roomId);
        }
    }, GAME_RULES.COUNTDOWN_SEC * 1000);
}

function checkAllReadyAndStart(roomId) {
    const room = rooms[roomId];
    if (!room || room.state !== 'waiting') return;

    const playerIds = Object.keys(room.players);
    const minRequired = room.mode === 'boss' ? 1 : 2;
    if (playerIds.length < minRequired) return;

    const allReady = playerIds.every((id) => room.players[id].isReady);
    if (!allReady) return;

    beginMatchCountdown(roomId);
}

function checkMatchWinner(roomId) {
    const room = rooms[roomId];
    if (!room || room.state !== 'playing') return;

    const playerIds = Object.keys(room.players);
    const survivors = playerIds.filter((id) => !room.players[id].isEliminated);

    if (room.mode === 'boss') {
        if (room.boss && room.boss.hp <= 0) {
            room.state = 'result';
            room.lastMatchCleared = true;
            stopGimmickLoop(roomId);

            const stage = getStageByNumber(room.stageNumber);
            const clearBonus = stage.clearRewardPt || 300;
            const nextStage = getNextStage(room.stageNumber);

            let mvpId = null;
            let maxDmg = -1;
            let totalDamageDealt = 0;

            playerIds.forEach((id) => {
                const dmg = room.players[id].bossDamageDealt || 0;
                totalDamageDealt += dmg;
                if (dmg > maxDmg) {
                    maxDmg = dmg;
                    mvpId = id;
                }
            });
            if (maxDmg <= 0) mvpId = null;

            const rewardsByPlayer = {};
            const unlockedStagesByPlayer = {};

            playerIds.forEach((id) => {
                const p = room.players[id];
                const dmg = p.bossDamageDealt || 0;
                const dmgRatio = totalDamageDealt > 0 ? (dmg / totalDamageDealt) : (1 / Math.max(1, playerIds.length));
                const contributionBonus = Math.round(REWARD_BOSS_CONTRIBUTION_POOL * dmgRatio);
                const mvpBonus = (id === mvpId) ? REWARD_BOSS_MVP : 0;
                const totalEarned = clearBonus + contributionBonus + mvpBonus;

                p.wins = (p.wins || 0) + 1;
                p.points = (p.points || 0) + totalEarned;
                p.lastEarnedPoints = totalEarned;
                p.lastPointBreakdown = {
                    clearBonus,
                    contributionBonus,
                    mvpBonus,
                    damageRatioPercent: Math.round(dmgRatio * 100),
                    totalEarned
                };

                const prof = getOrCreateProfile(p.clientKey);
                prof.wins = p.wins;
                prof.points = p.points;
                let newlyUnlockedStage = null;
                if (nextStage && prof.maxUnlockedStage < nextStage.stageNumber) {
                    prof.maxUnlockedStage = nextStage.stageNumber;
                    newlyUnlockedStage = nextStage.stageNumber;
                }
                unlockedStagesByPlayer[id] = {
                    maxUnlockedStage: prof.maxUnlockedStage,
                    newlyUnlockedStage
                };

                rewardsByPlayer[id] = p.lastPointBreakdown;
                saveSessionRecord(room, p);

                const sock = io.sockets.sockets.get(id);
                if (sock) emitProfileToClient(sock, prof);
            });

            io.to(roomId).emit('matchResult', {
                mode: 'boss',
                stageNumber: room.stageNumber,
                stageId: room.stageId,
                bossId: room.bossId,
                bossName: room.boss.name,
                bossCleared: true,
                nextStageNumber: nextStage ? nextStage.stageNumber : null,
                nextStageTitle: nextStage ? nextStage.title : null,
                mvpId,
                clearBonus,
                contributionPool: REWARD_BOSS_CONTRIBUTION_POOL,
                mvpBonus: REWARD_BOSS_MVP,
                rewardsByPlayer,
                unlockedStagesByPlayer,
                players: serializeRoomPlayers(room)
            });
            return;
        }

        if (survivors.length === 0) {
            room.state = 'result';
            room.lastMatchCleared = false;
            stopGimmickLoop(roomId);

            const rewardsByPlayer = {};
            playerIds.forEach((id) => {
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
                stageNumber: room.stageNumber,
                stageId: room.stageId,
                bossId: room.bossId,
                bossName: room.boss ? room.boss.name : getBossDef(room.bossId).name,
                bossCleared: false,
                nextStageNumber: null,
                mvpId: null,
                clearBonus: 0,
                contributionPool: 0,
                mvpBonus: 0,
                rewardsByPlayer,
                players: serializeRoomPlayers(room)
            });
        }
        return;
    }

    // PvPモード勝敗判定
    if (survivors.length <= 1) {
        room.state = 'result';
        room.lastMatchCleared = false;
        stopGimmickLoop(roomId);

        const winnerId = survivors.length === 1 ? survivors[0] : null;
        const rewardsByPlayer = {};

        playerIds.forEach((id) => {
            const p = room.players[id];
            const earned = (id === winnerId) ? REWARD_PVP_WIN : 0;
            if (id === winnerId) {
                p.wins = (p.wins || 0) + 1;
                p.points = (p.points || 0) + earned;
            }
            p.lastEarnedPoints = earned;
            p.lastPointBreakdown = { totalEarned: earned };
            rewardsByPlayer[id] = p.lastPointBreakdown;

            const prof = getOrCreateProfile(p.clientKey);
            prof.wins = p.wins;
            prof.points = p.points;
            saveSessionRecord(room, p);

            const sock = io.sockets.sockets.get(id);
            if (sock) emitProfileToClient(sock, prof);
        });

        const serialized = serializeRoomPlayers(room);
        io.to(roomId).emit('matchResult', {
            mode: 'pvp',
            winner: winnerId ? serialized[winnerId] : null,
            winnerId,
            winBonus: winnerId ? REWARD_PVP_WIN : 0,
            rewardsByPlayer,
            players: serialized
        });
    }
}

function handlePlayerExit(socket, roomId) {
    if (!roomId || !rooms[roomId]) return;
    const room = rooms[roomId];
    const leavingPlayer = room.players[socket.id];
    if (!leavingPlayer) return;

    const wasEliminated = Boolean(leavingPlayer.isEliminated);
    clearPlayerUltraStateAndTimers(leavingPlayer);
    saveSessionRecord(room, leavingPlayer);

    delete room.players[socket.id];
    io.to(roomId).emit('disconnectPlayer', socket.id);

    const remainingIds = Object.keys(room.players);
    if (remainingIds.length === 0) {
        stopGimmickLoop(roomId);
        delete rooms[roomId];
        return;
    }

    // ホスト引き継ぎ
    if (room.hostId === socket.id) {
        room.hostId = remainingIds[0];
        const hostMax = getHostMaxUnlockedStage(room);
        if (room.stageNumber > hostMax) {
            const clampedStage = getStageByNumber(hostMax);
            room.stageNumber = clampedStage.stageNumber;
            room.stageId = clampedStage.stageId;
            room.bossId = clampedStage.bossId;
        }
    }

    if (room.state === 'playing') {
        if (!wasEliminated) {
            checkMatchWinner(roomId);
        }
    } else if (room.state === 'countdown') {
        const minReq = room.mode === 'boss' ? 1 : 2;
        if (remainingIds.length < minReq) {
            stopGimmickLoop(roomId);
            room.state = 'waiting';
            for (const id of remainingIds) {
                room.players[id].isReady = false;
            }
            emitRoomStateSync(roomId);
        }
    } else {
        emitRoomStateSync(roomId);
    }
}

// =========================================================================
// サーバー側 斬撃（X）当たり判定＆モーション配信
// =========================================================================
function executeServerSlash(roomId, attacker, ox, oy, facing, isPowered) {
    const room = rooms[roomId];
    if (!room || room.state !== 'playing') return;

    const matchId = room.matchId;
    const slashCfg = GAME_RULES.ACTIONS.slash;
    const vec = facingToVector(facing);
    const range = slashCfg.range || 78;
    const endX = ox + vec.dx * range;
    const endY = oy + vec.dy * range;
    const powerMult = isPowered ? 1.5 : 1.0;

    // 斬撃モーション描画イベントをルーム全員へ配信
    io.to(roomId).emit('slashMotionEvent', {
        attackerId: attacker.id,
        x: ox,
        y: oy,
        facing,
        element: attacker.element,
        mainColor: attacker.stats.mainColor,
        isPowered,
        hasSpecialInk: Boolean(attacker.hasSpecialInk),
        specialInkType: attacker.dominantSpecialInk || null,
        durationMs: 220
    });

    // 壊せる壁へのダメージ
    let wallsChanged = false;
    for (let i = room.walls.length - 1; i >= 0; i--) {
        const w = room.walls[i];
        const wx = w.x + w.w / 2;
        const wy = w.y + w.h / 2;
        if (pointToSegmentDistance(wx, wy, ox, oy, endX, endY) <= 44) {
            w.hp -= 20;
            wallsChanged = true;
            if (w.hp <= 0) {
                room.walls.splice(i, 1);
            }
        }
    }
    if (wallsChanged) {
        io.to(roomId).emit('gimmicksUpdated', { walls: room.walls, items: room.items });
    }

    if (room.mode === 'boss' && room.boss && room.boss.hp > 0) {
        const hitDist = pointToSegmentDistance(room.boss.x, room.boss.y, ox, oy, endX, endY);
        if (hitDist <= room.boss.radius + 32) {
            const rawDmg = attacker.stats.atk * slashCfg.bossMultiplier * powerMult;
            applyDamageToBossInternal(roomId, attacker, rawDmg, 'melee', 'melee');
        }
    } else if (room.mode === 'pvp') {
        for (const id in room.players) {
            if (id === attacker.id) continue;
            const target = room.players[id];
            if (!target || target.isDead || target.isEliminated) continue;
            const tc = playerCenter(target);
            if (pointToSegmentDistance(tc.x, tc.y, ox, oy, endX, endY) <= 42) {
                const rawDmg = attacker.stats.atk * slashCfg.pvpMultiplier * powerMult;
                applyDamageToPlayerInternal(roomId, target, attacker, rawDmg, facing, 'melee', matchId, attacker.element);
            }
        }
    }
}

// =========================================================================
// Socket.IO イベントハンドラ
// =========================================================================
io.on('connection', (socket) => {
    console.log(`クライアントが接続しました: ${socket.id}`);
    let currentRoom = null;

    // クライアントプロファイル初期化・同期
    socket.on('syncProfile', (payload) => {
        const clientKey = sanitizeClientKey(payload && payload.clientKey, socket.id);
        socket.data.clientKey = clientKey;
        const prof = getOrCreateProfile(clientKey, payload);
        emitProfileToClient(socket, prof);
    });

    // 特別インクガチャ（300Pt / 重複100Pt還元）
    socket.on('drawInkGacha', (payload) => {
        const clientKey = sanitizeClientKey((payload && payload.clientKey) || socket.data.clientKey, socket.id);
        socket.data.clientKey = clientKey;
        const prof = getOrCreateProfile(clientKey, payload);

        const cost = GAME_RULES.GACHA.INK_COST;
        const dupRefund = GAME_RULES.GACHA.INK_DUPLICATE_REFUND;
        if (prof.points < cost) {
            socket.emit('gachaError', { type: 'ink', message: `ポイントが不足しています（必要: ${cost}Pt）`, profile: serializeProfile(prof) });
            return;
        }

        prof.points -= cost;
        const pool = SPECIAL_INK_IDS;
        const drawnInkId = pool[Math.floor(Math.random() * pool.length)];
        const inkDef = SPECIAL_INKS[drawnInkId];
        const rarity = drawnInkId === 'SPECIAL_VENOM' ? 'A' : 'S';
        const isDuplicate = prof.unlockedInks.includes(drawnInkId);
        let refundPt = 0;

        if (isDuplicate) {
            refundPt = dupRefund;
            prof.points += refundPt;
        } else {
            prof.unlockedInks.push(drawnInkId);
        }

        if (currentRoom && rooms[currentRoom] && rooms[currentRoom].players[socket.id]) {
            rooms[currentRoom].players[socket.id].points = prof.points;
        }

        socket.emit('inkGachaResult', {
            inkId: drawnInkId,
            inkName: inkDef ? inkDef.name : drawnInkId,
            rarity,
            isDuplicate,
            cost,
            refundPt,
            profile: serializeProfile(prof)
        });
    });

    // ウルトラガチャ（1000Pt / 同一技最大3ストック / ×3到達後重複300Pt還元）
    socket.on('drawUltraGacha', (payload) => {
        const clientKey = sanitizeClientKey((payload && payload.clientKey) || socket.data.clientKey, socket.id);
        socket.data.clientKey = clientKey;
        const prof = getOrCreateProfile(clientKey, payload);

        const cost = GAME_RULES.GACHA.ULTRA_COST;
        const maxStock = GAME_RULES.GACHA.ULTRA_MAX_STOCK;
        const maxDupRefund = GAME_RULES.GACHA.ULTRA_DUPLICATE_REFUND;

        if (prof.points < cost) {
            socket.emit('gachaError', { type: 'ultra', message: `ポイントが不足しています（必要: ${cost}Pt）`, profile: serializeProfile(prof) });
            return;
        }

        prof.points -= cost;

        // 重み付き抽選（Aランク各30%、Sランク各20%）
        const weightedPool = [
            { id: 'end_of_days', weight: 20 },
            { id: 'absolute_wall', weight: 30 },
            { id: 'perfect_counter', weight: 20 },
            { id: 'sky_meteor', weight: 30 }
        ];
        const totalWeight = weightedPool.reduce((acc, item) => acc + item.weight, 0);
        let roll = Math.random() * totalWeight;
        let drawnSkillId = ULTRA_SKILL_ORDER[0];
        for (const entry of weightedPool) {
            roll -= entry.weight;
            if (roll <= 0) {
                drawnSkillId = entry.id;
                break;
            }
        }

        const skillDef = getUltraSkillDef(drawnSkillId);
        const prevStock = prof.ultraStocks[drawnSkillId] || 0;
        let newStock = prevStock;
        let isMaxDuplicate = false;
        let refundPt = 0;

        if (prevStock >= maxStock) {
            isMaxDuplicate = true;
            refundPt = maxDupRefund;
            prof.points += refundPt;
        } else {
            newStock = prevStock + 1;
            prof.ultraStocks[drawnSkillId] = newStock;
            if (!prof.equippedUltra) {
                prof.equippedUltra = drawnSkillId;
            }
        }

        if (currentRoom && rooms[currentRoom] && rooms[currentRoom].players[socket.id]) {
            const p = rooms[currentRoom].players[socket.id];
            p.points = prof.points;
            if (rooms[currentRoom].state === 'waiting') {
                syncPlayerEquippedUltraFromProfile(p);
                emitRoomStateSync(currentRoom);
            }
        }

        socket.emit('ultraGachaResult', {
            skillId: drawnSkillId,
            skillName: skillDef.name,
            rarity: skillDef.rarity,
            icon: skillDef.icon,
            prevStock,
            newStock,
            isDuplicate: prevStock > 0,
            isMaxDuplicate,
            cost,
            refundPt,
            profile: serializeProfile(prof)
        });
    });

    // 必殺技の装備変更
    socket.on('equipUltraSkill', (payload) => {
        const clientKey = sanitizeClientKey((payload && payload.clientKey) || socket.data.clientKey, socket.id);
        socket.data.clientKey = clientKey;
        const prof = getOrCreateProfile(clientKey, payload);

        const requestedId = payload && payload.skillId ? sanitizeUltraSkillId(payload.skillId) : null;
        if (requestedId && (prof.ultraStocks[requestedId] || 0) <= 0) {
            socket.emit('gachaError', { type: 'equip', message: '未所持の必殺技は装備できません', profile: serializeProfile(prof) });
            return;
        }

        prof.equippedUltra = requestedId;
        emitProfileToClient(socket, prof);

        if (currentRoom && rooms[currentRoom] && rooms[currentRoom].players[socket.id]) {
            const r = rooms[currentRoom];
            if (r.state === 'waiting') {
                syncPlayerEquippedUltraFromProfile(r.players[socket.id]);
                emitRoomStateSync(currentRoom);
            }
        }
    });

    // ルーム入室
    socket.on('joinRoom', (payload) => {
        const roomId = sanitizeRoomId(payload && payload.roomId);
        if (!roomId) return;

        const occupied = rooms[roomId]
            ? Object.keys(rooms[roomId].players).filter((id) => id !== socket.id).length
            : 0;
        if (occupied >= MAX_PLAYERS_PER_ROOM) {
            socket.emit('roomFull', { roomId });
            return;
        }

        if (currentRoom && rooms[currentRoom]) {
            socket.leave(currentRoom);
            handlePlayerExit(socket, currentRoom);
        }

        let clientKey = sanitizeClientKey(payload && payload.clientKey, socket.id);
        if (rooms[roomId] && Object.values(rooms[roomId].players).some((other) => other.clientKey === clientKey && other.id !== socket.id)) {
            clientKey = clientKey.slice(0, 34) + '_' + socket.id.slice(0, 8);
        }
        socket.data.clientKey = clientKey;

        const prof = getOrCreateProfile(clientKey, payload && payload.profile ? payload.profile : payload);
        emitProfileToClient(socket, prof);

        currentRoom = roomId;
        socket.join(roomId);

        if (!rooms[roomId]) {
            const reqStageNum = Math.min(prof.maxUnlockedStage, Math.max(1, Math.floor(Number(payload && payload.stageNumber) || DEFAULT_STAGE_NUMBER)));
            const stage = payload && payload.bossId
                ? (STAGES.find((s) => s.bossId === sanitizeBossId(payload.bossId) && s.stageNumber <= prof.maxUnlockedStage) || getStageByNumber(reqStageNum))
                : getStageByNumber(reqStageNum);

            rooms[roomId] = {
                state: 'waiting',
                mode: payload && payload.mode === 'boss' ? 'boss' : 'pvp',
                stageNumber: stage.stageNumber,
                stageId: stage.stageId,
                bossId: stage.bossId,
                hostId: socket.id,
                lastMatchCleared: false,
                matchId: 0,
                players: {},
                sessionRecords: {},
                walls: [],
                items: [],
                boss: null,
                lastBossAttackAt: {},
                countdownTimer: null,
                wallTimer: null,
                itemTimer: null,
                bossMoveTimer: null,
                bossAttackTimer: null,
                bossPendingTimeouts: []
            };
        }

        const room = rooms[roomId];
        const cleanStats = sanitizeStats(payload && payload.stats);
        const gridData = payload && Array.isArray(payload.gridData) ? payload.gridData : null;
        const element = gridData
            ? determineElementFromPixels(gridData)
            : sanitizeElementId(payload && payload.element);
        const inkMeta = analyzeSpecialInkFromGrid(gridData);

        const equippedSkill = sanitizeUltraSkillId(prof.equippedUltra);
        const ultraStockCount = equippedSkill ? (prof.ultraStocks[equippedSkill] || 0) : 0;

        room.players[socket.id] = {
            id: socket.id,
            clientKey,
            name: sanitizeName(payload && payload.name),
            rank: sanitizeRank(payload && payload.rank),
            title: payload && typeof payload.title === 'string' ? payload.title.slice(0, 16) : '',
            element,
            hasSpecialInk: inkMeta.hasSpecialInk,
            dominantSpecialInk: inkMeta.dominantSpecialInk,
            x: ARENA_CENTER_X - 24,
            y: ARENA_CENTER_Y - 24,
            facing: 'right',
            characterData: gridData,
            stats: cleanStats,
            hp: cleanStats.maxHp,
            maxHp: cleanStats.maxHp,
            stocks: INITIAL_STOCKS,
            isDead: false,
            isEliminated: false,
            shieldUntil: 0,
            absoluteWallUntil: 0,
            counterStanceUntil: 0,
            speedBoostUntil: 0,
            powerBoostUntil: 0,
            ultraSkillId: ultraStockCount > 0 ? equippedSkill : null,
            ultraRemainingUses: ultraStockCount,
            ultraMaxUses: ultraStockCount,
            ultraCooldownUntil: 0,
            ultraState: null,
            ultraStateUntil: 0,
            ultraTimers: [],
            bossDamageDealt: 0,
            lastEarnedPoints: 0,
            lastPointBreakdown: null,
            isReady: false,
            wins: prof.wins,
            points: prof.points,
            ...createPlayerGuards()
        };

        emitRoomStateSync(roomId);
    });

    // ルームモード切替（ホストのみ・waiting中）
    socket.on('changeRoomMode', (payload) => {
        if (!currentRoom || !rooms[currentRoom]) return;
        const room = rooms[currentRoom];
        if (room.state !== 'waiting') return;
        if (room.hostId !== socket.id) {
            socket.emit('roomActionRejected', { message: 'モード変更はルーム作成者（ホスト）のみ可能です' });
            return;
        }

        const nextMode = typeof payload === 'object' && payload !== null ? payload.mode : payload;
        room.mode = nextMode === 'boss' ? 'boss' : 'pvp';

        if (typeof payload === 'object' && payload !== null && (payload.stageNumber || payload.bossId)) {
            const hostMax = getHostMaxUnlockedStage(room);
            const targetStage = payload.stageNumber
                ? getStageByNumber(payload.stageNumber)
                : (STAGES.find((s) => s.bossId === sanitizeBossId(payload.bossId)) || getStageByNumber(1));
            if (targetStage.stageNumber <= hostMax) {
                room.stageNumber = targetStage.stageNumber;
                room.stageId = targetStage.stageId;
                room.bossId = targetStage.bossId;
            }
        }

        for (const id in room.players) {
            room.players[id].isReady = false;
        }
        emitRoomStateSync(currentRoom);
    });

    // ステージ変更（ホストのみ・ホスト解放済みステージ上限まで）
    socket.on('changeRoomStage', (payload) => {
        if (!currentRoom || !rooms[currentRoom]) return;
        const room = rooms[currentRoom];
        if (room.state !== 'waiting') return;

        if (room.hostId !== socket.id) {
            socket.emit('roomActionRejected', { message: 'ステージ変更はルーム作成者（ホスト）のみ可能です' });
            return;
        }

        const reqNum = typeof payload === 'object' && payload !== null
            ? Number(payload.stageNumber)
            : Number(payload);
        const reqBossId = typeof payload === 'object' && payload !== null && payload.bossId
            ? sanitizeBossId(payload.bossId)
            : null;

        const targetStage = reqBossId
            ? (STAGES.find((s) => s.bossId === reqBossId) || getStageByNumber(1))
            : getStageByNumber(reqNum || 1);

        const hostMax = getHostMaxUnlockedStage(room);
        if (targetStage.stageNumber > hostMax) {
            socket.emit('roomActionRejected', { message: `STAGE ${targetStage.stageNumber} はまだ解放されていません` });
            return;
        }

        room.stageNumber = targetStage.stageNumber;
        room.stageId = targetStage.stageId;
        room.bossId = targetStage.bossId;

        for (const id in room.players) {
            room.players[id].isReady = false;
        }
        emitRoomStateSync(currentRoom);
    });

    // 後方互換用 changeRoomBoss（ホスト・解放済みチェック適用）
    socket.on('changeRoomBoss', (newBossId) => {
        if (!currentRoom || !rooms[currentRoom]) return;
        const room = rooms[currentRoom];
        if (room.state !== 'waiting') return;
        if (room.hostId !== socket.id) {
            socket.emit('roomActionRejected', { message: 'ステージ変更はルーム作成者（ホスト）のみ可能です' });
            return;
        }

        const safeBossId = sanitizeBossId(newBossId);
        const targetStage = STAGES.find((s) => s.bossId === safeBossId) || getStageByNumber(1);
        const hostMax = getHostMaxUnlockedStage(room);
        if (targetStage.stageNumber > hostMax) {
            socket.emit('roomActionRejected', { message: `STAGE ${targetStage.stageNumber} はまだ解放されていません` });
            return;
        }

        room.stageNumber = targetStage.stageNumber;
        room.stageId = targetStage.stageId;
        room.bossId = targetStage.bossId;

        for (const id in room.players) {
            room.players[id].isReady = false;
        }
        emitRoomStateSync(currentRoom);
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

    // 全滅時・リザルトからの「同じステージを最初からやり直す（再挑戦）」
    socket.on('retryStage', () => {
        if (!currentRoom || !rooms[currentRoom]) return;
        const room = rooms[currentRoom];
        if (room.state !== 'result') return;

        const playerIds = Object.keys(room.players);
        const minReq = room.mode === 'boss' ? 1 : 2;
        if (playerIds.length < minReq) return;

        beginMatchCountdown(currentRoom);
    });

    // リザルトからロビーへ帰還（クリア後は次ステージを自動選択した状態で戻る）
    socket.on('returnToLobby', () => {
        if (!currentRoom || !rooms[currentRoom]) return;
        const room = rooms[currentRoom];
        stopGimmickLoop(currentRoom);
        room.state = 'waiting';
        room.walls = [];
        room.items = [];
        room.boss = null;
        room.lastBossAttackAt = {};

        // 直前がBOSS撃破クリアだった場合、次ステージが解放済みなら自動選択状態にする
        if (room.mode === 'boss' && room.lastMatchCleared) {
            const nextStage = getNextStage(room.stageNumber);
            const hostMax = getHostMaxUnlockedStage(room);
            if (nextStage && nextStage.stageNumber <= hostMax) {
                room.stageNumber = nextStage.stageNumber;
                room.stageId = nextStage.stageId;
                room.bossId = nextStage.bossId;
            }
        }
        room.lastMatchCleared = false;

        for (const id in room.players) {
            const p = room.players[id];
            clearPlayerUltraStateAndTimers(p);
            Object.assign(p, createPlayerGuards());
            p.isReady = false;
            p.isDead = false;
            p.isEliminated = false;
            p.stocks = INITIAL_STOCKS;
            p.shieldUntil = 0;
            p.speedBoostUntil = 0;
            p.powerBoostUntil = 0;
            p.ultraCooldownUntil = 0;
            syncPlayerEquippedUltraFromProfile(p);
            p.bossDamageDealt = 0;
            p.lastEarnedPoints = 0;
            p.lastPointBreakdown = null;
            p.hp = p.maxHp;
            saveSessionRecord(room, p);
        }
        emitRoomStateSync(currentRoom);
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

            const dt = Math.min(1500, Math.max(16, now - (p.lastMoveAt || now)));
            const boosted = now < p.speedBoostUntil + 500;
            const perSec = (p.stats.spd * (boosted ? GAME_RULES.ITEMS.speed.speedMultiplier : 1) + (room.mode === 'boss' ? 2.2 : 0)) * 60;
            const budget = perSec * (dt / 1000) * 1.3 + 64;
            const dist = Math.hypot(nx - p.x, ny - p.y);
            if (dist > budget) {
                const ratio = budget / dist;
                nx = p.x + (nx - p.x) * ratio;
                ny = p.y + (ny - p.y) * ratio;
            }

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

        const wallIndex = room.walls.findIndex((w) => w.id === data.wallId);
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

        const itemIndex = room.items.findIndex((it) => it.id === (data && data.itemId));
        if (itemIndex === -1) return;

        const item = room.items[itemIndex];
        room.items.splice(itemIndex, 1);

        if (item.type === 'speed') {
            const duration = GAME_RULES.ITEMS.speed.durationMs;
            p.speedBoostUntil = Date.now() + duration;
            io.to(currentRoom).emit('itemEffectApplied', { id: socket.id, type: 'speed', duration });
        } else if (item.type === 'heal') {
            const healAmount = GAME_RULES.ITEMS.heal.healAmount;
            p.hp = Math.min(p.maxHp, p.hp + healAmount);
            io.to(currentRoom).emit('itemEffectApplied', { id: socket.id, type: 'heal', hp: p.hp, maxHp: p.maxHp, healAmount });
        } else if (item.type === 'power') {
            const duration = GAME_RULES.ITEMS.power.durationMs;
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

            if (Array.isArray(actualGrid)) {
                p.element = determineElementFromPixels(actualGrid);
                const inkMeta = analyzeSpecialInkFromGrid(actualGrid);
                p.hasSpecialInk = inkMeta.hasSpecialInk;
                p.dominantSpecialInk = inkMeta.dominantSpecialInk;
            } else if (payload.element !== undefined) {
                p.element = sanitizeElementId(payload.element);
            }

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
                element: p.element,
                hasSpecialInk: p.hasSpecialInk,
                dominantSpecialInk: p.dominantSpecialInk,
                characterData: p.characterData,
                stats: p.stats,
                hp: p.hp,
                maxHp: p.maxHp
            });
        }
    });

    // バリア (Z): 持続 1200ms / CD 4000ms
    socket.on('activateShield', () => {
        if (!currentRoom || !rooms[currentRoom]) return;
        const room = rooms[currentRoom];
        if (room.state !== 'playing') return;

        const p = room.players[socket.id];
        if (p && !p.isDead && !p.isEliminated) {
            const now = Date.now();
            if (now < p.nextShieldAt) return;
            const duration = GAME_RULES.ACTIONS.shield.durationMs;
            const cooldown = GAME_RULES.ACTIONS.shield.cooldownMs;
            p.nextShieldAt = now + cooldown;
            p.shieldUntil = now + duration;
            io.to(currentRoom).emit('playerShielded', {
                id: socket.id,
                duration,
                cooldownMs: cooldown
            });
        }
    });

    // 通常攻撃（斬撃 X: CD 600ms / 玉 C: CD 450ms）
    socket.on('playerAttack', (attackData) => {
        if (!currentRoom || !rooms[currentRoom]) return;
        const room = rooms[currentRoom];
        if (room.state !== 'playing' || !attackData) return;

        const p = room.players[socket.id];
        const hitType = sanitizeHitType(attackData.type);
        if (!p || p.isDead || p.isEliminated || !hitType) return;

        const refillMs = hitType === 'melee'
            ? GAME_RULES.ACTIONS.slash.cooldownMs
            : GAME_RULES.ACTIONS.shot.cooldownMs;
        const allowed = takeToken(p, hitType, refillMs, 1);
        if (!allowed) return;

        const c = playerCenter(p);
        let ox = Number(attackData.x);
        let oy = Number(attackData.y);
        if (!Number.isFinite(ox) || !Number.isFinite(oy) || Math.hypot(ox - c.x, oy - c.y) > 90) {
            ox = c.x;
            oy = c.y;
        }
        const facing = VALID_FACING.includes(attackData.facing) ? attackData.facing : p.facing;
        p.facing = facing;

        const now = Date.now();
        const boostedSpd = now < p.speedBoostUntil ? p.stats.spd * GAME_RULES.ITEMS.speed.speedMultiplier : p.stats.spd;
        const isPowered = now < p.powerBoostUntil;

        if (hitType === 'melee') {
            // 斬撃（X）はサーバー正として即座に当たり判定＋モーションイベント配信
            executeServerSlash(currentRoom, p, ox, oy, facing, isPowered);
            return;
        }

        // 玉（C）は弾生成クレジットを付与してリモートへ配信
        addCredit(p, 'shot');
        socket.to(currentRoom).emit('remoteAttack', {
            attackerId: socket.id,
            type: 'shot',
            x: ox,
            y: oy,
            facing,
            element: p.element,
            color: isPowered ? '#ff2222' : p.stats.mainColor,
            spd: boostedSpd,
            isPowered
        });
    });

    // 必殺技（Space）発動要求（サーバー側でストック・CD・フェーズ・タイマーを厳密管理）
    socket.on('activateUltra', (payload) => {
        if (!currentRoom || !rooms[currentRoom]) return;
        const room = rooms[currentRoom];
        if (room.state !== 'playing') return;

        const p = room.players[socket.id];
        if (!p || p.isDead || p.isEliminated) return;

        const skillId = sanitizeUltraSkillId(p.ultraSkillId);
        const skill = getUltraSkillDef(skillId);
        if (!skill || p.ultraRemainingUses <= 0) return;

        const now = Date.now();
        // 溜め/構え/予兆/展開中の多重発動禁止
        if (p.ultraState !== null && now < p.ultraStateUntil) return;
        // 6000ms 再使用クールダウン中チェック
        if (now < p.ultraCooldownUntil) return;

        if (payload && VALID_FACING.includes(payload.facing)) {
            p.facing = payload.facing;
        }

        // 発動確定（ストック消費＆サーバー基準時刻で6000ms CD起算統一）
        const activatedAt = now;
        const matchId = room.matchId;
        const roomId = currentRoom;
        p.ultraRemainingUses = Math.max(0, p.ultraRemainingUses - 1);
        p.ultraCooldownUntil = activatedAt + skill.cooldownMs;

        const pc = playerCenter(p);
        const facing = p.facing;

        if (skill.id === 'end_of_days') {
            const chargeMs = skill.chargeMs || 550;
            p.ultraState = 'charging';
            p.ultraStateUntil = activatedAt + chargeMs;

            io.to(roomId).emit('ultraSkillEvent', {
                playerId: p.id,
                skillId: skill.id,
                phase: 'charge',
                x: pc.x,
                y: pc.y,
                facing,
                element: p.element,
                durationMs: chargeMs,
                remainingUses: p.ultraRemainingUses,
                maxUses: p.ultraMaxUses,
                cooldownMs: skill.cooldownMs,
                cooldownUntil: p.ultraCooldownUntil
            });

            registerPlayerUltraTimeout(room, p, () => {
                const cur = rooms[roomId];
                if (!cur || cur.state !== 'playing' || cur.matchId !== matchId) return;
                const shooter = cur.players[p.id];
                if (!shooter || shooter.isDead || shooter.isEliminated) {
                    if (shooter) {
                        shooter.ultraState = null;
                        shooter.ultraStateUntil = 0;
                    }
                    return;
                }

                shooter.ultraState = null;
                shooter.ultraStateUntil = 0;

                const curCenter = playerCenter(shooter);
                const curFacing = shooter.facing;
                const vec = facingToVector(curFacing);
                const range = skill.range || 560;
                const x1 = curCenter.x;
                const y1 = curCenter.y;
                const x2 = x1 + vec.dx * range;
                const y2 = y1 + vec.dy * range;
                const powerMult = Date.now() < shooter.powerBoostUntil ? 1.5 : 1.0;
                const rawDamage = shooter.stats.atk * skill.damageMultiplier * powerMult;

                io.to(roomId).emit('ultraSkillEvent', {
                    playerId: shooter.id,
                    skillId: skill.id,
                    phase: 'fire',
                    x1,
                    y1,
                    x2,
                    y2,
                    facing: curFacing,
                    element: shooter.element,
                    durationMs: skill.durationMs || 260
                });

                // ライン上の壊せる壁を粉砕
                let wallsChanged = false;
                for (let i = cur.walls.length - 1; i >= 0; i--) {
                    const w = cur.walls[i];
                    if (pointToSegmentDistance(w.x + w.w / 2, w.y + w.h / 2, x1, y1, x2, y2) <= (skill.halfWidth || 28) + 20) {
                        cur.walls.splice(i, 1);
                        wallsChanged = true;
                    }
                }
                if (wallsChanged) {
                    io.to(roomId).emit('gimmicksUpdated', { walls: cur.walls, items: cur.items });
                }

                if (cur.mode === 'boss' && cur.boss && cur.boss.hp > 0) {
                    if (pointToSegmentDistance(cur.boss.x, cur.boss.y, x1, y1, x2, y2) <= (skill.halfWidth || 28) + cur.boss.radius) {
                        applyDamageToBossInternal(roomId, shooter, rawDamage, 'ultra_line', 'ultra');
                    }
                } else if (cur.mode === 'pvp') {
                    for (const tid in cur.players) {
                        if (tid === shooter.id) continue;
                        const target = cur.players[tid];
                        if (!target || target.isDead || target.isEliminated) continue;
                        const tc = playerCenter(target);
                        if (pointToSegmentDistance(tc.x, tc.y, x1, y1, x2, y2) <= (skill.halfWidth || 28) + 20) {
                            applyDamageToPlayerInternal(roomId, target, shooter, rawDamage, curFacing, 'ultra_line', matchId, shooter.element);
                        }
                    }
                }
            }, chargeMs);
        } else if (skill.id === 'absolute_wall') {
            const durationMs = skill.durationMs || 2600;
            p.ultraState = 'active_wall';
            p.ultraStateUntil = activatedAt + durationMs;
            p.absoluteWallUntil = activatedAt + durationMs;

            io.to(roomId).emit('ultraSkillEvent', {
                playerId: p.id,
                skillId: skill.id,
                phase: 'active',
                durationMs,
                pullMultiplier: skill.pullMultiplier || 0.15,
                remainingUses: p.ultraRemainingUses,
                maxUses: p.ultraMaxUses,
                cooldownMs: skill.cooldownMs,
                cooldownUntil: p.ultraCooldownUntil
            });

            registerPlayerUltraTimeout(room, p, () => {
                const cur = rooms[roomId];
                if (!cur || cur.state !== 'playing' || cur.matchId !== matchId) return;
                const holder = cur.players[p.id];
                if (!holder) return;
                holder.ultraState = null;
                holder.ultraStateUntil = 0;
                holder.absoluteWallUntil = 0;
                io.to(roomId).emit('ultraSkillEvent', {
                    playerId: holder.id,
                    skillId: skill.id,
                    phase: 'end'
                });
            }, durationMs);
        } else if (skill.id === 'perfect_counter') {
            const stanceMs = skill.stanceMs || 1800;
            p.ultraState = 'counter_stance';
            p.ultraStateUntil = activatedAt + stanceMs;
            p.counterStanceUntil = activatedAt + stanceMs;

            io.to(roomId).emit('ultraSkillEvent', {
                playerId: p.id,
                skillId: skill.id,
                phase: 'stance',
                durationMs: stanceMs,
                remainingUses: p.ultraRemainingUses,
                maxUses: p.ultraMaxUses,
                cooldownMs: skill.cooldownMs,
                cooldownUntil: p.ultraCooldownUntil
            });

            // 構え終了まで被弾しなかった場合もストック消費済みで終了（CDは継続）
            registerPlayerUltraTimeout(room, p, () => {
                const cur = rooms[roomId];
                if (!cur || cur.state !== 'playing' || cur.matchId !== matchId) return;
                const holder = cur.players[p.id];
                if (!holder) return;
                if (holder.counterStanceUntil > 0) {
                    holder.counterStanceUntil = 0;
                    holder.ultraState = null;
                    holder.ultraStateUntil = 0;
                    io.to(roomId).emit('ultraSkillEvent', {
                        playerId: holder.id,
                        skillId: skill.id,
                        phase: 'end',
                        whiff: true
                    });
                }
            }, stanceMs);
        } else if (skill.id === 'sky_meteor') {
            const warnMs = skill.warnMs || 800;
            const radius = skill.radius || 100;
            const castDist = skill.castDistance || 165;
            const vec = facingToVector(facing);
            const tx = Math.max(radius, Math.min(ARENA_WIDTH - radius, pc.x + vec.dx * castDist));
            const ty = Math.max(ARENA_TOP + radius, Math.min(ARENA_HEIGHT - radius, pc.y + vec.dy * castDist));

            p.ultraState = 'meteor_warn';
            p.ultraStateUntil = activatedAt + warnMs;

            io.to(roomId).emit('ultraSkillEvent', {
                playerId: p.id,
                skillId: skill.id,
                phase: 'warn',
                x: tx,
                y: ty,
                radius,
                element: p.element,
                durationMs: warnMs,
                remainingUses: p.ultraRemainingUses,
                maxUses: p.ultraMaxUses,
                cooldownMs: skill.cooldownMs,
                cooldownUntil: p.ultraCooldownUntil
            });

            registerPlayerUltraTimeout(room, p, () => {
                const cur = rooms[roomId];
                if (!cur || cur.state !== 'playing' || cur.matchId !== matchId) return;
                const caster = cur.players[p.id];
                if (!caster) return;
                caster.ultraState = null;
                caster.ultraStateUntil = 0;
                if (caster.isDead || caster.isEliminated) return;

                const powerMult = Date.now() < caster.powerBoostUntil ? 1.5 : 1.0;
                const rawDamage = caster.stats.atk * skill.damageMultiplier * powerMult;

                io.to(roomId).emit('ultraSkillEvent', {
                    playerId: caster.id,
                    skillId: skill.id,
                    phase: 'impact',
                    x: tx,
                    y: ty,
                    radius,
                    element: caster.element,
                    durationMs: skill.durationMs || 320
                });

                // 範囲内の壊せる壁を破壊
                let wallsChanged = false;
                for (let i = cur.walls.length - 1; i >= 0; i--) {
                    const w = cur.walls[i];
                    if (Math.hypot((w.x + w.w / 2) - tx, (w.y + w.h / 2) - ty) <= radius + 20) {
                        cur.walls.splice(i, 1);
                        wallsChanged = true;
                    }
                }
                if (wallsChanged) {
                    io.to(roomId).emit('gimmicksUpdated', { walls: cur.walls, items: cur.items });
                }

                if (cur.mode === 'boss' && cur.boss && cur.boss.hp > 0) {
                    if (Math.hypot(cur.boss.x - tx, cur.boss.y - ty) <= radius + cur.boss.radius) {
                        applyDamageToBossInternal(roomId, caster, rawDamage, 'ultra_meteor', 'ultra');
                    }
                } else if (cur.mode === 'pvp') {
                    for (const tid in cur.players) {
                        if (tid === caster.id) continue;
                        const target = cur.players[tid];
                        if (!target || target.isDead || target.isEliminated) continue;
                        const tc = playerCenter(target);
                        if (Math.hypot(tc.x - tx, tc.y - ty) <= radius + 20) {
                            const knockDir = Math.abs(tc.x - tx) >= Math.abs(tc.y - ty)
                                ? (tc.x >= tx ? 'right' : 'left')
                                : (tc.y >= ty ? 'down' : 'up');
                            applyDamageToPlayerInternal(roomId, target, caster, rawDamage, knockDir, 'ultra_meteor', matchId, caster.element);
                        }
                    }
                }
            }, warnMs);
        }
    });

    // BOSSへのダメージ処理（遠距離弾ヒット用）
    socket.on('damageBoss', (hitData) => {
        if (!currentRoom || !rooms[currentRoom]) return;
        const room = rooms[currentRoom];
        if (room.state !== 'playing' || room.mode !== 'boss' || !room.boss) return;

        const attacker = room.players[socket.id];
        if (!attacker || attacker.isDead || attacker.isEliminated) return;

        const hitType = sanitizeHitType(hitData && hitData.type);
        if (!hitType || hitType !== 'shot' || room.boss.hp <= 0) return;
        if (!useCredit(attacker, 'shot')) return;

        const powerMultiplier = Date.now() < attacker.powerBoostUntil ? 1.5 : 1.0;
        const rawDamage = attacker.stats.atk * powerMultiplier;
        applyDamageToBossInternal(currentRoom, attacker, rawDamage, 'shot', 'shot');
    });

    // BOSSの弾・追尾ミサイルに当たったときの処理
    socket.on('bossProjectileHit', (data) => {
        if (!currentRoom || !rooms[currentRoom]) return;
        const room = rooms[currentRoom];
        if (room.state !== 'playing' || room.mode !== 'boss' || !room.boss) return;

        const p = room.players[socket.id];
        if (!p || p.isDead || p.isEliminated) return;

        const def = getBossDef(room.boss.id);
        const kind = data && typeof data.kind === 'string' && def.attackProjectiles.includes(data.kind)
            ? data.kind
            : def.attackProjectiles[0];
        if (!kind) return;

        const lastAt = room.lastBossAttackAt && room.lastBossAttackAt[kind];
        if (!lastAt || Date.now() - lastAt > 8500) return;

        const dmg = def.projectileDamage[kind] || 12;
        applyBossDamageToPlayer(currentRoom, p, dmg, kind, room.matchId, room.boss.element);
    });

    // PvPモードでのプレイヤー間ダメージ（遠距離弾ヒット用）
    socket.on('applyDamage', (hitData) => {
        if (!currentRoom || !rooms[currentRoom]) return;
        const room = rooms[currentRoom];
        if (room.state !== 'playing' || room.mode === 'boss') return;

        const attacker = room.players[socket.id];
        const hitType = sanitizeHitType(hitData && hitData.type);
        const target = hitData ? room.players[hitData.targetId] : null;

        if (!attacker || !target || hitType !== 'shot' || attacker.id === target.id) return;
        if (attacker.isDead || attacker.isEliminated || target.isDead || target.isEliminated) return;
        if (!useCredit(attacker, 'shot')) return;

        const knockDir = VALID_FACING.includes(hitData.facing) ? hitData.facing : attacker.facing;
        const powerMultiplier = Date.now() < attacker.powerBoostUntil ? 1.5 : 1.0;
        const rawDamage = attacker.stats.atk * powerMultiplier;

        applyDamageToPlayerInternal(currentRoom, target, attacker, rawDamage, knockDir, 'shot', room.matchId, attacker.element);
    });

    socket.on('disconnect', () => {
        console.log(`クライアントが切断しました: ${socket.id}`);
        if (currentRoom && rooms[currentRoom]) {
            handlePlayerExit(socket, currentRoom);
            currentRoom = null;
        }
    });
});

const PORT = process.env.PORT || 3002;
server.listen(PORT, () => {
    console.log(`完全版バトルサーバー起動中: http://localhost:${PORT}`);
});
