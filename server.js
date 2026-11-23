'use strict';

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const BossSystem = require('./bosses.js');

const {
    GAME_RULES,
    STATIC_OBSTACLES,
    SPECIAL_INK_IDS,
    determineElementFromPixels,
    getElementMultiplier,
    sanitizeUltraSkillId,
    getUltraSkillDef,
    getStageByNumber,
    getNextStage,
    sanitizeBossId,
    getBossDef,
    createBossInstance
} = BossSystem;

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*' }
});

const PORT = Number(process.env.PORT) || 3000;
const TICK_INTERVAL_MS = 1000 / 60;
const ARENA_WIDTH = GAME_RULES.ARENA.WIDTH;
const ARENA_TOP = GAME_RULES.ARENA.TOP;
const ARENA_HEIGHT = GAME_RULES.ARENA.HEIGHT;
const ARENA_PLAY_CENTER_Y = GAME_RULES.ARENA.PLAY_CENTER_Y;
const PLAYER_SIZE = GAME_RULES.PLAYER.SIZE;
const BREAKABLE_WALL_SIZE = GAME_RULES.OBSTACLES.BREAKABLE_SIZE;
const BREAKABLE_WALL_HP = GAME_RULES.OBSTACLES.BREAKABLE_HP;

// サーバーティックで直接判定する特殊弾種（クライアント重複ヒットを防止）
const SERVER_AUTHORITATIVE_PROJECTILES = new Set([
    'snake_dark',
    'shadow_orb',
    'curved_fireball',
    'phantom_homing',
    'curse_bolt',
    'feint_orb'
]);

app.use(express.static(path.join(__dirname)));

// =========================================================================
// 1. 永続プロファイル（clientKey 単位の正本）
// =========================================================================
const profiles = new Map();

function createDefaultProfile(clientKey) {
    return {
        clientKey: String(clientKey),
        name: 'プレイヤー',
        points: 1000,
        unlockedStage: 1,
        ownedInks: [],
        equippedInk: '',
        ultraStocks: {
            end_of_days: 0,
            absolute_wall: 0,
            perfect_counter: 0,
            sky_meteor: 0,
            demon_blade: 0,
            ricochet_guns: 0,
            phantom_boots: 0,
            time_stop: 0
        },
        equippedUltra: null,
        selectedBossId: BossSystem.DEFAULT_BOSS_ID,
        pixels: null,
        element: 'neutral'
    };
}

function normalizeUltraStocks(rawStocks) {
    const out = {};
    for (const id of BossSystem.ULTRA_SKILL_ORDER) {
        const val = rawStocks && typeof rawStocks[id] === 'number' ? Math.floor(rawStocks[id]) : 0;
        out[id] = Math.max(0, Math.min(GAME_RULES.GACHA.ULTRA_MAX_STOCK, val));
    }
    return out;
}

