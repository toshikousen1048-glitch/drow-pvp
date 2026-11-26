const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const BossSystem = require('./bosses.js');

// 起動時バリデーション実行（不正定義があれば即座に停止）
BossSystem.validateDefinitions({ throwOnError: true });

const {
    GAME_RULES,
    VALID_FACING,
    facingToVector,
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

// 想定外の例外でプロセスごと落ちないようにする（Render上での全員切断を防ぐ）
process.on('uncaughtException', (err) => {
    console.error('[uncaughtException]', err && err.stack ? err.stack : err);
});
process.on('unhandledRejection', (reason) => {
    console.error('[unhandledRejection]', reason);
});

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// サーバーのソースや設定ファイルをブラウザから取得されないようにする
// （bosses.js はクライアントでも使うので公開のまま）
const BLOCKED_PATH_PATTERN = /^\/(server\.js|package(-lock)?\.json|node_modules|\.|render\.yaml|Procfile)/i;
app.use((req, res, next) => {
    if (BLOCKED_PATH_PATTERN.test(req.path)) {
        return res.status(404).end();
    }
    next();
});
app.use(express.static(__dirname, { dotfiles: 'ignore' }));

// "constructor" や "__proto__" などの合言葉でサーバーが落ちないよう、プロトタイプなしのオブジェクトを使う
const rooms = Object.create(null);
const profiles = Object.create(null);

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
const TALENT_TREES = ['durability', 'attack', 'mobility', 'reward'];
const PASSIVE_GEAR_TYPES = ['weapon', 'armor', 'accessory'];
const PROGRESSION_RULES = GAME_RULES.PROGRESSION;
const PASSIVE_GACHA_COST = PROGRESSION_RULES.PASSIVE_GACHA_COST;
const PASSIVE_MAX_RANK = PROGRESSION_RULES.PASSIVE_MAX_RANK;

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

function createDefaultTalentLevels() {
    return { durability: 0, attack: 0, mobility: 0, reward: 0 };
}

function sanitizeTalentLevels(raw) {
    const levels = createDefaultTalentLevels();
    if (!raw || typeof raw !== 'object') return levels;
    for (const tree of TALENT_TREES) {
        levels[tree] = Math.min(PROGRESSION_RULES.TALENT_MAX_LEVEL, Math.max(0, Math.floor(Number(raw[tree]) || 0)));
    }
    return levels;
}

function createDefaultUltraAwakeningPoints() {
    const points = {};
    for (const skillId of ULTRA_SKILL_ORDER) points[skillId] = 0;
    return points;
}

function sanitizeUltraAwakeningPoints(raw) {
    const points = createDefaultUltraAwakeningPoints();
    if (!raw || typeof raw !== 'object') return points;
    for (const skillId of ULTRA_SKILL_ORDER) {
        points[skillId] = Math.min(PROGRESSION_RULES.ULTRA_RANK_3_POINTS, Math.max(0, Math.floor(Number(raw[skillId]) || 0)));
    }
    return points;
}

function createDefaultPassiveInventory() {
    const inventory = {};
    for (const type of PASSIVE_GEAR_TYPES) inventory[type] = [0, 0, 0, 0, 0, 0];
    return inventory;
}

function sanitizePassiveInventory(raw) {
    const inventory = createDefaultPassiveInventory();
    if (!raw || typeof raw !== 'object') return inventory;
    for (const type of PASSIVE_GEAR_TYPES) {
        const counts = raw[type];
        if (!Array.isArray(counts)) continue;
        for (let rank = 1; rank <= PASSIVE_MAX_RANK; rank++) {
            inventory[type][rank] = Math.min(999, Math.max(0, Math.floor(Number(counts[rank]) || 0)));
        }
    }
    return inventory;
}

function sanitizePassiveGearSlots(raw, inventory) {
    const slots = { weapon: 0, armor: 0, accessory: 0 };
    if (!raw || typeof raw !== 'object') return slots;
    for (const type of PASSIVE_GEAR_TYPES) {
        const rank = Math.min(PASSIVE_MAX_RANK, Math.max(0, Math.floor(Number(raw[type]) || 0)));
        slots[type] = rank > 0 && inventory && inventory[type] && inventory[type][rank] > 0 ? rank : 0;
    }
    return slots;
}

function sanitizeClientKey(raw, fallbackId) {
    if (typeof raw === 'string' && raw.trim()) {
        return raw.trim().slice(0, 48);
    }
    return String(fallbackId || 'guest').slice(0, 48);
}

function getOrCreateProfile(clientKey, seedData) {
    const key = sanitizeClientKey(clientKey);
    if (profiles[key]) {
        profiles[key].lastSeenAt = Date.now();
    }
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

        const passiveInventory = sanitizePassiveInventory(seed.passiveInventory);
        profiles[key] = {
            clientKey: key,
            lastSeenAt: Date.now(),
            points: initPoints,
            maxUnlockedStage: initStage,
            unlockedInks: initInks,
            ultraStocks: initStocks,
            talents: sanitizeTalentLevels(seed.talents),
            ultraAwakeningPoints: sanitizeUltraAwakeningPoints(seed.ultraAwakeningPoints),
            passiveInventory,
            passiveGearSlots: sanitizePassiveGearSlots(seed.passiveGearSlots, passiveInventory),
            dailyWinDate: typeof seed.dailyWinDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(seed.dailyWinDate)
                ? seed.dailyWinDate
                : '',
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
        talents: { ...profile.talents },
        ultraAwakeningPoints: { ...profile.ultraAwakeningPoints },
        passiveInventory: Object.fromEntries(PASSIVE_GEAR_TYPES.map((type) => [type, [...profile.passiveInventory[type]]])),
        passiveGearSlots: { ...profile.passiveGearSlots },
        dailyWinDate: profile.dailyWinDate,
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

function getJstDateKey(now = Date.now()) {
    return new Date(now + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function claimDailyFirstWinBonus(profile) {
    const today = getJstDateKey();
    if (!profile || profile.dailyWinDate === today) return 0;
    profile.dailyWinDate = today;
    return PROGRESSION_RULES.DAILY_FIRST_WIN_BONUS;
}

function getUltraAwakeningRank(points) {
    const safePoints = Math.max(0, Number(points) || 0);
    if (safePoints >= PROGRESSION_RULES.ULTRA_RANK_3_POINTS) return 3;
    if (safePoints >= PROGRESSION_RULES.ULTRA_RANK_2_POINTS) return 2;
    return 1;
}

function getProfileUltraAwakeningRank(profile, skillId) {
    return getUltraAwakeningRank(profile && profile.ultraAwakeningPoints
        ? profile.ultraAwakeningPoints[skillId]
        : 0);
}

function getProgressionSnapshot(profile) {
    return {
        talents: sanitizeTalentLevels(profile && profile.talents),
        ultraAwakeningPoints: sanitizeUltraAwakeningPoints(profile && profile.ultraAwakeningPoints),
        passiveGearSlots: sanitizePassiveGearSlots(profile && profile.passiveGearSlots, profile && profile.passiveInventory)
    };
}

function syncPlayerProgression(room, player, profile) {
    if (!room || !player || !profile) return;
    player.progression = getProgressionSnapshot(profile);
    const hpBonus = room.mode === 'boss'
        ? player.progression.talents.durability * PROGRESSION_RULES.TALENT_PER_LEVEL.durability
        : 0;
    player.maxHp = Math.max(1, Math.round(player.stats.maxHp * (1 + hpBonus)));
    player.hp = Math.min(player.hp, player.maxHp);
}

function getPlayerTalentLevel(player, tree, roomMode) {
    if (!player || roomMode !== 'boss' || !player.progression || !player.progression.talents) return 0;
    return player.progression.talents[tree] || 0;
}

function getPlayerPassiveRank(player, type) {
    if (!player || !player.progression || !player.progression.passiveGearSlots) return 0;
    return player.progression.passiveGearSlots[type] || 0;
}

function getPlayerUltraAwakeningRank(player, skillId) {
    if (!player || !player.progression || !player.progression.ultraAwakeningPoints) return 1;
    return getUltraAwakeningRank(player.progression.ultraAwakeningPoints[skillId]);
}

function getPlayerUltraDamageMultiplier(player, skillId, roomMode) {
    if (roomMode === 'training') return 1.0;
    return getPlayerUltraAwakeningRank(player, skillId) >= 3
        ? PROGRESSION_RULES.ULTRA_RANK_3_EFFECT_MULTIPLIER
        : 1.0;
}

function getPassiveItemDurationMultiplier(player, roomMode) {
    if (roomMode === 'training') return 1.0;
    return 1 + getPlayerPassiveRank(player, 'accessory') * PROGRESSION_RULES.PASSIVE_PER_RANK.accessoryDuration;
}

function addPassiveGear(profile, type) {
    const inventory = profile.passiveInventory[type];
    let rank = 1;
    inventory[rank] += 1;
    const merges = [];
    while (rank < PASSIVE_MAX_RANK && inventory[rank] >= PROGRESSION_RULES.PASSIVE_MERGE_COUNT) {
        inventory[rank] -= PROGRESSION_RULES.PASSIVE_MERGE_COUNT;
        inventory[rank + 1] += 1;
        rank += 1;
        merges.push(rank);
    }
    if (profile.passiveGearSlots[type] < rank) {
        profile.passiveGearSlots[type] = rank;
    }
    return { rank, merges };
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
        mainColor: (typeof stats.mainColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(stats.mainColor.trim()))
            ? stats.mainColor.trim().toLowerCase()
            : '#00a2e8'
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

const GRID_MAX_SIZE = 64;
const HEX_COLOR_PATTERN = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/;

// ドット絵データの検証:
//  - 64x64 を超えるデータや不正なトークンは空きマスに置き換える
//  - 未解放の特別インクは通常の空きマスに置き換える（ガチャ未所持でも使える抜け穴の防止）
function sanitizeGrid(raw, unlockedInks) {
    if (!Array.isArray(raw)) return null;
    const unlocked = new Set(Array.isArray(unlockedInks) ? unlockedInks : []);
    const cleanToken = (t) => {
        if (typeof t !== 'string') return '';
        const trimmed = t.trim();
        if (!trimmed) return '';
        if (Object.prototype.hasOwnProperty.call(SPECIAL_INKS, trimmed)) {
            return unlocked.has(trimmed) ? trimmed : '';
        }
        const lower = trimmed.toLowerCase();
        return HEX_COLOR_PATTERN.test(lower) ? lower : '';
    };
    if (raw.length > 0 && Array.isArray(raw[0])) {
        const rows = raw.slice(0, GRID_MAX_SIZE);
        return rows.map((row) => {
            const src = Array.isArray(row) ? row.slice(0, GRID_MAX_SIZE) : [];
            return src.map(cleanToken);
        });
    }
    return raw.slice(0, GRID_MAX_SIZE * GRID_MAX_SIZE).map(cleanToken);
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
        moveAllowancePx: 0,
        externalDisplacementAllowancePx: 0,
        externalDisplacementUntil: 0,
        lastMoveVectorAt: 0,
        vx: 0,
        vy: 0,
        invincibleUntil: 0,
        lastBossHitReportAt: 0,
        lastServerProjHitAt: 0,
        lastMagmaHitAt: 0,
        lastPulseHitAt: 0
    };
}

function grantExternalDisplacement(p, px, durationMs = 550) {
    if (!p) return;
    const now = Date.now();
    const addPx = Math.max(0, Number(px) || 0);
    const dur = Math.max(100, Number(durationMs) || 550);
    if (now > (p.externalDisplacementUntil || 0)) {
        p.externalDisplacementAllowancePx = 0;
    }
    p.externalDisplacementAllowancePx = Math.min(360, (p.externalDisplacementAllowancePx || 0) + addPx);
    p.externalDisplacementUntil = Math.max(p.externalDisplacementUntil || 0, now + dur);
}

function resetPlayerCombatStatuses(p) {
    if (!p) return;
    p.shieldUntil = 0;
    p.speedBoostUntil = 0;
    p.powerBoostUntil = 0;
    p.slowUntil = 0;
    p.slowStartedAt = 0;
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
    p.lastMoveAt = 0;
    p.moveAllowancePx = 0;
    p.externalDisplacementAllowancePx = 0;
    p.externalDisplacementUntil = 0;
    p.invincibleUntil = 0;
    p.lastBossHitReportAt = 0;
    p.lastServerProjHitAt = 0;
    p.lastMagmaHitAt = 0;
    p.lastPulseHitAt = 0;
    clearPlayerUltraStateAndTimers(p);
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

function pointToSegmentDistance(px, py, x1, y1, x2, y2) {
    const l2 = (x2 - x1) ** 2 + (y2 - y1) ** 2;
    if (l2 === 0) return Math.hypot(px - x1, py - y1);
    let t = ((px - x1) * (x2 - x1) + (py - y1) * (y2 - y1)) / l2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (x1 + t * (x2 - x1)), py - (y1 + t * (y2 - y1)));
}

function clampArenaPoint(x, y, margin) {
    const m = Math.max(40, Number(margin) || 95);
    return {
        x: Math.max(m, Math.min(ARENA_WIDTH - m, Number(x) || 0)),
        y: Math.max(ARENA_TOP + m, Math.min(ARENA_HEIGHT - m, Number(y) || ARENA_TOP))
    };
}

function resolveFacingFromMovement(dx, dy) {
    if (!Number.isFinite(dx) || !Number.isFinite(dy) || Math.hypot(dx, dy) < 0.01) return null;
    const deg = Math.atan2(dy, dx) * (180 / Math.PI);
    if (deg >= -22.5 && deg < 22.5) return 'right';
    if (deg >= 22.5 && deg < 67.5) return 'down_right';
    if (deg >= 67.5 && deg < 112.5) return 'down';
    if (deg >= 112.5 && deg < 157.5) return 'down_left';
    if (deg >= 157.5 || deg < -157.5) return 'left';
    if (deg >= -157.5 && deg < -112.5) return 'up_left';
    if (deg >= -112.5 && deg < -67.5) return 'up';
    return 'up_right';
}

function isPointInSlashSector(px, py, ox, oy, facingAngle, maxRange, halfAngleRad, targetRadius) {
    const dx = px - ox;
    const dy = py - oy;
    const dist = Math.hypot(dx, dy);
    const tr = Number(targetRadius) || 0;
    if (dist > maxRange + tr) return false;
    if (dist <= Math.max(18, tr * 0.85)) return true;

    let diff = Math.atan2(dy, dx) - facingAngle;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;

    const radiusAnglePad = Math.atan2(tr * 0.75, Math.max(1, dist));
    const effectiveHalfAngle = Math.min(Math.PI * 0.62, halfAngleRad + radiusAnglePad);
    return Math.abs(diff) <= effectiveHalfAngle;
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

function overlapsBreakableWall(room, x, y, size, pad = 6) {
    if (!room || !Array.isArray(room.walls)) return false;
    const left = x + pad;
    const right = x + size - pad;
    const top = y + pad;
    const bottom = y + size - pad;
    for (const w of room.walls) {
        if (left < w.x + w.w && right > w.x && top < w.y + w.h && bottom > w.y) {
            return true;
        }
    }
    return false;
}

function overlapsPlayerBlocking(room, x, y, size) {
    return overlapsStaticObstacle(x, y, size, 12) || overlapsBreakableWall(room, x, y, size, 6);
}

function ejectPlayerFromObstacles(room, p) {
    if (!p || !overlapsPlayerBlocking(room, p.x, p.y, CHAR_SIZE)) return false;
    const maxX = ARENA_WIDTH - CHAR_SIZE;
    const maxY = ARENA_HEIGHT - CHAR_SIZE;
    for (let r = 8; r <= 280; r += 8) {
        for (let a = 0; a < 16; a++) {
            const ang = (Math.PI * 2 / 16) * a;
            const cx = Math.max(0, Math.min(maxX, p.x + Math.cos(ang) * r));
            const cy = Math.max(ARENA_TOP, Math.min(maxY, p.y + Math.sin(ang) * r));
            if (!overlapsPlayerBlocking(room, cx, cy, CHAR_SIZE)) {
                p.x = cx;
                p.y = cy;
                grantExternalDisplacement(p, 160, 500);
                return true;
            }
        }
    }
    const safe = findSafePosition(room, CHAR_SIZE);
    p.x = safe.x;
    p.y = safe.y;
    grantExternalDisplacement(p, 240, 500);
    return true;
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

function findSafePosition(room, size, allowFallback = true) {
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

    // 壁・アイテム用は無理に置かない（障害物やプレイヤーの上に湧くのを防ぐ）
    return allowFallback ? { x: 64, y: 64 } : null;
}

function pushPlayerSafely(p, angle, distance, room) {
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
        if (overlapsPlayerBlocking(room, candX, candY, CHAR_SIZE)) {
            break;
        }
        curX = candX;
        curY = candY;
    }

    p.x = curX;
    p.y = curY;
}

// =========================================================================
// 時間停止判定 & タイマー管理・必殺技タイマー完全破棄
// =========================================================================
function isTimeStoppedWorld(room, now) {
    return Boolean(room && room.timeStopOwnerId && now < (room.timeStopUntil || 0));
}

function isTimeStoppedForActor(room, actorId, now) {
    return Boolean(room && room.timeStopOwnerId && now < (room.timeStopUntil || 0) && room.timeStopOwnerId !== actorId);
}

function clearRoomTimeStopIfOwner(roomId, ownerId) {
const room = rooms[roomId];
if (!room) return;
if (room.timeStopOwnerId === ownerId) {
const now = Date.now();
const unspentMs = Math.max(0, (room.timeStopUntil || 0) - now);
if (room.timeStopTimer) {
clearTimeout(room.timeStopTimer);
room.timeStopTimer = null;
}
room.timeStopOwnerId = null;
room.timeStopUntil = 0;
if (unspentMs > 0) {
if (room.boss && room.boss.scaleAuraActive && room.boss.scaleAuraUntil > now) {
room.boss.scaleAuraUntil = Math.max(now, room.boss.scaleAuraUntil - unspentMs);
io.to(roomId).emit('bossStateUpdated', room.boss);
}
if (room.bossRoarPullUntil > now) {
                room.bossRoarPullUntil = Math.max(now, room.bossRoarPullUntil - unspentMs);
            }
            if (room.bossVortexPullUntil > now) {
                room.bossVortexPullUntil = Math.max(now, room.bossVortexPullUntil - unspentMs);
            }
}
io.to(roomId).emit('ultraSkillEvent', {
playerId: ownerId,
skillId: 'time_stop',
phase: 'end'
});
}
}

function clearPlayerUltraStateAndTimers(p) {
    if (!p) return;
    if (Array.isArray(p.ultraTimers)) {
        for (const tid of p.ultraTimers) {
            clearTimeout(tid);
        }
    }
    if (Array.isArray(p.ultraIntervals)) {
        for (const iid of p.ultraIntervals) {
            clearInterval(iid);
        }
    }
    p.ultraTimers = [];
    p.ultraIntervals = [];
    p.ultraState = null;
    p.ultraStateUntil = 0;
    p.absoluteWallUntil = 0;
    p.counterStanceUntil = 0;
    p.bladeBuffUntil = 0;
    p.bootsBuffUntil = 0;
    p.gunBuffUntil = 0;
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

function registerPlayerUltraInterval(room, p, fn, intervalMs) {
    if (!room || !p) return null;
    if (!Array.isArray(p.ultraIntervals)) {
        p.ultraIntervals = [];
    }
    const intervalId = setInterval(fn, intervalMs);
    p.ultraIntervals.push(intervalId);
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
        const now = Date.now();
        if (isTimeStoppedWorld(room, now)) {
            const waitMs = Math.max(20, (room.timeStopUntil - now) + 20);
            registerBossTimeout(room, fn, waitMs);
            return;
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
    if (room.combatTickTimer) { clearInterval(room.combatTickTimer); room.combatTickTimer = null; }
    if (room.bossMoveTimer) { clearInterval(room.bossMoveTimer); room.bossMoveTimer = null; }
    if (room.bossProjectileTimer) { clearInterval(room.bossProjectileTimer); room.bossProjectileTimer = null; }
    if (room.bossAttackTimer) { clearTimeout(room.bossAttackTimer); room.bossAttackTimer = null; }
    if (room.timeStopTimer) { clearTimeout(room.timeStopTimer); room.timeStopTimer = null; }
if (Array.isArray(room.bossPendingTimeouts)) {
        for (const tid of room.bossPendingTimeouts) {
            clearTimeout(tid);
        }
        room.bossPendingTimeouts = [];
    }
    if (Array.isArray(room.respawnTimers)) {
        for (const rtid of room.respawnTimers) {
            clearTimeout(rtid);
        }
        room.respawnTimers = [];
    }
    room.bossProjectiles = [];
    room.bossMagmaZones = [];
    room.playerMagmaZones = [];
    room.ultraProjectiles = [];
    room.timeStopUntil = 0;
    room.timeStopOwnerId = null;
    room.bossRoarPullUntil = 0;
    room.bossRoarPullStrength = 0;
    room.bossVortexPullUntil = 0;
    room.bossVortexPullStrength = 0;
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
            bladeBuffUntil: p.bladeBuffUntil || 0,
            bootsBuffUntil: p.bootsBuffUntil || 0,
            gunBuffUntil: p.gunBuffUntil || 0,
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
            ultraCooldownDurationMs: p.ultraCooldownDurationMs || 0,
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

function buildRoomStatePayload(room) {
    return {
        state: room.state,
        mode: room.mode,
        stageNumber: room.stageNumber,
        stageId: room.stageId,
        bossId: room.bossId,
        hostId: room.hostId,
        hostMaxUnlockedStage: getHostMaxUnlockedStage(room),
        lastMatchCleared: Boolean(room.lastMatchCleared),
        timeStopUntil: room.timeStopUntil || 0,
        timeStopOwnerId: room.timeStopOwnerId || null,
        players: serializeRoomPlayers(room),
        walls: room.walls,
        items: room.items,
        staticObstacles: STATIC_OBSTACLES,
        boss: room.boss
    };
}

function emitRoomStateSync(roomId) {
    const room = rooms[roomId];
    if (!room) return;
    io.to(roomId).emit('roomStateSync', buildRoomStatePayload(room));
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
// サーバー側BOSS弾道＆マグマ床＆跳弾銃ティック更新
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
    } else if (ev.type === 'vortex' && ev.active) {
        room.bossVortexPullUntil = Date.now() + (Number(ev.duration) || 3800);
        room.bossVortexPullStrength = Number(ev.pullStrength) || 1.55;
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
    } else if (ev.type === 'true_void_spiral' || ev.type === 'true_void_clone_spiral') {
        const total = Math.max(1, ev.count || 9);
        const baseAngle = ev.baseAngle || 0;
        const speed = ev.speed || 4.4;
        const damage = ev.damage || (ev.type === 'true_void_clone_spiral' ? 20 : 18);
        for (let i = 0; i < total; i++) {
            const ang = baseAngle + (Math.PI * 2 / total) * i;
            room.bossProjectiles.push({
                kind: 'spiral',
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

function stepServerMagmaZones(roomId, matchId) {
    const room = rooms[roomId];
    if (!room || room.state !== 'playing' || room.matchId !== matchId || !room.boss) return;
    if (isTimeStoppedWorld(room, Date.now())) return;
    if (!Array.isArray(room.bossMagmaZones) || room.bossMagmaZones.length === 0) return;

    const now = Date.now();
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
        if (room.state !== 'playing' || room.matchId !== matchId) return;
        const p = room.players[pid];
        if (!p || p.isDead || p.isEliminated) continue;
        if (now < (p.lastMagmaHitAt || 0) + tickInterval) continue;

        const pcx = p.x + CHAR_SIZE / 2;
        const pcy = p.y + CHAR_SIZE / 2;
        const touching = room.bossMagmaZones.find((z) => Math.hypot(pcx - z.x, pcy - z.y) <= z.radius);
        if (touching) {
            p.lastMagmaHitAt = now;
            applyPulseDamageToPlayer(roomId, p, tickDmg, 'magma', matchId, touching.element);
            if (room.state !== 'playing' || room.matchId !== matchId) return;
        }
    }
}

function stepServerPlayerDots(roomId, matchId) {
    const room = rooms[roomId];
    if (!room || room.state !== 'playing' || room.matchId !== matchId) return;

    const now = Date.now();
    for (const pid in room.players) {
        if (room.state !== 'playing' || room.matchId !== matchId) return;
        const p = room.players[pid];
        if (!p || p.isDead || p.isEliminated) continue;
        if (isTimeStoppedForActor(room, p.id, now)) continue;
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

            applyDamageToPlayerInternal(roomId, p, 'BOSS', dotDmg, 'down', 'curse_dot', matchId, 'neutral', {
                skipInvincible: true,
                noKnockback: true,
                noCounter: true
            });
            if (room.state !== 'playing' || room.matchId !== matchId) return;
        }
    }
}

function stepServerBossProjectiles(roomId, matchId, dtMs) {
    const room = rooms[roomId];
    if (!room || room.state !== 'playing' || room.matchId !== matchId || !room.boss) return;
    if (isTimeStoppedWorld(room, Date.now())) return;
    if (!Array.isArray(room.bossProjectiles) || room.bossProjectiles.length === 0) return;

    const stepFrames = Math.min(4, Math.max(0.5, dtMs / (1000 / 60)));
    const now = Date.now();

    for (let i = room.bossProjectiles.length - 1; i >= 0; i--) {
        if (room.state !== 'playing' || room.matchId !== matchId || !room.boss) return;
        const bp = room.bossProjectiles[i];
        if (!bp) continue;

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
            if (room.state !== 'playing' || room.matchId !== matchId) return;
            const p = room.players[pid];
            if (!p || p.isDead || p.isEliminated) continue;
            if (now < (p.invincibleUntil || 0) || now < (p.lastServerProjHitAt || 0) + 150) continue;

            const pcx = p.x + CHAR_SIZE / 2;
            const pcy = p.y + CHAR_SIZE / 2;
            if (Math.hypot(bp.x - pcx, bp.y - pcy) < (bp.hitRadius || 20)) {
                p.lastServerProjHitAt = now;
                const applied = applyBossDamageToPlayer(roomId, p, bp.damage, bp.kind, matchId, bp.element);
                if (applied !== false && bp.kind === 'curse_bolt' && room.state === 'playing' && room.matchId === matchId) {
                    applyRandomPhantomCurse(roomId, p, matchId);
                }
                if (room.state !== 'playing' || room.matchId !== matchId) return;
                hitPlayer = true;
                break;
            }
        }

        if (hitPlayer && room.bossProjectiles[i] === bp) {
            room.bossProjectiles.splice(i, 1);
        }
    }
}

function stepPlayerMagmaZones(roomId, matchId) {
    const room = rooms[roomId];
    if (!room || room.state !== 'playing' || room.matchId !== matchId) return;
    if (!Array.isArray(room.playerMagmaZones) || room.playerMagmaZones.length === 0) return;

    const now = Date.now();
    for (let i = room.playerMagmaZones.length - 1; i >= 0; i--) {
        if (now >= room.playerMagmaZones[i].expiresAt) {
            room.playerMagmaZones.splice(i, 1);
        }
    }
    if (room.playerMagmaZones.length === 0) return;

    for (const mz of room.playerMagmaZones) {
        if (isTimeStoppedForActor(room, mz.ownerId, now)) continue;
        const owner = room.players[mz.ownerId];
        if (!owner) continue;
        const tickInterval = mz.tickIntervalMs || 1000;
        const tickDamage = mz.tickDamage || 10;

        if ((room.mode === 'boss' || room.mode === 'training') && room.boss && room.boss.hp > 0) {
            if (!room.boss.isStealthed) {
                const lastBossHit = mz.lastHitAtByTarget.BOSS || 0;
                if (now >= lastBossHit + tickInterval) {
                    const touchingBoss = mz.zones.some((z) => Math.hypot(room.boss.x - z.x, room.boss.y - z.y) <= z.radius + room.boss.radius * 0.5);
                    if (touchingBoss) {
                        mz.lastHitAtByTarget.BOSS = now;
                        applyDamageToBossInternal(roomId, owner, tickDamage, 'ultra_meteor_magma', 'magma');
                    }
                }
            }
            for (const clone of room.boss.clones || []) {
                if (!clone || clone.hp <= 0) continue;
                const lastCloneHit = mz.lastHitAtByTarget[clone.id] || 0;
                if (now < lastCloneHit + tickInterval) continue;
                const touchingClone = mz.zones.some((z) => Math.hypot(clone.x - z.x, clone.y - z.y) <= z.radius + (clone.radius || 0) * 0.5);
                if (touchingClone) {
                    mz.lastHitAtByTarget[clone.id] = now;
                    applyDamageToBossInternal(roomId, owner, tickDamage, 'ultra_meteor_magma', 'magma', clone.id);
                }
            }
        } else if (room.mode === 'pvp') {
            for (const pid in room.players) {
                if (pid === mz.ownerId) continue;
                const target = room.players[pid];
                if (!target || target.isDead || target.isEliminated) continue;
                const lastTargetHit = mz.lastHitAtByTarget[pid] || 0;
                if (now < lastTargetHit + tickInterval) continue;

                const tc = playerCenter(target);
                const touching = mz.zones.some((z) => Math.hypot(tc.x - z.x, tc.y - z.y) <= z.radius + 16);
                if (touching) {
                    mz.lastHitAtByTarget[pid] = now;
                    applyDamageToPlayerInternal(roomId, target, owner, tickDamage, 'down', 'magma', matchId, mz.element, {
                        skipInvincible: true,
                        noKnockback: true,
                        noCounter: true
                    });
                }
            }
        }
    }
}

function findWallOrObstacleAtPoint(room, px, py, radius) {
    for (const obs of STATIC_OBSTACLES) {
        if (px + radius > obs.x && px - radius < obs.x + obs.w && py + radius > obs.y && py - radius < obs.y + obs.h) {
            return { kind: 'static', obj: obs };
        }
    }
    if (room && Array.isArray(room.walls)) {
        for (let i = 0; i < room.walls.length; i++) {
            const w = room.walls[i];
            if (px + radius > w.x && px - radius < w.x + w.w && py + radius > w.y && py - radius < w.y + w.h) {
                return { kind: 'wall', obj: w, index: i };
            }
        }
    }
    return null;
}

function stepUltraProjectiles(roomId, matchId, dtMs) {
    const room = rooms[roomId];
    if (!room || room.state !== 'playing' || room.matchId !== matchId) return;
    if (!Array.isArray(room.ultraProjectiles) || room.ultraProjectiles.length === 0) return;

    const now = Date.now();
    const stepFrames = Math.min(4, Math.max(0.5, dtMs / (1000 / 60)));

        for (let i = room.ultraProjectiles.length - 1; i >= 0; i--) {
        if (room.state !== 'playing' || room.matchId !== matchId) return;
        const up = room.ultraProjectiles[i];
        if (!up) continue;
        if (isTimeStoppedForActor(room, up.ownerId, now)) continue;
        up.life -= stepFrames;
            if (up.life <= 0) {
                io.to(roomId).emit('ultraSkillEvent', {
                    playerId: up.ownerId,
                    skillId: 'ricochet_guns',
                    phase: 'despawn',
                    bulletId: up.id
                });
                room.ultraProjectiles.splice(i, 1);
                continue;
            }

            const totalDx = up.vx * stepFrames;
            const totalDy = up.vy * stepFrames;
            const subSteps = Math.max(1, Math.ceil(Math.hypot(totalDx, totalDy) / 4.5));
            let subDx = totalDx / subSteps;
            let subDy = totalDy / subSteps;
            const r = up.radius || 6;

            let destroyed = false;
            let bouncedThisTick = false;

for (let s = 0; s < subSteps; s++) {
                const nextX = up.x + subDx;
                let hitX = false;
                if (nextX - r <= 0 || nextX + r >= ARENA_WIDTH) {
                    hitX = true;
                } else {
                    const colX = findWallOrObstacleAtPoint(room, nextX, up.y, r);
                    if (colX) {
                        hitX = true;
                        if (colX.kind === 'wall') {
                            colX.obj.hp -= 10;
                            if (colX.obj.hp <= 0) {
                                room.walls.splice(colX.index, 1);
                            }
                            io.to(roomId).emit('gimmicksUpdated', { walls: room.walls, items: room.items });
                        }
                    }
                }
                if (hitX) {
                    if (up.bouncesLeft > 0) {
                        up.vx = -up.vx;
                        subDx = -subDx;
                        up.bouncesLeft -= 1;
                        bouncedThisTick = true;
                        const bounceX = Math.max(r + 1, Math.min(ARENA_WIDTH - r - 1, up.x + subDx));
                        if (!findWallOrObstacleAtPoint(room, bounceX, up.y, r)) {
                            up.x = bounceX;
                        }
                    } else {
                        destroyed = true;
                        break;
                    }
                } else {
                    up.x = nextX;
                }

                const nextY = up.y + subDy;
                let hitY = false;
                if (nextY - r <= ARENA_TOP || nextY + r >= ARENA_HEIGHT) {
                    hitY = true;
                } else {
                    const colY = findWallOrObstacleAtPoint(room, up.x, nextY, r);
                    if (colY) {
                        hitY = true;
                        if (colY.kind === 'wall') {
                            colY.obj.hp -= 10;
                            if (colY.obj.hp <= 0) {
                                room.walls.splice(colY.index, 1);
                            }
                            io.to(roomId).emit('gimmicksUpdated', { walls: room.walls, items: room.items });
                        }
                    }
                }
                if (hitY) {
                    if (up.bouncesLeft > 0) {
                        up.vy = -up.vy;
                        subDy = -subDy;
                        up.bouncesLeft -= 1;
                        bouncedThisTick = true;
                        const bounceY = Math.max(ARENA_TOP + r + 1, Math.min(ARENA_HEIGHT - r - 1, up.y + subDy));
                        if (!findWallOrObstacleAtPoint(room, up.x, bounceY, r)) {
                            up.y = bounceY;
                        }
                    } else {
                        destroyed = true;
                        break;
                    }
                } else {
                    up.y = nextY;
                }

                const owner = room.players[up.ownerId];
                if (owner) {
                    const rawDamage = up.fixedDamage * getPlayerEffectiveAttackMultiplier(owner, now, room.mode);

                    if ((room.mode === 'boss' || room.mode === 'training') && room.boss && room.boss.hp > 0) {
                        const hitClone = (room.boss.clones || []).find((clone) =>
                            clone && clone.hp > 0 &&
                            Math.hypot(up.x - clone.x, up.y - clone.y) <= (clone.radius || 0) + r + 4
                        );
                        if (hitClone) {
                            applyDamageToBossInternal(roomId, owner, rawDamage, 'ultra_ricochet', 'ultra', hitClone.id);
                            if (room.state !== 'playing' || room.matchId !== matchId) return;
                            destroyed = true;
                            break;
                        }
                        if (!room.boss.isStealthed && Math.hypot(up.x - room.boss.x, up.y - room.boss.y) <= room.boss.radius + r + 4) {
                            applyDamageToBossInternal(roomId, owner, rawDamage, 'ultra_ricochet', 'ultra');
                            if (room.state !== 'playing' || room.matchId !== matchId) return;
                            destroyed = true;
                            break;
                        }
                    } else if (room.mode === 'pvp') {
                        for (const tid in room.players) {
                            if (tid === up.ownerId) continue;
                            const target = room.players[tid];
                            if (!target || target.isDead || target.isEliminated) continue;
                            const tc = playerCenter(target);
                            if (Math.hypot(up.x - tc.x, up.y - tc.y) <= 22 + r) {
                                const knockDir = Math.abs(up.vx) >= Math.abs(up.vy)
                                    ? (up.vx >= 0 ? 'right' : 'left')
                                    : (up.vy >= 0 ? 'down' : 'up');
                                applyDamageToPlayerInternal(roomId, target, owner, rawDamage, knockDir, 'ultra_ricochet', matchId, owner.element);
                                if (room.state !== 'playing' || room.matchId !== matchId) return;
                                destroyed = true;
                                break;
                            }
                        }
                        if (destroyed) break;
                    }
                }
            }

    if (room.state !== 'playing' || room.matchId !== matchId) return;
    if (destroyed) {
            io.to(roomId).emit('ultraSkillEvent', {
                playerId: up.ownerId,
                skillId: 'ricochet_guns',
                phase: 'despawn',
                bulletId: up.id,
                x: up.x,
                y: up.y
            });
            room.ultraProjectiles.splice(i, 1);
        } else if (bouncedThisTick) {
            io.to(roomId).emit('ultraSkillEvent', {
                playerId: up.ownerId,
                skillId: 'ricochet_guns',
                phase: 'bounce',
                bulletId: up.id,
                x: up.x,
                y: up.y,
                vx: up.vx,
                vy: up.vy
            });
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
        if (!r || r.state !== 'playing' || r.matchId !== currentMatchId) return;
        if (isTimeStoppedWorld(r, Date.now())) return;
        const maxWalls = r.mode === 'boss'
            ? GAME_RULES.OBSTACLES.BREAKABLE_MAX_BOSS
            : GAME_RULES.OBSTACLES.BREAKABLE_MAX_PVP;
        const wallSize = GAME_RULES.OBSTACLES.BREAKABLE_SIZE;
        const wallHp = GAME_RULES.OBSTACLES.BREAKABLE_HP;

        if (r.walls.length < maxWalls) {
            const wallPos = findSafePosition(r, wallSize, false);
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
        if (!r || r.state !== 'playing' || r.matchId !== currentMatchId) return;
        if (isTimeStoppedWorld(r, Date.now())) return;
        const maxItems = r.mode === 'boss' ? 6 : 5;
        if (r.items.length < maxItems) {
            const itemPos = findSafePosition(r, 24, false);
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

    // 共通32msバトルティック（跳弾銃・プレイヤーマグマ床・DoT更新：PvP/BOSS両対応）
    let lastCombatTickAt = Date.now();
    room.combatTickTimer = setInterval(() => {
        const r = rooms[roomId];
        if (!r || r.state !== 'playing' || r.matchId !== currentMatchId) return;
        const now = Date.now();
        const dtMs = Math.min(80, Math.max(16, now - lastCombatTickAt));
        lastCombatTickAt = now;
        stepUltraProjectiles(roomId, currentMatchId, dtMs);
        stepPlayerMagmaZones(roomId, currentMatchId);
        if (r.mode !== 'boss') {
            stepServerPlayerDots(roomId, currentMatchId);
        }
    }, 32);

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
        if (!r || r.state !== 'playing' || r.matchId !== matchId || !r.boss) return;
        const now = Date.now();
        if (isTimeStoppedWorld(r, now)) return;

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
            if (boss.id === 'true_void_typhoon' && boss.phase === 2) {
                moveSpd = 5.0;
            }

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

        if (boss.id === 'true_void_typhoon' && boss.phase === 2 && Array.isArray(boss.clones)) {
            for (const clone of boss.clones) {
                if (!nearest) break;
                const angleToPlayer = Math.atan2((nearest.y + 24) - clone.y, (nearest.x + 24) - clone.x);
                clone.x += Math.cos(angleToPlayer) * 2.2;
                clone.y += Math.sin(angleToPlayer) * 2.2;
                clone.x = Math.max(70, Math.min(ARENA_WIDTH - 70, clone.x));
                clone.y = Math.max(ARENA_TOP + 70, Math.min(ARENA_HEIGHT - 70, clone.y));

                if (!clone.lastShotAt || now - clone.lastShotAt >= 1500) {
                    clone.lastShotAt = now;
                    const baseAngle = angleToPlayer;
                    const count = 9;
                    const speed = 4.4;
                    const eventPayload = {
                        bossId: boss.id,
                        element: boss.element,
                        type: 'true_void_clone_spiral',
                        x: clone.x,
                        y: clone.y,
                        count,
                        baseAngle,
                        speed,
                        damage: 20
                    };
                    io.to(roomId).emit('bossAttackEvent', eventPayload);
                    registerServerBossProjectilesFromEvent(roomId, matchId, eventPayload);
                }
            }
        }

        io.to(roomId).emit('bossStateUpdated', boss);
        if (boss.id === 'true_void_typhoon' && boss.phase === 2 && Array.isArray(boss.clones)) {
            io.to(roomId).emit('bossClonesUpdated', {
                bossId: boss.id,
                phase: boss.phase,
                clones: boss.clones.map((clone) => ({ ...clone }))
            });
        }
    }, 200);

    let lastProjTickAt = Date.now();
    room.bossProjectileTimer = setInterval(() => {
        const r = rooms[roomId];
        if (!r || r.state !== 'playing' || r.matchId !== matchId || !r.boss) return;
        const now = Date.now();
        const dtMs = Math.min(80, Math.max(16, now - lastProjTickAt));
        lastProjTickAt = now;
        stepServerBossProjectiles(roomId, matchId, dtMs);
        stepServerMagmaZones(roomId, matchId);
        stepServerPlayerDots(roomId, matchId);
    }, 32);

    let attackCount = 0;
    const scheduleNextAttack = (customDelayMs) => {
        const r = rooms[roomId];
        if (!r || r.state !== 'playing' || r.matchId !== matchId || !r.boss) return;

        const curDef = getBossDef(r.boss.id);
        const activePlayerCount = Object.keys(r.players).filter((id) => !r.players[id].isEliminated).length;
        const isSolo = activePlayerCount <= 1;
        const phaseKey = r.boss.phase === 2 ? 'p2' : 'p1';
        const intervalDef = curDef.attackIntervalMs || {};
        const extendedIntervalKey = `${isSolo ? 'solo' : 'multi'}${phaseKey[1].toUpperCase()}`;
        const intervalFallback = intervalDef[phaseKey];
        const interval = customDelayMs !== undefined
            ? customDelayMs
            : (intervalDef[extendedIntervalKey] ?? intervalFallback);
        r.bossAttackTimer = setTimeout(() => {
            const cur = rooms[roomId];
            if (!cur || cur.state !== 'playing' || cur.matchId !== matchId || !cur.boss) return;
            const now = Date.now();
            if (isTimeStoppedWorld(cur, now)) {
                scheduleNextAttack(Math.max(20, (cur.timeStopUntil - now) + 30));
                return;
            }

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
                if (eventName === 'bossAttackEvent' && eventPayload) {
                    const targetRoom = rooms[targetRoomId];
                    if (targetRoom) {
                        if (!targetRoom.lastBossAttackAt) targetRoom.lastBossAttackAt = {};
                        const attackStamp = Date.now();
                        if (eventPayload.type) {
                            targetRoom.lastBossAttackAt[eventPayload.type] = attackStamp;
                        }
                        if (Array.isArray(def.attackProjectiles)) {
                            for (const projKind of def.attackProjectiles) {
                                targetRoom.lastBossAttackAt[projKind] = attackStamp;
                            }
                        }
                    }
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
    const isTrueVoid = def.id === 'true_void_typhoon';
    const shockDamage = isTrueVoid ? (Number(cfg.shockDamage) || 22) : 0;
    const shockRadius = isTrueVoid ? (Number(cfg.knockbackRadius) || 250) : kbRadius;

    boss.scaleAuraActive = true;
    boss.scaleAuraUntil = now + auraDuration;

    // 周囲ノックバック衝撃波（ダメージなし）
    for (const id in room.players) {
        const p = room.players[id];
        if (!p || p.isDead || p.isEliminated) continue;
        if (isTimeStoppedForActor(room, p.id, now)) continue;
        const pcx = p.x + CHAR_SIZE / 2;
        const pcy = p.y + CHAR_SIZE / 2;
        const dist = Math.hypot(pcx - boss.x, pcy - boss.y);
        if (dist <= shockRadius) {
            const ang = dist > 0.1 ? Math.atan2(pcy - boss.y, pcx - boss.x) : Math.PI / 2;
            let mult = 1.0;
            if (now < (p.absoluteWallUntil || 0)) mult = 0.15;
            else if (now < (p.shieldUntil || 0)) mult = 0.25;
            pushPlayerSafely(p, ang, kbDist * mult, room);
            grantExternalDisplacement(p, kbDist * mult + 24, 550);
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
            if (shockDamage > 0) {
                applyBossDamageToPlayer(roomId, p, shockDamage, 'true_void_shockwave', matchId, boss.element);
            }
        }
    }

    io.to(roomId).emit('bossAttackEvent', {
        bossId: boss.id,
        element: boss.element,
        type: 'p2_awaken',
        x: boss.x,
        y: boss.y,
        knockbackRadius: shockRadius,
        scaleAuraDurationMs: auraDuration
    });

    if (isTrueVoid) {
        boss.clones = [];
        const cloneAngles = [Math.PI * 0.25, Math.PI * 0.75, Math.PI * 1.25, Math.PI * 1.75];
        for (let i = 0; i < 4; i++) {
            const pos = clampArenaPoint(
                boss.x + Math.cos(cloneAngles[i]) * 170,
                boss.y + Math.sin(cloneAngles[i]) * 170,
                70
            );
            boss.clones.push({
                id: `void_clone_${matchId}_${i}`,
                x: pos.x,
                y: pos.y,
                radius: 24,
                hp: 400,
                maxHp: 400,
                lastShotAt: 0
            });
        }
        io.to(roomId).emit('bossStateUpdated', boss);
        io.to(roomId).emit('bossClonesUpdated', {
            bossId: boss.id,
            phase: boss.phase,
            clones: boss.clones.map((clone) => ({ ...clone }))
        });
        io.to(roomId).emit('bossAttackEvent', {
            bossId: boss.id,
            element: boss.element,
            type: 'p2_awaken',
            x: boss.x,
            y: boss.y,
            knockbackRadius: shockRadius,
            scaleAuraDurationMs: auraDuration,
            clones: boss.clones.map((clone) => ({ ...clone }))
        });

        const tornadoRadius = Number(cfg.tornadoRadius) || 170;
        const tornadoDuration = Number(cfg.tornadoDurationMs) || 8000;
        const tornadoPull = Number(cfg.tornadoPullStrength) || 2.65;
        const tickInterval = Number(cfg.tornadoTickIntervalMs) || 500;
        const tickDamage = Number(cfg.tornadoTickDamage) || 8;
        room.bossGiantTornadoUntil = now + tornadoDuration;
        room.bossGiantTornadoRadius = tornadoRadius;
        room.bossGiantTornadoPullStrength = tornadoPull;
        io.to(roomId).emit('bossAttackEvent', {
            bossId: boss.id,
            element: boss.element,
            type: 'true_void_giant_tornado',
            x: boss.x,
            y: boss.y,
            radius: tornadoRadius,
            duration: tornadoDuration,
            pullStrength: tornadoPull,
            tickIntervalMs: tickInterval,
            tickDamage
        });
        const tickCount = Math.floor(tornadoDuration / tickInterval);
        for (let i = 1; i <= tickCount; i++) {
            registerBossTimeout(room, () => {
                const cur = rooms[roomId];
                if (!cur || cur.state !== 'playing' || cur.matchId !== matchId || !cur.boss) return;
                for (const id in cur.players) {
                    const p = cur.players[id];
                    if (!p || p.isDead || p.isEliminated) continue;
                    if (Math.hypot(p.x + 24 - cur.boss.x, p.y + 24 - cur.boss.y) <= tornadoRadius) {
                        applyBossDamageToPlayer(roomId, p, tickDamage, 'true_void_giant_tornado', matchId, cur.boss.element);
                    }
                }
            }, i * tickInterval);
        }
        registerBossTimeout(room, () => {
            const cur = rooms[roomId];
            if (!cur) return;
            cur.bossGiantTornadoUntil = 0;
            cur.bossGiantTornadoRadius = 0;
            cur.bossGiantTornadoPullStrength = 0;
        }, tornadoDuration);
    }
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

    const now = Date.now();
    if (attacker === 'BOSS' && isTimeStoppedForActor(room, target.id, now)) return false;
    const safeMult = Math.min(1.0, Math.max(0.25, Number(multiplier) || 0.75));
    const safeDuration = Math.max(100, Math.floor(Number(durationMs) || 1800));
    const until = now + safeDuration;

    if (!target.slowUntil || now >= target.slowUntil) {
        target.slowStartedAt = now;
    }
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

    pushPlayerSafely(target, ang, desiredDist * mult, room);
    grantExternalDisplacement(target, desiredDist * mult + 24, 550);

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

function getPlayerEffectiveAttackMultiplier(p, now, roomMode) {
    if (!p) return 1.0;
    const powerMult = now < (p.powerBoostUntil || 0) ? 1.5 : 1.0;
    const debuffMult = now < (p.attackDebuffUntil || 0) ? (p.attackDebuffMultiplier || 0.75) : 1.0;
    const talentMult = 1 + getPlayerTalentLevel(p, 'attack', roomMode) * PROGRESSION_RULES.TALENT_PER_LEVEL.attack;
    const gearMult = roomMode === 'training' ? 1.0
        : (1 + getPlayerPassiveRank(p, 'weapon') * PROGRESSION_RULES.PASSIVE_PER_RANK.weaponAttack);
    return powerMult * debuffMult * talentMult * gearMult;
}

function getPlayerMobilityMultiplier(p, roomMode) {
    return 1 + getPlayerTalentLevel(p, 'mobility', roomMode) * PROGRESSION_RULES.TALENT_PER_LEVEL.mobility;
}

function getPlayerShotCooldownMs(p, roomMode) {
    const baseCooldown = GAME_RULES.ACTIONS.shot.cooldownMs;
    return roomMode === 'boss' && getPlayerTalentLevel(p, 'attack', roomMode) >= PROGRESSION_RULES.TALENT_UNLOCKS.bulletConservation
        ? Math.floor(baseCooldown * PROGRESSION_RULES.BULLET_COOLDOWN_MULTIPLIER)
        : baseCooldown;
}

function getPlayerDamageModifiers(target, attackerElement, roomMode) {
    let elementMultiplier = getElementMultiplier(attackerElement, target.element);
    if (roomMode === 'boss' && getPlayerTalentLevel(target, 'durability', roomMode) >= PROGRESSION_RULES.TALENT_UNLOCKS.inkProtection &&
        elementMultiplier >= 1.35 && elementMultiplier <= 1.45) {
        elementMultiplier = PROGRESSION_RULES.WEAKNESS_DAMAGE_MULTIPLIER;
    }
    return {
        elementMultiplier,
        armorMultiplier: roomMode === 'training' ? 1.0
            : (1 - getPlayerPassiveRank(target, 'armor') * PROGRESSION_RULES.PASSIVE_PER_RANK.armorReduction)
    };
}

function tryActivateEmergencyEscape(roomId, room, target, incomingDamage, now) {
    if (!room || room.mode !== 'boss' || !target || target.emergencyEscapeUsed ||
        getPlayerTalentLevel(target, 'durability', room.mode) < PROGRESSION_RULES.TALENT_UNLOCKS.emergencyEscape ||
        now < (target.shieldUntil || 0) || now < (target.absoluteWallUntil || 0)) {
        return false;
    }
    if (target.hp - incomingDamage > target.maxHp * PROGRESSION_RULES.EMERGENCY_ESCAPE_HP_RATIO) return false;

    const duration = GAME_RULES.ACTIONS.shield.durationMs;
    target.emergencyEscapeUsed = true;
    target.shieldUntil = now + duration;
    target.nextShieldAt = now + GAME_RULES.ACTIONS.shield.cooldownMs;
    io.to(roomId).emit('playerShielded', {
        id: target.id,
        duration,
        cooldownMs: GAME_RULES.ACTIONS.shield.cooldownMs,
        autoEmergency: true
    });
    io.to(roomId).emit('attackBlocked', {
        targetId: target.id,
        attackerId: 'BOSS',
        type: 'talent_emergency',
        byTalent: true
    });
    return true;
}

function applyDamageToBossInternal(roomId, attacker, rawDamage, attackKind, hitTypeLabel, targetCloneId) {
    const room = rooms[roomId];
    if (!room || room.state !== 'playing' || !['boss', 'training'].includes(room.mode) || !room.boss) return false;
    if (!attacker || room.boss.hp <= 0) return false;

    const now = Date.now();
    const def = getBossDef(room.boss.id);
    const elemMult = getElementMultiplier(attacker.element, room.boss.element);
    const barrierMult = (room.boss.barrierActive && def.barrierDamageMultiplier) ? def.barrierDamageMultiplier : 1.0;

    if (targetCloneId) {
        const clone = Array.isArray(room.boss.clones)
            ? room.boss.clones.find((c) => c && c.id === targetCloneId)
            : null;
        if (!clone || clone.hp <= 0) return false;
        const elemMult = getElementMultiplier(attacker.element, room.boss.element);
        const finalCloneDamage = Math.max(1, Math.round(rawDamage * elemMult));
        clone.hp = Math.max(0, clone.hp - finalCloneDamage);
        attacker.bossDamageDealt = (attacker.bossDamageDealt || 0) + finalCloneDamage;
        io.to(roomId).emit('bossDamaged', {
            attackerId: attacker.id,
            damage: finalCloneDamage,
            hp: room.boss.hp,
            maxHp: room.boss.maxHp,
            phase: room.boss.phase,
            targetCloneId,
            cloneId: clone.id,
            cloneHp: clone.hp,
            cloneMaxHp: clone.maxHp,
            clones: room.boss.clones.map((c) => ({ ...c })),
            elementMultiplier: elemMult,
            attackerElement: attacker.element,
            defenderElement: room.boss.element,
            attackType: hitTypeLabel || attackKind
        });
        if (clone.hp <= 0) {
            room.boss.clones = room.boss.clones.filter((c) => c.id !== targetCloneId);
            io.to(roomId).emit('bossStateUpdated', room.boss);
            io.to(roomId).emit('bossClonesUpdated', {
                bossId: room.boss.id,
                phase: room.boss.phase,
                clones: room.boss.clones.map((c) => ({ ...c }))
            });
        }
        return true;
    }

    if (room.boss.isStealthed) return false;

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
    attacker.bossCoreDamageDealt = (attacker.bossCoreDamageDealt || 0) + finalDamage;
    if (room.mode === 'training') {
        if (!room.trainingStats) room.trainingStats = { startAt: now, totalDamage: 0, maxHit: 0, elapsedMs: 0 };
        room.trainingStats.totalDamage = (room.trainingStats.totalDamage || 0) + finalDamage;
        room.trainingStats.maxHit = Math.max(room.trainingStats.maxHit || 0, finalDamage);
        room.trainingStats.elapsedMs = Math.max(0, now - (room.trainingStats.startAt || now));
    }

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
        clones: Array.isArray(room.boss.clones)
            ? room.boss.clones.map((clone) => ({ ...clone }))
            : [],
        blockedByBarrier: Boolean(room.boss.barrierActive),
        reducedByScaleAura: scaleAuraMult < 1.0,
        elementMultiplier: elemMult,
        attackerElement: attacker.element,
        defenderElement: room.boss.element,
        attackType: hitTypeLabel || attackKind,
        trainingStats: room.mode === 'training' ? {
            totalDamage: room.trainingStats.totalDamage,
            maxHit: room.trainingStats.maxHit,
            elapsedMs: room.trainingStats.elapsedMs
        } : null
    });

    if (triggeredAwaken) {
        triggerBossPhase2Awaken(roomId, room, def, room.matchId);
    }

    if (room.boss.hp <= 0 && room.mode === 'training') {
        room.boss.hp = room.boss.maxHp;
        room.boss.phase = 1;
        io.to(roomId).emit('bossStateUpdated', room.boss);
    } else if (room.boss.hp <= 0) {
        checkMatchWinner(roomId);
    }
    return true;
}

function applyDamageToPlayerInternal(roomId, target, attacker, rawDamage, knockDir, hitType, matchId, attackerElement, opts) {
    const room = rooms[roomId];
    if (!room || room.state !== 'playing' || room.matchId !== matchId) return false;
    if (!target || target.isDead || target.isEliminated) return false;

    const now = Date.now();
    const options = opts || {};
    const isEndOfDays = Boolean(options.isEndOfDays);
    const skipInvincible = Boolean(options.skipInvincible);
    const noCounter = Boolean(options.noCounter);
    const eodDef = isEndOfDays ? getUltraSkillDef('end_of_days') : null;

    // 1. 完全反撃（構え中）チェック（※スリップ系 noCounter は発火しない）
    if (!noCounter && now < target.counterStanceUntil) {
        if (isEndOfDays) {
            const counterMult = (eodDef && eodDef.counterInteraction && typeof eodDef.counterInteraction.damageMultiplier === 'number')
                ? eodDef.counterInteraction.damageMultiplier
                : 0.5;
            const shouldCounter = eodDef && eodDef.counterInteraction
                ? Boolean(eodDef.counterInteraction.triggersCounter)
                : true;
            const atkElem = attackerElement || (attacker && attacker !== 'BOSS' ? attacker.element : 'neutral');
            const damageMods = getPlayerDamageModifiers(target, atkElem, room.mode);
            const damage = Math.max(1, Math.round(rawDamage * damageMods.elementMultiplier * damageMods.armorMultiplier * counterMult));

            target.hp = Math.max(0, target.hp - damage);
            if (!skipInvincible) {
                target.invincibleUntil = now + 350;
            }
            if (!options.noKnockback) {
        grantExternalDisplacement(target, (hitType === 'melee' ? 32 : 16) + 20, 600);
    }
            io.to(roomId).emit('playerDamaged', {
                targetId: target.id,
                attackerId: attacker && attacker !== 'BOSS' ? attacker.id : 'BOSS',
                damage,
                hp: target.hp,
                maxHp: target.maxHp,
                knockbackDir: knockDir || 'down',
                type: hitType,
                elementMultiplier: damageMods.elementMultiplier,
                attackerElement: atkElem,
                defenderElement: target.element,
                skipInvincible,
                noKnockback: Boolean(options.noKnockback)
            });

            if (shouldCounter && target.hp > 0) {
                triggerPerfectCounter(roomId, target, attacker || 'BOSS', matchId);
            } else {
                clearPlayerUltraStateAndTimers(target);
            }

            if (target.hp <= 0) {
                handlePlayerKO(roomId, target, attacker && attacker !== 'BOSS' ? attacker : null, matchId);
            }
            return true;
        }
        triggerPerfectCounter(roomId, target, attacker || 'BOSS', matchId);
        return false;
    }

    // 2. サーバー権威 i-frame (350ms) チェック
    if (!skipInvincible && now < (target.invincibleUntil || 0)) {
        return false;
    }

    // 3. 絶対防壁 / 通常バリア Z チェック
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
            const damageMods = getPlayerDamageModifiers(target, atkElem, room.mode);
            const damage = Math.max(1, Math.round(rawDamage * damageMods.elementMultiplier * damageMods.armorMultiplier * guardMult));

            target.hp = Math.max(0, target.hp - damage);
            if (!skipInvincible) {
                target.invincibleUntil = now + 350;
            }
            if (!options.noKnockback) {
        grantExternalDisplacement(target, (hitType === 'melee' ? 32 : 16) + 20, 600);
    }
            io.to(roomId).emit('playerDamaged', {
                targetId: target.id,
                attackerId: attacker && attacker !== 'BOSS' ? attacker.id : 'BOSS',
                damage,
                hp: target.hp,
                maxHp: target.maxHp,
                knockbackDir: knockDir || 'down',
                type: hitType,
                elementMultiplier: damageMods.elementMultiplier,
                attackerElement: atkElem,
                defenderElement: target.element,
                skipInvincible,
                noKnockback: Boolean(options.noKnockback),
                byAbsoluteWall: hasAbsoluteWall,
                byShield: !hasAbsoluteWall && hasShield
            });

            if (target.hp <= 0) {
                handlePlayerKO(roomId, target, attacker && attacker !== 'BOSS' ? attacker : null, matchId);
            }
            return true;
        }

        if (hitType === 'melee' && attacker && attacker !== 'BOSS') {
            grantExternalDisplacement(attacker, 36, 600);
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
    const damageMods = getPlayerDamageModifiers(target, atkElem, room.mode);
    const damage = Math.max(1, Math.round(rawDamage * damageMods.elementMultiplier * damageMods.armorMultiplier));
    if (tryActivateEmergencyEscape(roomId, room, target, damage, now)) return false;

    target.hp = Math.max(0, target.hp - damage);
    if (!skipInvincible) {
        target.invincibleUntil = now + 350;
    }
    if (!options.noKnockback) {
        grantExternalDisplacement(target, (hitType === 'melee' ? 32 : 16) + 20, 600);
    }
    io.to(roomId).emit('playerDamaged', {
        targetId: target.id,
        attackerId: attacker && attacker !== 'BOSS' ? attacker.id : 'BOSS',
        damage,
        hp: target.hp,
        maxHp: target.maxHp,
        knockbackDir: knockDir || 'down',
        type: hitType,
        elementMultiplier: damageMods.elementMultiplier,
        attackerElement: atkElem,
        defenderElement: target.element,
        skipInvincible,
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
        noKnockback: true,
        noCounter: attackType === 'magma'
    });
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
    const atkMult = getPlayerEffectiveAttackMultiplier(counterPlayer, Date.now(), room.mode);
    const baseCounterDmg = counterPlayer.stats.atk * skill.damageMultiplier * atkMult *
        getPlayerUltraDamageMultiplier(counterPlayer, skill.id, room.mode);

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

    if ((room.mode === 'boss' || room.mode === 'training') && room.boss && room.boss.hp > 0) {
        const distToBoss = Math.hypot(room.boss.x - pc.x, room.boss.y - pc.y);
        if (attacker === 'BOSS' || distToBoss <= counterRadius + room.boss.radius + 90) {
            applyDamageToBossInternal(roomId, counterPlayer, baseCounterDmg, 'ultra_counter', 'ultra');
        }
        for (const clone of room.boss.clones || []) {
            if (!clone || clone.hp <= 0) continue;
            const distToClone = Math.hypot(clone.x - pc.x, clone.y - pc.y);
            if (attacker === 'BOSS' || distToClone <= counterRadius + (clone.radius || 0) + 90) {
                applyDamageToBossInternal(roomId, counterPlayer, baseCounterDmg, 'ultra_counter', 'ultra', clone.id);
            }
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
    clearRoomTimeStopIfOwner(roomId, target.id);
    clearPlayerUltraStateAndTimers(target);
    resetPlayerCombatStatuses(target);
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

        if (!Array.isArray(room.respawnTimers)) room.respawnTimers = [];
        const respawnTimerId = setTimeout(() => {
            const currentR = rooms[roomId];
            if (currentR && Array.isArray(currentR.respawnTimers)) {
                currentR.respawnTimers = currentR.respawnTimers.filter((id) => id !== respawnTimerId);
            }
            if (currentR && currentR.state === 'playing' && currentR.matchId === matchIdAtKO && currentR.players[targetId]) {
                const respawnTarget = currentR.players[targetId];
                if (!respawnTarget.isEliminated && respawnTarget.isDead) {
                    respawnTarget.isDead = false;
                    resetPlayerCombatStatuses(respawnTarget);
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
        room.respawnTimers.push(respawnTimerId);
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
    room.playerMagmaZones = [];
    room.ultraProjectiles = [];
    room.timeStopUntil = 0;
    room.timeStopOwnerId = null;
    room.bossRoarPullUntil = 0;
    room.bossRoarPullStrength = 0;
    room.bossVortexPullUntil = 0; room.bossVortexPullStrength = 0;

    const stage = getStageByNumber(room.stageNumber);
    room.stageNumber = stage.stageNumber;
    room.stageId = stage.stageId;
    room.bossId = stage.bossId;

    const playerIds = Object.keys(room.players);
    if (room.mode === 'training') {
        room.boss = createBossInstance(room.bossId || 'void_typhoon', 1);
        room.boss.maxHp = 100000;
        room.boss.hp = 100000;
        room.boss.phase = 1;
        room.boss.isStealthed = false;
        room.boss.x = ARENA_CENTER_X;
        room.boss.y = 220;
        room.trainingStats = { startAt: Date.now(), totalDamage: 0, maxHit: 0, elapsedMs: 0 };
    } else {
        room.boss = room.mode === 'boss' ? createBossInstance(room.bossId, playerIds.length) : null;
    }

    playerIds.forEach((id, index) => {
        const p = room.players[id];
        const spawn = SPAWN_POINTS[index % SPAWN_POINTS.length];
        resetPlayerCombatStatuses(p);
        Object.assign(p, createPlayerGuards());

        p.isDead = false;
        p.isEliminated = false;
        p.stocks = INITIAL_STOCKS;
        p.bossDamageDealt = 0;
        p.lastEarnedPoints = 0;
        p.lastPointBreakdown = null;
        p.bossCoreDamageDealt = 0;
        p.emergencyEscapeUsed = false;
        p.ultraCooldownUntil = 0;
        p.ultraCooldownDurationMs = 0;
        syncPlayerEquippedUltraFromProfile(p);
        syncPlayerProgression(room, p, getOrCreateProfile(p.clientKey));
        if (room.mode === 'training') {
            p.ultraSkillId = p.ultraSkillId && ULTRA_SKILL_ORDER.includes(p.ultraSkillId) ? p.ultraSkillId : ULTRA_SKILL_ORDER[0];
            p.ultraRemainingUses = GAME_RULES.GACHA.ULTRA_MAX_STOCK;
            p.ultraMaxUses = GAME_RULES.GACHA.ULTRA_MAX_STOCK;
            p.ultraCooldownUntil = 0;
        }

        p.hp = p.maxHp;
        p.x = spawn.x;
        p.y = spawn.y;
        p.facing = spawn.facing;
    });

    io.to(roomId).emit('currentPlayers', serializeRoomPlayers(room));
    io.to(roomId).emit('gimmicksUpdated', { walls: [], items: [] });
    if (room.mode === 'boss' || room.mode === 'training') {
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
    const minRequired = room.mode === 'boss' || room.mode === 'training' ? 1 : 2;
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

    if (room.mode === 'training') {
        return;
    }

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
            const dailyBonusByPlayer = {};

            playerIds.forEach((id) => {
                const p = room.players[id];
                resetPlayerCombatStatuses(p);
                const dmg = p.bossDamageDealt || 0;
                const dmgRatio = totalDamageDealt > 0 ? (dmg / totalDamageDealt) : (1 / Math.max(1, playerIds.length));
                const contributionBonus = Math.round(REWARD_BOSS_CONTRIBUTION_POOL * dmgRatio);
                const mvpBonus = (id === mvpId) ? REWARD_BOSS_MVP : 0;
                const baseEarned = clearBonus + contributionBonus + mvpBonus;
                const prof = getOrCreateProfile(p.clientKey);
                const rewardMultiplier = 1 + getPlayerTalentLevel(p, 'reward', room.mode) * PROGRESSION_RULES.TALENT_PER_LEVEL.reward;
                const talentBonus = Math.round(baseEarned * (rewardMultiplier - 1));
                const dailyFirstWinBonus = claimDailyFirstWinBonus(prof);
                const totalEarned = baseEarned + talentBonus + dailyFirstWinBonus;

                p.wins = (p.wins || 0) + 1;
                p.points = (p.points || 0) + totalEarned;
                p.lastEarnedPoints = totalEarned;
                p.lastPointBreakdown = {
                    clearBonus,
                    contributionBonus,
                    mvpBonus,
                    rewardMultiplier,
                    talentBonus,
                    dailyFirstWinBonus,
                    damageRatioPercent: Math.round(dmgRatio * 100),
                    totalEarned
                };

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
                dailyBonusByPlayer[id] = dailyFirstWinBonus;
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
                dailyBonusByPlayer,
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
            const stage = getStageByNumber(room.stageNumber);
            const participationBaseReward = Math.max(0, Number(stage.clearRewardPt) || 0);
            const bossMaxHp = Math.max(1, Number(room.boss && room.boss.maxHp) || 1);
            playerIds.forEach((id) => {
                const p = room.players[id];
                resetPlayerCombatStatuses(p);
                const damagedBossHp = Math.min(bossMaxHp, Math.max(0, p.bossCoreDamageDealt || 0));
                const participationBonus = Math.min(
                    participationBaseReward,
                    Math.round(participationBaseReward * damagedBossHp / bossMaxHp)
                );
                p.points = (p.points || 0) + participationBonus;
                p.lastEarnedPoints = participationBonus;
                p.lastPointBreakdown = {
                    clearBonus: 0,
                    contributionBonus: 0,
                    mvpBonus: 0,
                    participationBonus,
                    damageRatioPercent: Math.round(damagedBossHp / bossMaxHp * 100),
                    totalEarned: participationBonus
                };
                rewardsByPlayer[id] = p.lastPointBreakdown;
                const prof = getOrCreateProfile(p.clientKey);
                prof.points = p.points;
                saveSessionRecord(room, p);
                const sock = io.sockets.sockets.get(id);
                if (sock) emitProfileToClient(sock, prof);
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
                participationBaseReward,
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
            resetPlayerCombatStatuses(p);
            const prof = getOrCreateProfile(p.clientKey);
            const dailyFirstWinBonus = id === winnerId ? claimDailyFirstWinBonus(prof) : 0;
            const earned = (id === winnerId) ? REWARD_PVP_WIN + dailyFirstWinBonus : 0;
            if (id === winnerId) {
                p.wins = (p.wins || 0) + 1;
                p.points = (p.points || 0) + earned;
            }
            p.lastEarnedPoints = earned;
            p.lastPointBreakdown = { winBonus: id === winnerId ? REWARD_PVP_WIN : 0, dailyFirstWinBonus, totalEarned: earned };
            rewardsByPlayer[id] = p.lastPointBreakdown;

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
            dailyFirstWinBonus: winnerId
                ? (rewardsByPlayer[winnerId] ? rewardsByPlayer[winnerId].dailyFirstWinBonus : 0)
                : 0,
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
    clearRoomTimeStopIfOwner(roomId, socket.id);
    resetPlayerCombatStatuses(leavingPlayer);
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
        const minReq = room.mode === 'boss' || room.mode === 'training' ? 1 : 2;
        if (remainingIds.length < minReq) {
            room.matchId = (room.matchId || 0) + 1;
            stopGimmickLoop(roomId);
            room.state = 'waiting';
            for (const id of remainingIds) {
                resetPlayerCombatStatuses(room.players[id]);
                room.players[id].isReady = false;
            }
            emitRoomStateSync(roomId);
        }
    } else {
        emitRoomStateSync(roomId);
    }
}

// =========================================================================
// サーバー側 斬撃（X）当たり判定＆跳弾銃ウェーブ生成
// =========================================================================
function executeServerSlash(roomId, attacker, ox, oy, facing, isPowered) {
    const room = rooms[roomId];
    if (!room || room.state !== 'playing') return;

    const now = Date.now();
    const matchId = room.matchId;
    const slashCfg = GAME_RULES.ACTIONS.slash;
    const isDemonBlade = now < (attacker.bladeBuffUntil || 0);
    const bladeDef = isDemonBlade ? getUltraSkillDef('demon_blade') : null;
    const rangeMult = isDemonBlade ? ((bladeDef && bladeDef.slashRangeMultiplier) || 1.5) : 1.0;
    const dmgMult = isDemonBlade
        ? ((bladeDef && bladeDef.slashDamageMultiplier) || 2.0) * getPlayerUltraDamageMultiplier(attacker, 'demon_blade', room.mode)
        : 1.0;

    const vec = facingToVector(facing);
    const facingAngle = Math.atan2(vec.dy, vec.dx);
    const range = (slashCfg.range || 78) * rangeMult;
    const slashHalfAngleRad = 1.05;
    const atkMult = getPlayerEffectiveAttackMultiplier(attacker, now, room.mode);

    // 斬撃モーション描画イベントをルーム全員へ配信
    io.to(roomId).emit('slashMotionEvent', {
        attackerId: attacker.id,
        x: ox,
        y: oy,
        facing,
        element: attacker.element,
        mainColor: attacker.stats.mainColor,
        isPowered,
        isDemonBlade,
        rangeScale: rangeMult,
        hasSpecialInk: Boolean(attacker.hasSpecialInk),
        specialInkType: attacker.dominantSpecialInk || null,
        durationMs: 220
    });

    // 壊せる壁へのダメージ（扇形判定）
    let wallsChanged = false;
    for (let i = room.walls.length - 1; i >= 0; i--) {
        const w = room.walls[i];
        const wx = w.x + w.w / 2;
        const wy = w.y + w.h / 2;
        if (isPointInSlashSector(wx, wy, ox, oy, facingAngle, range, slashHalfAngleRad, 22)) {
            w.hp -= isDemonBlade ? 40 : 20;
            wallsChanged = true;
            if (w.hp <= 0) {
                room.walls.splice(i, 1);
            }
        }
    }
    if (wallsChanged) {
        io.to(roomId).emit('gimmicksUpdated', { walls: room.walls, items: room.items });
    }

    if ((room.mode === 'boss' || room.mode === 'training') && room.boss && room.boss.hp > 0) {
        if (isPointInSlashSector(room.boss.x, room.boss.y, ox, oy, facingAngle, range, slashHalfAngleRad, room.boss.radius)) {
            const rawDmg = attacker.stats.atk * slashCfg.bossMultiplier * atkMult * dmgMult;
            applyDamageToBossInternal(roomId, attacker, rawDmg, 'melee', 'melee');
        }
        if (Array.isArray(room.boss.clones)) {
            for (const clone of room.boss.clones) {
                if (!clone || clone.hp <= 0) continue;
                if (isPointInSlashSector(clone.x, clone.y, ox, oy, facingAngle, range, slashHalfAngleRad, clone.radius)) {
                    const rawDmg = attacker.stats.atk * slashCfg.bossMultiplier * atkMult * dmgMult;
                    applyDamageToBossInternal(roomId, attacker, rawDmg, 'melee', 'melee', clone.id);
                }
            }
        }
    } else if (room.mode === 'pvp') {
        for (const id in room.players) {
            if (id === attacker.id) continue;
            const target = room.players[id];
            if (!target || target.isDead || target.isEliminated) continue;
            const tc = playerCenter(target);
            if (isPointInSlashSector(tc.x, tc.y, ox, oy, facingAngle, range, slashHalfAngleRad, 22)) {
                const rawDmg = attacker.stats.atk * slashCfg.pvpMultiplier * atkMult * dmgMult;
                applyDamageToPlayerInternal(roomId, target, attacker, rawDmg, facing, 'melee', matchId, attacker.element);
            }
        }
    }
}

function fireRicochetWave(roomId, matchId, shooterId, waveIndex) {
    const room = rooms[roomId];
    if (!room || room.state !== 'playing' || room.matchId !== matchId) return false;
    const shooter = room.players[shooterId];
    if (!shooter || shooter.isDead || shooter.isEliminated) return false;

    const skill = getUltraSkillDef('ricochet_guns');
    if (!skill) return false;
    if (!Array.isArray(room.ultraProjectiles)) room.ultraProjectiles = [];

    const pc = playerCenter(shooter);
    const dirs = skill.directions || 8;
    const spd = skill.bulletSpeed || 9.0;
    const fixedDmg = (skill.fixedDamage || 40) * getPlayerUltraDamageMultiplier(shooter, skill.id, room.mode);
    const maxBounces = skill.maxBounces ?? 1;
    const radius = skill.bulletRadius || 6;
    const emittedBullets = [];

    for (let d = 0; d < dirs; d++) {
        const ang = (Math.PI * 2 / dirs) * d;
        const vx = Math.cos(ang) * spd;
        const vy = Math.sin(ang) * spd;
        const id = `rg_${shooter.id}_${waveIndex}_${d}_${Date.now()}`;
        const bulletObj = {
            id,
            ownerId: shooter.id,
            element: shooter.element,
            x: pc.x,
            y: pc.y,
            vx,
            vy,
            fixedDamage: fixedDmg,
            bouncesLeft: maxBounces,
            radius,
            life: 110
        };
        room.ultraProjectiles.push(bulletObj);
        emittedBullets.push({ id, x: pc.x, y: pc.y, vx, vy, element: shooter.element });
    }

    io.to(roomId).emit('ultraSkillEvent', {
        playerId: shooter.id,
        skillId: 'ricochet_guns',
        phase: 'wave',
        waveIndex,
        x: pc.x,
        y: pc.y,
        bullets: emittedBullets,
        element: shooter.element
    });
    return true;
}

// =========================================================================
// Socket.IO イベントハンドラ
// =========================================================================
io.on('connection', (socket) => {
    console.log(`クライアントが接続しました: ${socket.id}`);
    let currentRoom = null;
        let lastPingAt = 0;

    socket.on('latencyPing', (cb) => {
        const now = Date.now();
        if (now - lastPingAt < 1000) return;
        lastPingAt = now;
        if (typeof cb === 'function') cb();
    });

    // クライアントプロファイル初期化・同期
    socket.on('syncProfile', (payload) => {
        const clientKey = sanitizeClientKey(payload && payload.clientKey, socket.id);
        socket.data.clientKey = clientKey;
        const prof = getOrCreateProfile(clientKey, payload);
        emitProfileToClient(socket, prof);
    });

    function canEditProgression() {
        const room = currentRoom ? rooms[currentRoom] : null;
        return !room || (room.state !== 'playing' && room.state !== 'countdown');
    }

    function syncWaitingPlayerProgression(profile) {
        const room = currentRoom ? rooms[currentRoom] : null;
        const player = room && room.players[socket.id];
        if (!room || room.state !== 'waiting' || !player) return;
        syncPlayerProgression(room, player, profile);
        player.hp = player.maxHp;
        player.points = profile.points;
        emitRoomStateSync(currentRoom);
    }

    socket.on('buyTalent', (payload) => {
        const clientKey = sanitizeClientKey((payload && payload.clientKey) || socket.data.clientKey, socket.id);
        socket.data.clientKey = clientKey;
        const prof = getOrCreateProfile(clientKey, payload);
        const tree = payload && payload.tree;
        if (!TALENT_TREES.includes(tree)) {
            socket.emit('progressionError', { message: '指定されたタレント項目が正しくありません' });
            return;
        }
        if (!canEditProgression()) {
            socket.emit('progressionError', { message: 'タレント強化は試合終了後に行ってください' });
            return;
        }
        const currentLevel = prof.talents[tree];
        if (currentLevel >= PROGRESSION_RULES.TALENT_MAX_LEVEL) {
            socket.emit('progressionError', { message: 'このタレントは最大レベルです' });
            return;
        }
        const cost = PROGRESSION_RULES.TALENT_COST_PER_LEVEL * (currentLevel + 1);
        if (prof.points < cost) {
            socket.emit('progressionError', { message: `ポイントが不足しています（必要: ${cost}Pt）` });
            return;
        }
        prof.points -= cost;
        prof.talents[tree] = currentLevel + 1;
        syncWaitingPlayerProgression(prof);
        emitProfileToClient(socket, prof);
        socket.emit('progressionActionResult', {
            message: `${({ durability: '耐久', attack: '攻撃', mobility: '機動', reward: '報酬' })[tree]}タレントがLv.${prof.talents[tree]}になりました`,
            profile: serializeProfile(prof)
        });
    });

    socket.on('drawPassiveGear', (payload) => {
        const clientKey = sanitizeClientKey((payload && payload.clientKey) || socket.data.clientKey, socket.id);
        socket.data.clientKey = clientKey;
        const prof = getOrCreateProfile(clientKey, payload);
        if (!canEditProgression()) {
            socket.emit('progressionError', { message: 'パッシブガチャは試合終了後に行ってください' });
            return;
        }
        if (prof.points < PASSIVE_GACHA_COST) {
            socket.emit('progressionError', { message: `ポイントが不足しています（必要: ${PASSIVE_GACHA_COST}Pt）` });
            return;
        }
        prof.points -= PASSIVE_GACHA_COST;
        const type = PASSIVE_GEAR_TYPES[Math.floor(Math.random() * PASSIVE_GEAR_TYPES.length)];
        const result = addPassiveGear(prof, type);
        syncWaitingPlayerProgression(prof);
        emitProfileToClient(socket, prof);
        socket.emit('passiveGachaResult', {
            type,
            rank: result.rank,
            merges: result.merges,
            cost: PASSIVE_GACHA_COST,
            profile: serializeProfile(prof)
        });
    });

    socket.on('equipPassiveGear', (payload) => {
        const clientKey = sanitizeClientKey((payload && payload.clientKey) || socket.data.clientKey, socket.id);
        socket.data.clientKey = clientKey;
        const prof = getOrCreateProfile(clientKey, payload);
        const type = payload && payload.type;
        const rank = Math.floor(Number(payload && payload.rank) || 0);
        if (!PASSIVE_GEAR_TYPES.includes(type) || rank < 1 || rank > PASSIVE_MAX_RANK ||
            prof.passiveInventory[type][rank] <= 0) {
            socket.emit('progressionError', { message: '装備できるパッシブが見つかりません' });
            return;
        }
        if (!canEditProgression()) {
            socket.emit('progressionError', { message: '装備変更は試合終了後に行ってください' });
            return;
        }
        prof.passiveGearSlots[type] = rank;
        syncWaitingPlayerProgression(prof);
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

    // ウルトラガチャ（1000Pt / 全8種・S4種各10%・A4種各15% / 上限×3超過時300Pt還元）
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

        const weightedPool = ULTRA_SKILL_ORDER.map((id) => ({
            id,
            weight: (ULTRA_SKILLS[id] && ULTRA_SKILLS[id].gachaWeight) || 10
        }));
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
        const prevAwakeningPoints = prof.ultraAwakeningPoints[drawnSkillId] || 0;
        let newStock = prevStock;
        let isMaxDuplicate = false;
        let refundPt = 0;
        let awakeningPointsGained = 0;

        if (prevStock > 0 && prevAwakeningPoints < PROGRESSION_RULES.ULTRA_RANK_3_POINTS) {
            prof.ultraAwakeningPoints[drawnSkillId] = Math.min(
                PROGRESSION_RULES.ULTRA_RANK_3_POINTS,
                prevAwakeningPoints + PROGRESSION_RULES.ULTRA_AWAKENING_POINTS_PER_DUPLICATE
            );
            awakeningPointsGained = 1;
        }
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
                syncPlayerProgression(rooms[currentRoom], p, prof);
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
            awakeningPointsGained,
            awakeningPoints: prof.ultraAwakeningPoints[drawnSkillId],
            awakeningRank: getProfileUltraAwakeningRank(prof, drawnSkillId),
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

    // ルーム入室（試合中の途中参戦にも対応）
    socket.on('joinRoom', (payload) => {
        const roomId = sanitizeRoomId(payload && payload.roomId);
        if (!roomId) return;

        const occupied = rooms[roomId]
            ? Object.keys(rooms[roomId].players).filter((id) => id !== socket.id).length
            : 0;
        const trainingLimit = rooms[roomId] && rooms[roomId].mode === 'training' ? 1 : MAX_PLAYERS_PER_ROOM;
        if (occupied >= trainingLimit) {
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
                mode: payload && ['boss', 'training'].includes(payload.mode) ? payload.mode : 'pvp',
                stageNumber: stage.stageNumber,
                stageId: stage.stageId,
                bossId: stage.bossId,
                hostId: socket.id,
                lastMatchCleared: false,
                matchId: 0,
                players: {},
                sessionRecords: Object.create(null),
                walls: [],
                items: [],
                boss: null,
                bossProjectiles: [],
                bossMagmaZones: [],
                playerMagmaZones: [],
                ultraProjectiles: [],
                timeStopUntil: 0,
                timeStopOwnerId: null,
                timeStopTimer: null,
                bossRoarPullUntil: 0,
                bossRoarPullStrength: 0,
                lastBossAttackAt: {},
                countdownTimer: null,
                wallTimer: null,
                itemTimer: null,
                combatTickTimer: null,
                bossMoveTimer: null,
                bossProjectileTimer: null,
                bossAttackTimer: null,
                bossPendingTimeouts: [],
                trainingStats: { startAt: 0, totalDamage: 0, maxHit: 0, elapsedMs: 0 }
            };
        }

        const room = rooms[roomId];
        const cleanStats = sanitizeStats(payload && payload.stats);
        const gridData = sanitizeGrid(payload && payload.gridData, prof.unlockedInks);
        const element = gridData
            ? determineElementFromPixels(gridData)
            : sanitizeElementId(payload && payload.element);
        const inkMeta = analyzeSpecialInkFromGrid(gridData);

        const equippedSkill = sanitizeUltraSkillId(prof.equippedUltra);
        const ultraStockCount = equippedSkill ? (prof.ultraStocks[equippedSkill] || 0) : 0;
        const progression = getProgressionSnapshot(prof);
        const hpBonus = room.mode === 'boss'
            ? progression.talents.durability * PROGRESSION_RULES.TALENT_PER_LEVEL.durability
            : 0;
        const effectiveMaxHp = Math.max(1, Math.round(cleanStats.maxHp * (1 + hpBonus)));

        const isMidGameJoin = (room.state === 'playing' || room.state === 'countdown');
        const isResultJoin = (room.state === 'result');
        const spawnPos = isMidGameJoin ? findSafePosition(room, CHAR_SIZE) : { x: ARENA_CENTER_X - 24, y: ARENA_CENTER_Y - 24 };

        room.players[socket.id] = {
            id: socket.id,
            clientKey,
            name: sanitizeName(payload && payload.name),
            rank: sanitizeRank(payload && payload.rank),
            title: payload && typeof payload.title === 'string' ? payload.title.slice(0, 16) : '',
            element,
            hasSpecialInk: inkMeta.hasSpecialInk,
            dominantSpecialInk: inkMeta.dominantSpecialInk,
            x: spawnPos.x,
            y: spawnPos.y,
            facing: 'right',
            characterData: gridData,
            stats: cleanStats,
            progression,
            hp: effectiveMaxHp,
            maxHp: effectiveMaxHp,
            stocks: INITIAL_STOCKS,
            isDead: isResultJoin,
            isEliminated: isResultJoin,
            shieldUntil: 0,
            absoluteWallUntil: 0,
            counterStanceUntil: 0,
            bladeBuffUntil: 0,
            bootsBuffUntil: 0,
            gunBuffUntil: 0,
            speedBoostUntil: 0,
            powerBoostUntil: 0,
            slowUntil: 0,
            slowStartedAt: 0,
            slowMultiplier: 1.0,
            attackDebuffUntil: 0,
            attackDebuffMultiplier: 1.0,
            dotUntil: 0,
            dotDamage: 0,
            dotIntervalMs: 600,
            nextDotAt: 0,
            ultraSkillId: room.mode === 'training' ? ULTRA_SKILL_ORDER[0] : (ultraStockCount > 0 ? equippedSkill : null),
            ultraRemainingUses: room.mode === 'training' ? GAME_RULES.GACHA.ULTRA_MAX_STOCK : ultraStockCount,
            ultraMaxUses: room.mode === 'training' ? GAME_RULES.GACHA.ULTRA_MAX_STOCK : ultraStockCount,
            ultraCooldownUntil: 0,
            ultraCooldownDurationMs: 0,
            ultraState: null,
            ultraStateUntil: 0,
            ultraTimers: [],
            ultraIntervals: [],
            bossDamageDealt: 0,
            bossCoreDamageDealt: 0,
            emergencyEscapeUsed: false,
            lastEarnedPoints: 0,
            lastPointBreakdown: null,
            isReady: false,
            wins: prof.wins,
            points: prof.points,
            ...createPlayerGuards()
        };

        if (isMidGameJoin || isResultJoin) {
            if (isMidGameJoin && room.mode === 'boss' && room.boss && room.boss.hp > 0) {
                const def = getBossDef(room.boss.id);
                const totalCount = Math.min(MAX_PLAYERS_PER_ROOM, Math.max(1, Object.keys(room.players).length));
                const targetMaxHp = (def.hpByPlayers && def.hpByPlayers[totalCount]) || def.maxHp;
                if (targetMaxHp > room.boss.maxHp) {
                    const hpRatio = room.boss.hp / room.boss.maxHp;
                    room.boss.maxHp = targetMaxHp;
                    room.boss.hp = Math.max(1, Math.round(targetMaxHp * hpRatio));
                    room.boss.initialPlayerCount = totalCount;
                }
            }

            socket.emit('roomStateSync', buildRoomStatePayload(room));
            const serializedAll = serializeRoomPlayers(room);
            socket.to(roomId).emit('playerJoined', {
                player: serializedAll[socket.id],
                boss: room.boss
            });
        } else {
            emitRoomStateSync(roomId);
        }
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
        room.mode = nextMode === 'boss' ? 'boss' : (nextMode === 'training' ? 'training' : 'pvp');
        if (room.mode !== 'training') {
            for (const id in room.players) {
                syncPlayerEquippedUltraFromProfile(room.players[id]);
                room.players[id].ultraCooldownUntil = 0;
            }
        }

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
            resetPlayerCombatStatuses(room.players[id]);
            room.players[id].isReady = false;
        }
        emitRoomStateSync(currentRoom);
    });

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
            resetPlayerCombatStatuses(room.players[id]);
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

    socket.on('retryStage', () => {
        if (!currentRoom || !rooms[currentRoom]) return;
        const room = rooms[currentRoom];
        if (room.state !== 'result') return;

        const playerIds = Object.keys(room.players);
        const minReq = room.mode === 'boss' || room.mode === 'training' ? 1 : 2;
        if (playerIds.length < minReq) return;

        beginMatchCountdown(currentRoom);
    });

    socket.on('returnToLobby', () => {
        if (!currentRoom || !rooms[currentRoom]) return;
        const room = rooms[currentRoom];
        if (room.state !== 'result') {
            if (room.state !== 'waiting') {
                socket.emit('roomActionRejected', { message: '試合中はロビーに戻れません' });
            }
            return;
        }
        room.matchId = (room.matchId || 0) + 1;
        stopGimmickLoop(currentRoom);
        room.state = 'waiting';
        room.walls = [];
        room.items = [];
        room.boss = null;
        room.bossProjectiles = [];
        room.bossMagmaZones = [];
        room.playerMagmaZones = [];
        room.ultraProjectiles = [];
        room.timeStopUntil = 0;
        room.timeStopOwnerId = null;
        room.bossRoarPullUntil = 0;
        room.bossRoarPullStrength = 0;
        room.bossVortexPullUntil = 0; room.bossVortexPullStrength = 0;
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
            resetPlayerCombatStatuses(p);
            Object.assign(p, createPlayerGuards());
            p.isReady = false;
            p.isDead = false;
            p.isEliminated = false;
            p.stocks = INITIAL_STOCKS;
            p.ultraCooldownUntil = 0;
            p.ultraCooldownDurationMs = 0;
            syncPlayerEquippedUltraFromProfile(p);
            syncPlayerProgression(room, p, getOrCreateProfile(p.clientKey));
            p.hp = p.maxHp;
            p.bossDamageDealt = 0;
            p.bossCoreDamageDealt = 0;
            p.emergencyEscapeUsed = false;
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
            if (isTimeStoppedForActor(room, socket.id, now)) return;

            // 壁・障害物にめり込んだまま動けなくなる事故の救済
            if (overlapsPlayerBlocking(room, p.x, p.y, CHAR_SIZE)) {
                ejectPlayerFromObstacles(room, p);
                socket.emit('playerKnockback', { id: socket.id, x: p.x, y: p.y, facing: p.facing, source: 'unstuck' });
            }

            const maxX = ARENA_WIDTH - CHAR_SIZE;
            const maxY = ARENA_HEIGHT - CHAR_SIZE;
            let nx = Math.max(0, Math.min(maxX, Number(data.x) || 0));
            let ny = Math.max(ARENA_TOP, Math.min(maxY, Number(data.y) || ARENA_TOP));

            const dt = p.lastMoveAt ? Math.min(600, Math.max(0, now - p.lastMoveAt)) : 60;
            const boosted = now < (p.speedBoostUntil || 0) + 350;
            const hasBoots = now < (p.bootsBuffUntil || 0) + 350;
            const slowed = now < (p.slowUntil || 0) && now >= ((p.slowStartedAt || 0) + 300);
            const slowMult = slowed ? (p.slowMultiplier || 0.75) : 1.0;
            const bootsMult = hasBoots ? 1.5 : 1.0;
            const effSpd = p.stats.spd * getPlayerMobilityMultiplier(p, room.mode) *
                (boosted ? GAME_RULES.ITEMS.speed.speedMultiplier : 1) * slowMult * bootsMult;
            const perSec = effSpd * 60;

            // BOSS吸引中（vortex / roar_warn）のみ正当な追加引き寄せ速度分を加算
            let pullPerSec = 0;
            if (room.mode === 'boss' && room.boss && !isTimeStoppedWorld(room, now)) {
                const pcx = p.x + 24;
                const pcy = p.y + 24;
                const distToBoss = Math.hypot(pcx - room.boss.x, pcy - room.boss.y);
                if (room.bossGiantTornadoUntil && now <= room.bossGiantTornadoUntil && distToBoss <= (room.bossGiantTornadoRadius || 150)) {
                    pullPerSec = (room.bossGiantTornadoPullStrength || 2.65) * 60;
                } else if (room.boss.id === 'true_void_typhoon' && room.boss.vortexActive && distToBoss <= 260) {
                    pullPerSec = (room.boss.vortexPullStrength || 2.2) * 60;
                } else if (room.boss.id !== 'true_void_typhoon' && (room.boss.vortexActive || now <= (room.bossVortexPullUntil || 0) + 250)) {
                    const vPull = room.bossVortexPullStrength || (room.boss.phase === 2 ? 1.95 : 1.55);
                    pullPerSec = vPull * 60;
                } else if (now <= (room.bossRoarPullUntil || 0) + 250) {
                    pullPerSec = (room.bossRoarPullStrength || 1.15) * 60;
                }
            }

            const maxCap = (perSec + pullPerSec) * 0.6 * 1.2 + 12;
            const earned = (perSec + pullPerSec) * (dt / 1000) * 1.2;
            p.moveAllowancePx = Math.min(maxCap, (p.moveAllowancePx || 0) + earned);

            if (now > (p.externalDisplacementUntil || 0)) {
                p.externalDisplacementAllowancePx = 0;
            }
            const extAllowance = p.externalDisplacementAllowancePx || 0;
            const totalBudget = p.moveAllowancePx + extAllowance;

            const rawDist = Math.hypot(nx - p.x, ny - p.y);
            let clampedBySpeed = false;
            if (rawDist > totalBudget && rawDist > 0.001) {
                const ratio = totalBudget / rawDist;
                nx = p.x + (nx - p.x) * ratio;
                ny = p.y + (ny - p.y) * ratio;
                if (rawDist > totalBudget + 28) {
                    clampedBySpeed = true;
                }
            }

            const hitsStatic = overlapsStaticObstacle(nx, ny, CHAR_SIZE, 12);
            const hitsWall = overlapsBreakableWall(room, nx, ny, CHAR_SIZE, 6);
            if (hitsStatic || hitsWall) {
                // X方向のみ・Y方向のみのスライド移動を試行して引っかかりを軽減
                const canMoveX = !overlapsStaticObstacle(nx, p.y, CHAR_SIZE, 12) && !overlapsBreakableWall(room, nx, p.y, CHAR_SIZE, 6);
                const canMoveY = !overlapsStaticObstacle(p.x, ny, CHAR_SIZE, 12) && !overlapsBreakableWall(room, p.x, ny, CHAR_SIZE, 6);
                if (canMoveX) {
                    ny = p.y;
                } else if (canMoveY) {
                    nx = p.x;
                } else {
                    nx = p.x;
                    ny = p.y;
                }
            }

            const actualDist = Math.hypot(nx - p.x, ny - p.y);
            const usedExt = Math.min(actualDist, extAllowance);
            p.externalDisplacementAllowancePx = Math.max(0, extAllowance - usedExt);
            const usedMove = Math.max(0, actualDist - usedExt);
            p.moveAllowancePx = Math.max(0, p.moveAllowancePx - usedMove);

            const moveDx = nx - p.x;
            const moveDy = ny - p.y;
            if (actualDist > 0.2) {
                p.vx = moveDx;
                p.vy = moveDy;
                p.lastMoveVectorAt = now;
            }

            p.lastMoveAt = now;
            p.x = nx;
            p.y = ny;
            if (VALID_FACING.includes(data.facing)) {
                p.facing = data.facing;
            } else if (actualDist > 0.2) {
                p.facing = resolveFacingFromMovement(moveDx, moveDy) || p.facing;
            }

            if (clampedBySpeed) {
                socket.emit('playerKnockback', {
                    id: socket.id,
                    x: p.x,
                    y: p.y,
                    facing: p.facing,
                    source: 'speed_clamp'
                });
            }

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
        if (isTimeStoppedForActor(room, socket.id, Date.now())) return;
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
        if (isTimeStoppedForActor(room, socket.id, Date.now())) return;

        const p = room.players[socket.id];
        if (!p || p.isDead || p.isEliminated) return;

        const itemIndex = room.items.findIndex((it) => it.id === (data && data.itemId));
        if (itemIndex === -1) return;

        const item = room.items[itemIndex];
        const pc = playerCenter(p);
        if (Math.hypot(pc.x - item.x, pc.y - item.y) > 64) return;

        room.items.splice(itemIndex, 1);

        if (item.type === 'speed') {
            const duration = Math.round(GAME_RULES.ITEMS.speed.durationMs * getPassiveItemDurationMultiplier(p, room.mode));
            p.speedBoostUntil = Date.now() + duration;
            io.to(currentRoom).emit('itemEffectApplied', { id: socket.id, type: 'speed', duration });
        } else if (item.type === 'heal') {
            const healAmount = GAME_RULES.ITEMS.heal.healAmount;
            p.hp = Math.min(p.maxHp, p.hp + healAmount);
            io.to(currentRoom).emit('itemEffectApplied', { id: socket.id, type: 'heal', hp: p.hp, maxHp: p.maxHp, healAmount });
        } else if (item.type === 'power') {
            const duration = Math.round(GAME_RULES.ITEMS.power.durationMs * getPassiveItemDurationMultiplier(p, room.mode));
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
            const rawGrid = Array.isArray(payload) ? payload : payload.gridData;
            const ownerProfile = profiles[p.clientKey];
            const actualGrid = sanitizeGrid(rawGrid, ownerProfile ? ownerProfile.unlockedInks : []);
            if (actualGrid) p.characterData = actualGrid;
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
                syncPlayerProgression(room, p, getOrCreateProfile(p.clientKey));
                p.hp = p.maxHp;
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
        if (isTimeStoppedForActor(room, socket.id, Date.now())) return;

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

    // トレーニングモード：必殺技切替（ストックは常時満タン・CD0）
    socket.on('setTrainingUltra', (payload) => {
        if (!currentRoom || !rooms[currentRoom]) return;
        const room = rooms[currentRoom];
        if (room.mode !== 'training' || (room.state !== 'waiting' && room.state !== 'playing')) return;
        const p = room.players[socket.id];
        if (!p) return;
        const skillId = typeof payload === 'object' && payload ? sanitizeUltraSkillId(payload.skillId) : null;
        if (!skillId) return;
        p.ultraSkillId = skillId;
        p.ultraRemainingUses = GAME_RULES.GACHA.ULTRA_MAX_STOCK;
        p.ultraMaxUses = GAME_RULES.GACHA.ULTRA_MAX_STOCK;
        p.ultraCooldownUntil = 0;
        p.ultraState = null;
        p.ultraStateUntil = 0;
        io.to(currentRoom).emit('roomStateSync', buildRoomStatePayload(room));
    });

    socket.on('resetTrainingTarget', () => {
        if (!currentRoom || !rooms[currentRoom]) return;
        const room = rooms[currentRoom];
        if (room.mode !== 'training' || (room.state !== 'waiting' && room.state !== 'playing')) return;
        if (!room.boss) {
            room.boss = createBossInstance(room.bossId || 'void_typhoon', 1);
            room.boss.maxHp = 100000;
            room.boss.hp = 100000;
            room.boss.phase = 1;
            room.boss.isStealthed = false;
            room.boss.x = ARENA_CENTER_X;
            room.boss.y = 220;
        }
        room.boss.hp = room.boss.maxHp;
        room.boss.phase = 1;
        room.trainingStats = { startAt: Date.now(), totalDamage: 0, maxHit: 0, elapsedMs: 0 };
        io.to(currentRoom).emit('bossStateUpdated', room.boss);
        io.to(currentRoom).emit('trainingStatsUpdated', room.trainingStats);
    });

    // 通常攻撃（斬撃 X: CD 600ms / 玉 C: CD 450ms）
    socket.on('playerAttack', (attackData) => {
        if (!currentRoom || !rooms[currentRoom]) return;
        const room = rooms[currentRoom];
        if (room.state !== 'playing' || !attackData) return;
        if (isTimeStoppedForActor(room, socket.id, Date.now())) return;

        const p = room.players[socket.id];
        const hitType = sanitizeHitType(attackData.type);
        if (!p || p.isDead || p.isEliminated || !hitType) return;

        const now = Date.now();
        const baseRefillMs = hitType === 'melee'
            ? GAME_RULES.ACTIONS.slash.cooldownMs
            : getPlayerShotCooldownMs(p, room.mode);
        const atkSpeedMult = now < (p.bootsBuffUntil || 0) ? 1.5 : 1.0;
        const refillMs = Math.floor(baseRefillMs / atkSpeedMult);
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

    // 必殺技（Space）発動要求（全8種対応）
    socket.on('activateUltra', (payload) => {
        if (!currentRoom || !rooms[currentRoom]) return;
        const room = rooms[currentRoom];
        if (room.state !== 'playing') return;

        const now = Date.now();
        if (isTimeStoppedForActor(room, socket.id, now)) return;

        const p = room.players[socket.id];
        if (!p || p.isDead || p.isEliminated) return;

        const skillId = sanitizeUltraSkillId(p.ultraSkillId);
        const skill = getUltraSkillDef(skillId);
        if (!skill || p.ultraRemainingUses <= 0) return;

        // 溜め/構え/予兆/展開中の多重発動禁止
        if (p.ultraState !== null && now < p.ultraStateUntil) return;
        // 6000ms 再使用クールダウン中チェック
        if (now < p.ultraCooldownUntil) return;

        if (payload && VALID_FACING.includes(payload.facing)) {
            p.facing = payload.facing;
        }

        const activatedAt = now;
        const awakeningRank = getPlayerUltraAwakeningRank(p.progression, skill.id);
        const cooldownMs = room.mode === 'training'
            ? 0
            : Math.round((Number(skill.cooldownMs) || 6000) *
                (awakeningRank >= 2 ? PROGRESSION_RULES.ULTRA_RANK_2_COOLDOWN_MULTIPLIER : 1));
        const matchId = room.matchId;
        const roomId = currentRoom;
        p.ultraRemainingUses = room.mode === 'training'
            ? GAME_RULES.GACHA.ULTRA_MAX_STOCK
            : Math.max(0, p.ultraRemainingUses - 1);
        p.ultraCooldownUntil = activatedAt + cooldownMs;
        p.ultraCooldownDurationMs = cooldownMs;

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
                    if (shooter) clearPlayerUltraStateAndTimers(shooter);
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
                const atkMult = getPlayerEffectiveAttackMultiplier(shooter, Date.now(), cur.mode);
                const rawDamage = shooter.stats.atk * dmgMult * atkMult * getPlayerUltraDamageMultiplier(shooter, skill.id, cur.mode);

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

                if ((cur.mode === 'boss' || cur.mode === 'training') && cur.boss && cur.boss.hp > 0) {
                    if (!cur.boss.isStealthed && pointToSegmentDistance(cur.boss.x, cur.boss.y, x1, y1, x2, y2) <= halfWidth + cur.boss.radius) {
                        applyDamageToBossInternal(roomId, shooter, rawDamage, 'ultra_line', 'ultra');
                    }
                    for (const clone of cur.boss.clones || []) {
                        if (!clone || clone.hp <= 0) continue;
                        if (pointToSegmentDistance(clone.x, clone.y, x1, y1, x2, y2) <= halfWidth + (clone.radius || 0)) {
                            applyDamageToBossInternal(roomId, shooter, rawDamage, 'ultra_line', 'ultra', clone.id);
                        }
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
        } else if (skill.id === 'absolute_wall') {
            const durationMs = (Number(skill.durationMs) || 2600) *
                getPlayerUltraDamageMultiplier(p, skill.id, room.mode);
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
            // リメイク仕様：自分中心半径200px円内に5発落下＋4秒マグマ（1秒毎10ダメ）
            const warnMs = Number(skill.warnMs) || 650;
            const radius = Number(skill.radius) || 110;
            const ringOffset = Number(skill.ringOffset) || 90;
            const dmgMult = Number(skill.damageMultiplier) || 2.2;
            const meteorCount = Math.max(1, Number(skill.meteorCount) || 5);
            const magmaDurationMs = Number(skill.magmaDurationMs) || 4000;
            const magmaTickIntervalMs = Number(skill.magmaTickIntervalMs) || 1000;
            const magmaTickDamage = Number(skill.magmaTickDamage) || 10;

            const vec = facingToVector(facing);
            const baseAngle = Math.atan2(vec.dy, vec.dx);

            const meteors = [];
            for (let idx = 0; idx < meteorCount; idx++) {
                const angle = baseAngle + ((Math.PI * 2) / meteorCount) * idx;
                const rawX = pc.x + Math.cos(angle) * ringOffset;
                const rawY = pc.y + Math.sin(angle) * ringOffset;
                const clampedX = Math.max(radius, Math.min(ARENA_WIDTH - radius, rawX));
                const clampedY = Math.max(ARENA_TOP + radius, Math.min(ARENA_HEIGHT - radius, rawY));
                meteors.push({
                    index: idx,
                    x: clampedX,
                    y: clampedY,
                    radius
                });
            }

            p.ultraState = 'meteor_warn';
            p.ultraStateUntil = activatedAt + warnMs;

            io.to(roomId).emit('ultraSkillEvent', {
                playerId: p.id,
                skillId: skill.id,
                phase: 'warn',
                x: pc.x,
                y: pc.y,
                radius,
                castRadius: Number(skill.castRadius) || 200,
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
                    clearPlayerUltraStateAndTimers(caster);
                    return;
                }

                caster.ultraState = null;
                caster.ultraStateUntil = 0;

                const atkMult = getPlayerEffectiveAttackMultiplier(caster, Date.now(), cur.mode);
                const rawDamage = caster.stats.atk * dmgMult * atkMult * getPlayerUltraDamageMultiplier(caster, skill.id, cur.mode);

                // 各隕石（130px以内）の壊せる壁を破壊
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

                // 各半径110px円ごとに独立ヒット（複数ヒット可）・ヒット数集計
                const impacts = [];
                let totalHits = 0;

                for (const m of meteors) {
                    let hitCount = 0;
                    if (cur.mode === 'boss' || cur.mode === 'training') {
                        if (cur.boss && cur.boss.hp > 0 && cur.state === 'playing') {
                            if (!cur.boss.isStealthed && Math.hypot(cur.boss.x - m.x, cur.boss.y - m.y) <= radius + cur.boss.radius) {
                                if (applyDamageToBossInternal(roomId, caster, rawDamage, 'ultra_meteor', 'ultra')) {
                                    hitCount++;
                                }
                            }
                            for (const clone of cur.boss.clones || []) {
                                if (!clone || clone.hp <= 0) continue;
                                if (Math.hypot(clone.x - m.x, clone.y - m.y) <= radius + (clone.radius || 0)) {
                                    if (applyDamageToBossInternal(roomId, caster, rawDamage, 'ultra_meteor', 'ultra', clone.id)) {
                                        hitCount++;
                                    }
                                }
                            }
                        }
                    } else if (cur.mode === 'pvp' && cur.state === 'playing') {
                        for (const tid in cur.players) {
                            if (tid === caster.id) continue;
                            const target = cur.players[tid];
                            if (!target || target.isDead || target.isEliminated) continue;
                            const tc = playerCenter(target);
                            const dist = Math.hypot(tc.x - m.x, tc.y - m.y);
                            if (dist <= radius + 20) {
                                const knockDir = Math.abs(tc.x - m.x) >= Math.abs(tc.y - m.y)
                                    ? (tc.x >= m.x ? 'right' : 'left')
                                    : (tc.y >= m.y ? 'down' : 'up');
                                const hitApplied = applyDamageToPlayerInternal(
                                    roomId,
                                    target,
                                    caster,
                                    rawDamage,
                                    knockDir,
                                    'ultra_meteor',
                                    matchId,
                                    caster.element,
                                    { skipInvincible: true }
                                );
                                if (hitApplied) {
                                    hitCount++;
                                    if (!target.isDead && !target.isEliminated) {
                                        const kbAng = dist > 0.1 ? Math.atan2(tc.y - m.y, tc.x - m.x) : baseAngle;
                                        pushPlayerSafely(target, kbAng, 48, cur);
                                        grantExternalDisplacement(target, 72, 550);
                                        io.to(roomId).emit('playerKnockback', {
                                            id: target.id,
                                            x: target.x,
                                            y: target.y,
                                            facing: target.facing,
                                            source: 'sky_meteor'
                                        });
                                        io.to(roomId).emit('playerMoved', {
                                            id: target.id,
                                            x: target.x,
                                            y: target.y,
                                            facing: target.facing
                                        });
                                    }
                                }
                            }
                        }
                    }
                    totalHits += hitCount;
                    impacts.push({ index: m.index, x: m.x, y: m.y, radius: m.radius, hitCount });
                }

                // 4秒間（1秒毎10ダメ×4回）マグマ床をサーバーに登録
                const magmaNow = Date.now();
                const initialCooldownMap = { BOSS: magmaNow };
                for (const pid in cur.players) {
                    initialCooldownMap[pid] = magmaNow;
                }
                if (!Array.isArray(cur.playerMagmaZones)) cur.playerMagmaZones = [];
                cur.playerMagmaZones.push({
                    id: `pmz_${caster.id}_${magmaNow}`,
                    ownerId: caster.id,
                    element: caster.element,
                    zones: meteors,
                    radius,
                    expiresAt: magmaNow + magmaDurationMs,
                    tickIntervalMs: magmaTickIntervalMs,
                    tickDamage: magmaTickDamage,
                    lastHitAtByTarget: initialCooldownMap
                });

                io.to(roomId).emit('ultraSkillEvent', {
                    playerId: caster.id,
                    skillId: skill.id,
                    phase: 'impact',
                    x: pc.x,
                    y: pc.y,
                    radius,
                    meteors,
                    impacts,
                    totalHits,
                    magmaDurationMs,
                    facing,
                    element: caster.element,
                    durationMs: Number(skill.durationMs) || 320
                });
            }, warnMs);
        } else if (skill.id === 'demon_blade') {
            const durationMs = Number(skill.durationMs) || 5000;
            p.ultraState = 'blade_active';
            p.ultraStateUntil = activatedAt + durationMs;
            p.bladeBuffUntil = activatedAt + durationMs;

            io.to(roomId).emit('ultraSkillEvent', {
                playerId: p.id,
                skillId: skill.id,
                phase: 'active',
                durationMs,
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
                holder.ultraState = null;
                holder.ultraStateUntil = 0;
                holder.bladeBuffUntil = 0;
                io.to(roomId).emit('ultraSkillEvent', {
                    playerId: holder.id,
                    skillId: skill.id,
                    phase: 'end'
                });
            }, durationMs);
            } else if (skill.id === 'phantom_boots') {
            const durationMs = Number(skill.durationMs) || 5000;
            const healIntervalMs = Number(skill.healTickIntervalMs) || 1000;
            const healAmount = (Number(skill.healTickAmount) || 10) *
                getPlayerUltraDamageMultiplier(p, skill.id, room.mode);
            const healTicks = Math.max(1, Math.floor(durationMs / healIntervalMs));

            p.ultraState = 'boots_active';
            p.ultraStateUntil = activatedAt + durationMs;
            p.bootsBuffUntil = activatedAt + durationMs;

            io.to(roomId).emit('ultraSkillEvent', {
                playerId: p.id,
                skillId: skill.id,
                phase: 'active',
                durationMs,
                element: p.element,
                remainingUses: p.ultraRemainingUses,
                maxUses: p.ultraMaxUses,
                cooldownMs,
                cooldownUntil: p.ultraCooldownUntil
            });

            const applyBootsHealTick = () => {
                const cur = rooms[roomId];
                if (!cur || cur.state !== 'playing' || cur.matchId !== matchId) return;
                const holder = cur.players[p.id];
                if (!holder || holder.isDead || holder.isEliminated) return;
                holder.hp = Math.min(holder.maxHp, holder.hp + healAmount);
                io.to(roomId).emit('ultraSkillEvent', {
                    playerId: holder.id,
                    skillId: skill.id,
                    phase: 'heal_tick',
                    hp: holder.hp,
                    maxHp: holder.maxHp,
                    healAmount
                });
            };

            for (let t = 1; t < healTicks; t++) {
                registerPlayerUltraTimeout(room, p, applyBootsHealTick, t * healIntervalMs);
            }

            registerPlayerUltraTimeout(room, p, () => {
                const cur = rooms[roomId];
                if (!cur || cur.state !== 'playing' || cur.matchId !== matchId) return;
                const holder = cur.players[p.id];
                if (!holder) return;
                applyBootsHealTick();
                holder.ultraState = null;
                holder.ultraStateUntil = 0;
                holder.bootsBuffUntil = 0;
                io.to(roomId).emit('ultraSkillEvent', {
                    playerId: holder.id,
                    skillId: skill.id,
                    phase: 'end'
                });
            }, durationMs);
        } else if (skill.id === 'ricochet_guns') {
            const durationMs = Number(skill.durationMs) || 5000;
            const intervalMs = Number(skill.intervalMs) || 625;
            const maxWaves = Number(skill.maxWaves) || 8;
            p.ultraState = 'guns_active';
            p.ultraStateUntil = activatedAt + durationMs;
            p.gunBuffUntil = activatedAt + durationMs;

            io.to(roomId).emit('ultraSkillEvent', {
                playerId: p.id,
                skillId: skill.id,
                phase: 'active',
                durationMs,
                element: p.element,
                remainingUses: p.ultraRemainingUses,
                maxUses: p.ultraMaxUses,
                cooldownMs,
                cooldownUntil: p.ultraCooldownUntil
            });

            // ウェーブ0を即時発射
            let waveCount = 1;
            fireRicochetWave(roomId, matchId, p.id, 0);

            let gunInt = null;
            gunInt = registerPlayerUltraInterval(room, p, () => {
                const cur = rooms[roomId];
                if (!cur || cur.state !== 'playing' || cur.matchId !== matchId) {
                    clearInterval(gunInt);
                    return;
                }
                const holder = cur.players[p.id];
                if (!holder || holder.isDead || holder.isEliminated || waveCount >= maxWaves) {
                    clearInterval(gunInt);
                    return;
                }
                if (isTimeStoppedForActor(cur, holder.id, Date.now())) return;
                fireRicochetWave(roomId, matchId, p.id, waveCount);
                waveCount++;
                if (waveCount >= maxWaves) {
                    clearInterval(gunInt);
                }
            }, intervalMs);

            registerPlayerUltraTimeout(room, p, () => {
                clearInterval(gunInt);
                const cur = rooms[roomId];
                if (!cur || cur.state !== 'playing' || cur.matchId !== matchId) return;
                const holder = cur.players[p.id];
                if (!holder) return;
                holder.ultraState = null;
                holder.ultraStateUntil = 0;
                holder.gunBuffUntil = 0;
                io.to(roomId).emit('ultraSkillEvent', {
                    playerId: holder.id,
                    skillId: skill.id,
                    phase: 'end'
                });
            }, durationMs);
        } else if (skill.id === 'time_stop') {
            const durationMs = (Number(skill.durationMs) || 2500) *
                getPlayerUltraDamageMultiplier(p, skill.id, room.mode);
            p.ultraState = 'time_stop_active';
            p.ultraStateUntil = activatedAt + durationMs;

            room.timeStopOwnerId = p.id;
            room.timeStopUntil = activatedAt + durationMs;

            // 既存のボスのスケールオーラ等のエポックも停止時間分延長
            if (room.boss && room.boss.scaleAuraActive && room.boss.scaleAuraUntil > activatedAt) {
                room.boss.scaleAuraUntil += durationMs;
                io.to(roomId).emit('bossStateUpdated', room.boss);
            }
            if (room.bossRoarPullUntil > activatedAt) {
                room.bossRoarPullUntil += durationMs;
            }
            if (room.bossVortexPullUntil > activatedAt) {
                room.bossVortexPullUntil += durationMs;
            }

            io.to(roomId).emit('ultraSkillEvent', {
                playerId: p.id,
                skillId: skill.id,
                phase: 'active',
                durationMs,
                timeStopUntil: room.timeStopUntil,
                element: p.element,
                remainingUses: p.ultraRemainingUses,
                maxUses: p.ultraMaxUses,
                cooldownMs,
                cooldownUntil: p.ultraCooldownUntil
            });

            room.timeStopTimer = registerPlayerUltraTimeout(room, p, () => {
                const cur = rooms[roomId];
                if (!cur || cur.state !== 'playing' || cur.matchId !== matchId) return;
                const holder = cur.players[p.id];
                if (holder) {
                    holder.ultraState = null;
                    holder.ultraStateUntil = 0;
                }
                clearRoomTimeStopIfOwner(roomId, p.id);
            }, durationMs);
        }
    });

    // BOSSへのダメージ処理（遠距離弾ヒット用）
    socket.on('damageBoss', (hitData) => {
        if (!currentRoom || !rooms[currentRoom]) return;
        const room = rooms[currentRoom];
        if (room.state !== 'playing' || !['boss', 'training'].includes(room.mode) || !room.boss) return;

        const attacker = room.players[socket.id];
        if (!attacker || attacker.isDead || attacker.isEliminated) return;

        const hitType = sanitizeHitType(hitData && hitData.type);
        if (!hitType || hitType !== 'shot' || room.boss.hp <= 0) return;
        if (!useCredit(attacker, 'shot')) return;

        const atkMult = getPlayerEffectiveAttackMultiplier(attacker, Date.now(), room.mode);
        const rawDamage = attacker.stats.atk * atkMult;
        const targetCloneId = typeof hitData.cloneId === 'string' ? hitData.cloneId : null;
        applyDamageToBossInternal(currentRoom, attacker, rawDamage, 'shot', 'shot', targetCloneId);
    });

    // BOSSの弾・追尾ミサイルに当たったときの処理
    socket.on('bossProjectileHit', (data) => {
        if (!currentRoom || !rooms[currentRoom]) return;
        const room = rooms[currentRoom];
        if (room.state !== 'playing' || room.mode !== 'boss' || !room.boss) return;

        const now = Date.now();
        if (isTimeStoppedWorld(room, now)) return;

        const p = room.players[socket.id];
        if (!p || p.isDead || p.isEliminated) return;

        if (now < (p.invincibleUntil || 0)) return;
        if (now < (p.lastBossHitReportAt || 0) + 200) return;

        const def = getBossDef(room.boss.id);
        const kind = data && typeof data.kind === 'string' && def.attackProjectiles.includes(data.kind)
            ? data.kind
            : def.attackProjectiles[0];
        if (!kind) return;

        if (SERVER_AUTHORITATIVE_PROJECTILES.has(kind) || (data && data.curveRate)) return;

        const lastAt = room.lastBossAttackAt && room.lastBossAttackAt[kind];
        if (!lastAt || now - lastAt > 8500) return;

        p.lastBossHitReportAt = now;
        const dmg = def.projectileDamage[kind] || 12;
        applyBossDamageToPlayer(currentRoom, p, dmg, kind, room.matchId, room.boss.element);
    });

    // PvPモードでのプレイヤー間ダメージ（遠距離弾ヒット用）
    socket.on('applyDamage', (hitData) => {
        if (!currentRoom || !rooms[currentRoom]) return;
        const room = rooms[currentRoom];
        if (room.state !== 'playing' || room.mode === 'boss' || room.mode === 'training') return;

        const attacker = room.players[socket.id];
        const hitType = sanitizeHitType(hitData && hitData.type);
        const target = hitData ? room.players[hitData.targetId] : null;

        if (!attacker || !target || hitType !== 'shot' || attacker.id === target.id) return;
        if (attacker.isDead || attacker.isEliminated || target.isDead || target.isEliminated) return;
        if (!useCredit(attacker, 'shot')) return;

        const knockDir = VALID_FACING.includes(hitData.facing) ? hitData.facing : attacker.facing;
        const atkMult = getPlayerEffectiveAttackMultiplier(attacker, Date.now(), room.mode);
        const rawDamage = attacker.stats.atk * atkMult;

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

// 長時間オフラインのプロファイルを掃除（メモリ肥大化対策。クライアント側localStorageから復元可能）
const PROFILE_TTL_MS = 6 * 60 * 60 * 1000;
setInterval(() => {
    const now = Date.now();
    const onlineKeys = new Set();
    for (const [, s] of io.sockets.sockets) {
        if (s.data && s.data.clientKey) onlineKeys.add(s.data.clientKey);
    }
    for (const key of Object.keys(profiles)) {
        const prof = profiles[key];
        if (!onlineKeys.has(key) && now - (prof.lastSeenAt || 0) > PROFILE_TTL_MS) {
            delete profiles[key];
        }
    }
}, 30 * 60 * 1000).unref();

const PORT = process.env.PORT || 3002;
server.listen(PORT, () => {
    console.log(`完全版バトルサーバー起動中: http://localhost:${PORT}`);
});