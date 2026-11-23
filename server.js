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
    ULTRA_SKILLS: RAW_ULTRA_SKILLS,
    ULTRA_SKILL_ORDER: RAW_ULTRA_SKILL_ORDER,
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
    getUltraSkillDef: RAW_getUltraSkillDef,
    sanitizeUltraSkillId: RAW_sanitizeUltraSkillId
} = BossSystem;

// 全8種ウルトラ必殺技定義（bosses.js 未更新時のフォールバックも安全に補完）
const FALLBACK_ULTRA_SKILLS = {
    end_of_days: {
        id: 'end_of_days',
        name: '終焉の一閃',
        rarity: 'S',
        icon: '⚔️',
        cooldownMs: 6000,
        chargeMs: 350,
        durationMs: 260,
        range: 620,
        halfWidth: 56,
        damageMultiplier: 4.0,
        absoluteWallDamageMultiplier: 0.25,
        normalBarrierDamageMultiplier: 0.5,
        counterInteraction: { damageMultiplier: 0.5, triggersCounter: true }
    },
    absolute_wall: {
        id: 'absolute_wall',
        name: '絶対防壁',
        rarity: 'A',
        icon: '🛡️',
        cooldownMs: 6000,
        durationMs: 2600,
        pullMultiplier: 0.15
    },
    perfect_counter: {
        id: 'perfect_counter',
        name: '完全反撃',
        rarity: 'S',
        icon: '⚡',
        cooldownMs: 6000,
        stanceMs: 1800,
        counterRadius: 210,
        damageMultiplier: 3.5
    },
    sky_meteor: {
        id: 'sky_meteor',
        name: '天空隕石',
        rarity: 'A',
        icon: '☄️',
        cooldownMs: 6000,
        warnMs: 650,
        durationMs: 320,
        radius: 110,
        damageMultiplier: 2.2,
        meteorCount: 5,
        fanSpreadRad: 1.05,
        castDistance: 210
    },
    demon_blade: {
        id: 'demon_blade',
        name: '聖魔の覇剣',
        rarity: 'S',
        icon: '🗡️',
        cooldownMs: 6000,
        durationMs: 5000,
        rangeMultiplier: 1.5,
        damageMultiplier: 2.0
    },
    ricochet_guns: {
        id: 'ricochet_guns',
        name: '全方位跳弾銃',
        rarity: 'S',
        icon: '🔫',
        cooldownMs: 6000,
        durationMs: 5000,
        intervalMs: 625,
        directions: 8,
        bulletDamage: 40,
        bulletSpeed: 9.5,
        maxBounces: 1
    },
    phantom_boots: {
        id: 'phantom_boots',
        name: '疾風幻影靴',
        rarity: 'A',
        icon: '👢',
        cooldownMs: 6000,
        durationMs: 4000,
        speedMultiplier: 2.0
    },
    time_stop: {
        id: 'time_stop',
        name: '刻の静止',
        rarity: 'S',
        icon: '⏳',
        cooldownMs: 6000,
        durationMs: 2500
    }
};

const ALL_EIGHT_ULTRA_IDS = [
    'end_of_days',
    'absolute_wall',
    'perfect_counter',
    'sky_meteor',
    'demon_blade',
    'ricochet_guns',
    'phantom_boots',
    'time_stop'
];

const ULTRA_SKILL_ORDER = Array.from(new Set([
    ...(Array.isArray(RAW_ULTRA_SKILL_ORDER) ? RAW_ULTRA_SKILL_ORDER : []),
    ...ALL_EIGHT_ULTRA_IDS
]));

function getUltraSkillDef(skillId) {
    const base = typeof RAW_getUltraSkillDef === 'function' ? RAW_getUltraSkillDef(skillId) : null;
    const fallback = FALLBACK_ULTRA_SKILLS[skillId] || null;
    if (base && fallback) {
        return { ...fallback, ...base };
    }
    return base || fallback || null;
}

function sanitizeUltraSkillId(raw) {
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    if (ALL_EIGHT_ULTRA_IDS.includes(trimmed)) return trimmed;
    return typeof RAW_sanitizeUltraSkillId === 'function' ? RAW_sanitizeUltraSkillId(trimmed) : null;
}

const ULTRA_MAX_STOCK = (GAME_RULES && GAME_RULES.GACHA && GAME_RULES.GACHA.ULTRA_MAX_STOCK) || 3;
const ULTRA_DUPLICATE_REFUND = (GAME_RULES && GAME_RULES.GACHA && GAME_RULES.GACHA.ULTRA_DUPLICATE_REFUND) || 300;
const ULTRA_COOLDOWN_MS = 6000;

// Sレア4種（各重み10＝40）＋ Aレア4種（各重み15＝60）＝ 合計100
const ULTRA_GACHA_POOL = [
    { id: 'end_of_days', weight: 10, rarity: 'S' },
    { id: 'demon_blade', weight: 10, rarity: 'S' },
    { id: 'ricochet_guns', weight: 10, rarity: 'S' },
    { id: 'time_stop', weight: 10, rarity: 'S' },
    { id: 'absolute_wall', weight: 15, rarity: 'A' },
    { id: 'perfect_counter', weight: 15, rarity: 'A' },
    { id: 'sky_meteor', weight: 15, rarity: 'A' },
    { id: 'phantom_boots', weight: 15, rarity: 'A' }
];

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

// サーバー側ティックで直接当たり判定を行うBOSS弾種（二重ダメージ防止用）
const SERVER_AUTHORITATIVE_PROJECTILES = new Set([
    'snake_dark',
    'shadow_orb',
    'curved_fireball',
    'phantom_homing',
    'curse_bolt',
    'feint_orb'
]);

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
                initStocks[skillId] = Math.min(ULTRA_MAX_STOCK, Math.max(0, rawVal));
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
        lastMoveAt: 0,
        lastMoveVectorAt: 0,
        vx: 0,
        vy: 0,
        lastServerProjHitAt: 0,
        lastMagmaHitAt: 0,
        lastPulseHitAt: 0
    };
}