function getOrCreateProfile(rawClientKey) {
    const key = (typeof rawClientKey === 'string' && rawClientKey.trim())
        ? rawClientKey.trim().slice(0, 128)
        : `guest_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    if (!profiles.has(key)) {
        profiles.set(key, createDefaultProfile(key));
    }
    const prof = profiles.get(key);
    prof.ultraStocks = normalizeUltraStocks(prof.ultraStocks);
    prof.unlockedStage = Math.max(1, Math.min(BossSystem.STAGES.length, Number(prof.unlockedStage) || 1));
    prof.points = Math.max(0, Math.floor(Number(prof.points) || 0));
    if (!Array.isArray(prof.ownedInks)) prof.ownedInks = [];
    if (prof.equippedUltra && !sanitizeUltraSkillId(prof.equippedUltra)) {
        prof.equippedUltra = null;
    }
    if (prof.equippedUltra && (prof.ultraStocks[prof.equippedUltra] || 0) <= 0) {
        prof.equippedUltra = null;
    }
    return prof;
}

function buildProfilePayload(prof) {
    return {
        clientKey: prof.clientKey,
        name: prof.name,
        points: prof.points,
        unlockedStage: prof.unlockedStage,
        ownedInks: [...prof.ownedInks],
        equippedInk: prof.equippedInk || '',
        ultraStocks: { ...prof.ultraStocks },
        equippedUltra: prof.equippedUltra || null,
        selectedBossId: sanitizeBossId(prof.selectedBossId)
    };
}

// =========================================================================
// 2. ルーム管理・タイマー・状態リセットヘルパー
// =========================================================================
const rooms = new Map();
let matchSeq = 1;

function registerTimeout(room, fn, delayMs) {
    if (!room) return null;
    if (!Array.isArray(room._timers)) room._timers = [];
    const safeDelay = Math.max(0, Number(delayMs) || 0);
    const id = setTimeout(() => {
        if (Array.isArray(room._timers)) {
            const idx = room._timers.indexOf(id);
            if (idx !== -1) room._timers.splice(idx, 1);
        }
        fn();
    }, safeDelay);
    room._timers.push(id);
    return id;
}

function registerInterval(room, fn, intervalMs) {
    if (!room) return null;
    if (!Array.isArray(room._intervals)) room._intervals = [];
    const safeInterval = Math.max(16, Number(intervalMs) || 100);
    const id = setInterval(fn, safeInterval);
    room._intervals.push(id);
    return id;
}

function clearRoomTimers(room) {
    if (!room) return;
    if (Array.isArray(room._timers)) {
        for (const t of room._timers) clearTimeout(t);
        room._timers = [];
    }
    if (Array.isArray(room._intervals)) {
        for (const iv of room._intervals) clearInterval(iv);
        room._intervals = [];
    }
}

function clearPlayerTimers(p) {
    if (!p) return;
    if (Array.isArray(p._timers)) {
        for (const t of p._timers) clearTimeout(t);
        p._timers = [];
    }
    if (Array.isArray(p._intervals)) {
        for (const iv of p._intervals) clearInterval(iv);
        p._intervals = [];
    }
}

function resetPlayerCombatStatuses(p, now) {
    if (!p) return;
    clearPlayerTimers(p);
    p.hp = p.maxHp || GAME_RULES.PLAYER.BASE_MAX_HP;
    p.isDead = false;
    p.isEliminated = false;
    p.respawnAt = 0;
    p.invincibleUntil = now + 1200;
    p.shieldUntil = 0;
    p.speedBoostUntil = 0;
    p.powerBoostUntil = 0;
    p.slowUntil = 0;
    p.slowMultiplier = 1;
    p.ultraActiveUntil = 0;
    p.ultraEndOfDaysUntil = 0;
    p.ultraAbsoluteWallUntil = 0;
    p.ultraCounterUntil = 0;
    p.ultraDemonBladeUntil = 0;
    p.ultraRicochetGunsUntil = 0;
    p.ultraPhantomBootsUntil = 0;
    p.attackCredits = { shot: 0, slash: 0 };
}

function addCredit(p, type) {
    if (!p) return;
    if (!p.attackCredits) p.attackCredits = { shot: 0, slash: 0 };
    p.attackCredits[type] = (p.attackCredits[type] || 0) + 1;
}

function useCredit(p, type) {
    if (!p || !p.attackCredits) return false;
    const cur = p.attackCredits[type] || 0;
    if (cur <= 0) return false;
    p.attackCredits[type] = cur - 1;
    return true;
}

function getOrCreateRoom(roomId, mode, bossId) {
    const id = String(roomId || 'default').trim().slice(0, 64) || 'default';
    let room = rooms.get(id);
    if (!room) {
        const safeMode = mode === 'boss' ? 'boss' : 'pvp';
        const safeBossId = sanitizeBossId(bossId);
        room = {
            id,
            mode: safeMode,
            bossId: safeBossId,
            state: 'lobby', // 'lobby' | 'countdown' | 'playing' | 'ended'
            matchId: 0,
            timeLeftSec: safeMode === 'boss' ? GAME_RULES.BOSS_TIME_LIMIT_SEC : GAME_RULES.PVP_TIME_LIMIT_SEC,
            players: Object.create(null),
            breakableWalls: [],
            items: [],
            boss: null,
            bossAttackCount: 0,
            lastBossAttackAt: Object.create(null),
            serverProjectiles: [],
            magmaZones: [],
            timeStopUntil: 0,
            timeStopOwnerId: null,
            _timers: [],
            _intervals: [],
            _lastTickAt: Date.now()
        };
        rooms.set(id, room);
    } else if (mode === 'boss' || mode === 'pvp') {
        if (room.state === 'lobby' || room.state === 'ended') {
            room.mode = mode;
        }
    }
    if (bossId && (room.state === 'lobby' || room.state === 'ended')) {
        room.bossId = sanitizeBossId(bossId);
    }
    return room;
}

function rectsOverlap(ax, ay, aw, ah, bx, by, bw, bh) {
    return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
}

function pointToSegmentDistance(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const lenSq = dx * dx + dy * dy;
    if (lenSq <= 1e-6) return Math.hypot(px - x1, py - y1);
    const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lenSq));
    const projX = x1 + t * dx;
    const projY = y1 + t * dy;
    return Math.hypot(px - projX, py - projY);
}

function resolvePlayerMoveSpeed(p, now, room) {
    let spd = GAME_RULES.PLAYER.BASE_SPEED;
    if (p.speedBoostUntil && now < p.speedBoostUntil) {
        spd *= GAME_RULES.ITEMS.speed.speedMultiplier;
    }
    if (p.ultraPhantomBootsUntil && now < p.ultraPhantomBootsUntil) {
        const bootDef = getUltraSkillDef('phantom_boots');
        spd *= (bootDef && bootDef.speedMultiplier) || 2.0;
    }
    if (p.slowUntil && now < p.slowUntil) {
        spd *= (p.slowMultiplier || 0.75);
    }
    if (room && room.boss && room.boss.vortexActive && room.mode === 'boss') {
        spd *= 0.92;
    }
    return spd;
}

function movePlayerWithCollisions(room, p, dx, dy, now) {
    const passWalls = Boolean(p.ultraPhantomBootsUntil && now < p.ultraPhantomBootsUntil);
    const speed = resolvePlayerMoveSpeed(p, now, room);
    const len = Math.hypot(dx, dy);
    const ndx = len > 0 ? dx / len : 0;
    const ndy = len > 0 ? dy / len : 0;
    p.vx = ndx * speed;
    p.vy = ndy * speed;

    if (ndx !== 0 || ndy !== 0) {
        if (Math.abs(ndx) >= Math.abs(ndy)) {
            p.facing = ndx > 0 ? 'right' : 'left';
        } else {
            p.facing = ndy > 0 ? 'down' : 'up';
        }
    }

    const stepX = p.vx;
    const stepY = p.vy;

    const tryMoveAxis = (mx, my) => {
        const nextX = Math.max(0, Math.min(ARENA_WIDTH - PLAYER_SIZE, p.x + mx));
        const nextY = Math.max(ARENA_TOP, Math.min(ARENA_HEIGHT - PLAYER_SIZE, p.y + my));

        if (!passWalls) {
            for (const obs of STATIC_OBSTACLES) {
                if (rectsOverlap(nextX, nextY, PLAYER_SIZE, PLAYER_SIZE, obs.x, obs.y, obs.w, obs.h)) {
                    return false;
                }
            }
            for (const w of room.breakableWalls) {
                if (w.hp <= 0) continue;
                if (rectsOverlap(nextX, nextY, PLAYER_SIZE, PLAYER_SIZE, w.x, w.y, BREAKABLE_WALL_SIZE, BREAKABLE_WALL_SIZE)) {
                    return false;
                }
            }
        }
        p.x = nextX;
        p.y = nextY;
        return true;
    };

    tryMoveAxis(stepX, 0);
    tryMoveAxis(0, stepY);
}

function snapPlayerOutOfWalls(room, p) {
    const candidates = [
        { x: p.x, y: p.y },
        { x: ARENA_WIDTH / 2 - PLAYER_SIZE / 2, y: ARENA_PLAY_CENTER_Y - PLAYER_SIZE / 2 },
        { x: 80, y: ARENA_TOP + 60 },
        { x: ARENA_WIDTH - 80 - PLAYER_SIZE, y: ARENA_TOP + 60 },
        { x: 80, y: ARENA_HEIGHT - 60 - PLAYER_SIZE },
        { x: ARENA_WIDTH - 80 - PLAYER_SIZE, y: ARENA_HEIGHT - 60 - PLAYER_SIZE }
    ];

    const isFree = (cx, cy) => {
        if (cx < 0 || cx + PLAYER_SIZE > ARENA_WIDTH || cy < ARENA_TOP || cy + PLAYER_SIZE > ARENA_HEIGHT) {
            return false;
        }
        for (const obs of STATIC_OBSTACLES) {
            if (rectsOverlap(cx, cy, PLAYER_SIZE, PLAYER_SIZE, obs.x, obs.y, obs.w, obs.h)) return false;
        }
        for (const w of room.breakableWalls) {
            if (w.hp > 0 && rectsOverlap(cx, cy, PLAYER_SIZE, PLAYER_SIZE, w.x, w.y, BREAKABLE_WALL_SIZE, BREAKABLE_WALL_SIZE)) {
                return false;
            }
        }
        return true;
    };

    for (const c of candidates) {
        const sx = Math.max(0, Math.min(ARENA_WIDTH - PLAYER_SIZE, c.x));
        const sy = Math.max(ARENA_TOP, Math.min(ARENA_HEIGHT - PLAYER_SIZE, c.y));
        if (isFree(sx, sy)) {
            p.x = sx;
            p.y = sy;
            return;
        }
    }
}

// =========================================================================
// 3. ダメージ適用・カウンター・KO・勝利判定
// =========================================================================
function triggerUltraCounter(roomId, defender, attacker, matchId) {
    const room = rooms.get(roomId);
    if (!room || room.state !== 'playing' || room.matchId !== matchId) return;
    const defSkill = getUltraSkillDef('perfect_counter');
    const radius = (defSkill && defSkill.counterRadius) || 210;
    const mult = (defSkill && defSkill.damageMultiplier) || 2.8;
    const baseDmg = GAME_RULES.PLAYER.BASE_SHOT_DAMAGE * mult;
    const dcx = defender.x + PLAYER_SIZE / 2;
    const dcy = defender.y + PLAYER_SIZE / 2;

    io.to(roomId).emit('ultraSkillEvent', {
        skillId: 'perfect_counter',
        phase: 'counter_burst',
        ownerId: defender.id,
        x: dcx,
        y: dcy,
        radius
    });

    if (room.mode === 'boss' && room.boss && room.boss.hp > 0) {
        if (Math.hypot(room.boss.x - dcx, room.boss.y - dcy) <= radius + room.boss.radius) {
            applyDamageToBoss(roomId, defender, baseDmg, 'perfect_counter', matchId);
        }
    }

    for (const id in room.players) {
        const other = room.players[id];
        if (!other || other.id === defender.id || other.isDead || other.isEliminated) continue;
        if (room.mode === 'pvp' || (attacker && other.id === attacker.id)) {
            const ocx = other.x + PLAYER_SIZE / 2;
            const ocy = other.y + PLAYER_SIZE / 2;
            if (Math.hypot(ocx - dcx, ocy - dcy) <= radius + PLAYER_SIZE / 2) {
                applyDamageToPlayer(roomId, other, baseDmg, 'perfect_counter', matchId, defender.element, defender);
            }
        }
    }
}

function applyDamageToPlayer(roomId, target, rawDamage, sourceKind, matchId, attackerElement, attackerPlayer) {
    const room = rooms.get(roomId);
    if (!room || room.state !== 'playing' || room.matchId !== matchId) return false;
    if (!target || target.isDead || target.isEliminated) return false;

    const now = Date.now();
    if (now < (target.invincibleUntil || 0)) return false;

    const isEndOfDays = sourceKind === 'end_of_days';
    const eodDef = getUltraSkillDef('end_of_days');
    const absWallActive = Boolean(target.ultraAbsoluteWallUntil && now < target.ultraAbsoluteWallUntil);
    const normalShieldActive = Boolean(target.shieldUntil && now < target.shieldUntil);
    const counterActive = Boolean(target.ultraCounterUntil && now < target.ultraCounterUntil);

    if (absWallActive) {
        if (isEndOfDays) {
            const wallMult = (eodDef && eodDef.absoluteWallDamageMultiplier) || 0.25;
            rawDamage = rawDamage * wallMult;
            io.to(roomId).emit('ultraSkillEvent', {
                skillId: 'end_of_days',
                phase: 'pierce_absolute_wall',
                targetId: target.id,
                label: (eodDef && eodDef.absoluteWallFloatingText) || 'ABSOLUTE!'
            });
        } else {
            io.to(roomId).emit('ultraSkillEvent', {
                skillId: 'absolute_wall',
                phase: 'blocked',
                targetId: target.id,
                label: 'ABSOLUTE!'
            });
            return false;
        }
    } else if (normalShieldActive && !isEndOfDays) {
        io.to(roomId).emit('playerBlocked', { playerId: target.id, kind: sourceKind });
        return false;
    } else if (normalShieldActive && isEndOfDays) {
        const pierMult = (eodDef && eodDef.normalBarrierDamageMultiplier) || 0.5;
        rawDamage = rawDamage * pierMult;
    }

    const elemMult = getElementMultiplier(attackerElement || 'neutral', target.element || 'neutral');
    const finalDamage = Math.max(1, Math.round(rawDamage * elemMult));

    if (counterActive && !isEndOfDays) {
        target.ultraCounterUntil = 0;
        triggerUltraCounter(roomId, target, attackerPlayer, matchId);
        return false;
    }

    target.hp = Math.max(0, target.hp - finalDamage);
    target.invincibleUntil = now + 260;

    io.to(roomId).emit('playerDamaged', {
        playerId: target.id,
        hp: target.hp,
        maxHp: target.maxHp,
        damage: finalDamage,
        sourceKind,
        elementMultiplier: elemMult
    });

    if (isEndOfDays && counterActive) {
        const cMult = (eodDef && eodDef.counterInteraction && eodDef.counterInteraction.damageMultiplier) || 0.5;
        const cDmg = Math.max(1, Math.round(rawDamage * cMult));
        target.hp = Math.max(0, target.hp - cDmg);
        target.ultraCounterUntil = 0;
        io.to(roomId).emit('playerDamaged', {
            playerId: target.id,
            hp: target.hp,
            maxHp: target.maxHp,
            damage: cDmg,
            sourceKind: 'end_of_days_counter',
            elementMultiplier: 1
        });
        if (target.hp > 0) {
            triggerUltraCounter(roomId, target, attackerPlayer, matchId);
        }
    }

    if (target.hp <= 0) {
        handlePlayerKO(roomId, target, attackerPlayer, matchId);
    }
    return true;
}

function applyPulseDamageToPlayer(roomId, target, rawDamage, sourceKind, matchId, attackerElement) {
    const room = rooms.get(roomId);
    if (!room || room.state !== 'playing' || room.matchId !== matchId) return false;
    if (!target || target.isDead || target.isEliminated) return false;

    const now = Date.now();
    if (target.ultraAbsoluteWallUntil && now < target.ultraAbsoluteWallUntil) return false;
    if (target.shieldUntil && now < target.shieldUntil) return false;

    const elemMult = getElementMultiplier(attackerElement || 'neutral', target.element || 'neutral');
    const dmg = Math.max(1, Math.round(rawDamage * elemMult));
    target.hp = Math.max(0, target.hp - dmg);

    io.to(roomId).emit('playerDamaged', {
        playerId: target.id,
        hp: target.hp,
        maxHp: target.maxHp,
        damage: dmg,
        sourceKind,
        elementMultiplier: elemMult
    });

    if (target.hp <= 0) {
        handlePlayerKO(roomId, target, null, matchId);
    }
    return true;
}

function applySlowToPlayer(roomId, target, multiplier, durationMs, matchId) {
    const room = rooms.get(roomId);
    if (!room || room.state !== 'playing' || room.matchId !== matchId) return;
    if (!target || target.isDead || target.isEliminated) return;
    const now = Date.now();
    target.slowMultiplier = Math.max(0.2, Math.min(1, Number(multiplier) || 0.75));
    target.slowUntil = Math.max(target.slowUntil || 0, now + Math.max(200, Number(durationMs) || 1800));
    io.to(roomId).emit('playerSlowed', {
        playerId: target.id,
        slowUntil: target.slowUntil,
        slowMultiplier: target.slowMultiplier
    });
}

function knockbackPlayerFromPoint(roomId, target, ox, oy, strength, matchId) {
    const room = rooms.get(roomId);
    if (!room || room.state !== 'playing' || room.matchId !== matchId) return;
    if (!target || target.isDead || target.isEliminated) return;
    const now = Date.now();
    let kbMult = 1;
    if (target.ultraAbsoluteWallUntil && now < target.ultraAbsoluteWallUntil) {
        const wDef = getUltraSkillDef('absolute_wall');
        kbMult = (wDef && wDef.knockbackMultiplier) || 0.15;
    }
    const px = target.x + PLAYER_SIZE / 2;
    const py = target.y + PLAYER_SIZE / 2;
    const ang = Math.atan2(py - oy, px - ox);
    const dist = (Number(strength) || 90) * kbMult;
    target.x = Math.max(0, Math.min(ARENA_WIDTH - PLAYER_SIZE, target.x + Math.cos(ang) * dist));
    target.y = Math.max(ARENA_TOP, Math.min(ARENA_HEIGHT - PLAYER_SIZE, target.y + Math.sin(ang) * dist));
}

function checkMatchEndConditions(roomId, matchId) {
    const room = rooms.get(roomId);
    if (!room || room.state !== 'playing' || room.matchId !== matchId) return;

    const allPlayers = Object.values(room.players);
    if (allPlayers.length === 0) return;

    if (room.mode === 'boss') {
        if (room.boss && room.boss.hp <= 0) {
            finishMatch(roomId, matchId, 'victory', 'BOSS撃破！');
            return;
        }
        const alive = allPlayers.filter((p) => !p.isDead && !p.isEliminated);
        if (alive.length === 0) {
            finishMatch(roomId, matchId, 'defeat', '全滅...');
        }
    } else {
        const alive = allPlayers.filter((p) => !p.isDead && !p.isEliminated);
        if (allPlayers.length >= 2 && alive.length <= 1) {
            const winner = alive[0] || null;
            finishMatch(roomId, matchId, 'pvp_end', winner ? `${winner.name} の勝利！` : '引き分け');
        }
    }
}

function handlePlayerKO(roomId, target, attacker, matchId) {
    const room = rooms.get(roomId);
    if (!room || room.state !== 'playing' || room.matchId !== matchId) return;
    if (!target || target.isDead || target.isEliminated) return;

    const now = Date.now();
    clearPlayerTimers(target);
    target.isDead = true;
    target.shieldUntil = 0;
    target.ultraActiveUntil = 0;
    target.ultraEndOfDaysUntil = 0;
    target.ultraAbsoluteWallUntil = 0;
    target.ultraCounterUntil = 0;
    target.ultraDemonBladeUntil = 0;
    target.ultraRicochetGunsUntil = 0;
    target.ultraPhantomBootsUntil = 0;

    if (room.mode === 'boss') {
        target.isEliminated = true;
        io.to(roomId).emit('playerEliminated', { playerId: target.id });
        checkMatchEndConditions(roomId, matchId);
        return;
    }

    // PvP リスポーン処理（3秒後）
    target.respawnAt = now + 3000;
    io.to(roomId).emit('playerKO', {
        playerId: target.id,
        attackerId: attacker ? attacker.id : null,
        respawnAt: target.respawnAt
    });

    registerTimeout(room, () => {
        const cur = rooms.get(roomId);
        if (!cur || cur.state !== 'playing' || cur.matchId !== matchId) return;
        const pl = cur.players[target.id];
        if (!pl || pl.isEliminated) return;

        resetPlayerCombatStatuses(pl, Date.now());
        snapPlayerOutOfWalls(cur, pl);
        io.to(roomId).emit('playerRespawn', {
            playerId: pl.id,
            x: pl.x,
            y: pl.y,
            hp: pl.hp,
            maxHp: pl.maxHp,
            invincibleUntil: pl.invincibleUntil
        });
    }, 3000);

    checkMatchEndConditions(roomId, matchId);
}

function applyDamageToBoss(roomId, attacker, rawDamage, sourceKind, matchId) {
    const room = rooms.get(roomId);
    if (!room || room.mode !== 'boss' || room.state !== 'playing' || room.matchId !== matchId) return false;
    if (!room.boss || room.boss.hp <= 0) return false;
    if (!attacker || attacker.isDead || attacker.isEliminated) return false;

    const now = Date.now();
    const boss = room.boss;
    const def = getBossDef(boss.id);

    if (boss.isStealthed && sourceKind !== 'end_of_days' && sourceKind !== 'sky_meteor') {
        return false;
    }

    let mult = getElementMultiplier(attacker.element || 'neutral', boss.element || 'neutral');

    if (attacker.powerBoostUntil && now < attacker.powerBoostUntil) {
        mult *= GAME_RULES.ITEMS.power.attackMultiplier;
    }

    if (sourceKind === 'slash') {
        const slashAct = GAME_RULES.ACTIONS.slash;
        mult *= (slashAct.bossMultiplier || 1.35);
        if (attacker.ultraDemonBladeUntil && now < attacker.ultraDemonBladeUntil) {
            const bladeDef = getUltraSkillDef('demon_blade');
            mult *= (bladeDef && bladeDef.slashDamageMultiplier) || 2.0;
        }
    }

    if (boss.barrierActive && sourceKind !== 'end_of_days') {
        mult *= (def.barrierDamageMultiplier || 0.45);
    }

    if (boss.scaleAuraActive && now < (boss.scaleAuraUntil || 0)) {
        const scaleMult = (def.phase2Awaken && def.phase2Awaken.scaleDamageMultiplier) || 0.75;
        mult *= scaleMult;
    }

    const dmg = Math.max(1, Math.round((Number(rawDamage) || GAME_RULES.PLAYER.BASE_SHOT_DAMAGE) * mult));
    boss.hp = Math.max(0, boss.hp - dmg);

    io.to(roomId).emit('bossDamaged', {
        bossId: boss.id,
        attackerId: attacker.id,
        damage: dmg,
        hp: boss.hp,
        maxHp: boss.maxHp,
        sourceKind,
        elementMultiplier: mult
    });

    // フェーズ2覚醒（HP 50% 以下）
    if (boss.phase === 1 && boss.hp > 0 && boss.hp <= boss.maxHp * 0.5) {
        boss.phase = 2;
        const awaken = def.phase2Awaken || {};
        const auraMs = awaken.scaleAuraDurationMs || 3000;
        boss.scaleAuraActive = true;
        boss.scaleAuraUntil = now + auraMs;

        io.to(roomId).emit('bossAttackEvent', {
            bossId: boss.id,
            element: boss.element,
            type: 'p2_awaken',
            x: boss.x,
            y: boss.y,
            knockbackRadius: awaken.knockbackRadius || 240,
            scaleAuraDurationMs: auraMs
        });
        io.to(roomId).emit('bossStateUpdated', boss);

        registerTimeout(room, () => {
            const cur = rooms.get(roomId);
            if (cur && cur.matchId === matchId && cur.boss) {
                cur.boss.scaleAuraActive = false;
                cur.boss.scaleAuraUntil = 0;
                io.to(roomId).emit('bossStateUpdated', cur.boss);
            }
        }, auraMs);
    }

    if (boss.hp <= 0) {
        checkMatchEndConditions(roomId, matchId);
    }
    return true;
}

function finishMatch(roomId, matchId, outcome, summaryText) {
    const room = rooms.get(roomId);
    if (!room || room.matchId !== matchId || room.state === 'ended') return;

    room.state = 'ended';
    room.timeStopUntil = 0;
    room.timeStopOwnerId = null;
    room.serverProjectiles = [];
    room.magmaZones = [];
    clearRoomTimers(room);

    const rewards = Object.create(null);

    for (const id in room.players) {
        const p = room.players[id];
        clearPlayerTimers(p);
        const prof = getOrCreateProfile(p.clientKey);
        let earnedPt = 0;

        if (room.mode === 'boss') {
            const stage = getStageByNumber(p.selectedStageNumber || (room.boss && room.boss.stageNumber) || 1);
            if (outcome === 'victory') {
                earnedPt = stage.clearRewardPt || 500;
                const nextStage = getNextStage(stage.stageNumber);
                if (nextStage && prof.unlockedStage < nextStage.stageNumber) {
                    prof.unlockedStage = nextStage.stageNumber;
                }
            } else {
                earnedPt = 100;
            }
        } else {
            earnedPt = (!p.isDead && !p.isEliminated) ? 250 : 100;
        }

        prof.points += earnedPt;
        rewards[id] = {
            earnedPt,
            points: prof.points,
            unlockedStage: prof.unlockedStage
        };

        io.to(id).emit('profileUpdated', buildProfilePayload(prof));
    }

    io.to(roomId).emit('matchResult', {
        matchId,
        mode: room.mode,
        outcome,
        summaryText,
        rewards
    });
}

// =========================================================================
// 4. 試合開始・カウントダウン・BOSSループ
// =========================================================================
function initArenaEntities(room) {
    room.breakableWalls = [];
    room.items = [];
    room.serverProjectiles = [];
    room.magmaZones = [];
    room.bossAttackCount = 0;
    room.lastBossAttackAt = Object.create(null);
    room.timeStopUntil = 0;
    room.timeStopOwnerId = null;

    const maxWalls = room.mode === 'boss'
        ? GAME_RULES.OBSTACLES.BREAKABLE_MAX_BOSS
        : GAME_RULES.OBSTACLES.BREAKABLE_MAX_PVP;

    for (let i = 0; i < maxWalls; i++) {
        const col = i % 4;
        const row = Math.floor(i / 4);
        const wx = 320 + col * 85;
        const wy = ARENA_TOP + 130 + row * 160;
        room.breakableWalls.push({
            id: `wall_${i}`,
            x: wx,
            y: wy,
            w: BREAKABLE_WALL_SIZE,
            h: BREAKABLE_WALL_SIZE,
            hp: BREAKABLE_WALL_HP,
            maxHp: BREAKABLE_WALL_HP
        });
    }

    const itemIds = Object.keys(GAME_RULES.ITEMS);
    for (let i = 0; i < 3; i++) {
        const kind = itemIds[i % itemIds.length];
        room.items.push({
            id: `item_${i}_${Date.now()}`,
            kind,
            x: 220 + i * 240,
            y: ARENA_PLAY_CENTER_Y + (i % 2 === 0 ? -60 : 60),
            radius: 16
        });
    }

    const playerList = Object.values(room.players);
    const spawnCoords = [
        { x: 120, y: ARENA_TOP + 120 },
        { x: ARENA_WIDTH - 120 - PLAYER_SIZE, y: ARENA_HEIGHT - 120 - PLAYER_SIZE },
        { x: 120, y: ARENA_HEIGHT - 120 - PLAYER_SIZE },
        { x: ARENA_WIDTH - 120 - PLAYER_SIZE, y: ARENA_TOP + 120 }
    ];

    const now = Date.now();
    playerList.forEach((p, idx) => {
        const sp = spawnCoords[idx % spawnCoords.length];
        p.x = sp.x;
        p.y = sp.y;
        p.vx = 0;
        p.vy = 0;
        p.facing = idx % 2 === 0 ? 'right' : 'left';
        resetPlayerCombatStatuses(p, now);
    });

    if (room.mode === 'boss') {
        const bossId = sanitizeBossId(room.bossId);
        room.boss = createBossInstance(bossId, Math.max(1, playerList.length));
        room.timeLeftSec = GAME_RULES.BOSS_TIME_LIMIT_SEC;
    } else {
        room.boss = null;
        room.timeLeftSec = GAME_RULES.PVP_TIME_LIMIT_SEC;
    }
}

function startMatchCountdown(roomId) {
    const room = rooms.get(roomId);
    if (!room) return;
    if (Object.keys(room.players).length === 0) return;

    clearRoomTimers(room);
    const matchId = ++matchSeq;
    room.matchId = matchId;
    room.state = 'countdown';
    initArenaEntities(room);

    let sec = GAME_RULES.COUNTDOWN_SEC;
    io.to(roomId).emit('matchCountdown', {
        matchId,
        seconds: sec,
        mode: room.mode,
        boss: room.boss,
        players: room.players,
        breakableWalls: room.breakableWalls,
        items: room.items
    });

    const cdInterval = registerInterval(room, () => {
        const cur = rooms.get(roomId);
        if (!cur || cur.matchId !== matchId || cur.state !== 'countdown') return;
        sec -= 1;
        if (sec > 0) {
            io.to(roomId).emit('matchCountdown', { matchId, seconds: sec });
        } else {
            clearInterval(cdInterval);
            beginPlayingMatch(roomId, matchId);
        }
    }, 1000);
}

function scheduleBossAttackLoop(roomId, matchId) {
    const room = rooms.get(roomId);
    if (!room || room.mode !== 'boss' || !room.boss) return;

    const triggerNext = () => {
        const cur = rooms.get(roomId);
        if (!cur || cur.state !== 'playing' || cur.matchId !== matchId || !cur.boss || cur.boss.hp <= 0) {
            return;
        }

        const now = Date.now();
        const isTimeStopped = Boolean(cur.timeStopUntil && now < cur.timeStopUntil && cur.timeStopOwnerId);
        const def = getBossDef(cur.boss.id);
        const intervalMs = cur.boss.phase === 2
            ? (def.attackIntervalMs && def.attackIntervalMs.p2) || 1400
            : (def.attackIntervalMs && def.attackIntervalMs.p1) || 2100;

        if (!isTimeStopped && !cur.boss.isStealthed) {
            const allPlayers = Object.values(cur.players);
            const alivePlayers = allPlayers.filter((p) => p && !p.isDead && !p.isEliminated);
            const targetPool = alivePlayers.length > 0 ? alivePlayers : allPlayers;
            let targetCx = ARENA_WIDTH / 2;
            let targetCy = ARENA_PLAY_CENTER_Y;
            if (targetPool.length > 0) {
                const chosen = targetPool[Math.floor(Math.random() * targetPool.length)];
                targetCx = chosen.x + PLAYER_SIZE / 2;
                targetCy = chosen.y + PLAYER_SIZE / 2;
            }

            const count = cur.bossAttackCount++;
            def.executeAttack({
                room: cur,
                roomId,
                matchId,
                boss: cur.boss,
                allPlayerCount: Math.max(1, allPlayers.length),
                alivePlayers,
                targetCx,
                targetCy,
                count,
                io,
                getRoom: () => rooms.get(roomId),
                registerTimeout,
                pointToSegmentDistance,
                applyDamageToPlayer,
                applyPulseDamageToPlayer,
                applySlowToPlayer,
                knockbackPlayerFromPoint,
                spawnMagmaZones: (rId, zones, durationMs, mId, elem) => {
                    const r = rooms.get(rId);
                    if (!r || r.state !== 'playing' || r.matchId !== mId) return;
                    const expiresAt = Date.now() + (durationMs || 2400);
                    for (const z of (zones || [])) {
                        r.magmaZones.push({
                            x: z.x,
                            y: z.y,
                            radius: z.radius || 84,
                            expiresAt,
                            nextTickAt: Date.now() + 500,
                            element: elem || 'fire'
                        });
                    }
                }
            });
        }

        registerTimeout(cur, triggerNext, intervalMs);
    };

    registerTimeout(room, triggerNext, 900);
}

function beginPlayingMatch(roomId, matchId) {
    const room = rooms.get(roomId);
    if (!room || room.matchId !== matchId) return;
    room.state = 'playing';
    room._lastTickAt = Date.now();

    io.to(roomId).emit('matchStart', {
        matchId,
        mode: room.mode,
        timeLeftSec: room.timeLeftSec,
        boss: room.boss,
        players: room.players
    });

    // 1秒タイマー
    registerInterval(room, () => {
        const cur = rooms.get(roomId);
        if (!cur || cur.state !== 'playing' || cur.matchId !== matchId) return;
        const now = Date.now();
        if (cur.timeStopUntil && now < cur.timeStopUntil && cur.timeStopOwnerId) {
            return;
        }
        cur.timeLeftSec = Math.max(0, cur.timeLeftSec - 1);
        io.to(roomId).emit('timerSync', { matchId, timeLeftSec: cur.timeLeftSec });

        if (cur.timeLeftSec <= 0) {
            if (cur.mode === 'boss') {
                finishMatch(roomId, matchId, 'timeout', 'タイムアップ！');
            } else {
                finishMatch(roomId, matchId, 'pvp_timeout', 'タイムアップ！');
            }
        }
    }, 1000);

    if (room.mode === 'boss') {
        scheduleBossAttackLoop(roomId, matchId);
    }
}

// =========================================================================
// 5. 60FPS サーバーシミュレーションループ
// =========================================================================
setInterval(() => {
    const now = Date.now();

    for (const [roomId, room] of rooms.entries()) {
        if (!room || room.state !== 'playing') continue;
        const matchId = room.matchId;

        if (room.timeStopUntil && now >= room.timeStopUntil) {
            const endedOwnerId = room.timeStopOwnerId;
            room.timeStopUntil = 0;
            room.timeStopOwnerId = null;
            io.to(roomId).emit('ultraSkillEvent', {
                skillId: 'time_stop',
                phase: 'end',
                ownerId: endedOwnerId
            });
        }

        const timeStopped = Boolean(room.timeStopUntil && now < room.timeStopUntil && room.timeStopOwnerId);
        const stopOwnerId = room.timeStopOwnerId;

        // プレイヤー移動・バフ切れ・アイテム取得
        for (const id in room.players) {
            const p = room.players[id];
            if (!p || p.isDead || p.isEliminated) continue;

            if (p.slowUntil && now >= p.slowUntil) {
                p.slowUntil = 0;
                p.slowMultiplier = 1;
            }

            const canMove = !timeStopped || (room.mode === 'boss') || (p.id === stopOwnerId);
            if (canMove && p.input) {
                const mx = (p.input.right ? 1 : 0) - (p.input.left ? 1 : 0);
                const my = (p.input.down ? 1 : 0) - (p.input.up ? 1 : 0);
                if (mx !== 0 || my !== 0) {
                    movePlayerWithCollisions(room, p, mx, my, now);
                } else {
                    p.vx = 0;
                    p.vy = 0;
                }
            } else {
                p.vx = 0;
                p.vy = 0;
            }

            // アイテム取得
            for (let i = room.items.length - 1; i >= 0; i--) {
                const it = room.items[i];
                const pcx = p.x + PLAYER_SIZE / 2;
                const pcy = p.y + PLAYER_SIZE / 2;
                if (Math.hypot(pcx - it.x, pcy - it.y) <= it.radius + PLAYER_SIZE / 2) {
                    const itemDef = GAME_RULES.ITEMS[it.kind];
                    if (itemDef) {
                        if (itemDef.id === 'heal') {
                            p.hp = Math.min(p.maxHp, p.hp + itemDef.healAmount);
                        } else if (itemDef.id === 'speed') {
                            p.speedBoostUntil = now + itemDef.durationMs;
                        } else if (itemDef.id === 'power') {
                            p.powerBoostUntil = now + itemDef.durationMs;
                        }
                        io.to(roomId).emit('itemPicked', {
                            itemId: it.id,
                            kind: it.kind,
                            playerId: p.id,
                            hp: p.hp,
                            speedBoostUntil: p.speedBoostUntil,
                            powerBoostUntil: p.powerBoostUntil
                        });
                    }
                    room.items.splice(i, 1);
                }
            }
        }

        // BOSS移動・渦潮吸引（timeStop 中は停止）
        if (room.mode === 'boss' && room.boss && room.boss.hp > 0 && !timeStopped) {
            const boss = room.boss;
            const def = getBossDef(boss.id);
            const playerCount = Object.keys(room.players).length;
            const isMulti = playerCount >= 2;
            const ms = def.moveSpeed || {};
            let bSpeed = boss.speed || 2.8;
            if (boss.phase === 2) {
                bSpeed = isMulti ? (ms.multiP2 || ms.p2 || bSpeed) : (ms.soloP2 || ms.p2 || bSpeed);
            } else {
                bSpeed = isMulti ? (ms.multiP1 || ms.p1 || bSpeed) : (ms.soloP1 || ms.p1 || bSpeed);
            }

            if (!boss.isStealthed) {
                const alive = Object.values(room.players).filter((pl) => pl && !pl.isDead && !pl.isEliminated);
                if (alive.length > 0) {
                    const target = alive[0];
                    const tcx = target.x + PLAYER_SIZE / 2;
                    const tcy = target.y + PLAYER_SIZE / 2;
                    const ang = Math.atan2(tcy - boss.y, tcx - boss.x);
                    const nx = boss.x + Math.cos(ang) * bSpeed;
                    const ny = boss.y + Math.sin(ang) * bSpeed;
                    boss.x = Math.max(boss.radius + 16, Math.min(ARENA_WIDTH - boss.radius - 16, nx));
                    boss.y = Math.max(ARENA_TOP + boss.radius + 16, Math.min(ARENA_HEIGHT - boss.radius - 16, ny));
                }
            }

            if (boss.vortexActive) {
                const pullBase = boss.phase === 2 ? 1.95 : 1.55;
                for (const id in room.players) {
                    const pl = room.players[id];
                    if (!pl || pl.isDead || pl.isEliminated) continue;
                    let pMult = 1;
                    if (pl.ultraAbsoluteWallUntil && now < pl.ultraAbsoluteWallUntil) {
                        const wDef = getUltraSkillDef('absolute_wall');
                        pMult = (wDef && wDef.pullMultiplier) || 0.15;
                    }
                    const pcx = pl.x + PLAYER_SIZE / 2;
                    const pcy = pl.y + PLAYER_SIZE / 2;
                    const ang = Math.atan2(boss.y - pcy, boss.x - pcx);
                    const pull = pullBase * pMult;
                    pl.x = Math.max(0, Math.min(ARENA_WIDTH - PLAYER_SIZE, pl.x + Math.cos(ang) * pull));
                    pl.y = Math.max(ARENA_TOP, Math.min(ARENA_HEIGHT - PLAYER_SIZE, pl.y + Math.sin(ang) * pull));
                }
            }
        }

        // マグマ床ティック（timeStop 中は停止）
        if (!timeStopped && room.magmaZones.length > 0) {
            const magCfg = (room.boss && getBossDef(room.boss.id).magmaConfig) || { tickIntervalMs: 600, tickDamage: 6 };
            for (let i = room.magmaZones.length - 1; i >= 0; i--) {
                const mz = room.magmaZones[i];
                if (now >= mz.expiresAt) {
                    room.magmaZones.splice(i, 1);
                    continue;
                }
                if (now >= mz.nextTickAt) {
                    mz.nextTickAt = now + (magCfg.tickIntervalMs || 600);
                    for (const id in room.players) {
                        const pl = room.players[id];
                        if (!pl || pl.isDead || pl.isEliminated) continue;
                        const pcx = pl.x + PLAYER_SIZE / 2;
                        const pcy = pl.y + PLAYER_SIZE / 2;
                        if (Math.hypot(pcx - mz.x, pcy - mz.y) <= mz.radius) {
                            applyPulseDamageToPlayer(roomId, pl, magCfg.tickDamage || 6, 'magma', matchId, mz.element || 'fire');
                        }
                    }
                }
            }
        }

        // サーバー管理弾（跳弾銃・蛇行闇弾・呪詛弾・追尾球など）
        for (let i = room.serverProjectiles.length - 1; i >= 0; i--) {
            const proj = room.serverProjectiles[i];
            if (timeStopped && proj.ownerType !== 'player') {
                continue;
            }
            if (timeStopped && proj.ownerType === 'player' && proj.ownerId !== stopOwnerId) {
                continue;
            }

            proj.life -= 1;
            if (proj.life <= 0) {
                room.serverProjectiles.splice(i, 1);
                continue;
            }

            if (proj.kind === 'snake_dark') {
                proj.age = (proj.age || 0) + 1;
                proj.baseX += Math.cos(proj.angle) * proj.speed;
                proj.baseY += Math.sin(proj.angle) * proj.speed;
                const offset = (proj.side || 1) * Math.sin(proj.age * (proj.waveFreq || 0.12)) * (proj.waveAmp || 34);
                const perpX = -Math.sin(proj.angle);
                const perpY = Math.cos(proj.angle);
                proj.x = proj.baseX + perpX * offset;
                proj.y = proj.baseY + perpY * offset;
            } else if ((proj.kind === 'phantom_homing' || proj.kind === 'homing') && proj.ownerType === 'boss') {
                const alive = Object.values(room.players).filter((pl) => pl && !pl.isDead && !pl.isEliminated);
                if (alive.length > 0) {
                    const t = alive[0];
                    const tcx = t.x + PLAYER_SIZE / 2;
                    const tcy = t.y + PLAYER_SIZE / 2;
                    const desired = Math.atan2(tcy - proj.y, tcx - proj.x);
                    const curAng = Math.atan2(proj.vy, proj.vx);
                    let diff = desired - curAng;
                    while (diff > Math.PI) diff -= Math.PI * 2;
                    while (diff < -Math.PI) diff += Math.PI * 2;
                    const tr = proj.turnRate || 0.045;
                    const step = Math.max(-tr, Math.min(tr, diff));
                    const nextAng = curAng + step;
                    const spd = proj.speed || Math.hypot(proj.vx, proj.vy) || 3.5;
                    proj.vx = Math.cos(nextAng) * spd;
                    proj.vy = Math.sin(nextAng) * spd;
                }
                proj.x += proj.vx;
                proj.y += proj.vy;
            } else {
                proj.x += proj.vx;
                proj.y += proj.vy;
            }

            // 反射判定（ricochet_guns）
            let bounced = false;
            if ((proj.bouncesLeft || 0) > 0) {
                if (proj.x <= 4 || proj.x >= ARENA_WIDTH - 4) {
                    proj.vx = -proj.vx;
                    proj.x = Math.max(5, Math.min(ARENA_WIDTH - 5, proj.x));
                    proj.bouncesLeft -= 1;
                    bounced = true;
                }
                if (proj.y <= ARENA_TOP + 4 || proj.y >= ARENA_HEIGHT - 4) {
                    proj.vy = -proj.vy;
                    proj.y = Math.max(ARENA_TOP + 5, Math.min(ARENA_HEIGHT - 5, proj.y));
                    proj.bouncesLeft -= 1;
                    bounced = true;
                }
                if (!bounced) {
                    for (const obs of STATIC_OBSTACLES) {
                        if (proj.x >= obs.x && proj.x <= obs.x + obs.w && proj.y >= obs.y && proj.y <= obs.y + obs.h) {
                            proj.vx = -proj.vx;
                            proj.vy = -proj.vy;
                            proj.x += proj.vx * 1.5;
                            proj.y += proj.vy * 1.5;
                            proj.bouncesLeft -= 1;
                            bounced = true;
                            break;
                        }
                    }
                }
                if (!bounced) {
                    for (const w of room.breakableWalls) {
                        if (w.hp > 0 && proj.x >= w.x && proj.x <= w.x + w.w && proj.y >= w.y && proj.y <= w.y + w.h) {
                            proj.vx = -proj.vx;
                            proj.vy = -proj.vy;
                            proj.x += proj.vx * 1.5;
                            proj.y += proj.vy * 1.5;
                            proj.bouncesLeft -= 1;
                            bounced = true;
                            break;
                        }
                    }
                }
                if (bounced) {
                    io.to(roomId).emit('projectileRicocheted', {
                        id: proj.id,
                        x: proj.x,
                        y: proj.y,
                        vx: proj.vx,
                        vy: proj.vy
                    });
                    continue;
                }
            }

            // 場外・障害物消滅
            if (proj.x < 0 || proj.x > ARENA_WIDTH || proj.y < ARENA_TOP || proj.y > ARENA_HEIGHT) {
                room.serverProjectiles.splice(i, 1);
                continue;
            }

            if (proj.ownerType === 'player') {
                const owner = room.players[proj.ownerId];
                if (room.mode === 'boss' && room.boss && room.boss.hp > 0 && owner) {
                    if (Math.hypot(proj.x - room.boss.x, proj.y - room.boss.y) <= room.boss.radius + 10) {
                        applyDamageToBoss(roomId, owner, proj.damage || 40, proj.kind || 'ricochet_guns', matchId);
                        room.serverProjectiles.splice(i, 1);
                        continue;
                    }
                }
                if (room.mode === 'pvp') {
                    let hitAny = false;
                    for (const id in room.players) {
                        if (id === proj.ownerId) continue;
                        const pl = room.players[id];
                        if (!pl || pl.isDead || pl.isEliminated) continue;
                        const pcx = pl.x + PLAYER_SIZE / 2;
                        const pcy = pl.y + PLAYER_SIZE / 2;
                        if (Math.hypot(proj.x - pcx, proj.y - pcy) <= PLAYER_SIZE / 2 + 8) {
                            applyDamageToPlayer(roomId, pl, proj.damage || 40, proj.kind || 'ricochet_guns', matchId, proj.element || 'neutral', owner);
                            hitAny = true;
                            break;
                        }
                    }
                    if (hitAny) {
                        room.serverProjectiles.splice(i, 1);
                        continue;
                    }
                }
            } else if (proj.ownerType === 'boss') {
                let hitPl = false;
                for (const id in room.players) {
                    const pl = room.players[id];
                    if (!pl || pl.isDead || pl.isEliminated) continue;
                    const pcx = pl.x + PLAYER_SIZE / 2;
                    const pcy = pl.y + PLAYER_SIZE / 2;
                    if (Math.hypot(proj.x - pcx, proj.y - pcy) <= PLAYER_SIZE / 2 + 8) {
                        applyDamageToPlayer(roomId, pl, proj.damage || 10, proj.kind || 'boss_proj', matchId, proj.element || 'neutral');
                        hitPl = true;
                        break;
                    }
                }
                if (hitPl) {
                    room.serverProjectiles.splice(i, 1);
                    continue;
                }
            }
        }

        io.to(roomId).emit('gameState', {
            matchId,
            state: room.state,
            timeLeftSec: room.timeLeftSec,
            players: room.players,
            boss: room.boss,
            breakableWalls: room.breakableWalls,
            items: room.items,
            serverProjectiles: room.serverProjectiles,
            timeStopUntil: room.timeStopUntil,
            timeStopOwnerId: room.timeStopOwnerId
        });
    }
}, TICK_INTERVAL_MS);

// =========================================================================
// 6. Socket.io イベントハンドラ
// =========================================================================
io.on('connection', (socket) => {
    let currentRoomId = null;
    let currentPlayerId = socket.id;

    socket.on('syncProfile', (payload) => {
        const data = payload || {};
        const prof = getOrCreateProfile(data.clientKey);
        if (typeof data.name === 'string' && data.name.trim()) {
            prof.name = data.name.trim().slice(0, 20);
        }
        if (Array.isArray(data.pixels)) {
            prof.pixels = data.pixels;
            prof.element = determineElementFromPixels(data.pixels);
        } else if (typeof data.element === 'string') {
            prof.element = BossSystem.sanitizeElementId(data.element);
        }
        if (data.selectedBossId) {
            prof.selectedBossId = sanitizeBossId(data.selectedBossId);
        }
        if (data.equippedUltra !== undefined) {
            const safeU = sanitizeUltraSkillId(data.equippedUltra);
            if (safeU && (prof.ultraStocks[safeU] || 0) > 0) {
                prof.equippedUltra = safeU;
            } else if (!data.equippedUltra) {
                prof.equippedUltra = null;
            }
        }
        socket.emit('profileUpdated', buildProfilePayload(prof));
    });

    socket.on('joinRoom', (payload) => {
        const data = payload || {};
        const prof = getOrCreateProfile(data.clientKey);
        if (typeof data.name === 'string' && data.name.trim()) {
            prof.name = data.name.trim().slice(0, 20);
        }
        if (Array.isArray(data.pixels)) {
            prof.pixels = data.pixels;
            prof.element = determineElementFromPixels(data.pixels);
        } else if (typeof data.element === 'string') {
            prof.element = BossSystem.sanitizeElementId(data.element);
        }

        const mode = data.mode === 'boss' ? 'boss' : 'pvp';
        const stageNum = Math.max(1, Math.min(BossSystem.STAGES.length, Number(data.stageNumber) || 1));
        const stageDef = getStageByNumber(stageNum);
        const bossId = sanitizeBossId(data.bossId || stageDef.bossId || prof.selectedBossId);
        prof.selectedBossId = bossId;

        if (currentRoomId && rooms.has(currentRoomId)) {
            const prevRoom = rooms.get(currentRoomId);
            delete prevRoom.players[socket.id];
            socket.leave(currentRoomId);
            io.to(currentRoomId).emit('roomUpdated', { players: prevRoom.players });
        }

        const room = getOrCreateRoom(data.roomId || 'room_1', mode, bossId);
        currentRoomId = room.id;
        socket.join(room.id);

        const existingCount = Object.keys(room.players).length;
        const spawnX = 120 + (existingCount % 2) * 560;
        const spawnY = ARENA_TOP + 120 + Math.floor(existingCount / 2) * 320;

        room.players[socket.id] = {
            id: socket.id,
            clientKey: prof.clientKey,
            name: prof.name,
            x: spawnX,
            y: spawnY,
            vx: 0,
            vy: 0,
            facing: 'down',
            hp: GAME_RULES.PLAYER.BASE_MAX_HP,
            maxHp: GAME_RULES.PLAYER.BASE_MAX_HP,
            isDead: false,
            isEliminated: false,
            respawnAt: 0,
            invincibleUntil: 0,
            shieldUntil: 0,
            speedBoostUntil: 0,
            powerBoostUntil: 0,
            slowUntil: 0,
            slowMultiplier: 1,
            equippedUltra: prof.equippedUltra,
            ultraStocks: { ...prof.ultraStocks },
            ultraCooldownUntil: 0,
            ultraActiveUntil: 0,
            ultraEndOfDaysUntil: 0,
            ultraAbsoluteWallUntil: 0,
            ultraCounterUntil: 0,
            ultraDemonBladeUntil: 0,
            ultraRicochetGunsUntil: 0,
            ultraPhantomBootsUntil: 0,
            pixels: prof.pixels || null,
            element: prof.element || 'neutral',
            equippedInk: prof.equippedInk || '',
            selectedStageNumber: stageNum,
            input: { up: false, down: false, left: false, right: false },
            attackCredits: { shot: 0, slash: 0 },
            _timers: [],
            _intervals: []
        };

        socket.emit('joinedRoom', {
            playerId: socket.id,
            roomId: room.id,
            mode: room.mode,
            bossId: room.bossId,
            stageNumber: stageNum,
            state: room.state,
            players: room.players,
            profile: buildProfilePayload(prof)
        });

        io.to(room.id).emit('roomUpdated', { players: room.players });
    });

    socket.on('startMatch', (payload) => {
        const data = payload || {};
        const roomId = data.roomId || currentRoomId;
        if (!roomId || !rooms.has(roomId)) return;
        const room = rooms.get(roomId);
        if (data.mode === 'boss' || data.mode === 'pvp') {
            room.mode = data.mode;
        }
        if (data.bossId) {
            room.bossId = sanitizeBossId(data.bossId);
        }
        startMatchCountdown(roomId);
    });

    socket.on('playerInput', (input) => {
        if (!currentRoomId || !rooms.has(currentRoomId)) return;
        const room = rooms.get(currentRoomId);
        const p = room.players[socket.id];
        if (!p || !input) return;
        p.input = {
            up: Boolean(input.up),
            down: Boolean(input.down),
            left: Boolean(input.left),
            right: Boolean(input.right)
        };
    });

    // Z: バリア / X: 斬撃 / C: 玉
    socket.on('playerAttack', (payload) => {
        if (!currentRoomId || !rooms.has(currentRoomId)) return;
        const room = rooms.get(currentRoomId);
        if (room.state !== 'playing') return;
        const p = room.players[socket.id];
        if (!p || p.isDead || p.isEliminated) return;

        const data = payload || {};
        const kind = data.kind || 'shot';
        const now = Date.now();

        if (kind === 'shield') {
            const sh = GAME_RULES.ACTIONS.shield;
            p.shieldUntil = now + sh.durationMs;
            io.to(room.id).emit('playerShield', { playerId: p.id, shieldUntil: p.shieldUntil });
            return;
        }

        if (kind === 'slash') {
            addCredit(p, 'slash');
            io.to(room.id).emit('playerSlash', {
                playerId: p.id,
                x: p.x,
                y: p.y,
                facing: p.facing,
                demonBladeActive: Boolean(p.ultraDemonBladeUntil && now < p.ultraDemonBladeUntil)
            });
            return;
        }

        // 遠距離攻撃（玉：shot）
        addCredit(p, 'shot');
        const shotSpeed = GAME_RULES.ACTIONS.shot.speed || 9.5;
        let vx = 0;
        let vy = 0;
        if (typeof data.vx === 'number' || typeof data.vy === 'number') {
            const len = Math.hypot(Number(data.vx) || 0, Number(data.vy) || 0) || 1;
            vx = ((Number(data.vx) || 0) / len) * shotSpeed;
            vy = ((Number(data.vy) || 0) / len) * shotSpeed;
        } else {
            switch (data.facing || p.facing) {
                case 'up': vy = -shotSpeed; break;
                case 'down': vy = shotSpeed; break;
                case 'left': vx = -shotSpeed; break;
                case 'right': vx = shotSpeed; break;
                default: vy = shotSpeed; break;
            }
        }

        io.to(room.id).emit('playerShot', {
            playerId: p.id,
            x: p.x + PLAYER_SIZE / 2,
            y: p.y + PLAYER_SIZE / 2,
            vx,
            vy,
            element: p.element || 'neutral',
            damage: GAME_RULES.PLAYER.BASE_SHOT_DAMAGE
        });
    });

    // ① 遠距離攻撃（玉）や斬撃のBOSSヒット受信
    socket.on('damageBoss', (payload) => {
        if (!currentRoomId || !rooms.has(currentRoomId)) return;
        const room = rooms.get(currentRoomId);
        if (room.mode !== 'boss' || room.state !== 'playing' || !room.boss || room.boss.hp <= 0) return;

        const attacker = room.players[socket.id];
        if (!attacker || attacker.isDead || attacker.isEliminated) return;

        const data = payload || {};
        const kind = data.kind === 'slash' ? 'slash' : 'shot';

        // クレジット検証（未発射・不正連打を防止）
        if (!useCredit(attacker, kind)) {
            return;
        }

        const baseDamage = kind === 'slash'
            ? GAME_RULES.PLAYER.BASE_SHOT_DAMAGE * (GAME_RULES.ACTIONS.slash.bossMultiplier || 1.35)
            : GAME_RULES.PLAYER.BASE_SHOT_DAMAGE;

        applyDamageToBoss(room.id, attacker, baseDamage, kind, room.matchId);
    });

    // 壊せる壁の破壊同期
    socket.on('damageBreakableWall', (payload) => {
        if (!currentRoomId || !rooms.has(currentRoomId)) return;
        const room = rooms.get(currentRoomId);
        if (room.state !== 'playing') return;
        const data = payload || {};
        const wall = room.breakableWalls.find((w) => w.id === data.wallId && w.hp > 0);
        if (!wall) return;
        wall.hp = Math.max(0, wall.hp - (Number(data.damage) || 15));
        io.to(room.id).emit('breakableWallUpdated', { wallId: wall.id, hp: wall.hp });
    });

    // ② BOSS攻撃のクライアント弾ヒット報告（サーバー権威で検証・HP反映）
    socket.on('bossProjectileHit', (payload) => {
        if (!currentRoomId || !rooms.has(currentRoomId)) return;
        const room = rooms.get(currentRoomId);
        if (room.state !== 'playing') return;

        const data = payload || {};
        const targetId = data.targetPlayerId || socket.id;
        const target = room.players[targetId];
        if (!target || target.isDead || target.isEliminated) return;

        const kind = typeof data.kind === 'string' ? data.kind : 'spiral';
        if (SERVER_AUTHORITATIVE_PROJECTILES.has(kind)) {
            return;
        }

        const bossDef = room.boss ? getBossDef(room.boss.id) : null;
        const tableDmg = bossDef && bossDef.projectileDamage && typeof bossDef.projectileDamage[kind] === 'number'
            ? bossDef.projectileDamage[kind]
            : null;
        const rawDmg = tableDmg !== null
            ? tableDmg
            : Math.max(1, Math.min(45, Number(data.damage) || 12));

        const elem = (room.boss && room.boss.element) || (bossDef && bossDef.element) || 'neutral';
        applyDamageToPlayer(room.id, target, rawDmg, kind, room.matchId, elem);
    });

    // Space: 必殺技（全8種）発動
    socket.on('useUltraSkill', (payload) => {
        if (!currentRoomId || !rooms.has(currentRoomId)) return;
        const room = rooms.get(currentRoomId);
        if (room.state !== 'playing') return;
        const p = room.players[socket.id];
        if (!p || p.isDead || p.isEliminated) return;

        const now = Date.now();
        if (now < (p.ultraCooldownUntil || 0)) return;

        const prof = getOrCreateProfile(p.clientKey);
        const data = payload || {};
        const skillId = sanitizeUltraSkillId(data.skillId || p.equippedUltra || prof.equippedUltra);
        const skill = skillId ? getUltraSkillDef(skillId) : null;
        if (!skill) return;

        const curStock = prof.ultraStocks[skill.id] || 0;
        if (curStock <= 0) return;

        const matchId = room.matchId;
        prof.ultraStocks[skill.id] = curStock - 1;
        p.ultraStocks = { ...prof.ultraStocks };
        if (prof.ultraStocks[skill.id] <= 0 && prof.equippedUltra === skill.id) {
            prof.equippedUltra = null;
            p.equippedUltra = null;
        }
        p.ultraCooldownUntil = now + (skill.cooldownMs || GAME_RULES.ACTIONS.ultra.cooldownMs);
        p.ultraActiveUntil = now + skill.durationMs;

        io.to(socket.id).emit('profileUpdated', buildProfilePayload(prof));
        io.to(room.id).emit('ultraSkillEvent', {
            skillId: skill.id,
            phase: 'activate',
            ownerId: p.id,
            durationMs: skill.durationMs,
            cooldownUntil: p.ultraCooldownUntil,
            stocks: { ...prof.ultraStocks }
        });

        const cx = p.x + PLAYER_SIZE / 2;
        const cy = p.y + PLAYER_SIZE / 2;
        let dirX = 0;
        let dirY = 1;
        if (typeof data.dirX === 'number' || typeof data.dirY === 'number') {
            const len = Math.hypot(Number(data.dirX) || 0, Number(data.dirY) || 0);
            if (len > 0.01) {
                dirX = (Number(data.dirX) || 0) / len;
                dirY = (Number(data.dirY) || 0) / len;
            }
        }
        if (dirX === 0 && dirY === 0) {
            switch (p.facing) {
                case 'up': dirY = -1; break;
                case 'down': dirY = 1; break;
                case 'left': dirX = -1; break;
                case 'right': dirX = 1; break;
                default: dirY = 1; break;
            }
        }

        if (skill.id === 'end_of_days') {
            const chargeMs = skill.chargeMs || 350;
            const beamDuration = skill.durationMs || 260;
            const range = skill.range || 620;
            const halfWidth = skill.halfWidth || 56;
            const dmg = GAME_RULES.PLAYER.BASE_SHOT_DAMAGE * (skill.damageMultiplier || 4.0);

            io.to(room.id).emit('ultraSkillEvent', {
                skillId: 'end_of_days',
                phase: 'charge',
                ownerId: p.id,
                x: cx,
                y: cy,
                dirX,
                dirY,
                range,
                halfWidth,
                chargeMs
            });

            registerTimeout(room, () => {
                const cur = rooms.get(room.id);
                if (!cur || cur.state !== 'playing' || cur.matchId !== matchId) return;
                const owner = cur.players[p.id];
                if (!owner || owner.isDead || owner.isEliminated) return;

                const ox = owner.x + PLAYER_SIZE / 2;
                const oy = owner.y + PLAYER_SIZE / 2;
                const ex = ox + dirX * range;
                const ey = oy + dirY * range;

                io.to(room.id).emit('ultraSkillEvent', {
                    skillId: 'end_of_days',
                    phase: 'fire',
                    ownerId: owner.id,
                    x1: ox,
                    y1: oy,
                    x2: ex,
                    y2: ey,
                    halfWidth,
                    durationMs: beamDuration
                });

                if (cur.mode === 'boss' && cur.boss && cur.boss.hp > 0) {
                    const dist = pointToSegmentDistance(cur.boss.x, cur.boss.y, ox, oy, ex, ey);
                    if (dist <= halfWidth + cur.boss.radius) {
                        applyDamageToBoss(room.id, owner, dmg, 'end_of_days', matchId);
                    }
                }

                for (const id in cur.players) {
                    if (id === owner.id) continue;
                    const target = cur.players[id];
                    if (!target || target.isDead || target.isEliminated) continue;
                    const tcx = target.x + PLAYER_SIZE / 2;
                    const tcy = target.y + PLAYER_SIZE / 2;
                    if (pointToSegmentDistance(tcx, tcy, ox, oy, ex, ey) <= halfWidth + PLAYER_SIZE / 2) {
                        applyDamageToPlayer(room.id, target, dmg, 'end_of_days', matchId, owner.element, owner);
                    }
                }
            }, chargeMs);
        } else if (skill.id === 'absolute_wall') {
            p.ultraAbsoluteWallUntil = now + skill.durationMs;
        } else if (skill.id === 'perfect_counter') {
            p.ultraCounterUntil = now + (skill.stanceMs || skill.durationMs);
        } else if (skill.id === 'sky_meteor') {
            const warnMs = skill.warnMs || 650;
            const count = skill.meteorCount || 5;
            const spread = skill.fanSpreadRad || 1.05;
            const castDist = skill.castDistance || 210;
            const radius = skill.radius || 110;
            const baseAng = Math.atan2(dirY, dirX);
            const dmg = GAME_RULES.PLAYER.BASE_SHOT_DAMAGE * (skill.damageMultiplier || 2.2);

            const zones = [];
            for (let i = 0; i < count; i++) {
                const offset = count === 1 ? 0 : ((i / (count - 1)) - 0.5) * spread;
                const ang = baseAng + offset;
                const zx = Math.max(radius, Math.min(ARENA_WIDTH - radius, cx + Math.cos(ang) * castDist));
                const zy = Math.max(ARENA_TOP + radius, Math.min(ARENA_HEIGHT - radius, cy + Math.sin(ang) * castDist));
                zones.push({ x: zx, y: zy, radius });
            }

            io.to(room.id).emit('ultraSkillEvent', {
                skillId: 'sky_meteor',
                phase: 'warn',
                ownerId: p.id,
                zones,
                warnMs
            });

            registerTimeout(room, () => {
                const cur = rooms.get(room.id);
                if (!cur || cur.state !== 'playing' || cur.matchId !== matchId) return;
                const owner = cur.players[p.id];
                if (!owner || owner.isDead || owner.isEliminated) return;

                io.to(room.id).emit('ultraSkillEvent', {
                    skillId: 'sky_meteor',
                    phase: 'fire',
                    ownerId: owner.id,
                    zones
                });

                for (const z of zones) {
                    if (cur.mode === 'boss' && cur.boss && cur.boss.hp > 0) {
                        if (Math.hypot(cur.boss.x - z.x, cur.boss.y - z.y) <= z.radius + cur.boss.radius) {
                            applyDamageToBoss(room.id, owner, dmg, 'sky_meteor', matchId);
                        }
                    }
                    for (const id in cur.players) {
                        if (id === owner.id) continue;
                        const target = cur.players[id];
                        if (!target || target.isDead || target.isEliminated) continue;
                        const tcx = target.x + PLAYER_SIZE / 2;
                        const tcy = target.y + PLAYER_SIZE / 2;
                        if (Math.hypot(tcx - z.x, tcy - z.y) <= z.radius + PLAYER_SIZE / 2) {
                            applyDamageToPlayer(room.id, target, dmg, 'sky_meteor', matchId, owner.element, owner);
                        }
                    }
                }
            }, warnMs);
        } else if (skill.id === 'demon_blade') {
            p.ultraDemonBladeUntil = now + skill.durationMs;
        } else if (skill.id === 'ricochet_guns') {
            p.ultraRicochetGunsUntil = now + skill.durationMs;
            const intervalMs = Number(skill.waveIntervalMs ?? skill.fireIntervalMs) || 625;
            const maxWaves = skill.maxWaves || 8;
            const dirs = skill.directions || 8;
            const baseDmg = skill.baseDamage || 40;
            const maxBounces = skill.maxBounces || 1;

            let wave = 0;
            const fireWave = () => {
                const cur = rooms.get(room.id);
                if (!cur || cur.state !== 'playing' || cur.matchId !== matchId) return;
                const owner = cur.players[p.id];
                if (!owner || owner.isDead || owner.isEliminated) return;
                if (Date.now() > owner.ultraRicochetGunsUntil) return;

                const ox = owner.x + PLAYER_SIZE / 2;
                const oy = owner.y + PLAYER_SIZE / 2;
                const spd = 8.5;
                const waveOffset = wave * 0.2;

                for (let d = 0; d < dirs; d++) {
                    const ang = waveOffset + (Math.PI * 2 / dirs) * d;
                    cur.serverProjectiles.push({
                        id: `rg_${matchId}_${owner.id}_${wave}_${d}_${Date.now()}`,
                        kind: 'ricochet_guns',
                        ownerType: 'player',
                        ownerId: owner.id,
                        element: owner.element || 'neutral',
                        x: ox,
                        y: oy,
                        vx: Math.cos(ang) * spd,
                        vy: Math.sin(ang) * spd,
                        damage: baseDmg,
                        bouncesLeft: maxBounces,
                        life: 140
                    });
                }

                wave += 1;
                if (wave < maxWaves) {
                    registerTimeout(cur, fireWave, intervalMs);
                }
            };
            fireWave();
        } else if (skill.id === 'phantom_boots') {
            p.ultraPhantomBootsUntil = now + skill.durationMs;
            registerTimeout(room, () => {
                const cur = rooms.get(room.id);
                if (!cur || cur.matchId !== matchId) return;
                const owner = cur.players[p.id];
                if (!owner) return;
                owner.ultraPhantomBootsUntil = 0;
                if (skill.snapOnEnd) {
                    snapPlayerOutOfWalls(cur, owner);
                    io.to(room.id).emit('playerRespawn', {
                        playerId: owner.id,
                        x: owner.x,
                        y: owner.y,
                        hp: owner.hp,
                        maxHp: owner.maxHp,
                        invincibleUntil: owner.invincibleUntil
                    });
                }
            }, skill.durationMs);
        } else if (skill.id === 'time_stop') {
            room.timeStopUntil = Math.max(room.timeStopUntil || 0, now + skill.durationMs);
            room.timeStopOwnerId = p.id;
            io.to(room.id).emit('ultraSkillEvent', {
                skillId: 'time_stop',
                phase: 'time_stop_active',
                ownerId: p.id,
                timeStopUntil: room.timeStopUntil
            });
        }
    });

    // ③ 特別インクガチャ（300Pt / 重複100Pt還元）
    socket.on('pullInkGacha', (payload) => {
        const data = payload || {};
        const prof = getOrCreateProfile(data.clientKey);
        const cost = GAME_RULES.GACHA.INK_COST;
        if (prof.points < cost) {
            socket.emit('inkGachaResult', { ok: false, reason: 'insufficient_points', profile: buildProfilePayload(prof) });
            return;
        }

        prof.points -= cost;
        const pickedId = SPECIAL_INK_IDS[Math.floor(Math.random() * SPECIAL_INK_IDS.length)];
        const isDuplicate = prof.ownedInks.includes(pickedId);
        let refundPt = 0;

        if (isDuplicate) {
            refundPt = GAME_RULES.GACHA.INK_DUPLICATE_REFUND;
            prof.points += refundPt;
        } else {
            prof.ownedInks.push(pickedId);
            prof.equippedInk = pickedId;
        }

        const p = currentRoomId && rooms.get(currentRoomId) ? rooms.get(currentRoomId).players[socket.id] : null;
        if (p) p.equippedInk = prof.equippedInk;

        const out = buildProfilePayload(prof);
        socket.emit('inkGachaResult', {
            ok: true,
            inkId: pickedId,
            isDuplicate,
            refundPt,
            profile: out
        });
        socket.emit('profileUpdated', out);
    });

    // ③ 必殺技ガチャ（1000Pt / 重複300Pt還元 / 最大3ストック）
    socket.on('pullUltraGacha', (payload) => {
        const data = payload || {};
        const prof = getOrCreateProfile(data.clientKey);
        const cost = GAME_RULES.GACHA.ULTRA_COST;
        if (prof.points < cost) {
            socket.emit('ultraGachaResult', { ok: false, reason: 'insufficient_points', profile: buildProfilePayload(prof) });
            return;
        }

        prof.points -= cost;
        const pool = GAME_RULES.GACHA.ULTRA_POOL;
        const totalW = pool.reduce((acc, item) => acc + item.weight, 0);
        let roll = Math.random() * totalW;
        let chosen = pool[pool.length - 1];
        for (const item of pool) {
            roll -= item.weight;
            if (roll <= 0) {
                chosen = item;
                break;
            }
        }

        const skillId = sanitizeUltraSkillId(chosen.skillId) || 'end_of_days';
        const curStock = prof.ultraStocks[skillId] || 0;
        let isDuplicate = false;
        let refundPt = 0;

        if (curStock >= GAME_RULES.GACHA.ULTRA_MAX_STOCK) {
            isDuplicate = true;
            refundPt = GAME_RULES.GACHA.ULTRA_DUPLICATE_REFUND;
            prof.points += refundPt;
        } else {
            prof.ultraStocks[skillId] = curStock + 1;
            if (!prof.equippedUltra) {
                prof.equippedUltra = skillId;
            }
        }

        const p = currentRoomId && rooms.get(currentRoomId) ? rooms.get(currentRoomId).players[socket.id] : null;
        if (p) {
            p.ultraStocks = { ...prof.ultraStocks };
            p.equippedUltra = prof.equippedUltra;
        }

        const out = buildProfilePayload(prof);
        socket.emit('ultraGachaResult', {
            ok: true,
            skillId,
            rarity: chosen.rarity,
            isDuplicate,
            refundPt,
            stocks: { ...prof.ultraStocks },
            profile: out
        });
        socket.emit('profileUpdated', out);
    });

    socket.on('equipUltraSkill', (payload) => {
        const data = payload || {};
        const prof = getOrCreateProfile(data.clientKey);
        const skillId = sanitizeUltraSkillId(data.skillId);
        if (!skillId) {
            prof.equippedUltra = null;
        } else if ((prof.ultraStocks[skillId] || 0) > 0) {
            prof.equippedUltra = skillId;
        }
        const p = currentRoomId && rooms.get(currentRoomId) ? rooms.get(currentRoomId).players[socket.id] : null;
        if (p) p.equippedUltra = prof.equippedUltra;
        socket.emit('profileUpdated', buildProfilePayload(prof));
    });

    socket.on('returnToLobby', (payload) => {
        const roomId = (payload && payload.roomId) || currentRoomId;
        if (!roomId || !rooms.has(roomId)) return;
        const room = rooms.get(roomId);
        clearRoomTimers(room);
        room.state = 'lobby';
        room.boss = null;
        room.serverProjectiles = [];
        room.magmaZones = [];
        room.timeStopUntil = 0;
        room.timeStopOwnerId = null;

        for (const id in room.players) {
            const p = room.players[id];
            resetPlayerCombatStatuses(p, Date.now());
        }
        io.to(roomId).emit('returnedToLobby', { players: room.players });
    });

    socket.on('disconnect', () => {
        if (currentRoomId && rooms.has(currentRoomId)) {
            const room = rooms.get(currentRoomId);
            const p = room.players[socket.id];
            if (p) clearPlayerTimers(p);
            delete room.players[socket.id];
            io.to(currentRoomId).emit('roomUpdated', { players: room.players });

            if (Object.keys(room.players).length === 0) {
                clearRoomTimers(room);
                rooms.delete(currentRoomId);
            } else if (room.state === 'playing') {
                checkMatchEndConditions(currentRoomId, room.matchId);
            }
        }
    });
});

server.listen(PORT, () => {
    console.log(`[Server] Listening on http://localhost:${PORT}`);
});