(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.BossSystem = factory();
    }
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    // =========================================================================
    // 1. 共通ルール定数（Single Source of Truth 用マスター定義）
    // =========================================================================
    const ARENA_WIDTH = 960;
    const ARENA_TOP = 28;
    const ARENA_HEIGHT = 720;
    const ARENA_CENTER_X = ARENA_WIDTH / 2;
    const ARENA_PLAY_CENTER_Y = ARENA_TOP + (ARENA_HEIGHT - ARENA_TOP) / 2;

    const MAX_PLAYERS = 4;
    const PLAYER_SIZE = 48;
    const PLAYER_BASE_MAX_HP = 100;
    const PLAYER_BASE_SPEED = 4.2;
    const PLAYER_BASE_SHOT_DAMAGE = 12;

    const STATIC_OBSTACLE_SIZE = 52;
    const STATIC_OBSTACLE_COUNT = 8;
    // 960x720（HUD 28px除き 960x692）に対称配置された壊せない岩8個
    const STATIC_OBSTACLES = Object.freeze([
        Object.freeze({ x: 150, y: 164, w: STATIC_OBSTACLE_SIZE, h: STATIC_OBSTACLE_SIZE }),
        Object.freeze({ x: ARENA_WIDTH - 150 - STATIC_OBSTACLE_SIZE, y: 164, w: STATIC_OBSTACLE_SIZE, h: STATIC_OBSTACLE_SIZE }),
        Object.freeze({ x: 266, y: 310, w: STATIC_OBSTACLE_SIZE, h: STATIC_OBSTACLE_SIZE }),
        Object.freeze({ x: ARENA_WIDTH - 266 - STATIC_OBSTACLE_SIZE, y: 310, w: STATIC_OBSTACLE_SIZE, h: STATIC_OBSTACLE_SIZE }),
        Object.freeze({ x: 266, y: 454, w: STATIC_OBSTACLE_SIZE, h: STATIC_OBSTACLE_SIZE }),
        Object.freeze({ x: ARENA_WIDTH - 266 - STATIC_OBSTACLE_SIZE, y: 454, w: STATIC_OBSTACLE_SIZE, h: STATIC_OBSTACLE_SIZE }),
        Object.freeze({ x: 150, y: 544, w: STATIC_OBSTACLE_SIZE, h: STATIC_OBSTACLE_SIZE }),
        Object.freeze({ x: ARENA_WIDTH - 150 - STATIC_OBSTACLE_SIZE, y: 544, w: STATIC_OBSTACLE_SIZE, h: STATIC_OBSTACLE_SIZE })
    ]);

    const BREAKABLE_WALL_SIZE = 40;
    const BREAKABLE_WALL_HP = 30;
    const BREAKABLE_WALL_MAX_PVP = 8;
    const BREAKABLE_WALL_MAX_BOSS = 4;

    const ITEMS = Object.freeze({
        speed: Object.freeze({
            id: 'speed',
            name: 'スピードアップ',
            durationMs: 5000,
            speedMultiplier: 1.4,
            color: '#00e5ff'
        }),
        heal: Object.freeze({
            id: 'heal',
            name: 'HP回復',
            healAmount: 40,
            color: '#2ecc71'
        }),
        power: Object.freeze({
            id: 'power',
            name: 'パワーアップ',
            durationMs: 5000,
            attackMultiplier: 1.5,
            color: '#ff6b6b'
        })
    });

    const ACTIONS = Object.freeze({
        shield: Object.freeze({
            key: 'KeyZ',
            label: 'Z',
            name: 'バリア',
            durationMs: 1200,
            cooldownMs: 4000
        }),
        slash: Object.freeze({
            key: 'KeyX',
            label: 'X',
            name: '斬撃',
            pvpMultiplier: 1.3,
            bossMultiplier: 1.35,
            cooldownMs: 600,
            range: 78
        }),
        shot: Object.freeze({
            key: 'KeyC',
            label: 'C',
            name: '玉',
            cooldownMs: 450,
            speed: 9.5
        }),
        ultra: Object.freeze({
            key: 'Space',
            label: 'Space',
            name: '必殺技',
            cooldownMs: 6000,
            maxStock: 3
        })
    });

    const GACHA = Object.freeze({
        INK_COST: 300,
        INK_DUPLICATE_REFUND: 100,
        ULTRA_COST: 1000,
        ULTRA_MAX_STOCK: 3,
        ULTRA_DUPLICATE_REFUND: 300
    });

    const SPECIAL_INKS = Object.freeze({
        SPECIAL_GOLD: Object.freeze({ id: 'SPECIAL_GOLD', name: 'ゴールドインク', group: 'light', isAnimatedInk: true }),
        SPECIAL_RAINBOW: Object.freeze({ id: 'SPECIAL_RAINBOW', name: 'レインボーインク', group: 'light', isAnimatedInk: true }),
        SPECIAL_VENOM: Object.freeze({ id: 'SPECIAL_VENOM', name: 'ヴェノムインク', group: 'dark', isAnimatedInk: true })
    });
    const SPECIAL_INK_IDS = Object.freeze(Object.keys(SPECIAL_INKS));
    const SPECIAL_INK_ELEMENT_THRESHOLD = 20;

    const GAME_RULES = Object.freeze({
        MAX_PLAYERS,
        PVP_TIME_LIMIT_SEC: 180,
        BOSS_TIME_LIMIT_SEC: 300,
        COUNTDOWN_SEC: 3,
        ARENA: Object.freeze({
            WIDTH: ARENA_WIDTH,
            TOP: ARENA_TOP,
            HEIGHT: ARENA_HEIGHT,
            CENTER_X: ARENA_CENTER_X,
            PLAY_CENTER_Y: ARENA_PLAY_CENTER_Y
        }),
        PLAYER: Object.freeze({
            SIZE: PLAYER_SIZE,
            BASE_MAX_HP: PLAYER_BASE_MAX_HP,
            BASE_SPEED: PLAYER_BASE_SPEED,
            BASE_SHOT_DAMAGE: PLAYER_BASE_SHOT_DAMAGE
        }),
        OBSTACLES: Object.freeze({
            STATIC_SIZE: STATIC_OBSTACLE_SIZE,
            STATIC_COUNT: STATIC_OBSTACLE_COUNT,
            BREAKABLE_SIZE: BREAKABLE_WALL_SIZE,
            BREAKABLE_HP: BREAKABLE_WALL_HP,
            BREAKABLE_MAX_PVP: BREAKABLE_WALL_MAX_PVP,
            BREAKABLE_MAX_BOSS: BREAKABLE_WALL_MAX_BOSS
        }),
        ITEMS,
        ACTIONS,
        GACHA,
        ELEMENT: Object.freeze({
            SPECIAL_INK_THRESHOLD: SPECIAL_INK_ELEMENT_THRESHOLD,
            NORMAL_TIEBREAK_ORDER: Object.freeze(['fire', 'water', 'grass', 'thunder', 'rock']),
            ADVANTAGE_MULTIPLIER: 1.4,
            DISADVANTAGE_MULTIPLIER: 0.75,
            LIGHT_DARK_MUTUAL_MULTIPLIER: 1.5,
            NEUTRAL_MULTIPLIER: 1.0
        })
    });

    // =========================================================================
    // 2. 属性システム（判定ルール・パレット対応・相性倍率テーブル）
    // =========================================================================
    const ELEMENT_META = Object.freeze({
        fire: Object.freeze({ id: 'fire', name: '炎', icon: '🔥', color: '#ff5722', bg: 'rgba(255, 87, 34, 0.2)' }),
        water: Object.freeze({ id: 'water', name: '水', icon: '💧', color: '#00b4d8', bg: 'rgba(0, 180, 216, 0.2)' }),
        grass: Object.freeze({ id: 'grass', name: '草', icon: '🌿', color: '#2ecc71', bg: 'rgba(46, 204, 113, 0.2)' }),
        thunder: Object.freeze({ id: 'thunder', name: '電気', icon: '⚡', color: '#ffd60a', bg: 'rgba(255, 214, 10, 0.2)' }),
        rock: Object.freeze({ id: 'rock', name: '岩', icon: '🪨', color: '#b97a57', bg: 'rgba(185, 122, 87, 0.2)' }),
        light: Object.freeze({ id: 'light', name: '光', icon: '✨', color: '#fff3b0', bg: 'rgba(255, 243, 176, 0.22)' }),
        dark: Object.freeze({ id: 'dark', name: '闇', icon: '🌑', color: '#a349a4', bg: 'rgba(163, 73, 164, 0.24)' }),
        neutral: Object.freeze({ id: 'neutral', name: '無', icon: '⚪', color: '#cbd5e1', bg: 'rgba(203, 213, 225, 0.16)' })
    });

    const VALID_COMBAT_ELEMENTS = Object.freeze(['fire', 'water', 'grass', 'thunder', 'rock', 'light', 'dark']);
    const NORMAL_TIEBREAK_ORDER = GAME_RULES.ELEMENT.NORMAL_TIEBREAK_ORDER;

    const ELEMENT_COLOR_MAP = Object.freeze({
        fire: Object.freeze(['#ed1c24', '#ff7f27', '#880015', '#ff2a00', '#ffaec9']),
        water: Object.freeze(['#00a2e8', '#3f48cc', '#7df9ff', '#00ffff']),
        grass: Object.freeze(['#22b14c', '#98ff98']),
        thunder: Object.freeze(['#fff200', '#ffc90e']),
        rock: Object.freeze(['#b97a57', '#7f7f7f', '#c3c3c3']),
        light: Object.freeze(['#ffffff']),
        dark: Object.freeze(['#000000', '#a349a4', '#2b1b3d'])
    });

    // 5すくみリング: fire > grass > rock > thunder > water > fire
    const ELEMENT_BEATS_MAP = Object.freeze({
        fire: 'grass',
        grass: 'rock',
        rock: 'thunder',
        thunder: 'water',
        water: 'fire'
    });

    const COLOR_TO_ELEMENT_LOOKUP = (() => {
        const map = Object.create(null);
        for (const el of NORMAL_TIEBREAK_ORDER) {
            for (const hex of ELEMENT_COLOR_MAP[el]) {
                map[hex.toLowerCase()] = el;
            }
        }
        map['#a349a4'] = 'dark';
        map['#2b1b3d'] = 'dark';
        return map;
    })();

    function normalizeInkToken(raw) {
        if (typeof raw !== 'string') return '';
        const trimmed = raw.trim();
        if (!trimmed) return '';
        if (Object.prototype.hasOwnProperty.call(SPECIAL_INKS, trimmed)) {
            return trimmed;
        }
        return trimmed.toLowerCase();
    }

    function sanitizeElementId(raw) {
        if (typeof raw !== 'string') return 'neutral';
        const lower = raw.trim().toLowerCase();
        if (Object.prototype.hasOwnProperty.call(ELEMENT_META, lower)) {
            return lower;
        }
        return 'neutral';
    }

    function getElementInfo(elementId) {
        return ELEMENT_META[sanitizeElementId(elementId)] || ELEMENT_META.neutral;
    }

    /**
     * 32x32ピクセル配列（1次元または2次元）から基礎属性（element）を算出する。
     * 設計書 3章・4.2章と完全一致：
     * 1. 特別インク3種合計 >= 20ドットなら光（GOLD+RAINBOW）vs 闇（VENOM）で判定（同数は light 優先）
     * 2. 20ドット未満は白（#ffffff）・黒（#000000）を除く最多使用色から通常5属性を決定
     *    （同数タイブレーク：fire > water > grass > thunder > rock）
     * 3. 通常5属性が0ドットで紫系闇色がある場合は dark、白黒のみの場合は単色主体で light / dark、無色・未登録色のみは neutral（1.0倍）
     */
    function determineElementFromPixels(pixels) {
        if (!Array.isArray(pixels)) return 'neutral';

        const flat = Array.isArray(pixels[0]) ? pixels.flat() : pixels;
        let specialLightCount = 0;
        let specialDarkCount = 0;
        let whiteCount = 0;
        let blackCount = 0;
        let darkPurpleCount = 0;

        const normalCounts = {
            fire: 0,
            water: 0,
            grass: 0,
            thunder: 0,
            rock: 0
        };

        for (let i = 0; i < flat.length; i++) {
            const token = normalizeInkToken(flat[i]);
            if (!token || token === 'transparent' || token === 'none') continue;

            if (token === 'SPECIAL_GOLD' || token === 'SPECIAL_RAINBOW') {
                specialLightCount++;
                continue;
            }
            if (token === 'SPECIAL_VENOM') {
                specialDarkCount++;
                continue;
            }
            if (token === '#ffffff') {
                whiteCount++;
                continue;
            }
            if (token === '#000000') {
                blackCount++;
                continue;
            }

            const mapped = COLOR_TO_ELEMENT_LOOKUP[token];
            if (mapped === 'dark') {
                darkPurpleCount++;
            } else if (mapped && Object.prototype.hasOwnProperty.call(normalCounts, mapped)) {
                normalCounts[mapped]++;
            }
        }

        const totalSpecial = specialLightCount + specialDarkCount;
        if (totalSpecial >= SPECIAL_INK_ELEMENT_THRESHOLD) {
            return specialLightCount >= specialDarkCount ? 'light' : 'dark';
        }

        let bestNormal = null;
        let bestCount = 0;
        for (const el of NORMAL_TIEBREAK_ORDER) {
            const count = normalCounts[el];
            if (count > bestCount) {
                bestCount = count;
                bestNormal = el;
            }
        }
        if (bestNormal && bestCount > 0) {
            return bestNormal;
        }

        if (darkPurpleCount > 0) {
            return 'dark';
        }

        if (whiteCount > 0 || blackCount > 0) {
            return whiteCount >= blackCount ? 'light' : 'dark';
        }

        return 'neutral';
    }

    /**
     * (攻撃属性, 防御属性) の最終ダメージ倍率を返す。
     */
    function getElementMultiplier(attackerElement, defenderElement) {
        const atk = sanitizeElementId(attackerElement);
        const def = sanitizeElementId(defenderElement);

        if (atk === 'neutral' || def === 'neutral' || atk === def) {
            return GAME_RULES.ELEMENT.NEUTRAL_MULTIPLIER;
        }

        if ((atk === 'light' && def === 'dark') || (atk === 'dark' && def === 'light')) {
            return GAME_RULES.ELEMENT.LIGHT_DARK_MUTUAL_MULTIPLIER;
        }

        if (atk === 'light' || atk === 'dark' || def === 'light' || def === 'dark') {
            return GAME_RULES.ELEMENT.NEUTRAL_MULTIPLIER;
        }

        if (ELEMENT_BEATS_MAP[atk] === def) {
            return GAME_RULES.ELEMENT.ADVANTAGE_MULTIPLIER;
        }

        if (ELEMENT_BEATS_MAP[def] === atk) {
            return GAME_RULES.ELEMENT.DISADVANTAGE_MULTIPLIER;
        }

        return GAME_RULES.ELEMENT.NEUTRAL_MULTIPLIER;
    }

    // =========================================================================
    // 3. ウルトラガチャ（必殺技）データ駆動定義
    // =========================================================================
    const ULTRA_SKILLS = Object.freeze({
        end_of_days: Object.freeze({
            id: 'end_of_days',
            name: '終焉の一閃',
            type: 'line_burst',
            rarity: 'S',
            tag: '高火力・直線',
            icon: '⚔️',
            color: '#ff4d6d',
            description: '550msの溜めの後、前方直線へ通常攻撃約2.5倍の高威力斬撃光線を放つ（バリアZで防御可）',
            chargeMs: 550,
            stanceMs: 0,
            warnMs: 0,
            durationMs: 260,
            cooldownMs: ACTIONS.ultra.cooldownMs,
            maxStock: GACHA.ULTRA_MAX_STOCK,
            damageMultiplier: 2.5,
            range: 560,
            halfWidth: 28,
            guardableByBarrier: true
        }),
        absolute_wall: Object.freeze({
            id: 'absolute_wall',
            name: '絶対防壁',
            type: 'barrier',
            rarity: 'A',
            tag: '防御・立て直し',
            icon: '🛡️',
            color: '#00e5ff',
            description: '2600msの間、あらゆる攻撃ダメージを無効化しノックバックと吸引を大幅軽減する',
            chargeMs: 0,
            stanceMs: 0,
            warnMs: 0,
            durationMs: 2600,
            cooldownMs: ACTIONS.ultra.cooldownMs,
            maxStock: GACHA.ULTRA_MAX_STOCK,
            damageMultiplier: 0,
            pullMultiplier: 0.15,
            knockbackMultiplier: 0.15,
            guardableByBarrier: false
        }),
        perfect_counter: Object.freeze({
            id: 'perfect_counter',
            name: '完全反撃',
            type: 'counter',
            rarity: 'S',
            tag: 'カウンター',
            icon: '⚡',
            color: '#ffd60a',
            description: '1800ms構え、攻撃を受けると被ダメ0で無効化し約2.8倍の強烈な反撃を放つ',
            chargeMs: 0,
            stanceMs: 1800,
            warnMs: 0,
            durationMs: 1800,
            cooldownMs: ACTIONS.ultra.cooldownMs,
            maxStock: GACHA.ULTRA_MAX_STOCK,
            damageMultiplier: 2.8,
            counterRadius: 210,
            guardableByBarrier: true
        }),
        sky_meteor: Object.freeze({
            id: 'sky_meteor',
            name: '天空隕石',
            type: 'aoe_meteor',
            rarity: 'A',
            tag: '範囲・予兆',
            icon: '☄️',
            color: '#ff9f43',
            description: '自機前方エリア（半径100px）へ800msの予兆後に隕石を落下させ範囲大ダメージ',
            chargeMs: 0,
            stanceMs: 0,
            warnMs: 800,
            durationMs: 320,
            cooldownMs: ACTIONS.ultra.cooldownMs,
            maxStock: GACHA.ULTRA_MAX_STOCK,
            damageMultiplier: 2.45,
            castDistance: 165,
            radius: 100,
            guardableByBarrier: true
        })
    });

    const ULTRA_SKILL_ORDER = Object.freeze(['end_of_days', 'absolute_wall', 'perfect_counter', 'sky_meteor']);

    function sanitizeUltraSkillId(skillId) {
        if (typeof skillId === 'string' && Object.prototype.hasOwnProperty.call(ULTRA_SKILLS, skillId)) {
            return skillId;
        }
        return null;
    }

    function getUltraSkillDef(skillId) {
        const safeId = sanitizeUltraSkillId(skillId);
        return safeId ? ULTRA_SKILLS[safeId] : null;
    }

    function getAllUltraSkills() {
        return ULTRA_SKILL_ORDER.map((id) => ULTRA_SKILLS[id]);
    }

    // =========================================================================
    // 4. BOSS・ステージ定義（データ駆動・STAGE 1〜3）
    // =========================================================================
    const BOSS_SPIRAL_DAMAGE = 15;      // 渦巻き弾幕
    const BOSS_HOMING_DAMAGE = 12;      // 追尾ミサイル
    const BOSS_DRAGON_FIRE_DAMAGE = 20; // ドラゴン火炎弾

    const BOSS_CATALOG = {
        void_typhoon: {
            id: 'void_typhoon',
            stageNumber: 1,
            stageId: 'stage_1',
            name: 'water cyclone',
            tag: '🌀 渦潮・吸引型',
            element: 'water',
            summary: '渦巻き弾幕とブラックホール吸引で翻弄する嵐の化身',
            radius: 44, // ボスの当たり判定半径（px）
            spawnX: ARENA_CENTER_X, // ステージ1のボスは中央に出現する
            spawnY: 175,        // ステージ1のボスは上方に出現する
            maxHp: 800, // 1人時の基準HP（0より大きい値）
            hpByPlayers: { 1: 800, 2: 1600, 3: 2400, 4: 3200 }, // 参加人数(1〜4人)ごとのHP
            speed: 2.8,     // フェーズ1移動速度（1人プレイ時）
            moveSpeed: {
                soloP1: 2.8,    // フェーズ1移動速度（1人プレイ時）
                multiP1: 2.4,   // フェーズ1移動速度（2〜4人プレイ時）
                soloP2: 4.0,    // フェーズ2移動速度（1人プレイ時）
                multiP2: 6.0    // フェーズ2移動速度（2〜4人プレイ時）
            },
            attackIntervalMs: {
                p1: 2450,   // フェーズ1攻撃間隔
                p2: 1750    // フェーズ2攻撃間隔
            },
            attackProjectiles: ['spiral'],  // フェーズ1攻撃パターンの弾種（spiral, slash, vortex, pulse）
            projectileDamage: {         // フェーズ1攻撃パターンの弾種ごとのダメージ
                spiral: BOSS_SPIRAL_DAMAGE 
            },
            attackPatterns: [
                { id: 'spiral', name: '渦巻き弾幕', damage: BOSS_SPIRAL_DAMAGE },
                { id: 'slash', name: '虚空斬撃', damage: 40 },
                { id: 'vortex', name: 'ブラックホール吸引', damage: 2 },
                { id: 'pulse', name: '重力パルス爆発', damage: 26 }
            ],
            patternCount: 4, // 攻撃パターンの種類数（0〜3の4パターンを順番に繰り返す）
            executeAttack(ctx) {// 攻撃パターンの実行（サーバー側で呼び出される）
                const {
                    room, roomId, matchId, boss, allPlayerCount, targetCx, targetCy,
                    count, io, registerTimeout, pointToSegmentDistance, applyDamageToPlayer
                } = ctx;
                const patternIdx = count % 4;

                if (patternIdx === 0) {
                    const baseCount = boss.phase === 2 ? 11 : 9;
                    const extraBulletsByPlayers = (allPlayerCount - 1) * 3;
                    const bulletCount = baseCount + extraBulletsByPlayers;

                    boss.spiralAngle = (boss.spiralAngle + 0.45) % (Math.PI * 2);
                    room.lastBossAttackAt = Object.assign({}, room.lastBossAttackAt, { spiral: Date.now() });
                    io.to(roomId).emit('bossAttackEvent', {
                        bossId: boss.id,
                        element: boss.element,
                        type: 'spiral',
                        x: boss.x,
                        y: boss.y,
                        count: bulletCount,
                        baseAngle: boss.spiralAngle,
                        speed: boss.phase === 2 ? 4.6 : 3.9,
                        damage: BOSS_SPIRAL_DAMAGE
                    });
                } else if (patternIdx === 1) {  // 斬撃レーザー
                    const startX = boss.x;
                    const startY = boss.y;
                    const angle = Math.atan2(targetCy - startY, targetCx - startX);
                    const length = 480; // 斬撃レーザーの長さ（px）
                    const endX = startX + Math.cos(angle) * length;
                    const endY = startY + Math.sin(angle) * length;
                    const warnDuration = boss.phase === 2 ? 680 : 750;

                    io.to(roomId).emit('bossAttackEvent', {// 斬撃レーザーの予告表示
                        bossId: boss.id,
                        element: boss.element,
                        type: 'slash_warn',
                        x1: startX, y1: startY, x2: endX, y2: endY,
                        warnDuration
                    });

                    registerTimeout(room, () => {
                        const cur = ctx.getRoom();
                        if (!cur || cur.state !== 'playing' || cur.matchId !== matchId || !cur.boss) return;
                        io.to(roomId).emit('bossAttackEvent', {
                            bossId: cur.boss.id,
                            element: cur.boss.element,
                            type: 'slash_fire',
                            x1: startX, y1: startY, x2: endX, y2: endY,
                            damage: 40  // 斬撃レーザーのダメージ
                        });
                        for (const id in cur.players) {
                            const p = cur.players[id];
                            if (p.isDead || p.isEliminated) continue;
                            if (pointToSegmentDistance(p.x + 24, p.y + 24, startX, startY, endX, endY) < 28) {
                                applyDamageToPlayer(roomId, p, 40, 'slash', matchId, cur.boss.element);
                            }
                        }
                    }, warnDuration);
                } else if (patternIdx === 2) {
                    const duration = boss.phase === 2 ? 3400 : 3800;
                    boss.vortexActive = true;
                    io.to(roomId).emit('bossAttackEvent', {
                        bossId: boss.id,
                        element: boss.element,
                        type: 'vortex',
                        active: true,
                        duration,
                        pullStrength: boss.phase === 2 ? 1.95 : 1.55
                    });

                    registerTimeout(room, () => {
                        const cur = ctx.getRoom();
                        if (cur && cur.matchId === matchId && cur.boss) {
                            cur.boss.vortexActive = false;
                        }
                    }, duration);
                } else {
                    boss.pulseCharging = true;
                    const pulseRadius = boss.phase === 2 ? 225 : 195;
                    const chargeDuration = boss.phase === 2 ? 800 : 900;

                    io.to(roomId).emit('bossAttackEvent', {
                        bossId: boss.id,
                        element: boss.element,
                        type: 'pulse_warn',
                        x: boss.x, y: boss.y, radius: pulseRadius,
                        chargeDuration
                    });

                    registerTimeout(room, () => {
                        const cur = ctx.getRoom();
                        if (!cur || cur.state !== 'playing' || cur.matchId !== matchId || !cur.boss) return;
                        cur.boss.pulseCharging = false;
                        io.to(roomId).emit('bossAttackEvent', {
                            bossId: cur.boss.id,
                            element: cur.boss.element,
                            type: 'pulse_fire',
                            x: cur.boss.x, y: cur.boss.y, radius: pulseRadius,
                            damage: 26
                        });
                        for (const id in cur.players) {
                            const p = cur.players[id];
                            if (p.isDead || p.isEliminated) continue;
                            if (Math.hypot((p.x + 24) - cur.boss.x, (p.y + 24) - cur.boss.y) <= pulseRadius) {
                                applyDamageToPlayer(roomId, p, 26, 'pulse', matchId, cur.boss.element);
                            }
                        }
                    }, chargeDuration);
                }
            },
            drawEntity(ctx, boss, now, helpers) {
                const isRage = boss.phase === 2;
                const bx = boss.x;
                const by = boss.y;

                ctx.save();
                if (helpers && now < helpers.vortexUntil) {
                    const spin = now / 180;
                    for (let ring = 1; ring <= 4; ring++) {
                        ctx.beginPath();
                        ctx.arc(bx, by, 65 * ring, spin + ring, spin + ring + Math.PI * 1.4);
                        ctx.strokeStyle = isRage ? 'rgba(255, 42, 0, 0.25)' : 'rgba(0, 180, 216, 0.28)';
                        ctx.lineWidth = 6;
                        ctx.stroke();
                    }
                }

                const armCount = 4;
                const rot = now / (isRage ? 220 : 350);
                for (let a = 0; a < armCount; a++) {
                    const startAng = rot + (Math.PI * 2 / armCount) * a;
                    ctx.beginPath();
                    ctx.arc(bx, by, boss.radius + 14, startAng, startAng + 1.1);
                    ctx.strokeStyle = isRage ? 'rgba(255, 60, 40, 0.7)' : 'rgba(0, 210, 255, 0.7)';
                    ctx.lineWidth = 7;
                    ctx.stroke();
                }

                ctx.beginPath();
                ctx.ellipse(bx, by, boss.radius + 10, 18, Math.sin(now / 500) * 0.25, 0, Math.PI * 2);
                ctx.strokeStyle = isRage ? '#ff6b6b' : '#4cc9f0';
                ctx.lineWidth = 4;
                ctx.stroke();

                const grad = ctx.createRadialGradient(bx, by, 10, bx, by, boss.radius);
                grad.addColorStop(0, '#000000');
                grad.addColorStop(0.7, '#061a40');
                grad.addColorStop(1, isRage ? '#880015' : '#0077b6');

                ctx.beginPath();
                ctx.arc(bx, by, boss.radius, 0, Math.PI * 2);
                ctx.fillStyle = grad;
                ctx.fill();
                ctx.lineWidth = 3;
                ctx.strokeStyle = isRage ? '#ff2a00' : '#00ffff';
                ctx.stroke();

                ctx.fillStyle = isRage ? '#ff2a00' : '#00ffff';
                ctx.fillRect(bx - 18, by - 8, 12, 6);
                ctx.fillRect(bx + 6, by - 8, 12, 6);
                ctx.restore();
            }
        },

        omega_core: {
            id: 'omega_core',
            stageNumber: 2,
            stageId: 'stage_2',
            name: 'OMEGA CORE',
            tag: '🤖 古代兵器・要塞型',
            element: 'thunder',
            summary: '追尾ミサイル＆薙ぎ払いレーザー＋古代バリアを展開する重装コア',
            radius: 42,
            spawnX: ARENA_CENTER_X,
            spawnY: 165,
            maxHp: 1500,
            hpByPlayers: { 1: 1500, 2: 3000, 3: 4500, 4: 6000 },
            speed: 2.2,
            barrierDamageMultiplier: 0.45,
            moveSpeed: {
                soloP1: 2.2,
                multiP1: 3.0,
                soloP2: 4.0,
                multiP2: 6.0,
            },
            attackIntervalMs: {
                p1: 2050,   // フェーズ1攻撃間隔
                p2: 1050    // フェーズ2攻撃間隔
            },
            attackProjectiles: ['homing'],
            projectileDamage: {
                homing: BOSS_HOMING_DAMAGE
            },
            attackPatterns: [
                { id: 'homing', name: '追尾ミサイル', damage: BOSS_HOMING_DAMAGE },
                { id: 'laser', name: '薙ぎ払いレーザー', damage: 40 },
                { id: 'barrier', name: '古代イージスバリア', damage: 0 }
            ],
            patternCount: 4,
            executeAttack(ctx) {
                const {
                    room, roomId, matchId, boss, alivePlayers, targetCx, targetCy,
                    count, io, registerTimeout, pointToSegmentDistance, applyDamageToPlayer
                } = ctx;
                const patternIdx = count % 4;

                if (patternIdx === 0 || patternIdx === 3) {
                    const missileCount = (boss.phase === 2 ? 3 : 2) + Math.min(2, Math.max(0, alivePlayers.length - 1));
                    const baseAngle = Math.atan2(targetCy - boss.y, targetCx - boss.x);
                    const spread = 0.34;
                    const missiles = [];

                    for (let i = 0; i < missileCount; i++) {
                        const offset = (i - (missileCount - 1) / 2) * spread;
                        const ang = baseAngle + offset;
                        missiles.push({
                            x: boss.x + Math.cos(ang) * (boss.radius + 8),
                            y: boss.y + Math.sin(ang) * (boss.radius + 8),
                            vx: Math.cos(ang) * (boss.phase === 2 ? 3.5 : 3.0),
                            vy: Math.sin(ang) * (boss.phase === 2 ? 3.5 : 3.0),
                            turnRate: boss.phase === 2 ? 0.055 : 0.042,
                            speed: boss.phase === 2 ? 3.9 : 3.3,
                            damage: BOSS_HOMING_DAMAGE
                        });
                    }

                    room.lastBossAttackAt = Object.assign({}, room.lastBossAttackAt, { homing: Date.now() });
                    io.to(roomId).emit('bossAttackEvent', {
                        bossId: boss.id,
                        element: boss.element,
                        type: 'homing',
                        missiles,
                        damage: BOSS_HOMING_DAMAGE
                    });
                } else if (patternIdx === 1) {
                    const originX = boss.x;
                    const originY = boss.y;
                    const centerAngle = Math.atan2(targetCy - originY, targetCx - originX);
                    const sweepHalfAngle = boss.phase === 2 ? 0.68 : 0.52;
                    const startAngle = centerAngle - sweepHalfAngle;
                    const endAngle = centerAngle + sweepHalfAngle;
                    const length = 500;
                    const warnDuration = boss.phase === 2 ? 720 : 820;

                    io.to(roomId).emit('bossAttackEvent', {
                        bossId: boss.id,
                        element: boss.element,
                        type: 'laser_warn',
                        x: originX,
                        y: originY,
                        startAngle,
                        endAngle,
                        length,
                        warnDuration
                    });

                    registerTimeout(room, () => {
                        const cur = ctx.getRoom();
                        if (!cur || cur.state !== 'playing' || cur.matchId !== matchId || !cur.boss) return;

                        const fireX = cur.boss.x;
                        const fireY = cur.boss.y;
                        io.to(roomId).emit('bossAttackEvent', {
                            bossId: cur.boss.id,
                            element: cur.boss.element,
                            type: 'laser_fire',
                            x: fireX,
                            y: fireY,
                            startAngle,
                            endAngle,
                            length,
                            damage: 40
                        });

                        const steps = 6;
                        for (const id in cur.players) {
                            const p = cur.players[id];
                            if (p.isDead || p.isEliminated) continue;
                            const px = p.x + 24;
                            const py = p.y + 24;
                            let hitLaser = false;
                            for (let s = 0; s <= steps; s++) {
                                const a = startAngle + ((endAngle - startAngle) * s) / steps;
                                const lx = fireX + Math.cos(a) * length;
                                const ly = fireY + Math.sin(a) * length;
                                if (pointToSegmentDistance(px, py, fireX, fireY, lx, ly) < 26) {
                                    hitLaser = true;
                                    break;
                                }
                            }
                            if (hitLaser) {
                                applyDamageToPlayer(roomId, p, 22, 'laser', matchId, cur.boss.element);
                            }
                        }
                    }, warnDuration);
                } else {
                    const duration = boss.phase === 2 ? 5200 : 4800;    // バリア展開時間
                    boss.barrierActive = true;
                    io.to(roomId).emit('bossStateUpdated', boss);
                    io.to(roomId).emit('bossAttackEvent', {
                        bossId: boss.id,
                        element: boss.element,
                        type: 'barrier_on',
                        duration
                    });

                    registerTimeout(room, () => {
                        const cur = ctx.getRoom();
                        if (cur && cur.matchId === matchId && cur.boss) {
                            cur.boss.barrierActive = false;
                            io.to(roomId).emit('bossStateUpdated', cur.boss);
                            io.to(roomId).emit('bossAttackEvent', {
                                bossId: cur.boss.id,
                                element: cur.boss.element,
                                type: 'barrier_off'
                            });
                        }
                    }, duration);
                }
            },
            drawEntity(ctx, boss, now) {
                const isRage = boss.phase === 2;
                const bx = boss.x;
                const by = boss.y;

                ctx.save();

                if (boss.barrierActive) {
                    const pulse = Math.sin(now / 120) * 4;
                    ctx.beginPath();
                    ctx.arc(bx, by, boss.radius + 22 + pulse, 0, Math.PI * 2);
                    ctx.fillStyle = 'rgba(0, 229, 255, 0.14)';
                    ctx.fill();
                    ctx.lineWidth = 3.5;
                    ctx.strokeStyle = '#00e5ff';
                    ctx.setLineDash([10, 6]);
                    ctx.stroke();
                    ctx.setLineDash([]);
                }

                const rot = now / (isRage ? 420 : 750);
                ctx.save();
                ctx.translate(bx, by);
                ctx.rotate(rot);
                ctx.strokeStyle = isRage ? '#ff7675' : '#ffd60a';
                ctx.lineWidth = 3;
                for (let i = 0; i < 6; i++) {
                    const a = (Math.PI / 3) * i;
                    ctx.beginPath();
                    ctx.arc(0, 0, boss.radius + 10, a + 0.12, a + Math.PI / 3 - 0.12);
                    ctx.stroke();
                }
                ctx.restore();

                ctx.beginPath();
                for (let i = 0; i < 8; i++) {
                    const a = (Math.PI / 4) * i + Math.PI / 8;
                    const px = bx + Math.cos(a) * boss.radius;
                    const py = by + Math.sin(a) * boss.radius;
                    if (i === 0) ctx.moveTo(px, py);
                    else ctx.lineTo(px, py);
                }
                ctx.closePath();
                ctx.fillStyle = isRage ? '#2d132c' : '#1b263b';
                ctx.fill();
                ctx.lineWidth = 3.5;
                ctx.strokeStyle = isRage ? '#ff4757' : '#f1c40f';
                ctx.stroke();

                const eyeR = 11 + Math.sin(now / 160) * 2;
                ctx.beginPath();
                ctx.arc(bx, by, eyeR, 0, Math.PI * 2);
                ctx.fillStyle = boss.barrierActive ? '#00e5ff' : (isRage ? '#ff2a00' : '#ff9f43');
                ctx.fill();

                ctx.restore();
            }
        },

        inferno_dragon: {
            id: 'inferno_dragon',
            stageNumber: 3,
            stageId: 'stage_3',
            name: 'INFERNO DRAGON',
            tag: '🐉 紅蓮竜・覇王型',
            element: 'fire',
            summary: '灼熱ブレス・クロス竜爪斬撃・流星火柱で焼き払う終末のドラゴン',
            radius: 46,
            spawnX: ARENA_CENTER_X,
            spawnY: 160,
            maxHp: 760,
            hpByPlayers: { 1: 760, 2: 1480, 3: 2100, 4: 2680 },
            speed: 2.6,
            moveSpeed: {
                soloP1: 2.6,
                multiP1: 2.3,
                soloP2: 3.6,
                multiP2: 3.2
            },
            attackIntervalMs: {
                p1: 2300,
                p2: 1850
            },
            attackProjectiles: ['fireball'],
            projectileDamage: {
                fireball: BOSS_DRAGON_FIRE_DAMAGE
            },
            attackPatterns: [
                { id: 'breath', name: '灼熱ドラゴンブレス', damage: BOSS_DRAGON_FIRE_DAMAGE },
                { id: 'claw', name: 'クロス竜爪斬撃', damage: 24 },
                { id: 'meteor', name: '煉獄メテオピラー', damage: 26 },
                { id: 'roar', name: '覇竜の咆哮リング', damage: 22 }
            ],
            patternCount: 4,
            executeAttack(ctx) {
                const {
                    room, roomId, matchId, boss, alivePlayers, targetCx, targetCy,
                    count, io, registerTimeout, pointToSegmentDistance, applyDamageToPlayer
                } = ctx;
                const patternIdx = count % 4;

                if (patternIdx === 0) {
                    // 灼熱ブレス：扇状に炎弾を連射
                    const countShots = (boss.phase === 2 ? 7 : 5) + Math.min(2, Math.max(0, alivePlayers.length - 1));
                    const baseAngle = Math.atan2(targetCy - boss.y, targetCx - boss.x);
                    const totalSpread = boss.phase === 2 ? 1.25 : 0.95;
                    const speed = boss.phase === 2 ? 4.8 : 4.2;

                    room.lastBossAttackAt = Object.assign({}, room.lastBossAttackAt, { fireball: Date.now() });
                    io.to(roomId).emit('bossAttackEvent', {
                        bossId: boss.id,
                        element: boss.element,
                        type: 'breath',
                        x: boss.x,
                        y: boss.y,
                        baseAngle,
                        spread: totalSpread,
                        count: countShots,
                        speed,
                        damage: BOSS_DRAGON_FIRE_DAMAGE
                    });
                } else if (patternIdx === 1) {
                    // クロス竜爪斬撃：ターゲット方向を中心に2本の交差ラインを予兆後斬り裂く
                    const startX = boss.x;
                    const startY = boss.y;
                    const centerAng = Math.atan2(targetCy - startY, targetCx - startX);
                    const length = 500;
                    const offsetAngle = 0.24;
                    const lines = [
                        {
                            x1: startX,
                            y1: startY,
                            x2: startX + Math.cos(centerAng - offsetAngle) * length,
                            y2: startY + Math.sin(centerAng - offsetAngle) * length
                        },
                        {
                            x1: startX,
                            y1: startY,
                            x2: startX + Math.cos(centerAng + offsetAngle) * length,
                            y2: startY + Math.sin(centerAng + offsetAngle) * length
                        }
                    ];
                    const warnDuration = boss.phase === 2 ? 650 : 760;

                    io.to(roomId).emit('bossAttackEvent', {
                        bossId: boss.id,
                        element: boss.element,
                        type: 'claw_warn',
                        lines,
                        warnDuration
                    });

                    registerTimeout(room, () => {
                        const cur = ctx.getRoom();
                        if (!cur || cur.state !== 'playing' || cur.matchId !== matchId || !cur.boss) return;

                        io.to(roomId).emit('bossAttackEvent', {
                            bossId: cur.boss.id,
                            element: cur.boss.element,
                            type: 'claw_fire',
                            lines,
                            damage: 24
                        });

                        for (const id in cur.players) {
                            const p = cur.players[id];
                            if (p.isDead || p.isEliminated) continue;
                            const px = p.x + 24;
                            const py = p.y + 24;
                            const hit = lines.some((ln) => pointToSegmentDistance(px, py, ln.x1, ln.y1, ln.x2, ln.y2) < 28);
                            if (hit) {
                                applyDamageToPlayer(roomId, p, 24, 'claw', matchId, cur.boss.element);
                            }
                        }
                    }, warnDuration);
                } else if (patternIdx === 2) {
                    // 煉獄メテオピラー：生存プレイヤーの現在地付近へ落下予兆
                    const zones = [];
                    const radius = boss.phase === 2 ? 96 : 84;
                    const candidates = alivePlayers.length > 0 ? alivePlayers : [{ x: targetCx - 24, y: targetCy - 24 }];
                    for (let i = 0; i < candidates.length; i++) {
                        const pl = candidates[i];
                        zones.push({
                            x: Math.max(80, Math.min(ARENA_WIDTH - 80, pl.x + 24)),
                            y: Math.max(ARENA_TOP + 80, Math.min(ARENA_HEIGHT - 80, pl.y + 24)),
                            radius
                        });
                    }
                    if (boss.phase === 2) {
                        zones.push({
                            x: Math.max(90, Math.min(ARENA_WIDTH - 90, boss.x + (Math.random() * 240 - 120))),
                            y: Math.max(ARENA_TOP + 90, Math.min(ARENA_HEIGHT - 90, boss.y + 150)),
                            radius
                        });
                    }
                    const warnDuration = boss.phase === 2 ? 780 : 900;

                    io.to(roomId).emit('bossAttackEvent', {
                        bossId: boss.id,
                        element: boss.element,
                        type: 'meteor_warn',
                        zones,
                        warnDuration
                    });

                    registerTimeout(room, () => {
                        const cur = ctx.getRoom();
                        if (!cur || cur.state !== 'playing' || cur.matchId !== matchId || !cur.boss) return;

                        io.to(roomId).emit('bossAttackEvent', {
                            bossId: cur.boss.id,
                            element: cur.boss.element,
                            type: 'meteor_fire',
                            zones,
                            damage: 26
                        });

                        for (const id in cur.players) {
                            const p = cur.players[id];
                            if (p.isDead || p.isEliminated) continue;
                            const px = p.x + 24;
                            const py = p.y + 24;
                            const hit = zones.some((z) => Math.hypot(px - z.x, py - z.y) <= z.radius);
                            if (hit) {
                                applyDamageToPlayer(roomId, p, 26, 'meteor', matchId, cur.boss.element);
                            }
                        }
                    }, warnDuration);
                } else {
                    // 覇竜の咆哮リング：全方位火球＋衝撃波
                    const ringRadius = boss.phase === 2 ? 235 : 200;
                    const warnDuration = boss.phase === 2 ? 750 : 850;
                    const ox = boss.x;
                    const oy = boss.y;

                    io.to(roomId).emit('bossAttackEvent', {
                        bossId: boss.id,
                        element: boss.element,
                        type: 'roar_warn',
                        x: ox,
                        y: oy,
                        radius: ringRadius,
                        warnDuration
                    });

                    registerTimeout(room, () => {
                        const cur = ctx.getRoom();
                        if (!cur || cur.state !== 'playing' || cur.matchId !== matchId || !cur.boss) return;

                        const fx = cur.boss.x;
                        const fy = cur.boss.y;
                        const fireCount = cur.boss.phase === 2 ? 12 : 8;
                        room.lastBossAttackAt = Object.assign({}, room.lastBossAttackAt, { fireball: Date.now() });

                        io.to(roomId).emit('bossAttackEvent', {
                            bossId: cur.boss.id,
                            element: cur.boss.element,
                            type: 'roar_fire',
                            x: fx,
                            y: fy,
                            radius: ringRadius,
                            fireCount,
                            fireSpeed: cur.boss.phase === 2 ? 4.3 : 3.6,
                            fireDamage: BOSS_DRAGON_FIRE_DAMAGE,
                            damage: 22
                        });

                        for (const id in cur.players) {
                            const p = cur.players[id];
                            if (p.isDead || p.isEliminated) continue;
                            if (Math.hypot((p.x + 24) - fx, (p.y + 24) - fy) <= ringRadius) {
                                applyDamageToPlayer(roomId, p, 22, 'roar', matchId, cur.boss.element);
                            }
                        }
                    }, warnDuration);
                }
            },
            drawEntity(ctx, boss, now) {
                const isRage = boss.phase === 2;
                const bx = boss.x;
                const by = boss.y;
                const flap = Math.sin(now / (isRage ? 130 : 210)) * 12;

                ctx.save();

                // 炎オーラ
                if (isRage) {
                    const auraR = boss.radius + 18 + Math.sin(now / 110) * 5;
                    const aura = ctx.createRadialGradient(bx, by, boss.radius * 0.4, bx, by, auraR);
                    aura.addColorStop(0, 'rgba(255, 110, 0, 0.38)');
                    aura.addColorStop(1, 'rgba(255, 0, 0, 0)');
                    ctx.fillStyle = aura;
                    ctx.beginPath();
                    ctx.arc(bx, by, auraR, 0, Math.PI * 2);
                    ctx.fill();
                }

                // 左右の翼
                ctx.fillStyle = isRage ? '#7a0b0b' : '#58111a';
                ctx.strokeStyle = isRage ? '#ff9f1c' : '#ff4d4d';
                ctx.lineWidth = 2.5;

                // 左翼
                ctx.beginPath();
                ctx.moveTo(bx - 16, by - 6);
                ctx.lineTo(bx - 68, by - 36 + flap);
                ctx.lineTo(bx - 56, by + 18 + flap * 0.5);
                ctx.lineTo(bx - 18, by + 14);
                ctx.closePath();
                ctx.fill();
                ctx.stroke();

                // 右翼
                ctx.beginPath();
                ctx.moveTo(bx + 16, by - 6);
                ctx.lineTo(bx + 68, by - 36 + flap);
                ctx.lineTo(bx + 56, by + 18 + flap * 0.5);
                ctx.lineTo(bx + 18, by + 14);
                ctx.closePath();
                ctx.fill();
                ctx.stroke();

                // 竜角
                ctx.fillStyle = '#ffd166';
                ctx.beginPath();
                ctx.moveTo(bx - 18, by - 28);
                ctx.lineTo(bx - 30, by - 56);
                ctx.lineTo(bx - 8, by - 34);
                ctx.closePath();
                ctx.fill();

                ctx.beginPath();
                ctx.moveTo(bx + 18, by - 28);
                ctx.lineTo(bx + 30, by - 56);
                ctx.lineTo(bx + 8, by - 34);
                ctx.closePath();
                ctx.fill();

                // 胴体・頭部コア
                const bodyGrad = ctx.createRadialGradient(bx, by - 6, 8, bx, by, boss.radius);
                bodyGrad.addColorStop(0, isRage ? '#ff7b00' : '#d62828');
                bodyGrad.addColorStop(0.65, '#6a040f');
                bodyGrad.addColorStop(1, '#2b090c');

                ctx.beginPath();
                ctx.arc(bx, by, boss.radius - 4, 0, Math.PI * 2);
                ctx.fillStyle = bodyGrad;
                ctx.fill();
                ctx.lineWidth = 3;
                ctx.strokeStyle = isRage ? '#ffbe0b' : '#ff595e';
                ctx.stroke();

                // 鋭い竜眼
                ctx.fillStyle = isRage ? '#fff3b0' : '#ffbe0b';
                ctx.beginPath();
                ctx.moveTo(bx - 22, by - 10);
                ctx.lineTo(bx - 7, by - 4);
                ctx.lineTo(bx - 16, by + 2);
                ctx.closePath();
                ctx.fill();

                ctx.beginPath();
                ctx.moveTo(bx + 22, by - 10);
                ctx.lineTo(bx + 7, by - 4);
                ctx.lineTo(bx + 16, by + 2);
                ctx.closePath();
                ctx.fill();

                ctx.restore();
            }
        }
    };

    const STAGES = Object.freeze([
        Object.freeze({
            stageNumber: 1,
            stageId: 'stage_1',
            title: 'STAGE 1 : 渦潮の嵐域',
            bossId: 'void_typhoon',
            unlockedByDefault: true,
            clearRewardPt: 300
        }),
        Object.freeze({
            stageNumber: 2,
            stageId: 'stage_2',
            title: 'STAGE 2 : 古代要塞中枢',
            bossId: 'omega_core',
            unlockedByDefault: false,
            clearRewardPt: 500
        }),
        Object.freeze({
            stageNumber: 3,
            stageId: 'stage_3',
            title: 'STAGE 3 : 紅蓮竜の巣窟',
            bossId: 'inferno_dragon',
            unlockedByDefault: false,
            clearRewardPt: 800
        })
    ]);

    const STAGE_ORDER = Object.freeze(STAGES.map((s) => s.stageId));
    const BOSS_ORDER = Object.freeze(STAGES.map((s) => s.bossId));
    const DEFAULT_BOSS_ID = STAGES[0].bossId;
    const DEFAULT_STAGE_NUMBER = STAGES[0].stageNumber;

    function getStageList() {
        return STAGES.map((stage) => ({
            ...stage,
            boss: getBossDef(stage.bossId)
        }));
    }

    function getStageByNumber(stageNumber) {
        const num = Number(stageNumber);
        return STAGES.find((s) => s.stageNumber === num) || STAGES[0];
    }

    function getStageById(stageId) {
        if (typeof stageId !== 'string') return STAGES[0];
        return STAGES.find((s) => s.stageId === stageId) || STAGES[0];
    }

    function getNextStage(currentStageNumber) {
        const num = Number(currentStageNumber);
        return STAGES.find((s) => s.stageNumber === num + 1) || null;
    }

    function sanitizeBossId(raw) {
        if (typeof raw === 'string' && Object.prototype.hasOwnProperty.call(BOSS_CATALOG, raw)) {
            return raw;
        }
        return DEFAULT_BOSS_ID;
    }

    function getBossDef(bossId) {
        return BOSS_CATALOG[sanitizeBossId(bossId)];
    }

    function createBossInstance(bossId, playerCount) {
        const def = getBossDef(bossId);
        const count = Math.min(MAX_PLAYERS, Math.max(1, playerCount || 1));
        const maxHp = (def.hpByPlayers && def.hpByPlayers[count]) || def.maxHp;
        return {
            id: def.id,
            stageNumber: def.stageNumber,
            stageId: def.stageId,
            name: def.name,
            element: def.element,
            x: def.spawnX,
            y: def.spawnY,
            radius: def.radius,
            hp: maxHp,
            maxHp,
            phase: 1,
            spiralAngle: 0,
            vortexActive: false,
            pulseCharging: false,
            barrierActive: false,
            initialPlayerCount: count
        };
    }

    // =========================================================================
    // 5. クライアント用イベント反映＆描画関数（DOM / Canvas限定）
    // =========================================================================
    function callSeSafe(state, fnName) {
        if (state && state.SE && typeof state.SE[fnName] === 'function') {
            state.SE[fnName]();
        }
    }

    function handleClientBossAttack(ev, state) {
        const def = getBossDef(ev.bossId || (state.bossState && state.bossState.id));
        if (ev.type === 'spiral') {
            callSeSafe(state, 'shot');
            for (let i = 0; i < ev.count; i++) {
                const ang = ev.baseAngle + (Math.PI * 2 / ev.count) * i;
                state.bossProjectiles.push({
                    kind: 'spiral',
                    element: ev.element || def.element,
                    x: ev.x,
                    y: ev.y,
                    vx: Math.cos(ang) * ev.speed,
                    vy: Math.sin(ang) * ev.speed,
                    damage: ev.damage || BOSS_SPIRAL_DAMAGE,
                    life: 145
                });
            }
        } else if (ev.type === 'breath') {
            callSeSafe(state, 'shot');
            const total = Math.max(1, ev.count || 5);
            const spread = ev.spread || 0.95;
            for (let i = 0; i < total; i++) {
                const offset = total === 1 ? 0 : ((i / (total - 1)) - 0.5) * spread;
                const ang = ev.baseAngle + offset;
                state.bossProjectiles.push({
                    kind: 'fireball',
                    element: ev.element || def.element,
                    x: ev.x,
                    y: ev.y,
                    vx: Math.cos(ang) * ev.speed,
                    vy: Math.sin(ang) * ev.speed,
                    damage: ev.damage || BOSS_DRAGON_FIRE_DAMAGE,
                    life: 150
                });
            }
        } else if (ev.type === 'homing') {
            callSeSafe(state, 'shot');
            for (const m of (ev.missiles || [])) {
                state.bossProjectiles.push({
                    kind: 'homing',
                    element: ev.element || def.element,
                    x: m.x,
                    y: m.y,
                    vx: m.vx,
                    vy: m.vy,
                    speed: m.speed || 3.4,
                    turnRate: m.turnRate || 0.045,
                    damage: m.damage || BOSS_HOMING_DAMAGE,
                    life: 175
                });
            }
        } else if (ev.type === 'slash_warn') {
            state.bossEffects.push({
                type: 'slash_warn',
                x1: ev.x1, y1: ev.y1, x2: ev.x2, y2: ev.y2,
                timer: Math.max(20, Math.round((ev.warnDuration || 750) / 16))
            });
        } else if (ev.type === 'slash_fire') {
            callSeSafe(state, 'bossSlash');
            if (typeof state.onShake === 'function') state.onShake(8, 5);
            state.bossEffects.push({
                type: 'slash_fire',
                x1: ev.x1, y1: ev.y1, x2: ev.x2, y2: ev.y2,
                timer: 18
            });
        } else if (ev.type === 'claw_warn') {
            state.bossEffects.push({
                type: 'claw_warn',
                lines: ev.lines || [],
                timer: Math.max(20, Math.round((ev.warnDuration || 750) / 16))
            });
        } else if (ev.type === 'claw_fire') {
            callSeSafe(state, 'bossSlash');
            if (typeof state.onShake === 'function') state.onShake(10, 6);
            state.bossEffects.push({
                type: 'claw_fire',
                lines: ev.lines || [],
                timer: 20
            });
        } else if (ev.type === 'laser_warn') {
            state.bossEffects.push({
                type: 'laser_warn',
                x: ev.x, y: ev.y,
                startAngle: ev.startAngle, endAngle: ev.endAngle, length: ev.length,
                timer: Math.max(20, Math.round((ev.warnDuration || 800) / 16))
            });
        } else if (ev.type === 'laser_fire') {
            callSeSafe(state, 'bossSlash');
            if (typeof state.onShake === 'function') state.onShake(10, 6);
            state.bossEffects.push({
                type: 'laser_fire',
                x: ev.x, y: ev.y,
                startAngle: ev.startAngle, endAngle: ev.endAngle, length: ev.length,
                timer: 20
            });
        } else if (ev.type === 'meteor_warn') {
            state.bossEffects.push({
                type: 'meteor_warn',
                zones: ev.zones || [],
                timer: Math.max(20, Math.round((ev.warnDuration || 850) / 16))
            });
        } else if (ev.type === 'meteor_fire') {
            callSeSafe(state, 'bossPulse');
            if (typeof state.onShake === 'function') state.onShake(13, 8);
            state.bossEffects.push({
                type: 'meteor_fire',
                zones: ev.zones || [],
                timer: 24
            });
        } else if (ev.type === 'roar_warn') {
            state.bossEffects.push({
                type: 'roar_warn',
                x: ev.x, y: ev.y, radius: ev.radius,
                timer: Math.max(20, Math.round((ev.warnDuration || 800) / 16))
            });
        } else if (ev.type === 'roar_fire') {
            callSeSafe(state, 'bossPulse');
            if (typeof state.onShake === 'function') state.onShake(14, 8);
            state.bossEffects.push({
                type: 'roar_fire',
                x: ev.x, y: ev.y, radius: ev.radius,
                timer: 24
            });
            const fireCount = ev.fireCount || 8;
            const fireSpeed = ev.fireSpeed || 3.8;
            for (let i = 0; i < fireCount; i++) {
                const ang = (Math.PI * 2 / fireCount) * i;
                state.bossProjectiles.push({
                    kind: 'fireball',
                    element: ev.element || def.element,
                    x: ev.x,
                    y: ev.y,
                    vx: Math.cos(ang) * fireSpeed,
                    vy: Math.sin(ang) * fireSpeed,
                    damage: ev.fireDamage || BOSS_DRAGON_FIRE_DAMAGE,
                    life: 140
                });
            }
        } else if (ev.type === 'vortex') {
            if (typeof state.setVortex === 'function') {
                state.setVortex(performance.now() + (ev.duration || 3800), ev.pullStrength || 1.55);
            }
            if (state.bossState && typeof state.addFloatingText === 'function') {
                state.addFloatingText(state.bossState.x, state.bossState.y - 45, 'VORTEX PULL!!', '#00b4d8');
            }
        } else if (ev.type === 'barrier_on') {
            callSeSafe(state, 'shield');
            if (state.bossState) {
                state.bossState.barrierActive = true;
                if (typeof state.addFloatingText === 'function') {
                    state.addFloatingText(state.bossState.x, state.bossState.y - 48, 'AEGIS BARRIER!!', '#00e5ff');
                }
            }
        } else if (ev.type === 'barrier_off') {
            if (state.bossState) {
                state.bossState.barrierActive = false;
            }
        } else if (ev.type === 'pulse_warn') {
            state.bossEffects.push({
                type: 'pulse_warn',
                x: ev.x, y: ev.y, radius: ev.radius,
                timer: Math.max(20, Math.round((ev.chargeDuration || 900) / 16))
            });
        } else if (ev.type === 'pulse_fire') {
            callSeSafe(state, 'bossPulse');
            if (typeof state.onShake === 'function') state.onShake(14, 8);
            state.bossEffects.push({
                type: 'pulse_fire',
                x: ev.x, y: ev.y, radius: ev.radius,
                timer: 22
            });
        }
        return def;
    }

    function updateBossProjectilesClient(bossProjectiles, ctx) {
        const { now, player, staticObstacles, arenaWidth, arenaTop, arenaHeight, onHitPlayer } = ctx;
        const pcx = player.x + 24;
        const pcy = player.y + 24;

        for (let i = bossProjectiles.length - 1; i >= 0; i--) {
            const bp = bossProjectiles[i];

            if (bp.kind === 'homing' && !player.isDead && !player.isEliminated) {
                const desiredAngle = Math.atan2(pcy - bp.y, pcx - bp.x);
                const curAngle = Math.atan2(bp.vy, bp.vx);
                let diff = desiredAngle - curAngle;
                while (diff > Math.PI) diff -= Math.PI * 2;
                while (diff < -Math.PI) diff += Math.PI * 2;
                const step = Math.max(-bp.turnRate, Math.min(bp.turnRate, diff));
                const nextAngle = curAngle + step;
                bp.vx = Math.cos(nextAngle) * bp.speed;
                bp.vy = Math.sin(nextAngle) * bp.speed;
            }

            bp.x += bp.vx;
            bp.y += bp.vy;
            bp.life--;

            let hitObs = false;
            for (const obs of staticObstacles) {
                if (bp.x >= obs.x && bp.x <= obs.x + obs.w && bp.y >= obs.y && bp.y <= obs.y + obs.h) {
                    hitObs = true;
                    break;
                }
            }
            if (hitObs) {
                bossProjectiles.splice(i, 1);
                continue;
            }

            if (!player.isDead && !player.isEliminated && now > player.invincibleUntil) {
                const hitRadius = bp.kind === 'homing' ? 24 : (bp.kind === 'fireball' ? 23 : 22);
                if (Math.hypot(bp.x - pcx, bp.y - pcy) < hitRadius) {
                    onHitPlayer(bp);
                    bossProjectiles.splice(i, 1);
                    continue;
                }
            }

            if (bp.life <= 0 || bp.x < 0 || bp.x > arenaWidth || bp.y < arenaTop || bp.y > arenaHeight) {
                bossProjectiles.splice(i, 1);
            }
        }
    }

    function drawBossEntity(ctx, boss, now, helpers) {
        if (!boss) return;
        const def = getBossDef(boss.id);
        def.drawEntity(ctx, boss, now, helpers);
    }

    function drawBossEffectsAndProjectiles(gameCtx, bossEffects, bossProjectiles) {
        for (const ef of bossEffects) {
            gameCtx.save();
            if (ef.type === 'slash_warn') {
                gameCtx.beginPath();
                gameCtx.moveTo(ef.x1, ef.y1);
                gameCtx.lineTo(ef.x2, ef.y2);
                gameCtx.strokeStyle = 'rgba(255, 50, 80, 0.65)';
                gameCtx.lineWidth = 3;
                gameCtx.setLineDash([8, 6]);
                gameCtx.stroke();
            } else if (ef.type === 'slash_fire') {
                gameCtx.beginPath();
                gameCtx.moveTo(ef.x1, ef.y1);
                gameCtx.lineTo(ef.x2, ef.y2);
                gameCtx.strokeStyle = '#00b4d8';
                gameCtx.lineWidth = 18;
                gameCtx.stroke();

                gameCtx.beginPath();
                gameCtx.moveTo(ef.x1, ef.y1);
                gameCtx.lineTo(ef.x2, ef.y2);
                gameCtx.strokeStyle = '#ffffff';
                gameCtx.lineWidth = 5;
                gameCtx.stroke();
            } else if (ef.type === 'claw_warn') {
                gameCtx.strokeStyle = 'rgba(255, 87, 34, 0.72)';
                gameCtx.lineWidth = 3;
                gameCtx.setLineDash([8, 6]);
                for (const ln of (ef.lines || [])) {
                    gameCtx.beginPath();
                    gameCtx.moveTo(ln.x1, ln.y1);
                    gameCtx.lineTo(ln.x2, ln.y2);
                    gameCtx.stroke();
                }
            } else if (ef.type === 'claw_fire') {
                for (const ln of (ef.lines || [])) {
                    gameCtx.beginPath();
                    gameCtx.moveTo(ln.x1, ln.y1);
                    gameCtx.lineTo(ln.x2, ln.y2);
                    gameCtx.strokeStyle = '#ff4d00';
                    gameCtx.lineWidth = 20;
                    gameCtx.stroke();

                    gameCtx.beginPath();
                    gameCtx.moveTo(ln.x1, ln.y1);
                    gameCtx.lineTo(ln.x2, ln.y2);
                    gameCtx.strokeStyle = '#fff3b0';
                    gameCtx.lineWidth = 6;
                    gameCtx.stroke();
                }
            } else if (ef.type === 'laser_warn') {
                const segs = 12;
                gameCtx.strokeStyle = 'rgba(255, 82, 82, 0.55)';
                gameCtx.lineWidth = 2.5;
                gameCtx.setLineDash([8, 6]);
                for (let s = 0; s <= segs; s++) {
                    const a = ef.startAngle + ((ef.endAngle - ef.startAngle) * s) / segs;
                    gameCtx.beginPath();
                    gameCtx.moveTo(ef.x, ef.y);
                    gameCtx.lineTo(ef.x + Math.cos(a) * ef.length, ef.y + Math.sin(a) * ef.length);
                    gameCtx.stroke();
                }
            } else if (ef.type === 'laser_fire') {
                const segs = 14;
                for (let s = 0; s <= segs; s++) {
                    const a = ef.startAngle + ((ef.endAngle - ef.startAngle) * s) / segs;
                    const ex = ef.x + Math.cos(a) * ef.length;
                    const ey = ef.y + Math.sin(a) * ef.length;
                    gameCtx.beginPath();
                    gameCtx.moveTo(ef.x, ef.y);
                    gameCtx.lineTo(ex, ey);
                    gameCtx.strokeStyle = 'rgba(255, 159, 67, 0.72)';
                    gameCtx.lineWidth = 16;
                    gameCtx.stroke();

                    gameCtx.beginPath();
                    gameCtx.moveTo(ef.x, ef.y);
                    gameCtx.lineTo(ex, ey);
                    gameCtx.strokeStyle = '#ffffff';
                    gameCtx.lineWidth = 4;
                    gameCtx.stroke();
                }
            } else if (ef.type === 'meteor_warn') {
                for (const z of (ef.zones || [])) {
                    gameCtx.beginPath();
                    gameCtx.arc(z.x, z.y, z.radius, 0, Math.PI * 2);
                    gameCtx.fillStyle = 'rgba(255, 69, 0, 0.16)';
                    gameCtx.fill();
                    gameCtx.strokeStyle = '#ff6b6b';
                    gameCtx.lineWidth = 2.5;
                    gameCtx.setLineDash([6, 6]);
                    gameCtx.stroke();
                }
            } else if (ef.type === 'meteor_fire') {
                for (const z of (ef.zones || [])) {
                    gameCtx.beginPath();
                    gameCtx.arc(z.x, z.y, z.radius, 0, Math.PI * 2);
                    gameCtx.fillStyle = 'rgba(255, 94, 0, 0.5)';
                    gameCtx.fill();
                    gameCtx.strokeStyle = '#ffd166';
                    gameCtx.lineWidth = 5;
                    gameCtx.stroke();
                }
            } else if (ef.type === 'pulse_warn' || ef.type === 'roar_warn') {
                gameCtx.beginPath();
                gameCtx.arc(ef.x, ef.y, ef.radius, 0, Math.PI * 2);
                gameCtx.fillStyle = ef.type === 'roar_warn' ? 'rgba(255, 87, 34, 0.14)' : 'rgba(0, 180, 216, 0.14)';
                gameCtx.fill();
                gameCtx.strokeStyle = '#ff4d4d';
                gameCtx.lineWidth = 2;
                gameCtx.setLineDash([6, 6]);
                gameCtx.stroke();
            } else if (ef.type === 'pulse_fire' || ef.type === 'roar_fire') {
                gameCtx.beginPath();
                gameCtx.arc(ef.x, ef.y, ef.radius, 0, Math.PI * 2);
                gameCtx.fillStyle = ef.type === 'roar_fire' ? 'rgba(255, 110, 0, 0.42)' : 'rgba(0, 180, 216, 0.42)';
                gameCtx.fill();
                gameCtx.strokeStyle = ef.type === 'roar_fire' ? '#ffd166' : '#00ffff';
                gameCtx.lineWidth = 6;
                gameCtx.stroke();
            }
            gameCtx.restore();
        }

        for (const bp of bossProjectiles) {
            gameCtx.save();
            if (bp.kind === 'homing') {
                const ang = Math.atan2(bp.vy, bp.vx);
                gameCtx.translate(bp.x, bp.y);
                gameCtx.rotate(ang);
                gameCtx.fillStyle = '#ffd60a';
                gameCtx.beginPath();
                gameCtx.moveTo(10, 0);
                gameCtx.lineTo(-8, -6);
                gameCtx.lineTo(-5, 0);
                gameCtx.lineTo(-8, 6);
                gameCtx.closePath();
                gameCtx.fill();
                gameCtx.strokeStyle = '#fff';
                gameCtx.lineWidth = 1.5;
                gameCtx.stroke();
            } else if (bp.kind === 'fireball') {
                gameCtx.fillStyle = '#ff5722';
                gameCtx.beginPath();
                gameCtx.arc(bp.x, bp.y, 8, 0, Math.PI * 2);
                gameCtx.fill();
                gameCtx.strokeStyle = '#ffd166';
                gameCtx.lineWidth = 2.5;
                gameCtx.stroke();
            } else {
                gameCtx.fillStyle = '#00b4d8';
                gameCtx.beginPath();
                gameCtx.arc(bp.x, bp.y, 7, 0, Math.PI * 2);
                gameCtx.fill();
                gameCtx.strokeStyle = '#e0fbfc';
                gameCtx.lineWidth = 2;
                gameCtx.stroke();
            }
            gameCtx.restore();
        }
    }

    // =========================================================================
    // 6. 起動時バリデーション（設定ミス・整合性エラー早期検知）
    // =========================================================================
    function validateDefinitions(options) {
        const opts = options || {};
        const throwOnError = opts.throwOnError !== false;
        const errors = [];
        const warnings = [];

        // 共通ルール定数チェック
        if (GAME_RULES.MAX_PLAYERS !== 4) {
            errors.push(`GAME_RULES.MAX_PLAYERS must be 4 (got ${GAME_RULES.MAX_PLAYERS})`);
        }
        if (GAME_RULES.ARENA.WIDTH !== 960 || GAME_RULES.ARENA.HEIGHT !== 720 || GAME_RULES.ARENA.TOP !== 28) {
            errors.push('GAME_RULES.ARENA dimensions must be 960x720 with top 28');
        }
        if (STATIC_OBSTACLES.length !== STATIC_OBSTACLE_COUNT) {
            errors.push(`STATIC_OBSTACLES count mismatch: expected ${STATIC_OBSTACLE_COUNT}, got ${STATIC_OBSTACLES.length}`);
        }
        if (GAME_RULES.ACTIONS.ultra.cooldownMs !== 6000) {
            errors.push(`Ultra skill cooldownMs must be 6000ms (got ${GAME_RULES.ACTIONS.ultra.cooldownMs})`);
        }
        if (GAME_RULES.GACHA.ULTRA_MAX_STOCK !== 3) {
            errors.push(`Ultra skill max stock must be 3 (got ${GAME_RULES.GACHA.ULTRA_MAX_STOCK})`);
        }

        // 必殺技定義チェック
        const seenSkillIds = new Set();
        for (const skillId of ULTRA_SKILL_ORDER) {
            const skill = ULTRA_SKILLS[skillId];
            if (!skill) {
                errors.push(`ULTRA_SKILL_ORDER references missing skill: ${skillId}`);
                continue;
            }
            if (seenSkillIds.has(skill.id)) {
                errors.push(`Duplicate ultra skill id: ${skill.id}`);
            }
            seenSkillIds.add(skill.id);

            if (!skill.id || !skill.name || !skill.type) {
                errors.push(`Ultra skill missing required field (id/name/type): ${skillId}`);
            }
            if (skill.cooldownMs !== 6000) {
                errors.push(`Ultra skill ${skill.id} cooldownMs must be 6000 (got ${skill.cooldownMs})`);
            }
            if (skill.maxStock !== 3) {
                errors.push(`Ultra skill ${skill.id} maxStock must be 3 (got ${skill.maxStock})`);
            }
        }

        // ステージ＆BOSS定義チェック
        if (!Array.isArray(STAGES) || STAGES.length === 0) {
            errors.push('STAGES must be a non-empty array');
        } else {
            const seenStageNumbers = new Set();
            const seenStageIds = new Set();

            STAGES.forEach((stage, idx) => {
                const expectedStageNum = idx + 1;
                if (stage.stageNumber !== expectedStageNum) {
                    errors.push(`Stage sequence invalid at index ${idx}: expected stageNumber ${expectedStageNum}, got ${stage.stageNumber}`);
                }
                if (seenStageNumbers.has(stage.stageNumber)) {
                    errors.push(`Duplicate stageNumber: ${stage.stageNumber}`);
                }
                seenStageNumbers.add(stage.stageNumber);

                if (!stage.stageId || typeof stage.stageId !== 'string') {
                    errors.push(`Stage #${stage.stageNumber} missing stageId`);
                } else if (seenStageIds.has(stage.stageId)) {
                    errors.push(`Duplicate stageId: ${stage.stageId}`);
                } else {
                    seenStageIds.add(stage.stageId);
                }

                const boss = BOSS_CATALOG[stage.bossId];
                if (!boss) {
                    errors.push(`Stage ${stage.stageId} references missing bossId: ${stage.bossId}`);
                    return;
                }

                // 必須項目検証: stageId, name, element, maxHp, speed, 攻撃パターン定義
                if (boss.stageId !== stage.stageId) {
                    errors.push(`Boss ${boss.id} stageId mismatch: expected ${stage.stageId}, got ${boss.stageId}`);
                }
                if (boss.stageNumber !== stage.stageNumber) {
                    errors.push(`Boss ${boss.id} stageNumber mismatch: expected ${stage.stageNumber}, got ${boss.stageNumber}`);
                }
                if (!boss.name || typeof boss.name !== 'string') {
                    errors.push(`Boss ${boss.id} missing name`);
                }
                if (!VALID_COMBAT_ELEMENTS.includes(boss.element)) {
                    errors.push(`Boss ${boss.id} has invalid element: ${boss.element}`);
                }
                if (typeof boss.maxHp !== 'number' || boss.maxHp <= 0) {
                    errors.push(`Boss ${boss.id} maxHp must be > 0`);
                }
                if (!boss.hpByPlayers || boss.hpByPlayers[1] <= 0 || boss.hpByPlayers[4] <= 0) {
                    errors.push(`Boss ${boss.id} missing valid hpByPlayers[1..4]`);
                }
                if (typeof boss.speed !== 'number' || boss.speed <= 0) {
                    errors.push(`Boss ${boss.id} speed must be > 0`);
                }
                if (!boss.attackIntervalMs || boss.attackIntervalMs.p1 <= 0 || boss.attackIntervalMs.p2 <= 0) {
                    errors.push(`Boss ${boss.id} missing valid attackIntervalMs`);
                }
                if (!Array.isArray(boss.attackPatterns) || boss.attackPatterns.length === 0) {
                    errors.push(`Boss ${boss.id} missing attackPatterns definition`);
                }
                if (typeof boss.executeAttack !== 'function') {
                    errors.push(`Boss ${boss.id} missing executeAttack function`);
                }
                if (typeof boss.drawEntity !== 'function') {
                    errors.push(`Boss ${boss.id} missing drawEntity function`);
                }
            });
        }

        // BOSS_CATALOG 内の孤立定義チェック
        for (const bossId of Object.keys(BOSS_CATALOG)) {
            const linked = STAGES.some((s) => s.bossId === bossId);
            if (!linked) {
                warnings.push(`Boss ${bossId} is defined in BOSS_CATALOG but not linked in STAGES`);
            }
        }

        const result = {
            valid: errors.length === 0,
            errors,
            warnings
        };

        if (!result.valid && throwOnError) {
            throw new Error(`[BossSystem Validation Failed]\n- ${errors.join('\n- ')}`);
        }
        return result;
    }

    // 起動時自動検証（致命的な定義ミスを即時検知）
    validateDefinitions({ throwOnError: true });

    return {
        // 基本定数・一元化ルール
        ARENA_WIDTH,
        ARENA_TOP,
        ARENA_HEIGHT,
        ARENA_CENTER_X,
        GAME_RULES,
        STATIC_OBSTACLES,

        // 属性システム
        SPECIAL_INKS,
        SPECIAL_INK_IDS,
        ELEMENT_META,
        ELEMENT_COLOR_MAP,
        determineElementFromPixels,
        getElementMultiplier,
        getElementInfo,
        sanitizeElementId,

        // 必殺技（ウルトラガチャ）
        ULTRA_SKILLS,
        ULTRA_SKILL_ORDER,
        sanitizeUltraSkillId,
        getUltraSkillDef,
        getAllUltraSkills,

        // ステージ＆BOSS
        STAGES,
        STAGE_ORDER,
        DEFAULT_STAGE_NUMBER,
        BOSS_CATALOG,
        BOSS_ORDER,
        DEFAULT_BOSS_ID,
        getStageList,
        getStageByNumber,
        getStageById,
        getNextStage,
        sanitizeBossId,
        getBossDef,
        createBossInstance,

        // バリデーション
        validateDefinitions,

        // クライアント描画＆攻撃更新
        handleClientBossAttack,
        updateBossProjectilesClient,
        drawBossEntity,
        drawBossEffectsAndProjectiles
    };
}));