function resetPlayerCombatStatuses(p, room) {
    if (!p) return;
    p.shieldUntil = 0;
    p.speedBoostUntil = 0;
    p.powerBoostUntil = 0;
    p.slowUntil = 0;
    p.slowMultiplier = 1.0;
    p.attackDebuffUntil = 0;
    p.attackDebuffMultiplier = 1.0;
    p.dotUntil = 0;
    p.dotDamage = 0;
    p.dotIntervalMs = 600;
    p.nextDotAt = 0;
    p.vx = 0;
    p.vy = 0;
    p.lastMoveVectorAt = 0;
    p.lastServerProjHitAt = 0;
    p.lastMagmaHitAt = 0;
    p.lastPulseHitAt = 0;
    clearPlayerUltraStateAndTimers(p, room);
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

function pointInStaticObstacle(px, py) {
    for (const obs of STATIC_OBSTACLES) {
        if (px >= obs.x && px <= obs.x + obs.w && py >= obs.y && py <= obs.y + obs.h) {
            return true;
        }
    }
    return false;
}

function overlapsObstacleOrWall(room, x, y, size, pad = 4) {
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

// phantom_boots 終了・強制解除時に障害物/壁と重なっている場合、最寄りの安全な非壁座標へ押し戻す
function ejectPlayerFromObstaclesIfOverlapping(room, p) {
    if (!room || !p) return false;
    const maxX = ARENA_WIDTH - CHAR_SIZE;
    const maxY = ARENA_HEIGHT - CHAR_SIZE;
    p.x = Math.max(0, Math.min(maxX, p.x));
    p.y = Math.max(ARENA_TOP, Math.min(maxY, p.y));

    if (!overlapsObstacleOrWall(room, p.x, p.y, CHAR_SIZE, 6)) {
        return false;
    }

    const startX = p.x;
    const startY = p.y;
    let bestPos = null;
    let bestDist = Infinity;

    // 放射状・格子状に探索して最短距離の非壁座標を探す
    for (let radius = 8; radius <= 260; radius += 8) {
        const steps = Math.max(12, Math.floor((Math.PI * 2 * radius) / 14));
        for (let i = 0; i < steps; i++) {
            const ang = (Math.PI * 2 / steps) * i;
            const cx = Math.max(0, Math.min(maxX, Math.round(startX + Math.cos(ang) * radius)));
            const cy = Math.max(ARENA_TOP, Math.min(maxY, Math.round(startY + Math.sin(ang) * radius)));
            if (!overlapsObstacleOrWall(room, cx, cy, CHAR_SIZE, 8)) {
                const dist = Math.hypot(cx - startX, cy - startY);
                if (dist < bestDist) {
                    bestDist = dist;
                    bestPos = { x: cx, y: cy };
                }
            }
        }
        if (bestPos) break;
    }

    if (!bestPos) {
        bestPos = findSafePosition(room, CHAR_SIZE);
    }

    p.x = bestPos.x;
    p.y = bestPos.y;
    return true;
}

function findSafePosition(room, size) {
    for (let attempt = 0; attempt < 60; attempt++) {
        const x = Math.floor(Math.random() * (ARENA_WIDTH - size - 48)) + 24;
        const y = Math.floor(Math.random() * (ARENA_HEIGHT - ARENA_TOP - size - 48)) + ARENA_TOP + 24;

        if (overlapsObstacleOrWall(room, x, y, size, 4)) continue;

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

function pushPlayerSafely(p, angle, distance, allowGhostThroughObstacles = false) {
    if (!p || distance <= 0) return;
    const steps = 10;
    const stepDist = distance / steps;
    const maxX = ARENA_WIDTH - CHAR_SIZE;
    const maxY = ARENA_HEIGHT - CHAR_SIZE;
    let curX = p.x;
    let curY = p.y;

    for (let s = 1; s <= steps; s++) {
        const candX = Math.max(0, Math.min(maxX, curX + Math.cos(angle) * stepDist));
        const candY = Math.max(ARENA_TOP, Math.min(maxY, curY + Math.sin(angle) * stepDist));
        if (!allowGhostThroughObstacles && overlapsStaticObstacle(candX, candY, CHAR_SIZE, 12)) {
            break;
        }
        curX = candX;
        curY = candY;
    }

    p.x = curX;
    p.y = curY;
}

function isTimeStopActive(room, now = Date.now()) {
    return Boolean(room && room.timeStopUntil && now < room.timeStopUntil);
}

// =========================================================================
// タイマー管理・必殺技タイマー完全破棄
// =========================================================================
function clearPlayerUltraStateAndTimers(p, room) {
    if (!p) return;
    const hadPhantomBoots = Boolean(p.phantomBootsUntil && p.phantomBootsUntil > 0) || p.ultraState === 'phantom_boots';
    const hadDemonBlade = Boolean(p.demonBladeUntil && p.demonBladeUntil > 0) || p.ultraState === 'demon_blade';
    const hadRicochet = p.ultraState === 'ricochet_guns';

    if (Array.isArray(p.ultraTimers)) {
        for (const tid of p.ultraTimers) {
            clearTimeout(tid);
            clearInterval(tid);
        }
    }
    p.ultraTimers = [];
    p.ultraState = null;
    p.ultraStateUntil = 0;
    p.absoluteWallUntil = 0;
    p.counterStanceUntil = 0;
    p.demonBladeUntil = 0;
    p.phantomBootsUntil = 0;
    p.ultraActiveTimerId = null;

    if (room) {
        if (Array.isArray(room.ricochetBullets) && p.id) {
            room.ricochetBullets = room.ricochetBullets.filter((b) => b.ownerId !== p.id);
        }
        if (room.timeStopCasterId === p.id) {
            room.timeStopCasterId = null;
            if (!room.timeStopUntil || Date.now() >= room.timeStopUntil) {
                room.timeStopUntil = 0;
            }
        }
        if (hadPhantomBoots) {
            ejectPlayerFromObstaclesIfOverlapping(room, p);
        }
        if ((hadPhantomBoots || hadDemonBlade || hadRicochet) && room.id) {
            io.to(room.id).emit('playerMoved', {
                id: p.id,
                x: p.x,
                y: p.y,
                facing: p.facing
            });
        }
    }
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

function registerPlayerUltraInterval(room, p, fn, intervalMs) {
    if (!room || !p) return null;
    if (!Array.isArray(p.ultraTimers)) {
        p.ultraTimers = [];
    }
    const intervalId = setInterval(() => {
        fn();
    }, intervalMs);
    p.ultraTimers.push(intervalId);
    return intervalId;
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
    if (room.bossProjectileTimer) { clearInterval(room.bossProjectileTimer); room.bossProjectileTimer = null; }
    if (room.bossAttackTimer) { clearTimeout(room.bossAttackTimer); room.bossAttackTimer = null; }
    if (Array.isArray(room.bossPendingTimeouts)) {
        for (const tid of room.bossPendingTimeouts) {
            clearTimeout(tid);
        }
        room.bossPendingTimeouts = [];
    }
    room.bossProjectiles = [];
    room.bossMagmaZones = [];
    room.ricochetBullets = [];
    room.timeStopUntil = 0;
    room.timeStopCasterId = null;
    room.bossRoarPullUntil = 0;
    room.bossRoarPullStrength = 0;
    if (room.boss) {
        room.boss.scaleAuraActive = false;
        room.boss.scaleAuraUntil = 0;
        room.boss.pulseCharging = false;
        room.boss.vortexActive = false;
        room.boss.barrierActive = false;
        room.boss.isStealthed = false;
        room.boss.clones = [];
    }
    for (const id in room.players) {
        clearPlayerUltraStateAndTimers(room.players[id], room);
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
            demonBladeUntil: p.demonBladeUntil || 0,
            phantomBootsUntil: p.phantomBootsUntil || 0,
            speedBoostUntil: p.speedBoostUntil,
            powerBoostUntil: p.powerBoostUntil,
            slowUntil: p.slowUntil || 0,
            slowMultiplier: p.slowMultiplier || 1.0,
            attackDebuffUntil: p.attackDebuffUntil || 0,
            attackDebuffMultiplier: p.attackDebuffMultiplier || 1.0,
            dotUntil: p.dotUntil || 0,
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
        timeStopUntil: room.timeStopUntil || 0,
        timeStopCasterId: room.timeStopCasterId || null,
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
// ricochet_guns（全方位跳弾銃）生成＆サーバーティック更新
// =========================================================================
function spawnRicochetVolley(roomId, caster, matchId) {
    const room = rooms[roomId];
    if (!room || room.state !== 'playing' || room.matchId !== matchId) return;
    if (!caster || caster.isDead || caster.isEliminated) return;

    const skill = getUltraSkillDef('ricochet_guns');
    const directions = Math.max(1, Number(skill && skill.directions) || 8);
    const speed = Number(skill && skill.bulletSpeed) || 9.5;
    const damage = Number(skill && skill.bulletDamage) || 40;
    const maxBounces = Number(skill && skill.maxBounces) || 1;
    const center = playerCenter(caster);

    if (!Array.isArray(room.ricochetBullets)) {
        room.ricochetBullets = [];
    }

    const spawned = [];
    for (let i = 0; i < directions; i++) {
        const angle = (Math.PI * 2 / directions) * i;
        const bullet = {
            id: `rb_${matchId}_${Date.now()}_${i}_${Math.floor(Math.random() * 1000)}`,
            ownerId: caster.id,
            element: caster.element || 'neutral',
            x: center.x,
            y: center.y,
            vx: Math.cos(angle) * speed,
            vy: Math.sin(angle) * speed,
            damage,
            hitRadius: 14,
            bounceCount: 0,
            maxBounces,
            life: 240,
            hitPlayerIds: new Set()
        };
        room.ricochetBullets.push(bullet);
        spawned.push({
            id: bullet.id,
            ownerId: bullet.ownerId,
            element: bullet.element,
            x: bullet.x,
            y: bullet.y,
            vx: bullet.vx,
            vy: bullet.vy,
            bounceCount: bullet.bounceCount
        });
    }

    io.to(roomId).emit('ultraSkillEvent', {
        playerId: caster.id,
        skillId: 'ricochet_guns',
        phase: 'volley',
        x: center.x,
        y: center.y,
        element: caster.element,
        bullets: spawned,
        durationMs: 220
    });
}

function stepServerRicochetBullets(roomId, matchId, dtMs, now) {
    const room = rooms[roomId];
    if (!room || room.state !== 'playing' || room.matchId !== matchId) return;
    if (!Array.isArray(room.ricochetBullets) || room.ricochetBullets.length === 0) return;

    // 時間停止中は既存跳弾の移動・タイマー進行も停止する
    if (isTimeStopActive(room, now)) return;

    const stepFrames = Math.min(4, Math.max(0.5, dtMs / (1000 / 60)));
    let wallsChanged = false;

    for (let i = room.ricochetBullets.length - 1; i >= 0; i--) {
        const b = room.ricochetBullets[i];
        const shooter = room.players[b.ownerId];
        if (!shooter) {
            room.ricochetBullets.splice(i, 1);
            continue;
        }

        b.life -= stepFrames;
        if (b.life <= 0) {
            room.ricochetBullets.splice(i, 1);
            continue;
        }

        const prevX = b.x;
        const prevY = b.y;
        const nextX = prevX + b.vx * stepFrames;
        const nextY = prevY + b.vy * stepFrames;

        // アリーナ外周境界チェック（反射対象または消滅）
        let hitBoundary = false;
        let hitWallOrObstacle = false;
        let wallDamageTarget = null;

        if (nextX < 0 || nextX > ARENA_WIDTH) {
            hitBoundary = true;
            if (b.bounceCount === 0) {
                b.vx = -b.vx;
                b.bounceCount = 1;
                b.x = Math.max(0, Math.min(ARENA_WIDTH, prevX + b.vx * stepFrames));
                b.y = Math.max(ARENA_TOP, Math.min(ARENA_HEIGHT, nextY));
            } else {
                room.ricochetBullets.splice(i, 1);
                continue;
            }
        }

        if (nextY < ARENA_TOP || nextY > ARENA_HEIGHT) {
            hitBoundary = true;
            if (b.bounceCount === 0) {
                b.vy = -b.vy;
                b.bounceCount = 1;
                b.x = Math.max(0, Math.min(ARENA_WIDTH, b.x));
                b.y = Math.max(ARENA_TOP, Math.min(ARENA_HEIGHT, prevY + b.vy * stepFrames));
            } else {
                room.ricochetBullets.splice(i, 1);
                continue;
            }
        }

        if (!hitBoundary) {
            b.x = nextX;
            b.y = nextY;
        }

        // 壊せる壁・固定障害物との接触判定（bounceCount === 0 のとき1回だけ反射、2回目で消滅）
        if (!hitBoundary) {
            for (let wIdx = room.walls.length - 1; wIdx >= 0; wIdx--) {
                const w = room.walls[wIdx];
                if (b.x >= w.x && b.x <= w.x + w.w && b.y >= w.y && b.y <= w.y + w.h) {
                    hitWallOrObstacle = true;
                    wallDamageTarget = w;
                    break;
                }
            }

            if (!hitWallOrObstacle) {
                for (const obs of STATIC_OBSTACLES) {
                    if (b.x >= obs.x && b.x <= obs.x + obs.w && b.y >= obs.y && b.y <= obs.y + obs.h) {
                        hitWallOrObstacle = true;
                        break;
                    }
                }
            }

            if (hitWallOrObstacle) {
                if (wallDamageTarget) {
                    wallDamageTarget.hp -= 10;
                    wallsChanged = true;
                    if (wallDamageTarget.hp <= 0) {
                        const idxToRemove = room.walls.findIndex((item) => item.id === wallDamageTarget.id);
                        if (idxToRemove !== -1) room.walls.splice(idxToRemove, 1);
                    }
                }

                if (b.bounceCount === 0) {
                    b.bounceCount = 1;
                    // X/Y どちらの軸で壁に入ったかを判定して反射
                    const hitXOnly = pointInStaticObstacle(nextX, prevY) || room.walls.some((w) => nextX >= w.x && nextX <= w.x + w.w && prevY >= w.y && prevY <= w.y + w.h);
                    const hitYOnly = pointInStaticObstacle(prevX, nextY) || room.walls.some((w) => prevX >= w.x && prevX <= w.x + w.w && nextY >= w.y && nextY <= w.y + w.h);
                    if (hitXOnly && !hitYOnly) {
                        b.vx = -b.vx;
                    } else if (hitYOnly && !hitXOnly) {
                        b.vy = -b.vy;
                    } else {
                        b.vx = -b.vx;
                        b.vy = -b.vy;
                    }
                    b.x = prevX + b.vx * stepFrames;
                    b.y = prevY + b.vy * stepFrames;
                    io.to(roomId).emit('ultraRicochetBounce', {
                        bulletId: b.id,
                        ownerId: b.ownerId,
                        x: b.x,
                        y: b.y,
                        vx: b.vx,
                        vy: b.vy,
                        bounceCount: b.bounceCount
                    });
                } else {
                    room.ricochetBullets.splice(i, 1);
                    continue;
                }
            }
        }

        // 当たり判定（BOSS または PvP 敵プレイヤー）
        let consumed = false;
        if (room.mode === 'boss' && room.boss && room.boss.hp > 0 && !room.boss.isStealthed) {
            const distToBoss = Math.hypot(room.boss.x - b.x, room.boss.y - b.y);
            if (distToBoss <= room.boss.radius + b.hitRadius) {
                applyDamageToBossInternal(roomId, shooter, b.damage, 'ultra_ricochet', 'ultra');
                consumed = true;
            }
        } else if (room.mode === 'pvp') {
            for (const pid in room.players) {
                if (pid === b.ownerId) continue;
                const target = room.players[pid];
                if (!target || target.isDead || target.isEliminated) continue;
                const tc = playerCenter(target);
                const dist = Math.hypot(tc.x - b.x, tc.y - b.y);
                if (dist <= b.hitRadius + 20) {
                    const knockDir = Math.abs(b.vx) >= Math.abs(b.vy)
                        ? (b.vx >= 0 ? 'right' : 'left')
                        : (b.vy >= 0 ? 'down' : 'up');
                    applyDamageToPlayerInternal(
                        roomId,
                        target,
                        shooter,
                        b.damage,
                        knockDir,
                        'ultra_ricochet',
                        matchId,
                        shooter.element
                    );
                    consumed = true;
                    break;
                }
            }
        }

        if (consumed) {
            room.ricochetBullets.splice(i, 1);
        }
    }

    if (wallsChanged) {
        io.to(roomId).emit('gimmicksUpdated', { walls: room.walls, items: room.items });
    }
}

// =========================================================================
// サーバー側BOSS弾道＆マグマ床登録＆ティック更新（STAGE 3〜5）
// =========================================================================
function registerServerBossProjectilesFromEvent(roomId, matchId, ev) {
    const room = rooms[roomId];
    if (!room || room.state !== 'playing' || room.matchId !== matchId || !room.boss || !ev) return;
    if (!Array.isArray(room.bossProjectiles)) {
        room.bossProjectiles = [];
    }

    const bossElem = ev.element || room.boss.element || 'neutral';

    if (ev.type === 'twin_serpent' && Array.isArray(ev.snakes)) {
        for (const s of ev.snakes) {
            room.bossProjectiles.push({
                kind: 'snake_dark',
                element: bossElem,
                x: s.x,
                y: s.y,
                baseX: s.x,
                baseY: s.y,
                angle: s.angle,
                side: s.side || 1,
                speed: s.speed || 4.1,
                waveAmp: s.waveAmp || 34,
                waveFreq: s.waveFreq || 0.12,
                age: 0,
                damage: s.damage || ev.damage || 14,
                hitRadius: 22,
                life: 155
            });
        }
    } else if (ev.type === 'curse_wave') {
        const total = Math.max(1, ev.count || 16);
        const baseAngle = ev.baseAngle || 0;
        const speed = ev.speed || 3.8;
        const damage = ev.damage || 8;
        for (let i = 0; i < total; i++) {
            const ang = baseAngle + (Math.PI * 2 / total) * i;
            room.bossProjectiles.push({
                kind: 'shadow_orb',
                element: bossElem,
                x: ev.x,
                y: ev.y,
                vx: Math.cos(ang) * speed,
                vy: Math.sin(ang) * speed,
                damage,
                hitRadius: 18,
                life: 150
            });
        }
    } else if (ev.type === 'roar_fire') {
        const fireCount = Math.max(1, ev.fireCount || 10);
        const fireSpeed = ev.fireSpeed || 3.7;
        const curveRate = Number(ev.curveRate) || 0;
        const fireDamage = ev.fireDamage || 20;
        for (let i = 0; i < fireCount; i++) {
            const ang = (Math.PI * 2 / fireCount) * i;
            room.bossProjectiles.push({
                kind: 'curved_fireball',
                element: bossElem,
                x: ev.x,
                y: ev.y,
                vx: Math.cos(ang) * fireSpeed,
                vy: Math.sin(ang) * fireSpeed,
                curveRate,
                damage: fireDamage,
                hitRadius: 23,
                life: 145
            });
        }
    } else if (ev.type === 'roar_warn' && ev.pullStrength) {
        room.bossRoarPullUntil = Date.now() + (Number(ev.warnDuration) || 780);
        room.bossRoarPullStrength = Number(ev.pullStrength) || 0.85;
    } else if (ev.type === 'phantom_homing' && Array.isArray(ev.orbs)) {
        for (const o of ev.orbs) {
            room.bossProjectiles.push({
                kind: 'phantom_homing',
                element: bossElem,
                x: o.x,
                y: o.y,
                vx: o.vx,
                vy: o.vy,
                speed: o.speed || 3.4,
                turnRate: o.turnRate || 0.045,
                damage: o.damage || ev.damage || 8,
                hitRadius: 20,
                life: 135
            });
        }
    } else if (ev.type === 'curse_bolt_fire') {
        const total = Math.max(1, ev.count || 3);
        const spread = ev.spread || 0.62;
        const speed = ev.speed || 4.1;
        const damage = ev.damage || 10;
        for (let i = 0; i < total; i++) {
            const offset = total === 1 ? 0 : ((i / (total - 1)) - 0.5) * spread;
            const ang = (ev.baseAngle || 0) + offset;
            room.bossProjectiles.push({
                kind: 'curse_bolt',
                element: bossElem,
                x: ev.x,
                y: ev.y,
                vx: Math.cos(ang) * speed,
                vy: Math.sin(ang) * speed,
                damage,
                hitRadius: 20,
                life: 145
            });
        }
    } else if (ev.type === 'feint_barrage') {
        const total = Math.max(1, ev.count || 10);
        const baseAngle = ev.baseAngle || 0;
        const speed = ev.speed || 3.8;
        const damage = ev.damage || 6;
        for (let i = 0; i < total; i++) {
            const ang = baseAngle + (Math.PI * 2 / total) * i;
            room.bossProjectiles.push({
                kind: 'feint_orb',
                element: bossElem,
                x: ev.x,
                y: ev.y,
                vx: Math.cos(ang) * speed,
                vy: Math.sin(ang) * speed,
                damage,
                hitRadius: 18,
                life: 150
            });
        }
    }
}

function spawnMagmaZones(roomId, zones, durationMs, matchId, bossElement) {
    const room = rooms[roomId];
    if (!room || room.state !== 'playing' || room.matchId !== matchId || !Array.isArray(zones)) return;
    if (!Array.isArray(room.bossMagmaZones)) {
        room.bossMagmaZones = [];
    }
    const expiresAt = Date.now() + (Number(durationMs) || 2400);
    const elem = bossElement || (room.boss ? room.boss.element : 'fire');
    for (const z of zones) {
        room.bossMagmaZones.push({
            x: z.x,
            y: z.y,
            radius: z.radius || 84,
            expiresAt,
            element: elem
        });
    }
}

function stepServerMagmaZones(roomId, matchId, now = Date.now()) {
    const room = rooms[roomId];
    if (!room || room.state !== 'playing' || room.matchId !== matchId || !room.boss) return;
    if (!Array.isArray(room.bossMagmaZones) || room.bossMagmaZones.length === 0) return;

    // 時間停止中はマグマ床の進行・ティック判定も一時停止
    if (isTimeStopActive(room, now)) return;

    for (let i = room.bossMagmaZones.length - 1; i >= 0; i--) {
        if (now >= room.bossMagmaZones[i].expiresAt) {
            room.bossMagmaZones.splice(i, 1);
        }
    }
    if (room.bossMagmaZones.length === 0) return;

    const def = getBossDef(room.boss.id);
    const magmaCfg = def.magmaConfig || { tickIntervalMs: 600, tickDamage: 6 };
    const tickInterval = magmaCfg.tickIntervalMs || 600;
    const tickDmg = magmaCfg.tickDamage || 6;

    for (const pid in room.players) {
        const p = room.players[pid];
        if (!p || p.isDead || p.isEliminated) continue;
        if (now < (p.lastMagmaHitAt || 0) + tickInterval) continue;

        const pcx = p.x + CHAR_SIZE / 2;
        const pcy = p.y + CHAR_SIZE / 2;
        const touching = room.bossMagmaZones.find((z) => Math.hypot(pcx - z.x, pcy - z.y) <= z.radius);
        if (touching) {
            p.lastMagmaHitAt = now;
            applyPulseDamageToPlayer(roomId, p, tickDmg, 'magma', matchId, touching.element);
        }
    }
}

function stepServerPlayerDots(roomId, matchId, now = Date.now()) {
    const room = rooms[roomId];
    if (!room || room.state !== 'playing' || room.matchId !== matchId) return;

    for (const pid in room.players) {
        const p = room.players[pid];
        if (!p || p.isDead || p.isEliminated) continue;
        // 時間停止中に発動者が受けている敵由来の継続ダメージ進行は停止
        if (isTimeStopActive(room, now) && room.timeStopCasterId === p.id) continue;

        if (!p.dotUntil || now >= p.dotUntil) {
            if (p.dotUntil) {
                p.dotUntil = 0;
                p.dotDamage = 0;
                p.nextDotAt = 0;
            }
            continue;
        }
        if (now >= (p.nextDotAt || 0)) {
            const interval = p.dotIntervalMs || 600;
            p.nextDotAt = now + interval;
            const dotDmg = Math.max(1, Math.floor(Number(p.dotDamage) || 6));

            p.hp = Math.max(0, p.hp - dotDmg);
            io.to(roomId).emit('playerDamaged', {
                targetId: p.id,
                attackerId: 'BOSS',
                damage: dotDmg,
                hp: p.hp,
                maxHp: p.maxHp,
                knockbackDir: 'down',
                type: 'curse_dot',
                elementMultiplier: 1.0,
                attackerElement: 'neutral',
                defenderElement: p.element,
                skipInvincible: true,
                noKnockback: true
            });

            if (p.hp <= 0) {
                handlePlayerKO(roomId, p, null, matchId);
            }
        }
    }
}

function stepServerBossProjectiles(roomId, matchId, dtMs, now = Date.now()) {
    const room = rooms[roomId];
    if (!room || room.state !== 'playing' || room.matchId !== matchId || !room.boss) return;
    if (!Array.isArray(room.bossProjectiles) || room.bossProjectiles.length === 0) return;

    // 時間停止中は既存BOSS弾幕の移動・当たり判定・寿命進行を一時停止
    if (isTimeStopActive(room, now)) return;

    const stepFrames = Math.min(4, Math.max(0.5, dtMs / (1000 / 60)));

    for (let i = room.bossProjectiles.length - 1; i >= 0; i--) {
        const bp = room.bossProjectiles[i];

        if (bp.kind === 'phantom_homing') {
            let nearest = null;
            let minDist = Infinity;
            for (const pid in room.players) {
                const pl = room.players[pid];
                if (!pl || pl.isDead || pl.isEliminated) continue;
                const d = Math.hypot((pl.x + CHAR_SIZE / 2) - bp.x, (pl.y + CHAR_SIZE / 2) - bp.y);
                if (d < minDist) {
                    minDist = d;
                    nearest = pl;
                }
            }
            if (nearest) {
                const desiredAngle = Math.atan2((nearest.y + CHAR_SIZE / 2) - bp.y, (nearest.x + CHAR_SIZE / 2) - bp.x);
                const curAngle = Math.atan2(bp.vy, bp.vx);
                let diff = desiredAngle - curAngle;
                while (diff > Math.PI) diff -= Math.PI * 2;
                while (diff < -Math.PI) diff += Math.PI * 2;
                const maxTurn = (bp.turnRate || 0.045) * stepFrames;
                const step = Math.max(-maxTurn, Math.min(maxTurn, diff));
                const nextAngle = curAngle + step;
                const spd = bp.speed || 3.4;
                bp.vx = Math.cos(nextAngle) * spd;
                bp.vy = Math.sin(nextAngle) * spd;
            }
            bp.x += bp.vx * stepFrames;
            bp.y += bp.vy * stepFrames;
        } else if (bp.kind === 'snake_dark') {
            bp.age += stepFrames;
            bp.baseX += Math.cos(bp.angle) * bp.speed * stepFrames;
            bp.baseY += Math.sin(bp.angle) * bp.speed * stepFrames;
            const offset = bp.side * Math.sin(bp.age * bp.waveFreq) * bp.waveAmp;
            const perpX = -Math.sin(bp.angle);
            const perpY = Math.cos(bp.angle);
            bp.x = bp.baseX + perpX * offset;
            bp.y = bp.baseY + perpY * offset;
        } else {
            if (bp.curveRate) {
                const angleStep = bp.curveRate * stepFrames;
                const cosA = Math.cos(angleStep);
                const sinA = Math.sin(angleStep);
                const nvx = bp.vx * cosA - bp.vy * sinA;
                const nvy = bp.vx * sinA + bp.vy * cosA;
                bp.vx = nvx;
                bp.vy = nvy;
            }
            bp.x += (bp.vx || 0) * stepFrames;
            bp.y += (bp.vy || 0) * stepFrames;
        }

        bp.life -= stepFrames;

        if (pointInStaticObstacle(bp.x, bp.y)) {
            room.bossProjectiles.splice(i, 1);
            continue;
        }

        if (bp.life <= 0 || bp.x < 0 || bp.x > ARENA_WIDTH || bp.y < ARENA_TOP || bp.y > ARENA_HEIGHT) {
            room.bossProjectiles.splice(i, 1);
            continue;
        }

        let hitPlayer = false;
        for (const pid in room.players) {
            const p = room.players[pid];
            if (!p || p.isDead || p.isEliminated) continue;
            if (now < (p.lastServerProjHitAt || 0) + 150) continue;

            const pcx = p.x + CHAR_SIZE / 2;
            const pcy = p.y + CHAR_SIZE / 2;
            if (Math.hypot(bp.x - pcx, bp.y - pcy) < (bp.hitRadius || 20)) {
                p.lastServerProjHitAt = now;
                const applied = applyBossDamageToPlayer(roomId, p, bp.damage, bp.kind, matchId, bp.element);
                if (applied !== false && bp.kind === 'curse_bolt') {
                    applyRandomPhantomCurse(roomId, p, matchId);
                }
                hitPlayer = true;
                break;
            }
        }

        if (hitPlayer) {
            room.bossProjectiles.splice(i, 1);
        }
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
        const now = Date.now();
        if (isTimeStopActive(r, now)) return;

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
        const now = Date.now();
        if (isTimeStopActive(r, now)) return;

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
        const now = Date.now();
        if (isTimeStopActive(r, now)) {
            return;
        }

        const boss = r.boss;
        const curDef = getBossDef(boss.id);
        tick++;

        if (boss.scaleAuraActive && now >= (boss.scaleAuraUntil || 0)) {
            boss.scaleAuraActive = false;
            boss.scaleAuraUntil = 0;
        }

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

        if (nearest && !boss.pulseCharging && !boss.isStealthed) {
            const angle = Math.atan2((nearest.y + 24) - boss.y, (nearest.x + 24) - boss.x);
            const moveCfg = curDef.moveSpeed || {};
            let moveSpd = boss.phase === 2
                ? (isSolo ? (moveCfg.soloP2 ?? moveCfg.p2 ?? curDef.speed) : (moveCfg.multiP2 ?? moveCfg.p2 ?? curDef.speed))
                : (isSolo ? (moveCfg.soloP1 ?? moveCfg.p1 ?? curDef.speed) : (moveCfg.multiP1 ?? moveCfg.p1 ?? curDef.speed));

            if (boss.vortexActive) {
                moveSpd *= 0.65;
            }

            boss.x += Math.cos(angle) * moveSpd;
            boss.y += Math.sin(angle) * moveSpd;

            boss.x = Math.max(95, Math.min(ARENA_WIDTH - 95, boss.x));
            boss.y = Math.max(ARENA_TOP + 85, Math.min(ARENA_HEIGHT - 95, boss.y));
        }

        if (!boss.isStealthed && tick % 5 === 0) {
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

    let lastProjTickAt = Date.now();
    room.bossProjectileTimer = setInterval(() => {
        const r = rooms[roomId];
        if (!r || r.state !== 'playing' || r.matchId !== matchId) {
            return;
        }
        const now = Date.now();
        const dtMs = Math.min(80, Math.max(16, now - lastProjTickAt));
        lastProjTickAt = now;

        stepServerRicochetBullets(roomId, matchId, dtMs, now);
        if (r.boss) {
            stepServerBossProjectiles(roomId, matchId, dtMs, now);
            stepServerMagmaZones(roomId, matchId, now);
            stepServerPlayerDots(roomId, matchId, now);
        }
    }, 32);

    let attackCount = 0;
    const scheduleNextAttack = () => {
        const r = rooms[roomId];
        if (!r || r.state !== 'playing' || r.matchId !== matchId || !r.boss) return;

        const curDef = getBossDef(r.boss.id);
        const interval = r.boss.phase === 2 ? curDef.attackIntervalMs.p2 : curDef.attackIntervalMs.p1;
        r.bossAttackTimer = setTimeout(() => {
            const cur = rooms[roomId];
            if (!cur || cur.state !== 'playing' || cur.matchId !== matchId || !cur.boss) return;

            if (!isTimeStopActive(cur, Date.now())) {
                executeBossAttack(roomId, attackCount, matchId);
                attackCount++;
            }
            scheduleNextAttack();
        }, interval);
    };

    scheduleNextAttack();
}

function executeBossAttack(roomId, count, matchId) {
    const room = rooms[roomId];
    if (!room || room.state !== 'playing' || room.matchId !== matchId || !room.boss) return;
    if (isTimeStopActive(room, Date.now())) return;

    const boss = room.boss;
    const def = getBossDef(boss.id);

    const now = Date.now();
    const allPlayerCount = Math.min(MAX_PLAYERS_PER_ROOM, Math.max(1, Object.keys(room.players).length));
    const alivePlayers = Object.values(room.players)
        .filter((p) => !p.isDead && !p.isEliminated)
        .map((p) => {
            if (now - (p.lastMoveVectorAt || 0) > 250) {
                p.vx = 0;
                p.vy = 0;
            }
            return p;
        });
    if (alivePlayers.length === 0) return;

    const target = alivePlayers[Math.floor(Math.random() * alivePlayers.length)];
    const targetCx = target.x + 24;
    const targetCy = target.y + 24;

    const wrappedIo = {
        to: (targetRoomId) => ({
            emit: (eventName, eventPayload) => {
                if (eventName === 'bossAttackEvent') {
                    registerServerBossProjectilesFromEvent(targetRoomId, matchId, eventPayload);
                }
                io.to(targetRoomId).emit(eventName, eventPayload);
            }
        })
    };

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
        io: wrappedIo,
        getRoom: () => rooms[roomId],
        registerTimeout: registerBossTimeout,
        pointToSegmentDistance,
        applyDamageToPlayer: applyBossDamageToPlayer,
        applyPulseDamageToPlayer,
        applySlowToPlayer,
        knockbackPlayerFromPoint,
        spawnMagmaZones
    });
}

// =========================================================================
// 状態異常・ノックバック・P2覚醒・ダメージ適用・完全反撃・絶対防壁・KO・勝敗判定
// =========================================================================
function triggerBossPhase2Awaken(roomId, room, def, matchId) {
    if (!room || !room.boss || !def || !def.phase2Awaken) return;
    const boss = room.boss;
    const cfg = def.phase2Awaken;
    const now = Date.now();
    const auraDuration = Number(cfg.scaleAuraDurationMs) || 3000;
    const kbRadius = Number(cfg.knockbackRadius) || 240;
    const kbDist = Number(cfg.knockbackDistance) || 120;

    boss.scaleAuraActive = true;
    boss.scaleAuraUntil = now + auraDuration;

    for (const id in room.players) {
        const p = room.players[id];
        if (!p || p.isDead || p.isEliminated) continue;
        const pcx = p.x + CHAR_SIZE / 2;
        const pcy = p.y + CHAR_SIZE / 2;
        const dist = Math.hypot(pcx - boss.x, pcy - boss.y);
        if (dist <= kbRadius) {
            const ang = dist > 0.1 ? Math.atan2(pcy - boss.y, pcx - boss.x) : Math.PI / 2;
            let mult = 1.0;
            if (now < (p.absoluteWallUntil || 0)) mult = 0.15;
            else if (now < (p.shieldUntil || 0)) mult = 0.25;
            const allowGhost = now < (p.phantomBootsUntil || 0);
            pushPlayerSafely(p, ang, kbDist * mult, allowGhost);
            io.to(roomId).emit('playerKnockback', {
                id: p.id,
                x: p.x,
                y: p.y,
                facing: p.facing,
                source: 'p2_awaken'
            });
            io.to(roomId).emit('playerMoved', {
                id: p.id,
                x: p.x,
                y: p.y,
                facing: p.facing
            });
        }
    }

    io.to(roomId).emit('bossAttackEvent', {
        bossId: boss.id,
        element: boss.element,
        type: 'p2_awaken',
        x: boss.x,
        y: boss.y,
        knockbackRadius: kbRadius,
        scaleAuraDurationMs: auraDuration
    });
    io.to(roomId).emit('bossStateUpdated', boss);

    registerBossTimeout(room, () => {
        const cur = rooms[roomId];
        if (!cur || cur.matchId !== matchId || !cur.boss) return;
        cur.boss.scaleAuraActive = false;
        cur.boss.scaleAuraUntil = 0;
        io.to(roomId).emit('bossStateUpdated', cur.boss);
    }, auraDuration);
}

function applySlowToPlayer(roomId, target, multiplier, durationMs, matchId) {
    const room = rooms[roomId];
    if (!room || room.state !== 'playing' || room.matchId !== matchId) return false;
    if (!target || target.isDead || target.isEliminated) return false;

    const safeMult = Math.min(1.0, Math.max(0.25, Number(multiplier) || 0.75));
    const safeDuration = Math.max(100, Math.floor(Number(durationMs) || 1800));
    const until = Date.now() + safeDuration;

    target.slowMultiplier = safeMult;
    target.slowUntil = until;

    io.to(roomId).emit('playerSlowed', {
        id: target.id,
        multiplier: safeMult,
        durationMs: safeDuration,
        until
    });
    return true;
}

function applyAttackDebuffToPlayer(roomId, target, multiplier, durationMs, matchId) {
    const room = rooms[roomId];
    if (!room || room.state !== 'playing' || room.matchId !== matchId) return false;
    if (!target || target.isDead || target.isEliminated) return false;

    const safeMult = Math.min(1.0, Math.max(0.25, Number(multiplier) || 0.75));
    const safeDuration = Math.max(100, Math.floor(Number(durationMs) || 3000));
    const until = Date.now() + safeDuration;

    target.attackDebuffMultiplier = safeMult;
    target.attackDebuffUntil = until;

    io.to(roomId).emit('playerAttackDebuffed', {
        id: target.id,
        multiplier: safeMult,
        durationMs: safeDuration,
        until
    });
    return true;
}

function applyPoisonDotToPlayer(roomId, target, damagePerTick, intervalMs, durationMs, matchId) {
    const room = rooms[roomId];
    if (!room || room.state !== 'playing' || room.matchId !== matchId) return false;
    if (!target || target.isDead || target.isEliminated) return false;

    const now = Date.now();
    const safeInterval = Math.max(200, Math.floor(Number(intervalMs) || 600));
    const safeDuration = Math.max(safeInterval, Math.floor(Number(durationMs) || 3000));
    const safeDamage = Math.max(1, Math.floor(Number(damagePerTick) || 6));
    const until = now + safeDuration;

    const alreadyActive = Boolean(target.dotUntil && now < target.dotUntil);
    target.dotDamage = safeDamage;
    target.dotIntervalMs = safeInterval;
    target.dotUntil = until;
    if (!alreadyActive || !target.nextDotAt || target.nextDotAt < now) {
        target.nextDotAt = now + safeInterval;
    }

    io.to(roomId).emit('playerDotApplied', {
        id: target.id,
        damage: safeDamage,
        intervalMs: safeInterval,
        durationMs: safeDuration,
        until
    });
    return true;
}

function applyRandomPhantomCurse(roomId, target, matchId) {
    const room = rooms[roomId];
    if (!room || room.state !== 'playing' || room.matchId !== matchId) return;
    if (!target || target.isDead || target.isEliminated) return;

    const roll = Math.floor(Math.random() * 4);
    if (roll === 0) {
        applySlowToPlayer(roomId, target, 0.75, 2000, matchId);
    } else if (roll === 1) {
        applyAttackDebuffToPlayer(roomId, target, 0.75, 3000, matchId);
    } else if (roll === 2) {
        applyPoisonDotToPlayer(roomId, target, 6, 600, 3000, matchId);
    }
}

function knockbackPlayerFromPoint(roomId, target, originX, originY, targetDistanceFromOrigin, matchId, source) {
    const room = rooms[roomId];
    if (!room || room.state !== 'playing' || room.matchId !== matchId) return false;
    if (!target || target.isDead || target.isEliminated) return false;

    const now = Date.now();
    const pcx = target.x + CHAR_SIZE / 2;
    const pcy = target.y + CHAR_SIZE / 2;
    const dist = Math.hypot(pcx - originX, pcy - originY);
    const ang = dist > 0.1 ? Math.atan2(pcy - originY, pcx - originX) : Math.random() * Math.PI * 2;
    const desiredDist = Math.max(40, (Number(targetDistanceFromOrigin) || 136) - dist);

    let mult = 1.0;
    if (now < (target.absoluteWallUntil || 0)) mult = 0.15;
    else if (now < (target.shieldUntil || 0)) mult = 0.25;

    const allowGhost = now < (target.phantomBootsUntil || 0);
    pushPlayerSafely(target, ang, desiredDist * mult, allowGhost);

    io.to(roomId).emit('playerKnockback', {
        id: target.id,
        x: target.x,
        y: target.y,
        facing: target.facing,
        source: source || 'boss_knockback'
    });
    io.to(roomId).emit('playerMoved', {
        id: target.id,
        x: target.x,
        y: target.y,
        facing: target.facing
    });
    return true;
}

function getPlayerEffectiveAttackMultiplier(p, now) {
    if (!p) return 1.0;
    const powerMult = now < (p.powerBoostUntil || 0) ? 1.5 : 1.0;
    const debuffMult = now < (p.attackDebuffUntil || 0) ? (p.attackDebuffMultiplier || 0.75) : 1.0;
    return powerMult * debuffMult;
}

function applyDamageToBossInternal(roomId, attacker, rawDamage, attackKind, hitTypeLabel) {
    const room = rooms[roomId];
    if (!room || room.state !== 'playing' || room.mode !== 'boss' || !room.boss) return;
    if (!attacker || room.boss.hp <= 0) return;
    if (room.boss.isStealthed) return;

    const now = Date.now();
    const def = getBossDef(room.boss.id);
    const elemMult = getElementMultiplier(attacker.element, room.boss.element);
    const barrierMult = (room.boss.barrierActive && def.barrierDamageMultiplier) ? def.barrierDamageMultiplier : 1.0;

    if (room.boss.scaleAuraActive && now >= (room.boss.scaleAuraUntil || 0)) {
        room.boss.scaleAuraActive = false;
        room.boss.scaleAuraUntil = 0;
    }
    const scaleAuraMult = (room.boss.scaleAuraActive && def.phase2Awaken)
        ? (def.phase2Awaken.scaleDamageMultiplier || 0.75)
        : 1.0;

    const finalDamage = Math.max(1, Math.round(rawDamage * elemMult * barrierMult * scaleAuraMult));

    room.boss.hp = Math.max(0, room.boss.hp - finalDamage);
    attacker.bossDamageDealt = (attacker.bossDamageDealt || 0) + finalDamage;

    let triggeredAwaken = false;
    if (room.boss.phase === 1 && room.boss.hp > 0 && room.boss.hp <= room.boss.maxHp * 0.5) {
        room.boss.phase = 2;
        if (def.phase2Awaken) {
            triggeredAwaken = true;
        }
    }

    io.to(roomId).emit('bossDamaged', {
        attackerId: attacker.id,
        damage: finalDamage,
        hp: room.boss.hp,
        maxHp: room.boss.maxHp,
        phase: room.boss.phase,
        blockedByBarrier: Boolean(room.boss.barrierActive),
        reducedByScaleAura: scaleAuraMult < 1.0,
        elementMultiplier: elemMult,
        attackerElement: attacker.element,
        defenderElement: room.boss.element,
        attackType: hitTypeLabel || attackKind
    });

    if (triggeredAwaken) {
        triggerBossPhase2Awaken(roomId, room, def, room.matchId);
    }

    if (room.boss.hp <= 0) {
        checkMatchWinner(roomId);
    }
}

function applyDamageToPlayerInternal(roomId, target, attacker, rawDamage, knockDir, hitType, matchId, attackerElement, opts) {
    const room = rooms[roomId];
    if (!room || room.state !== 'playing' || room.matchId !== matchId) return false;
    if (!target || target.isDead || target.isEliminated) return false;

    const now = Date.now();
    const options = opts || {};
    const isEndOfDays = Boolean(options.isEndOfDays);
    const eodDef = isEndOfDays ? getUltraSkillDef('end_of_days') : null;

    if (now < target.counterStanceUntil) {
        if (isEndOfDays) {
            const counterMult = (eodDef && eodDef.counterInteraction && typeof eodDef.counterInteraction.damageMultiplier === 'number')
                ? eodDef.counterInteraction.damageMultiplier
                : 0.5;
            const shouldCounter = eodDef && eodDef.counterInteraction
                ? Boolean(eodDef.counterInteraction.triggersCounter)
                : true;
            const atkElem = attackerElement || (attacker && attacker !== 'BOSS' ? attacker.element : 'neutral');
            const elemMult = getElementMultiplier(atkElem, target.element);
            const damage = Math.max(1, Math.round(rawDamage * elemMult * counterMult));

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
                defenderElement: target.element,
                skipInvincible: Boolean(options.skipInvincible),
                noKnockback: Boolean(options.noKnockback)
            });

            if (shouldCounter && target.hp > 0) {
                triggerPerfectCounter(roomId, target, attacker || 'BOSS', matchId);
            } else {
                clearPlayerUltraStateAndTimers(target, room);
            }

            if (target.hp <= 0) {
                handlePlayerKO(roomId, target, attacker && attacker !== 'BOSS' ? attacker : null, matchId);
            }
            return true;
        }
        triggerPerfectCounter(roomId, target, attacker || 'BOSS', matchId);
        return false;
    }

    const hasAbsoluteWall = now < target.absoluteWallUntil;
    const hasShield = now < target.shieldUntil;
    if (hasAbsoluteWall || hasShield) {
        if (isEndOfDays) {
            const absMult = (eodDef && typeof eodDef.absoluteWallDamageMultiplier === 'number')
                ? eodDef.absoluteWallDamageMultiplier
                : 0.25;
            const shieldMult = (eodDef && typeof eodDef.normalBarrierDamageMultiplier === 'number')
                ? eodDef.normalBarrierDamageMultiplier
                : 0.5;
            const guardMult = hasAbsoluteWall ? absMult : shieldMult;

            if (hasAbsoluteWall) {
                io.to(roomId).emit('attackBlocked', {
                    targetId: target.id,
                    attackerId: attacker && attacker !== 'BOSS' ? attacker.id : 'BOSS',
                    knockbackDir: knockDir || 'down',
                    type: hitType,
                    byAbsoluteWall: true,
                    pierced: true
                });
            }

            const atkElem = attackerElement || (attacker && attacker !== 'BOSS' ? attacker.element : 'neutral');
            const elemMult = getElementMultiplier(atkElem, target.element);
            const damage = Math.max(1, Math.round(rawDamage * elemMult * guardMult));

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
                defenderElement: target.element,
                skipInvincible: Boolean(options.skipInvincible),
                noKnockback: Boolean(options.noKnockback),
                byAbsoluteWall: hasAbsoluteWall,
                byShield: !hasAbsoluteWall && hasShield
            });

            if (target.hp <= 0) {
                handlePlayerKO(roomId, target, attacker && attacker !== 'BOSS' ? attacker : null, matchId);
            }
            return true;
        }

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
        defenderElement: target.element,
        skipInvincible: Boolean(options.skipInvincible),
        noKnockback: Boolean(options.noKnockback)
    });

    if (target.hp <= 0) {
        handlePlayerKO(roomId, target, attacker && attacker !== 'BOSS' ? attacker : null, matchId);
    }
    return true;
}

function applyBossDamageToPlayer(roomId, target, damage, attackType, matchId, bossElement) {
    const room = rooms[roomId];
    if (!room || !room.boss) return false;
    const elem = bossElement || room.boss.element || 'neutral';
    return applyDamageToPlayerInternal(roomId, target, 'BOSS', damage, 'down', attackType, matchId, elem);
}

function applyPulseDamageToPlayer(roomId, target, damage, attackType, matchId, bossElement) {
    const room = rooms[roomId];
    if (!room || !room.boss) return false;
    const elem = bossElement || room.boss.element || 'neutral';
    return applyDamageToPlayerInternal(roomId, target, 'BOSS', damage, 'down', attackType, matchId, elem, {
        skipInvincible: true,
        noKnockback: true
    });
}

function triggerPerfectCounter(roomId, counterPlayer, attacker, matchId) {
    const room = rooms[roomId];
    if (!room || room.state !== 'playing' || room.matchId !== matchId) return;
    if (!counterPlayer || counterPlayer.isDead || counterPlayer.isEliminated) return;

    const skill = getUltraSkillDef('perfect_counter');
    if (!skill) return;

    clearPlayerUltraStateAndTimers(counterPlayer, room);

    const pc = playerCenter(counterPlayer);
    const counterRadius = skill.counterRadius || 210;
    const atkMult = getPlayerEffectiveAttackMultiplier(counterPlayer, Date.now());
    const baseCounterDmg = counterPlayer.stats.atk * skill.damageMultiplier * atkMult;

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
    clearPlayerUltraStateAndTimers(target, room);
    resetPlayerCombatStatuses(target, room);
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
                    resetPlayerCombatStatuses(respawnTarget, currentR);
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
    room.bossProjectiles = [];
    room.bossMagmaZones = [];
    room.ricochetBullets = [];
    room.timeStopUntil = 0;
    room.timeStopCasterId = null;
    room.bossRoarPullUntil = 0;
    room.bossRoarPullStrength = 0;

    const stage = getStageByNumber(room.stageNumber);
    room.stageNumber = stage.stageNumber;
    room.stageId = stage.stageId;
    room.bossId = stage.bossId;

    const playerIds = Object.keys(room.players);
    room.boss = room.mode === 'boss' ? createBossInstance(room.bossId, playerIds.length) : null;

    playerIds.forEach((id, index) => {
        const p = room.players[id];
        const spawn = SPAWN_POINTS[index % SPAWN_POINTS.length];
        resetPlayerCombatStatuses(p, room);
        Object.assign(p, createPlayerGuards());

        p.isDead = false;
        p.isEliminated = false;
        p.stocks = INITIAL_STOCKS;
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
            room.matchId = (room.matchId || 0) + 1;
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
                resetPlayerCombatStatuses(p, room);
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
            room.matchId = (room.matchId || 0) + 1;
            stopGimmickLoop(roomId);

            const rewardsByPlayer = {};
            playerIds.forEach((id) => {
                const p = room.players[id];
                resetPlayerCombatStatuses(p, room);
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
        room.matchId = (room.matchId || 0) + 1;
        stopGimmickLoop(roomId);

        const winnerId = survivors.length === 1 ? survivors[0] : null;
        const rewardsByPlayer = {};

        playerIds.forEach((id) => {
            const p = room.players[id];
            resetPlayerCombatStatuses(p, room);
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
    clearPlayerUltraStateAndTimers(leavingPlayer, room);
    resetPlayerCombatStatuses(leavingPlayer, room);
    saveSessionRecord(room, leavingPlayer);

    delete room.players[socket.id];
    io.to(roomId).emit('disconnectPlayer', socket.id);

    const remainingIds = Object.keys(room.players);
    if (remainingIds.length === 0) {
        room.matchId = (room.matchId || 0) + 1;
        stopGimmickLoop(roomId);
        delete rooms[roomId];
        return;
    }

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
            room.matchId = (room.matchId || 0) + 1;
            stopGimmickLoop(roomId);
            room.state = 'waiting';
            for (const id of remainingIds) {
                resetPlayerCombatStatuses(room.players[id], room);
                room.players[id].isReady = false;
            }
            emitRoomStateSync(roomId);
        }
    } else {
        emitRoomStateSync(roomId);
    }
}

// =========================================================================
// サーバー側 斬撃（X）当たり判定＆モーション配信（demon_blade 対応）
// =========================================================================
function executeServerSlash(roomId, attacker, ox, oy, facing, isPowered) {
    const room = rooms[roomId];
    if (!room || room.state !== 'playing') return;

    const now = Date.now();
    const matchId = room.matchId;
    const slashCfg = GAME_RULES.ACTIONS.slash;
    const vec = facingToVector(facing);

    const hasDemonBlade = Boolean(attacker.demonBladeUntil && now < attacker.demonBladeUntil);
    const demonDef = hasDemonBlade ? getUltraSkillDef('demon_blade') : null;
    const rangeMult = hasDemonBlade ? (Number(demonDef && demonDef.rangeMultiplier) || 1.5) : 1.0;
    const bladePowerMult = hasDemonBlade ? (Number(demonDef && demonDef.damageMultiplier) || 2.0) : 1.0;

    const range = (slashCfg.range || 78) * rangeMult;
    const endX = ox + vec.dx * range;
    const endY = oy + vec.dy * range;
    const atkMult = getPlayerEffectiveAttackMultiplier(attacker, now);

    io.to(roomId).emit('slashMotionEvent', {
        attackerId: attacker.id,
        x: ox,
        y: oy,
        facing,
        range,
        demonBladeActive: hasDemonBlade,
        element: attacker.element,
        mainColor: attacker.stats.mainColor,
        isPowered,
        hasSpecialInk: Boolean(attacker.hasSpecialInk),
        specialInkType: attacker.dominantSpecialInk || null,
        durationMs: 220
    });

    let wallsChanged = false;
    const wallHitRadius = hasDemonBlade ? 56 : 44;
    for (let i = room.walls.length - 1; i >= 0; i--) {
        const w = room.walls[i];
        const wx = w.x + w.w / 2;
        const wy = w.y + w.h / 2;
        if (pointToSegmentDistance(wx, wy, ox, oy, endX, endY) <= wallHitRadius) {
            w.hp -= hasDemonBlade ? 40 : 20;
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
        if (hitDist <= room.boss.radius + (hasDemonBlade ? 42 : 32)) {
            const rawDmg = attacker.stats.atk * slashCfg.bossMultiplier * bladePowerMult * atkMult;
            applyDamageToBossInternal(roomId, attacker, rawDmg, 'melee', 'melee');
        }
    } else if (room.mode === 'pvp') {
        for (const id in room.players) {
            if (id === attacker.id) continue;
            const target = room.players[id];
            if (!target || target.isDead || target.isEliminated) continue;
            const tc = playerCenter(target);
            if (pointToSegmentDistance(tc.x, tc.y, ox, oy, endX, endY) <= (hasDemonBlade ? 52 : 42)) {
                const rawDmg = attacker.stats.atk * slashCfg.pvpMultiplier * bladePowerMult * atkMult;
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

    // ウルトラガチャ（全8種 / Sレア4種×重み10 + Aレア4種×重み15 = 合計100 / 上限3 / 上限重複300Pt還元）
    socket.on('drawUltraGacha', (payload) => {
        const clientKey = sanitizeClientKey((payload && payload.clientKey) || socket.data.clientKey, socket.id);
        socket.data.clientKey = clientKey;
        const prof = getOrCreateProfile(clientKey, payload);

        const cost = GAME_RULES.GACHA.ULTRA_COST;
        const maxStock = ULTRA_MAX_STOCK;
        const maxDupRefund = ULTRA_DUPLICATE_REFUND;

        if (prof.points < cost) {
            socket.emit('gachaError', { type: 'ultra', message: `ポイントが不足しています（必要: ${cost}Pt）`, profile: serializeProfile(prof) });
            return;
        }

        prof.points -= cost;

        const totalWeight = ULTRA_GACHA_POOL.reduce((acc, item) => acc + item.weight, 0);
        let roll = Math.random() * totalWeight;
        let chosenEntry = ULTRA_GACHA_POOL[0];
        for (const entry of ULTRA_GACHA_POOL) {
            roll -= entry.weight;
            if (roll <= 0) {
                chosenEntry = entry;
                break;
            }
        }

        const drawnSkillId = chosenEntry.id;
        const skillDef = getUltraSkillDef(drawnSkillId) || {
            name: drawnSkillId,
            rarity: chosenEntry.rarity,
            icon: '✨'
        };
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
            rarity: skillDef.rarity || chosenEntry.rarity,
            icon: skillDef.icon || '✨',
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
                id: roomId,
                state: 'waiting',
                mode: payload && payload.mode === 'boss' ? 'boss' : 'pvp',
                stageNumber: stage.stageNumber,
                stageId: stage.stageId,
                bossId: stage.bossId,
                hostId: socket.id,
                lastMatchCleared: false,
                matchId: 0,
                timeStopUntil: 0,
                timeStopCasterId: null,
                players: {},
                sessionRecords: {},
                walls: [],
                items: [],
                boss: null,
                bossProjectiles: [],
                bossMagmaZones: [],
                ricochetBullets: [],
                bossRoarPullUntil: 0,
                bossRoarPullStrength: 0,
                lastBossAttackAt: {},
                countdownTimer: null,
                wallTimer: null,
                itemTimer: null,
                bossMoveTimer: null,
                bossProjectileTimer: null,
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
            demonBladeUntil: 0,
            phantomBootsUntil: 0,
            speedBoostUntil: 0,
            powerBoostUntil: 0,
            slowUntil: 0,
            slowMultiplier: 1.0,
            attackDebuffUntil: 0,
            attackDebuffMultiplier: 1.0,
            dotUntil: 0,
            dotDamage: 0,
            dotIntervalMs: 600,
            nextDotAt: 0,
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

        room.matchId = (room.matchId || 0) + 1;
        stopGimmickLoop(currentRoom);
        room.stageNumber = targetStage.stageNumber;
        room.stageId = targetStage.stageId;
        room.bossId = targetStage.bossId;

        for (const id in room.players) {
            resetPlayerCombatStatuses(room.players[id], room);
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

        room.matchId = (room.matchId || 0) + 1;
        stopGimmickLoop(currentRoom);
        room.stageNumber = targetStage.stageNumber;
        room.stageId = targetStage.stageId;
        room.bossId = targetStage.bossId;

        for (const id in room.players) {
            resetPlayerCombatStatuses(room.players[id], room);
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

    // リザルトからロビーへ帰還
    socket.on('returnToLobby', () => {
        if (!currentRoom || !rooms[currentRoom]) return;
        const room = rooms[currentRoom];
        room.matchId = (room.matchId || 0) + 1;
        stopGimmickLoop(currentRoom);
        room.state = 'waiting';
        room.walls = [];
        room.items = [];
        room.boss = null;
        room.bossProjectiles = [];
        room.bossMagmaZones = [];
        room.ricochetBullets = [];
        room.timeStopUntil = 0;
        room.timeStopCasterId = null;
        room.bossRoarPullUntil = 0;
        room.bossRoarPullStrength = 0;
        room.lastBossAttackAt = {};

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
            resetPlayerCombatStatuses(p, room);
            Object.assign(p, createPlayerGuards());
            p.isReady = false;
            p.isDead = false;
            p.isEliminated = false;
            p.stocks = INITIAL_STOCKS;
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

            // 時間停止中は発動者以外のプレイヤー移動を一時停止
            if (isTimeStopActive(room, now) && room.timeStopCasterId !== p.id) {
                return;
            }

            const maxX = ARENA_WIDTH - CHAR_SIZE;
            const maxY = ARENA_HEIGHT - CHAR_SIZE;
            let nx = Math.max(0, Math.min(maxX, Number(data.x) || 0));
            let ny = Math.max(ARENA_TOP, Math.min(maxY, Number(data.y) || ARENA_TOP));

            const hasPhantomBoots = Boolean(p.phantomBootsUntil && now < p.phantomBootsUntil);
            const bootsDef = hasPhantomBoots ? getUltraSkillDef('phantom_boots') : null;
            const bootsMult = hasPhantomBoots ? (Number(bootsDef && bootsDef.speedMultiplier) || 2.0) : 1.0;

            const dt = Math.min(1500, Math.max(16, now - (p.lastMoveAt || now)));
            const boosted = now < p.speedBoostUntil + 500;
            const slowed = now < (p.slowUntil || 0);
            const slowMult = slowed ? (p.slowMultiplier || 0.75) : 1.0;
            const effSpd = p.stats.spd * (boosted ? GAME_RULES.ITEMS.speed.speedMultiplier : 1) * slowMult * bootsMult;
            const perSec = (effSpd + (room.mode === 'boss' ? 2.2 : 0)) * 60;
            const budget = perSec * (dt / 1000) * 1.3 + (hasPhantomBoots ? 96 : 64);
            const dist = Math.hypot(nx - p.x, ny - p.y);
            if (dist > budget) {
                const ratio = budget / dist;
                nx = p.x + (nx - p.x) * ratio;
                ny = p.y + (ny - p.y) * ratio;
            }

            // phantom_boots 効果中は障害物すり抜けを許可（アリーナ外周境界は上記クランプで厳守）
            if (!hasPhantomBoots && overlapsStaticObstacle(nx, ny, CHAR_SIZE, 12)) {
                nx = p.x;
                ny = p.y;
            }

            const moveDx = nx - p.x;
            const moveDy = ny - p.y;
            if (Math.hypot(moveDx, moveDy) > 0.2) {
                p.vx = moveDx;
                p.vy = moveDy;
                p.lastMoveVectorAt = now;
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
            if (isTimeStopActive(room, now) && room.timeStopCasterId !== p.id) return;
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

        const now = Date.now();
        // 時間停止中は発動者以外の攻撃も停止（発動者の攻撃は通常どおり即時適用）
        if (isTimeStopActive(room, now) && room.timeStopCasterId !== p.id) {
            return;
        }

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

        const boostedSpd = now < p.speedBoostUntil ? p.stats.spd * GAME_RULES.ITEMS.speed.speedMultiplier : p.stats.spd;
        const isPowered = now < p.powerBoostUntil;

        if (hitType === 'melee') {
            executeServerSlash(currentRoom, p, ox, oy, facing, isPowered);
            return;
        }

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

    // 必殺技（Space）発動要求（サーバー側でストック・CD・排他・フェーズ・タイマーを厳密管理）
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
        // 排他制御：溜め/構え/予兆/展開中の多重発動禁止
        if (p.ultraState !== null && now < p.ultraStateUntil) return;
        // 全技共通：activatedAt 起算 6000ms クールダウン
        if (now < (p.ultraCooldownUntil || 0)) return;

        if (payload && VALID_FACING.includes(payload.facing)) {
            p.facing = payload.facing;
        }

        const activatedAt = now;
        const cooldownMs = Number(skill.cooldownMs) || ULTRA_COOLDOWN_MS;
        const matchId = room.matchId;
        const roomId = currentRoom;
        p.ultraRemainingUses = Math.max(0, p.ultraRemainingUses - 1);
        p.ultraCooldownUntil = activatedAt + cooldownMs;

        const pc = playerCenter(p);
        const facing = p.facing;

        if (skill.id === 'end_of_days') {
            const chargeMs = Number(skill.chargeMs) || 350;
            const range = Number(skill.range) || 620;
            const halfWidth = Number(skill.halfWidth) || 56;
            const dmgMult = Number(skill.damageMultiplier) || 4.0;
            p.ultraState = 'charging';
            p.ultraStateUntil = activatedAt + chargeMs;

            io.to(roomId).emit('ultraSkillEvent', {
                playerId: p.id,
                skillId: skill.id,
                phase: 'charge',
                x: pc.x,
                y: pc.y,
                facing,
                range,
                halfWidth,
                element: p.element,
                durationMs: chargeMs,
                remainingUses: p.ultraRemainingUses,
                maxUses: p.ultraMaxUses,
                cooldownMs,
                cooldownUntil: p.ultraCooldownUntil
            });

            registerPlayerUltraTimeout(room, p, () => {
                const cur = rooms[roomId];
                if (!cur || cur.state !== 'playing' || cur.matchId !== matchId) return;
                const shooter = cur.players[p.id];
                if (!shooter || shooter.isDead || shooter.isEliminated) {
                    if (shooter) {
                        clearPlayerUltraStateAndTimers(shooter, cur);
                    }
                    return;
                }

                shooter.ultraState = null;
                shooter.ultraStateUntil = 0;

                const curCenter = playerCenter(shooter);
                const curFacing = shooter.facing;
                const vec = facingToVector(curFacing);
                const x1 = curCenter.x;
                const y1 = curCenter.y;
                const x2 = x1 + vec.dx * range;
                const y2 = y1 + vec.dy * range;
                const atkMult = getPlayerEffectiveAttackMultiplier(shooter, Date.now());
                const rawDamage = shooter.stats.atk * dmgMult * atkMult;

                io.to(roomId).emit('ultraSkillEvent', {
                    playerId: shooter.id,
                    skillId: skill.id,
                    phase: 'fire',
                    x1,
                    y1,
                    x2,
                    y2,
                    range,
                    halfWidth,
                    facing: curFacing,
                    element: shooter.element,
                    durationMs: Number(skill.durationMs) || 260
                });

                let wallsChanged = false;
                for (let i = cur.walls.length - 1; i >= 0; i--) {
                    const w = cur.walls[i];
                    if (pointToSegmentDistance(w.x + w.w / 2, w.y + w.h / 2, x1, y1, x2, y2) <= 76) {
                        cur.walls.splice(i, 1);
                        wallsChanged = true;
                    }
                }
                if (wallsChanged) {
                    io.to(roomId).emit('gimmicksUpdated', { walls: cur.walls, items: cur.items });
                }

                if (cur.mode === 'boss' && cur.boss && cur.boss.hp > 0) {
                    if (pointToSegmentDistance(cur.boss.x, cur.boss.y, x1, y1, x2, y2) <= halfWidth + cur.boss.radius) {
                        applyDamageToBossInternal(roomId, shooter, rawDamage, 'ultra_line', 'ultra');
                    }
                } else if (cur.mode === 'pvp') {
                    for (const tid in cur.players) {
                        if (tid === shooter.id) continue;
                        const target = cur.players[tid];
                        if (!target || target.isDead || target.isEliminated) continue;
                        const tc = playerCenter(target);
                        if (pointToSegmentDistance(tc.x, tc.y, x1, y1, x2, y2) <= halfWidth + 20) {
                            applyDamageToPlayerInternal(
                                roomId,
                                target,
                                shooter,
                                rawDamage,
                                curFacing,
                                'ultra_line',
                                matchId,
                                shooter.element,
                                { isEndOfDays: true }
                            );
                        }
                    }
                }
            }, chargeMs);
        } else if (skill.id === 'demon_blade') {
            const durationMs = Number(skill.durationMs) || 5000;
            const bladeUntil = activatedAt + durationMs;
            p.ultraState = 'demon_blade';
            p.ultraStateUntil = bladeUntil;
            p.demonBladeUntil = bladeUntil;

            io.to(roomId).emit('ultraSkillEvent', {
                playerId: p.id,
                skillId: skill.id,
                phase: 'active',
                durationMs,
                demonBladeUntil: bladeUntil,
                rangeMultiplier: Number(skill.rangeMultiplier) || 1.5,
                damageMultiplier: Number(skill.damageMultiplier) || 2.0,
                element: p.element,
                remainingUses: p.ultraRemainingUses,
                maxUses: p.ultraMaxUses,
                cooldownMs,
                cooldownUntil: p.ultraCooldownUntil
            });

            registerPlayerUltraTimeout(room, p, () => {
                const cur = rooms[roomId];
                if (!cur || cur.state !== 'playing' || cur.matchId !== matchId) return;
                const holder = cur.players[p.id];
                if (!holder) return;
                holder.demonBladeUntil = 0;
                if (holder.ultraState === 'demon_blade') {
                    holder.ultraState = null;
                    holder.ultraStateUntil = 0;
                }
                io.to(roomId).emit('ultraSkillEvent', {
                    playerId: holder.id,
                    skillId: skill.id,
                    phase: 'end'
                });
            }, durationMs);
        } else if (skill.id === 'ricochet_guns') {
            const durationMs = Number(skill.durationMs) || 5000;
            const intervalMs = Number(skill.intervalMs) || 625;
            const ricochetUntil = activatedAt + durationMs;

            p.ultraState = 'ricochet_guns';
            p.ultraStateUntil = ricochetUntil;

            io.to(roomId).emit('ultraSkillEvent', {
                playerId: p.id,
                skillId: skill.id,
                phase: 'active',
                durationMs,
                intervalMs,
                bulletDamage: Number(skill.bulletDamage) || 40,
                element: p.element,
                remainingUses: p.ultraRemainingUses,
                maxUses: p.ultraMaxUses,
                cooldownMs,
                cooldownUntil: p.ultraCooldownUntil
            });

            // 発動直後（0ms）に1発目生成
            spawnRicochetVolley(roomId, p, matchId);

            // 625ms 間隔で 5000ms 間生成
            const intervalId = registerPlayerUltraInterval(room, p, () => {
                const cur = rooms[roomId];
                if (!cur || cur.state !== 'playing' || cur.matchId !== matchId) {
                    clearInterval(intervalId);
                    return;
                }
                const shooter = cur.players[p.id];
                const tNow = Date.now();
                if (!shooter || shooter.isDead || shooter.isEliminated || tNow > ricochetUntil) {
                    clearInterval(intervalId);
                    if (shooter && Array.isArray(shooter.ultraTimers)) {
                        shooter.ultraTimers = shooter.ultraTimers.filter((id) => id !== intervalId);
                    }
                    return;
                }
                if (isTimeStopActive(cur, tNow) && cur.timeStopCasterId !== shooter.id) {
                    return;
                }
                spawnRicochetVolley(roomId, shooter, matchId);
            }, intervalMs);

            registerPlayerUltraTimeout(room, p, () => {
                clearInterval(intervalId);
                const cur = rooms[roomId];
                if (!cur || cur.state !== 'playing' || cur.matchId !== matchId) return;
                const holder = cur.players[p.id];
                if (!holder) return;
                if (Array.isArray(holder.ultraTimers)) {
                    holder.ultraTimers = holder.ultraTimers.filter((id) => id !== intervalId);
                }
                if (holder.ultraState === 'ricochet_guns') {
                    holder.ultraState = null;
                    holder.ultraStateUntil = 0;
                }
                io.to(roomId).emit('ultraSkillEvent', {
                    playerId: holder.id,
                    skillId: skill.id,
                    phase: 'end'
                });
            }, durationMs);
        } else if (skill.id === 'phantom_boots') {
            const durationMs = Number(skill.durationMs) || 4000;
            const bootsUntil = activatedAt + durationMs;
            p.ultraState = 'phantom_boots';
            p.ultraStateUntil = bootsUntil;
            p.phantomBootsUntil = bootsUntil;

            io.to(roomId).emit('ultraSkillEvent', {
                playerId: p.id,
                skillId: skill.id,
                phase: 'active',
                durationMs,
                phantomBootsUntil: bootsUntil,
                speedMultiplier: Number(skill.speedMultiplier) || 2.0,
                element: p.element,
                remainingUses: p.ultraRemainingUses,
                maxUses: p.ultraMaxUses,
                cooldownMs,
                cooldownUntil: p.ultraCooldownUntil
            });

            registerPlayerUltraTimeout(room, p, () => {
                const cur = rooms[roomId];
                if (!cur || cur.state !== 'playing' || cur.matchId !== matchId) return;
                const holder = cur.players[p.id];
                if (!holder) return;
                holder.phantomBootsUntil = 0;
                if (holder.ultraState === 'phantom_boots') {
                    holder.ultraState = null;
                    holder.ultraStateUntil = 0;
                }
                const ejected = ejectPlayerFromObstaclesIfOverlapping(cur, holder);
                if (ejected) {
                    io.to(roomId).emit('playerMoved', {
                        id: holder.id,
                        x: holder.x,
                        y: holder.y,
                        facing: holder.facing
                    });
                }
                io.to(roomId).emit('ultraSkillEvent', {
                    playerId: holder.id,
                    skillId: skill.id,
                    phase: 'end',
                    x: holder.x,
                    y: holder.y,
                    ejected
                });
            }, durationMs);
        } else if (skill.id === 'time_stop') {
            const durationMs = Number(skill.durationMs) || 2500;
            // 競合制御：既存の時間停止と重なる場合は終了時刻を最大値へ延伸し、直近発動者を優先許可
            const nextStopUntil = Math.max(room.timeStopUntil || 0, activatedAt + durationMs);
            room.timeStopUntil = nextStopUntil;
            room.timeStopCasterId = p.id;

            p.ultraState = 'time_stop';
            p.ultraStateUntil = nextStopUntil;

            io.to(roomId).emit('ultraSkillEvent', {
                playerId: p.id,
                skillId: skill.id,
                phase: 'active',
                durationMs,
                timeStopUntil: nextStopUntil,
                timeStopCasterId: room.timeStopCasterId,
                element: p.element,
                remainingUses: p.ultraRemainingUses,
                maxUses: p.ultraMaxUses,
                cooldownMs,
                cooldownUntil: p.ultraCooldownUntil
            });

            registerPlayerUltraTimeout(room, p, () => {
                const cur = rooms[roomId];
                if (!cur || cur.state !== 'playing' || cur.matchId !== matchId) return;
                const holder = cur.players[p.id];
                const tNow = Date.now();
                if (holder && holder.ultraState === 'time_stop' && tNow >= (holder.ultraStateUntil || 0)) {
                    holder.ultraState = null;
                    holder.ultraStateUntil = 0;
                }
                if (cur.timeStopUntil && tNow >= cur.timeStopUntil) {
                    cur.timeStopUntil = 0;
                    cur.timeStopCasterId = null;
                    io.to(roomId).emit('ultraSkillEvent', {
                        playerId: p.id,
                        skillId: skill.id,
                        phase: 'end',
                        timeStopUntil: 0
                    });
                }
            }, durationMs);
        } else if (skill.id === 'absolute_wall') {
            const durationMs = Number(skill.durationMs) || 2600;
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
                cooldownMs,
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
            const stanceMs = Number(skill.stanceMs) || 1800;
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
                cooldownMs,
                cooldownUntil: p.ultraCooldownUntil
            });

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
            const warnMs = Number(skill.warnMs) || 650;
            const radius = Number(skill.radius) || 110;
            const dmgMult = Number(skill.damageMultiplier) || 2.2;
            const meteorCount = Math.max(1, Number(skill.meteorCount) || 5);
            const spreadRad = Number(skill.fanSpreadRad) || 1.05;
            const baseCastDist = Number(skill.castDistance) || 210;
            const vec = facingToVector(facing);
            const baseAngle = Math.atan2(vec.dy, vec.dx);

            const meteors = [];
            for (let idx = 0; idx < meteorCount; idx++) {
                const ratio = meteorCount === 1 ? 0 : (idx / (meteorCount - 1)) - 0.5;
                const angle = baseAngle + ratio * spreadRad;
                const distOffset = (1 - Math.abs(ratio) * 2) * 35;
                const dist = baseCastDist + distOffset;
                const rawX = pc.x + Math.cos(angle) * dist;
                const rawY = pc.y + Math.sin(angle) * dist;
                const clampedX = Math.max(radius, Math.min(ARENA_WIDTH - radius, rawX));
                const clampedY = Math.max(ARENA_TOP + radius, Math.min(ARENA_HEIGHT - radius, rawY));
                meteors.push({
                    index: idx,
                    x: clampedX,
                    y: clampedY,
                    radius
                });
            }

            const centerMeteor = meteors[Math.floor(meteors.length / 2)];
            p.ultraState = 'meteor_warn';
            p.ultraStateUntil = activatedAt + warnMs;

            io.to(roomId).emit('ultraSkillEvent', {
                playerId: p.id,
                skillId: skill.id,
                phase: 'warn',
                x: centerMeteor.x,
                y: centerMeteor.y,
                radius,
                meteors,
                facing,
                element: p.element,
                durationMs: warnMs,
                remainingUses: p.ultraRemainingUses,
                maxUses: p.ultraMaxUses,
                cooldownMs,
                cooldownUntil: p.ultraCooldownUntil
            });

            registerPlayerUltraTimeout(room, p, () => {
                const cur = rooms[roomId];
                if (!cur || cur.state !== 'playing' || cur.matchId !== matchId) return;
                const caster = cur.players[p.id];
                if (!caster) return;
                if (caster.isDead || caster.isEliminated) {
                    clearPlayerUltraStateAndTimers(caster, cur);
                    return;
                }

                caster.ultraState = null;
                caster.ultraStateUntil = 0;

                const atkMult = getPlayerEffectiveAttackMultiplier(caster, Date.now());
                const rawDamage = caster.stats.atk * dmgMult * atkMult;

                io.to(roomId).emit('ultraSkillEvent', {
                    playerId: caster.id,
                    skillId: skill.id,
                    phase: 'impact',
                    x: centerMeteor.x,
                    y: centerMeteor.y,
                    radius,
                    meteors,
                    facing,
                    element: caster.element,
                    durationMs: Number(skill.durationMs) || 320
                });

                let wallsChanged = false;
                for (let i = cur.walls.length - 1; i >= 0; i--) {
                    const w = cur.walls[i];
                    const wcx = w.x + w.w / 2;
                    const wcy = w.y + w.h / 2;
                    if (meteors.some((m) => Math.hypot(wcx - m.x, wcy - m.y) <= 130)) {
                        cur.walls.splice(i, 1);
                        wallsChanged = true;
                    }
                }
                if (wallsChanged) {
                    io.to(roomId).emit('gimmicksUpdated', { walls: cur.walls, items: cur.items });
                }

                for (const m of meteors) {
                    if (cur.mode === 'boss') {
                        if (cur.boss && cur.boss.hp > 0 && cur.state === 'playing') {
                            if (Math.hypot(cur.boss.x - m.x, cur.boss.y - m.y) <= radius + cur.boss.radius) {
                                applyDamageToBossInternal(roomId, caster, rawDamage, 'ultra_meteor', 'ultra');
                            }
                        }
 } else if (cur.mode === 'pvp' && cur.state === 'playing') {
                        for (const tid in cur.players) {
                            if (tid === caster.id) continue;
                            const target = cur.players[tid];
                            if (!target || target.isDead || target.isEliminated) continue;
                            const tc = playerCenter(target);
                            if (Math.hypot(tc.x - m.x, tc.y - m.y) <= radius + 20) {
                                applyDamageToPlayerInternal(
                                    roomId,
                                    target,
                                    caster,
                                    rawDamage,
                                    curFacing,
                                    'ultra_meteor',
                                    matchId,
                                    caster.element
                                );
                            }
                        }
                    }
                }
            }, warnMs);
        }
    });

    // 切断処理（disconnect）
    socket.on('disconnect', () => {
        console.log(`クライアントが切断しました: ${socket.id}`);
        if (currentRoom) {
            const leftRoom = currentRoom;
            currentRoom = null;
            handlePlayerExit(socket, leftRoom);
        }
    });
});

// =========================================================================
// サーバー起動
// =========================================================================
const PORT = process.env.PORT || 3002;
server.listen(PORT, () => {
    console.log(`サーバーがポート ${PORT} で起動しました`);
});