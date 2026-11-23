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
    const SPECIAL_INK_ELEMENT_THRESHOLD = 80;

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

    const VALID_COMBAT_ELEMENTS = Object.freeze(['fire', 'water', 'grass', 'thunder', 'rock', 'light', 'dark', 'neutral']);
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
    // 3. ウルトラガチャ（必殺技）データ駆動定義（全8種構成）
    // =========================================================================
    const ULTRA_SKILLS = Object.freeze({
        end_of_days: Object.freeze({
            id: 'end_of_days',
            name: '終焉の一閃',
            type: 'line_burst',
            rarity: 'S',
            gachaWeight: 10,
            tag: '超高火力・極太貫通',
            icon: '⚔️',
            color: '#ff4d6d',
            description: '350msの溜めの後、前方直線（射程620px・半幅56px）へ通常攻撃4.0倍の極太光線を放つ（通常バリアZ貫通0.5倍／絶対防壁貫通0.25倍）',
            chargeMs: 350,
            stanceMs: 0,
            warnMs: 0,
            durationMs: 260,
            cooldownMs: ACTIONS.ultra.cooldownMs,
            maxStock: GACHA.ULTRA_MAX_STOCK,
            damageMultiplier: 4.0,
            range: 620,
            halfWidth: 56,
            guardableByBarrier: false,
            piercesNormalBarrier: true,
            normalBarrierDamageMultiplier: 0.5,
            piercesAbsoluteWall: true,
            absoluteWallDamageMultiplier: 0.25,
            absoluteWallFloatingText: 'ABSOLUTE!',
            counterInteraction: Object.freeze({
                damageMultiplier: 0.5,
                triggersCounter: true
            })
        }),
        perfect_counter: Object.freeze({
            id: 'perfect_counter',
            name: '完全反撃',
            type: 'counter',
            rarity: 'S',
            gachaWeight: 10,
            tag: 'カウンター',
            icon: '⚡',
            color: '#ffd60a',
            description: '1800ms構え、攻撃を受けると無効化し2.8倍の強烈な反撃を放つ（終焉の一閃は0.5倍被ダメ＋反撃発動）',
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
        ricochet_guns: Object.freeze({
            id: 'ricochet_guns',
            name: '全方位跳弾銃',
            type: 'equip_guns',
            rarity: 'S',
            gachaWeight: 10,
            tag: '装備覚醒・弾幕',
            icon: '🔫',
            color: '#ff9f43',
            description: '5000msの間、625ms間隔（最大8ウェーブ）で8方向へ固定威力40の弾を発射し、壁に1回だけ反射する',
            chargeMs: 0,
            stanceMs: 0,
            warnMs: 0,
            durationMs: 5000,
            cooldownMs: ACTIONS.ultra.cooldownMs,
            maxStock: GACHA.ULTRA_MAX_STOCK,
            damageMultiplier: 0,
            fixedDamage: 40,
            intervalMs: 625,
            maxWaves: 8,
            directions: 8,
            bulletSpeed: 9.0,
            maxBounces: 1,
            bulletRadius: 6,
            guardableByBarrier: true
        }),
        time_stop: Object.freeze({
            id: 'time_stop',
            name: '刻の静止',
            type: 'time_stop',
            rarity: 'S',
            gachaWeight: 10,
            tag: '時空制御',
            icon: '⏳',
            color: '#a29bfe',
            description: '2500msの間、自分以外の敵・BOSS・弾幕の移動・行動・タイマー進行を停止し、自分の攻撃は即時反映する',
            chargeMs: 0,
            stanceMs: 0,
            warnMs: 0,
            durationMs: 2500,
            cooldownMs: ACTIONS.ultra.cooldownMs,
            maxStock: GACHA.ULTRA_MAX_STOCK,
            damageMultiplier: 0,
            guardableByBarrier: false
        }),
        absolute_wall: Object.freeze({
            id: 'absolute_wall',
            name: '絶対防壁',
            type: 'barrier',
            rarity: 'A',
            gachaWeight: 15,
            tag: '防御・立て直し',
            icon: '🛡️',
            color: '#00e5ff',
            description: '2600msの間、攻撃ダメージを無効化しノックバックと吸引を大幅軽減する（終焉の一閃は貫通0.25倍に軽減）',
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
        sky_meteor: Object.freeze({
            id: 'sky_meteor',
            name: '天空隕石',
            type: 'aoe_meteor',
            rarity: 'A',
            gachaWeight: 15,
            tag: '周囲5連・マグマ化',
            icon: '☄️',
            color: '#ff9f43',
            description: '自分を中心とする半径200pxに5発の隕石（各半径110px）が降り、着弾跡が4秒間マグマ化（1秒毎10ダメージ）',
            chargeMs: 0,
            stanceMs: 0,
            warnMs: 650,
            durationMs: 320,
            cooldownMs: ACTIONS.ultra.cooldownMs,
            maxStock: GACHA.ULTRA_MAX_STOCK,
            damageMultiplier: 2.2,
            meteorCount: 5,
            formation: 'circle_around_self',
            castRadius: 200,
            ringOffset: 90,
            radius: 110,
            magmaDurationMs: 4000,
            magmaTickIntervalMs: 1000,
            magmaTickDamage: 10,
            independentCircleHit: true,
            multiHit: true,
            guardableByBarrier: true
        }),
        demon_blade: Object.freeze({
            id: 'demon_blade',
            name: '聖魔の覇剣',
            type: 'equip_blade',
            rarity: 'A',
            gachaWeight: 15,
            tag: '装備覚醒・近接',
            icon: '🗡️',
            color: '#e056fd',
            description: '5000msの間、発動者が放つすべての斬撃攻撃に威力2.0倍・リーチ1.5倍を適用する',
            chargeMs: 0,
            stanceMs: 0,
            warnMs: 0,
            durationMs: 5000,
            cooldownMs: ACTIONS.ultra.cooldownMs,
            maxStock: GACHA.ULTRA_MAX_STOCK,
            damageMultiplier: 2.0,
            slashDamageMultiplier: 2.0,
            slashRangeMultiplier: 1.5,
            guardableByBarrier: true
        }),
        phantom_boots: Object.freeze({
            id: 'phantom_boots',
            name: '疾風幻影靴',
            type: 'equip_boots',
            rarity: 'A',
            gachaWeight: 15,
            tag: '装備覚醒・機動',
            icon: '👢',
            color: '#00d2d3',
            description: '4000msの間、移動速度2.0倍＆壁貫通（終了時に壁内の場合は安全な空き位置へ自動押し戻し）',
            chargeMs: 0,
            stanceMs: 0,
            warnMs: 0,
            durationMs: 4000,
            cooldownMs: ACTIONS.ultra.cooldownMs,
            maxStock: GACHA.ULTRA_MAX_STOCK,
            damageMultiplier: 0,
            speedMultiplier: 2.0,
            passWalls: true,
            guardableByBarrier: false
        })
    });

    const ULTRA_SKILL_ORDER = Object.freeze([
        'end_of_days',
        'perfect_counter',
        'ricochet_guns',
        'time_stop',
        'absolute_wall',
        'sky_meteor',
        'demon_blade',
        'phantom_boots'
    ]);

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
    // 4. BOSS・ステージ定義（データ駆動・STAGE 1〜5）
    // =========================================================================
    const BOSS_SPIRAL_DAMAGE = 15;               // 渦巻き弾幕
    const BOSS_HOMING_DAMAGE = 12;               // 追尾ミサイル
    const BOSS_DRAGON_FIRE_DAMAGE = 20;          // ドラゴン火炎弾
    const BOSS_DRAGON_CLAW_DAMAGE = 20;          // クロス竜爪斬撃
    const BOSS_DRAGON_METEOR_DAMAGE = 26;        // 煉獄メテオピラー
    const BOSS_DRAGON_MAGMA_DURATION_MS = 2400;  // 灼熱マグマ床持続時間
    const BOSS_DRAGON_ROAR_PULSE_DAMAGE = 4;     // 覇竜の咆哮リング1パルスダメージ
    const BOSS_DRAGON_ROAR_PULSE_COUNT = 4;      // 多段パルス回数（合計16）
    const BOSS_DRAGON_ROAR_PULSE_INTERVAL_MS = 160;// 多段パルス間隔
    const BOSS_ABYSS_SIGIL_DAMAGE = 24;          // 闇の刻印陣
    const BOSS_ABYSS_SNAKE_DAMAGE = 14;          // 双蛇の闇弾
    const BOSS_ABYSS_RING_DAMAGE = 28;           // 深淵の拘束リング
    const BOSS_ABYSS_SHADOW_DAMAGE = 10;          // 呪詛の影波
    const BOSS_PHANTOM_HOMING_DAMAGE = 10;        // 幻影追尾球（状態異常なし）
    const BOSS_PHANTOM_AMBUSH_DAMAGE = 20;       // 潜伏奇襲着弾（減速2000ms+ノックバック）
    const BOSS_PHANTOM_CURSE_DAMAGE = 20;        // 呪詛のランダム状態異常弾
    const BOSS_PHANTOM_FEINT_P1_DAMAGE = 8;      // 牽制弾幕 P1
    const BOSS_PHANTOM_FEINT_P2_DAMAGE = 12;      // 牽制弾幕 P2

    function resolvePredictedDirection(pl) {
        if (!pl) return { dx: 0, dy: 1 };
        const vx = Number(pl.vx) || 0;
        const vy = Number(pl.vy) || 0;
        const len = Math.hypot(vx, vy);
        if (len > 0.05) {
            return { dx: vx / len, dy: vy / len };
        }
        switch (pl.facing) {
            case 'up': return { dx: 0, dy: -1 };
            case 'down': return { dx: 0, dy: 1 };
            case 'left': return { dx: -1, dy: 0 };
            case 'right': return { dx: 1, dy: 0 };
            default: return { dx: 0, dy: 1 };
        }
    }

    function clampArenaPoint(x, y, margin) {
        const m = Math.max(40, Number(margin) || 95);
        return {
            x: Math.max(m, Math.min(ARENA_WIDTH - m, x)),
            y: Math.max(ARENA_TOP + m, Math.min(ARENA_HEIGHT - m, y))
        };
    }

    const BOSS_CATALOG = {
        void_typhoon: {
            id: 'void_typhoon',
            stageNumber: 1,
            stageId: 'stage_1',
            name: 'water cyclone',
            tag: '🌀 渦潮・吸引型',
            element: 'water',
            summary: '渦巻き弾幕とブラックホール吸引で翻弄する嵐の化身',
            radius: 44,
            spawnX: ARENA_CENTER_X,
            spawnY: 175,
            maxHp: 800,
            hpByPlayers: { 1: 800, 2: 1600, 3: 2400, 4: 3200 },
            speed: 2.8,
            moveSpeed: {
                soloP1: 2.8,
                multiP1: 2.4,
                soloP2: 4.0,
                multiP2: 6.0
            },
            attackIntervalMs: {
                p1: 2450,
                p2: 1750
            },
            attackProjectiles: ['spiral'],
            projectileDamage: {
                spiral: BOSS_SPIRAL_DAMAGE
            },
            attackPatterns: [
                { id: 'spiral', name: '渦巻き弾幕', damage: BOSS_SPIRAL_DAMAGE },
                { id: 'slash', name: '虚空斬撃', damage: 40 },
                { id: 'vortex', name: 'ブラックホール吸引', damage: 2 },
                { id: 'pulse', name: '重力パルス爆発', damage: 26 }
            ],
            patternCount: 4,
            executeAttack(ctx) {
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
                } else if (patternIdx === 1) {
                    const startX = boss.x;
                    const startY = boss.y;
                    const angle = Math.atan2(targetCy - startY, targetCx - startX);
                    const length = 480;
                    const endX = startX + Math.cos(angle) * length;
                    const endY = startY + Math.sin(angle) * length;
                    const warnDuration = boss.phase === 2 ? 680 : 750;

                    io.to(roomId).emit('bossAttackEvent', {
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
                            damage: 40
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
            maxHp: 800,
            hpByPlayers: { 1: 800, 2: 1600, 3: 2400, 4: 3200 },
            speed: 3.2,
            barrierDamageMultiplier: 0.45,
            moveSpeed: {
                soloP1: 3.2,
                multiP1: 4.2,
                soloP2: 4.2,
                multiP2: 5.0
            },
            attackIntervalMs: {
                p1: 1850,
                p2: 950
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
                                applyDamageToPlayer(roomId, p, 40, 'laser', matchId, cur.boss.element);
                            }
                        }
                    }, warnDuration);
                } else {
                    const duration = boss.phase === 2 ? 5200 : 4800;
                    boss.barrierActive = true;
                    boss.barrierToken = (boss.barrierToken || 0) + 1;
                    const myToken = boss.barrierToken;

                    io.to(roomId).emit('bossStateUpdated', boss);
                    io.to(roomId).emit('bossAttackEvent', {
                        bossId: boss.id,
                        element: boss.element,
                        type: 'barrier_on',
                        duration
                    });

                    registerTimeout(room, () => {
                        const cur = ctx.getRoom();
                        if (cur && cur.matchId === matchId && cur.boss && cur.boss.barrierToken === myToken) {
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
            summary: '2連灼熱ブレス・6連クロス竜爪・灼熱マグマ床・旋回火炎弾の咆哮を放つ紅蓮の覇竜',
            radius: 46,
            spawnX: ARENA_CENTER_X,
            spawnY: 160,
            maxHp: 1100,
            hpByPlayers: { 1: 1100, 2: 2100, 3: 3000, 4: 3800 },
            speed: 3.2,
            moveSpeed: {
                p1: 3.2,
                p2: 5.2,
                soloP1: 3.2,
                multiP1: 2.7,
                soloP2: 5.2,
                multiP2: 4.8
            },
            attackIntervalMs: {
                p1: 2350,
                p2: 2050
            },
            phase2Awaken: Object.freeze({
                knockbackRadius: 240,
                knockbackDistance: 120,
                scaleAuraDurationMs: 3000,
                scaleDamageMultiplier: 0.75
            }),
            magmaConfig: Object.freeze({
                durationMs: BOSS_DRAGON_MAGMA_DURATION_MS,
                tickIntervalMs: 600,
                tickDamage: 6
            }),
            attackProjectiles: ['fireball'],
            projectileDamage: {
                fireball: BOSS_DRAGON_FIRE_DAMAGE
            },
            attackPatterns: [
                { id: 'breath', name: '灼熱ドラゴンブレス', damage: BOSS_DRAGON_FIRE_DAMAGE },
                { id: 'claw', name: 'クロス竜爪斬撃', damage: BOSS_DRAGON_CLAW_DAMAGE },
                { id: 'meteor', name: '煉獄メテオピラー', damage: BOSS_DRAGON_METEOR_DAMAGE },
                { id: 'roar', name: '覇竜の咆哮リング', damage: BOSS_DRAGON_ROAR_PULSE_DAMAGE * BOSS_DRAGON_ROAR_PULSE_COUNT }
            ],
            patternCount: 4,
            executeAttack(ctx) {
                const {
                    room, roomId, matchId, boss, alivePlayers, targetCx, targetCy,
                    count, io, registerTimeout, pointToSegmentDistance, applyDamageToPlayer,
                    applyPulseDamageToPlayer, spawnMagmaZones
                } = ctx;
                const patternIdx = count % 4;
                const isP2 = boss.phase === 2;

                if (patternIdx === 0) {
                    const countShots = (isP2 ? 7 : 5) + Math.min(2, Math.max(0, alivePlayers.length - 1));
                    const baseAngle = Math.atan2(targetCy - boss.y, targetCx - boss.x);
                    const totalSpread = isP2 ? 1.25 : 0.95;
                    const speed = isP2 ? 4.8 : 4.2;

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

                    if (isP2) {
                        const angleShift = (count % 2 === 0 ? 0.18 : -0.18);
                        registerTimeout(room, () => {
                            const cur = ctx.getRoom();
                            if (!cur || cur.state !== 'playing' || cur.matchId !== matchId || !cur.boss) return;

                            cur.lastBossAttackAt = Object.assign({}, cur.lastBossAttackAt, { fireball: Date.now() });
                            io.to(roomId).emit('bossAttackEvent', {
                                bossId: cur.boss.id,
                                element: cur.boss.element,
                                type: 'breath',
                                x: cur.boss.x,
                                y: cur.boss.y,
                                baseAngle: baseAngle + angleShift,
                                spread: totalSpread,
                                count: countShots,
                                speed: speed + 0.25,
                                damage: BOSS_DRAGON_FIRE_DAMAGE
                            });
                        }, 340);
                    }
                } else if (patternIdx === 1) {
                    const startX = boss.x;
                    const startY = boss.y;
                    const centerAng = Math.atan2(targetCy - startY, targetCx - startX);
                    const perpX = -Math.sin(centerAng);
                    const perpY = Math.cos(centerAng);
                    const length = 520;
                    const clawOffset = 34;

                    const leftOriginX = startX - perpX * clawOffset;
                    const leftOriginY = startY - perpY * clawOffset;
                    const rightOriginX = startX + perpX * clawOffset;
                    const rightOriginY = startY + perpY * clawOffset;

                    const lines = [
                        { x1: leftOriginX, y1: leftOriginY, x2: leftOriginX + Math.cos(centerAng + 0.08) * length, y2: leftOriginY + Math.sin(centerAng + 0.08) * length },
                        { x1: leftOriginX, y1: leftOriginY, x2: leftOriginX + Math.cos(centerAng + 0.28) * length, y2: leftOriginY + Math.sin(centerAng + 0.28) * length },
                        { x1: leftOriginX, y1: leftOriginY, x2: leftOriginX + Math.cos(centerAng + 0.48) * length, y2: leftOriginY + Math.sin(centerAng + 0.48) * length },
                        { x1: rightOriginX, y1: rightOriginY, x2: rightOriginX + Math.cos(centerAng - 0.08) * length, y2: rightOriginY + Math.sin(centerAng - 0.08) * length },
                        { x1: rightOriginX, y1: rightOriginY, x2: rightOriginX + Math.cos(centerAng - 0.28) * length, y2: rightOriginY + Math.sin(centerAng - 0.28) * length },
                        { x1: rightOriginX, y1: rightOriginY, x2: rightOriginX + Math.cos(centerAng - 0.48) * length, y2: rightOriginY + Math.sin(centerAng - 0.48) * length }
                    ];
                    const warnDuration = isP2 ? 560 : 680;

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
                            damage: BOSS_DRAGON_CLAW_DAMAGE
                        });

                        const hitPlayerIds = new Set();
                        for (const id in cur.players) {
                            if (hitPlayerIds.has(id)) continue;
                            const p = cur.players[id];
                            if (!p || p.isDead || p.isEliminated) continue;
                            const px = p.x + 24;
                            const py = p.y + 24;
                            const hit = lines.some((ln) => pointToSegmentDistance(px, py, ln.x1, ln.y1, ln.x2, ln.y2) < 26);
                            if (hit) {
                                hitPlayerIds.add(id);
                                applyDamageToPlayer(roomId, p, BOSS_DRAGON_CLAW_DAMAGE, 'claw', matchId, cur.boss.element);
                            }
                        }
                    }, warnDuration);
                } else if (patternIdx === 2) {
                    const zones = [];
                    const radius = isP2 ? 96 : 84;
                    const warnDuration = isP2 ? 780 : 900;
                    const candidates = alivePlayers.length > 0
                        ? alivePlayers
                        : [{ x: targetCx - 24, y: targetCy - 24, facing: 'down', vx: 0, vy: 0 }];

                    for (let i = 0; i < candidates.length; i++) {
                        const pl = candidates[i];
                        zones.push({
                            x: Math.max(radius, Math.min(ARENA_WIDTH - radius, pl.x + 24)),
                            y: Math.max(ARENA_TOP + radius, Math.min(ARENA_HEIGHT - radius, pl.y + 24)),
                            radius
                        });
                    }

                    if (isP2) {
                        const leadAngles = [-0.36, 0, 0.36];
                        for (let k = 0; k < 3; k++) {
                            const src = candidates[k % candidates.length];
                            const dir = resolvePredictedDirection(src);
                            const baseAng = Math.atan2(dir.dy, dir.dx);
                            const ang = baseAng + (candidates.length === 1 ? leadAngles[k] : 0);
                            const dist = 120 + Math.floor(k / candidates.length) * 90;
                            const px = (src.x + 24) + Math.cos(ang) * dist;
                            const py = (src.y + 24) + Math.sin(ang) * dist;
                            zones.push({
                                x: Math.max(radius, Math.min(ARENA_WIDTH - radius, px)),
                                y: Math.max(ARENA_TOP + radius, Math.min(ARENA_HEIGHT - radius, py)),
                                radius
                            });
                        }
                    }

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
                            damage: BOSS_DRAGON_METEOR_DAMAGE,
                            magmaDurationMs: BOSS_DRAGON_MAGMA_DURATION_MS
                        });

                        for (const id in cur.players) {
                            const p = cur.players[id];
                            if (p.isDead || p.isEliminated) continue;
                            const px = p.x + 24;
                            const py = p.y + 24;
                            const hit = zones.some((z) => Math.hypot(px - z.x, py - z.y) <= z.radius);
                            if (hit) {
                                applyDamageToPlayer(roomId, p, BOSS_DRAGON_METEOR_DAMAGE, 'meteor', matchId, cur.boss.element);
                            }
                        }

                        if (typeof spawnMagmaZones === 'function') {
                            spawnMagmaZones(roomId, zones, BOSS_DRAGON_MAGMA_DURATION_MS, matchId, cur.boss.element);
                        }
                    }, warnDuration);
                } else {
                    const ringRadius = isP2 ? 250 : 215;
                    const warnDuration = isP2 ? 680 : 780;
                    const pullStrength = isP2 ? 1.15 : 0.85;
                    const ox = boss.x;
                    const oy = boss.y;

                    boss.pulseCharging = true;
                    io.to(roomId).emit('bossAttackEvent', {
                        bossId: boss.id,
                        element: boss.element,
                        type: 'roar_warn',
                        x: ox,
                        y: oy,
                        radius: ringRadius,
                        warnDuration,
                        pullStrength
                    });

                    registerTimeout(room, () => {
                        const cur = ctx.getRoom();
                        if (!cur || cur.state !== 'playing' || cur.matchId !== matchId || !cur.boss) return;
                        cur.boss.pulseCharging = false;

                        const fx = ox;
                        const fy = oy;
                        const fireCount = cur.boss.phase === 2 ? 16 : 10;
                        const fireSpeed = cur.boss.phase === 2 ? 4.3 : 3.7;
                        const curveRate = cur.boss.phase === 2 ? 0.022 : 0.016;
                        const pulseDmg = BOSS_DRAGON_ROAR_PULSE_DAMAGE;
                        const pulseCount = BOSS_DRAGON_ROAR_PULSE_COUNT;
                        const pulseInterval = BOSS_DRAGON_ROAR_PULSE_INTERVAL_MS;

                        cur.lastBossAttackAt = Object.assign({}, cur.lastBossAttackAt, { fireball: Date.now() });

                        io.to(roomId).emit('bossAttackEvent', {
                            bossId: cur.boss.id,
                            element: cur.boss.element,
                            type: 'roar_fire',
                            x: fx,
                            y: fy,
                            radius: ringRadius,
                            fireCount,
                            fireSpeed,
                            curveRate,
                            fireDamage: BOSS_DRAGON_FIRE_DAMAGE,
                            damage: pulseDmg,
                            pulseCount,
                            pulseIntervalMs: pulseInterval
                        });

                        const dealPulseTick = (tickIdx) => {
                            const curRoom = ctx.getRoom();
                            if (!curRoom || curRoom.state !== 'playing' || curRoom.matchId !== matchId || !curRoom.boss) return;

                            if (tickIdx > 0) {
                                io.to(roomId).emit('bossAttackEvent', {
                                    bossId: curRoom.boss.id,
                                    element: curRoom.boss.element,
                                    type: 'roar_pulse',
                                    x: fx,
                                    y: fy,
                                    radius: ringRadius,
                                    damage: pulseDmg,
                                    pulseIndex: tickIdx
                                });
                            }

                            for (const id in curRoom.players) {
                                const p = curRoom.players[id];
                                if (!p || p.isDead || p.isEliminated) continue;
                                if (Math.hypot((p.x + 24) - fx, (p.y + 24) - fy) <= ringRadius) {
                                    if (typeof applyPulseDamageToPlayer === 'function') {
                                        applyPulseDamageToPlayer(roomId, p, pulseDmg, 'roar_pulse', matchId, curRoom.boss.element);
                                    } else {
                                        applyDamageToPlayer(roomId, p, pulseDmg, 'roar', matchId, curRoom.boss.element);
                                    }
                                }
                            }
                        };

                        dealPulseTick(0);
                        for (let tickIdx = 1; tickIdx < pulseCount; tickIdx++) {
                            registerTimeout(cur, () => dealPulseTick(tickIdx), tickIdx * pulseInterval);
                        }
                    }, warnDuration);
                }
            },
            drawEntity(ctx, boss, now) {
                const isRage = boss.phase === 2;
                const hasScaleAura = Boolean(boss.scaleAuraActive) || (now < (boss.scaleAuraUntil || 0));
                const bx = boss.x;
                const by = boss.y;
                const flap = Math.sin(now / (isRage ? 130 : 210)) * 12;

                ctx.save();

                if (hasScaleAura) {
                    const scaleR = boss.radius + 26 + Math.sin(now / 90) * 4;
                    ctx.beginPath();
                    for (let i = 0; i < 6; i++) {
                        const a = (Math.PI / 3) * i + now / 450;
                        const px = bx + Math.cos(a) * scaleR;
                        const py = by + Math.sin(a) * scaleR;
                        if (i === 0) ctx.moveTo(px, py);
                        else ctx.lineTo(px, py);
                    }
                    ctx.closePath();
                    ctx.fillStyle = 'rgba(255, 190, 11, 0.16)';
                    ctx.fill();
                    ctx.lineWidth = 3.5;
                    ctx.strokeStyle = '#ffbe0b';
                    ctx.stroke();
                }

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

                ctx.fillStyle = isRage ? '#7a0b0b' : '#58111a';
                ctx.strokeStyle = isRage ? '#ff9f1c' : '#ff4d4d';
                ctx.lineWidth = 2.5;

                ctx.beginPath();
                ctx.moveTo(bx - 16, by - 6);
                ctx.lineTo(bx - 68, by - 36 + flap);
                ctx.lineTo(bx - 56, by + 18 + flap * 0.5);
                ctx.lineTo(bx - 18, by + 14);
                ctx.closePath();
                ctx.fill();
                ctx.stroke();

                ctx.beginPath();
                ctx.moveTo(bx + 16, by - 6);
                ctx.lineTo(bx + 68, by - 36 + flap);
                ctx.lineTo(bx + 56, by + 18 + flap * 0.5);
                ctx.lineTo(bx + 18, by + 14);
                ctx.closePath();
                ctx.fill();
                ctx.stroke();

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
        },

        abyss_weaver: {
            id: 'abyss_weaver',
            stageNumber: 4,
            stageId: 'stage_4',
            name: 'ABYSS WEAVER',
            tag: '🕸️ 深淵・幻影策士型',
            element: 'dark',
            summary: '闇の刻印陣による減速と蛇行闇弾・内外反転リングで追い詰める深淵の織り手',
            radius: 44,
            spawnX: ARENA_CENTER_X,
            spawnY: 165,
            maxHp: 950,
            hpByPlayers: { 1: 950, 2: 1900, 3: 2850, 4: 3800 },
            speed: 3.0,
            moveSpeed5: {
                p1: 3.0,
                p2: 3.2,
                soloP1: 3.0,
                multiP1: 4.0,
                soloP2: 3.2,
                multiP2: 4.2
            },
            attackIntervalMs: {
                p1: 2400,
                p2: 1950
            },
            attackProjectiles: ['snake_dark', 'shadow_orb'],
            projectileDamage: {
                snake_dark: BOSS_ABYSS_SNAKE_DAMAGE,
                shadow_orb: BOSS_ABYSS_SHADOW_DAMAGE
            },
            attackPatterns: [
                { id: 'abyss_sigil', name: '闇の刻印陣', damage: BOSS_ABYSS_SIGIL_DAMAGE },
                { id: 'twin_serpent', name: '双蛇の闇弾', damage: BOSS_ABYSS_SNAKE_DAMAGE },
                { id: 'abyss_ring', name: '深淵の拘束リング', damage: BOSS_ABYSS_RING_DAMAGE },
                { id: 'curse_wave', name: '呪詛の影波', damage: BOSS_ABYSS_SHADOW_DAMAGE }
            ],
            patternCount: 4,
            executeAttack(ctx) {
                const {
                    room, roomId, matchId, boss, alivePlayers, targetCx, targetCy,
                    count, io, registerTimeout, applyDamageToPlayer, applySlowToPlayer
                } = ctx;
                const patternIdx = count % 4;

                if (patternIdx === 0) {
                    const isP2 = boss.phase === 2;
                    const radius = isP2 ? 100 : 88;
                    const warnDuration = isP2 ? 700 : 820;
                    const zones = [];
                    const candidates = alivePlayers.length > 0 ? alivePlayers : [{ x: targetCx - 24, y: targetCy - 24 }];

                    for (let i = 0; i < candidates.length; i++) {
                        const pl = candidates[i];
                        zones.push({
                            x: Math.max(radius, Math.min(ARENA_WIDTH - radius, pl.x + 24)),
                            y: Math.max(ARENA_TOP + radius, Math.min(ARENA_HEIGHT - radius, pl.y + 24)),
                            radius
                        });
                    }

                    if (isP2) {
                        const anchor = candidates[0];
                        const ax = anchor.x + 24;
                        const ay = anchor.y + 24;
                        const extraOffsets = [
                            { dx: -150, dy: 90 },
                            { dx: 150, dy: -90 }
                        ];
                        for (const off of extraOffsets) {
                            zones.push({
                                x: Math.max(radius, Math.min(ARENA_WIDTH - radius, ax + off.dx)),
                                y: Math.max(ARENA_TOP + radius, Math.min(ARENA_HEIGHT - radius, ay + off.dy)),
                                radius
                            });
                        }
                    }

                    io.to(roomId).emit('bossAttackEvent', {
                        bossId: boss.id,
                        element: boss.element,
                        type: 'abyss_sigil_warn',
                        zones,
                        warnDuration
                    });

                    registerTimeout(room, () => {
                        const cur = ctx.getRoom();
                        if (!cur || cur.state !== 'playing' || cur.matchId !== matchId || !cur.boss) return;

                        io.to(roomId).emit('bossAttackEvent', {
                            bossId: cur.boss.id,
                            element: cur.boss.element,
                            type: 'abyss_sigil_fire',
                            zones,
                            damage: BOSS_ABYSS_SIGIL_DAMAGE
                        });

                        for (const id in cur.players) {
                            const p = cur.players[id];
                            if (p.isDead || p.isEliminated) continue;
                            const px = p.x + 24;
                            const py = p.y + 24;
                            const hit = zones.some((z) => Math.hypot(px - z.x, py - z.y) <= z.radius);
                            if (hit) {
                                const applied = applyDamageToPlayer(
                                    roomId,
                                    p,
                                    BOSS_ABYSS_SIGIL_DAMAGE,
                                    'abyss_sigil',
                                    matchId,
                                    cur.boss.element
                                );
                                if (applied !== false && typeof applySlowToPlayer === 'function') {
                                    applySlowToPlayer(roomId, p, 0.75, 1800, matchId);
                                }
                            }
                        }
                    }, warnDuration);
                } else if (patternIdx === 1) {
                    const isP2 = boss.phase === 2;
                    const baseAngle = Math.atan2(targetCy - boss.y, targetCx - boss.x);
                    const angleOffsets = isP2 ? [-0.28, 0, 0.28] : [0];
                    const speed = isP2 ? 4.8 : 4.1;
                    const waveAmp = isP2 ? 44 : 34;
                    const waveFreq = isP2 ? 0.17 : 0.12;
                    const snakes = [];

                    for (const offset of angleOffsets) {
                        const angle = baseAngle + offset;
                        for (const side of [-1, 1]) {
                            snakes.push({
                                x: boss.x,
                                y: boss.y,
                                angle,
                                side,
                                speed,
                                waveAmp,
                                waveFreq,
                                damage: BOSS_ABYSS_SNAKE_DAMAGE
                            });
                        }
                    }

                    room.lastBossAttackAt = Object.assign({}, room.lastBossAttackAt, { snake_dark: Date.now() });
                    io.to(roomId).emit('bossAttackEvent', {
                        bossId: boss.id,
                        element: boss.element,
                        type: 'twin_serpent',
                        snakes,
                        damage: BOSS_ABYSS_SNAKE_DAMAGE
                    });
                } else if (patternIdx === 2) {
                    const isP2 = boss.phase === 2;
                    const warnDuration = isP2 ? 740 : 850;
                    const ox = boss.x;
                    const oy = boss.y;
                    const innerRadius1 = 105;
                    const outerRadius1 = 235;

                    io.to(roomId).emit('bossAttackEvent', {
                        bossId: boss.id,
                        element: boss.element,
                        type: 'abyss_ring_warn',
                        x: ox,
                        y: oy,
                        innerRadius: innerRadius1,
                        outerRadius: outerRadius1,
                        warnDuration
                    });

                    registerTimeout(room, () => {
                        const cur = ctx.getRoom();
                        if (!cur || cur.state !== 'playing' || cur.matchId !== matchId || !cur.boss) return;

                        io.to(roomId).emit('bossAttackEvent', {
                            bossId: cur.boss.id,
                            element: cur.boss.element,
                            type: 'abyss_ring_fire',
                            x: ox,
                            y: oy,
                            innerRadius: innerRadius1,
                            outerRadius: outerRadius1,
                            damage: BOSS_ABYSS_RING_DAMAGE
                        });

                        for (const id in cur.players) {
                            const p = cur.players[id];
                            if (p.isDead || p.isEliminated) continue;
                            const dist = Math.hypot((p.x + 24) - ox, (p.y + 24) - oy);
                            if (dist >= innerRadius1 && dist <= outerRadius1) {
                                applyDamageToPlayer(roomId, p, BOSS_ABYSS_RING_DAMAGE, 'abyss_ring', matchId, cur.boss.element);
                            }
                        }

                        if (isP2) {
                            const secondWarnDuration = 700;
                            const innerRadius2 = 0;
                            const outerRadius2 = 128;

                            io.to(roomId).emit('bossAttackEvent', {
                                bossId: cur.boss.id,
                                element: cur.boss.element,
                                type: 'abyss_ring_warn',
                                x: ox,
                                y: oy,
                                innerRadius: innerRadius2,
                                outerRadius: outerRadius2,
                                warnDuration: secondWarnDuration
                            });

                            registerTimeout(room, () => {
                                const cur2 = ctx.getRoom();
                                if (!cur2 || cur2.state !== 'playing' || cur2.matchId !== matchId || !cur2.boss) return;

                                io.to(roomId).emit('bossAttackEvent', {
                                    bossId: cur2.boss.id,
                                    element: cur2.boss.element,
                                    type: 'abyss_ring_fire',
                                    x: ox,
                                    y: oy,
                                    innerRadius: innerRadius2,
                                    outerRadius: outerRadius2,
                                    damage: BOSS_ABYSS_RING_DAMAGE
                                });

                                for (const id in cur2.players) {
                                    const p = cur2.players[id];
                                    if (p.isDead || p.isEliminated) continue;
                                    const dist = Math.hypot((p.x + 24) - ox, (p.y + 24) - oy);
                                    if (dist >= innerRadius2 && dist <= outerRadius2) {
                                        applyDamageToPlayer(roomId, p, BOSS_ABYSS_RING_DAMAGE, 'abyss_ring', matchId, cur2.boss.element);
                                    }
                                }
                            }, secondWarnDuration);
                        }
                    }, warnDuration);
                } else {
                    const isP2 = boss.phase === 2;
                    const bulletCount = 16;
                    const wave1Angle = (count * 0.37) % (Math.PI * 2);
                    const speed = isP2 ? 4.4 : 3.8;

                    room.lastBossAttackAt = Object.assign({}, room.lastBossAttackAt, { shadow_orb: Date.now() });
                    io.to(roomId).emit('bossAttackEvent', {
                        bossId: boss.id,
                        element: boss.element,
                        type: 'curse_wave',
                        x: boss.x,
                        y: boss.y,
                        count: bulletCount,
                        baseAngle: wave1Angle,
                        speed,
                        damage: BOSS_ABYSS_SHADOW_DAMAGE,
                        wave: 1
                    });

                    if (isP2) {
                        const wave2DelayMs = 380;
                        const wave2Angle = wave1Angle + (Math.PI / bulletCount);
                        registerTimeout(room, () => {
                            const cur = ctx.getRoom();
                            if (!cur || cur.state !== 'playing' || cur.matchId !== matchId || !cur.boss) return;

                            cur.lastBossAttackAt = Object.assign({}, cur.lastBossAttackAt, { shadow_orb: Date.now() });
                            io.to(roomId).emit('bossAttackEvent', {
                                bossId: cur.boss.id,
                                element: cur.boss.element,
                                type: 'curse_wave',
                                x: cur.boss.x,
                                y: cur.boss.y,
                                count: bulletCount,
                                baseAngle: wave2Angle,
                                speed: speed + 0.25,
                                damage: BOSS_ABYSS_SHADOW_DAMAGE,
                                wave: 2
                            });
                        }, wave2DelayMs);
                    }
                }
            },
            drawEntity(ctx, boss, now) {
                const isRage = boss.phase === 2;
                const bx = boss.x;
                const by = boss.y;
                const rot = now / (isRage ? 280 : 500);

                ctx.save();

                const auraR = boss.radius + 22 + Math.sin(now / 150) * 5;
                const aura = ctx.createRadialGradient(bx, by, boss.radius * 0.3, bx, by, auraR);
                aura.addColorStop(0, isRage ? 'rgba(217, 70, 239, 0.35)' : 'rgba(139, 92, 246, 0.28)');
                aura.addColorStop(1, 'rgba(15, 10, 30, 0)');
                ctx.fillStyle = aura;
                ctx.beginPath();
                ctx.arc(bx, by, auraR, 0, Math.PI * 2);
                ctx.fill();

                ctx.save();
                ctx.translate(bx, by);
                ctx.rotate(rot);
                ctx.strokeStyle = isRage ? '#f43f5e' : '#a855f7';
                ctx.lineWidth = 2.5;
                for (let i = 0; i < 6; i++) {
                    const a = (Math.PI / 3) * i;
                    ctx.beginPath();
                    ctx.moveTo(Math.cos(a) * (boss.radius - 4), Math.sin(a) * (boss.radius - 4));
                    ctx.lineTo(Math.cos(a + 0.35) * (boss.radius + 16), Math.sin(a + 0.35) * (boss.radius + 16));
                    ctx.stroke();
                }
                ctx.beginPath();
                ctx.arc(0, 0, boss.radius + 10, 0, Math.PI * 2);
                ctx.setLineDash([7, 5]);
                ctx.strokeStyle = isRage ? '#e879f9' : '#7c3aed';
                ctx.stroke();
                ctx.setLineDash([]);
                ctx.restore();

                const bodyGrad = ctx.createRadialGradient(bx, by - 6, 8, bx, by, boss.radius);
                bodyGrad.addColorStop(0, isRage ? '#701a75' : '#3b0764');
                bodyGrad.addColorStop(0.65, '#1e1b4b');
                bodyGrad.addColorStop(1, '#09090b');

                ctx.beginPath();
                ctx.arc(bx, by, boss.radius, 0, Math.PI * 2);
                ctx.fillStyle = bodyGrad;
                ctx.fill();
                ctx.lineWidth = 3;
                ctx.strokeStyle = isRage ? '#f472b6' : '#c084fc';
                ctx.stroke();

                ctx.fillStyle = isRage ? '#fb7185' : '#e879f9';
                const eyePairs = [
                    { dx: 14, dy: -6, r: 4.2 },
                    { dx: 22, dy: 4, r: 3.0 },
                    { dx: 9, dy: 8, r: 2.8 }
                ];
                for (const ep of eyePairs) {
                    ctx.beginPath();
                    ctx.arc(bx - ep.dx, by + ep.dy, ep.r, 0, Math.PI * 2);
                    ctx.arc(bx + ep.dx, by + ep.dy, ep.r, 0, Math.PI * 2);
                    ctx.fill();
                }

                ctx.restore();
            }
        },

        phantom_mirage: {
            id: 'phantom_mirage',
            stageNumber: 5,
            stageId: 'stage_5',
            name: 'PHANTOM MIRAGE',
            tag: '🎭 幻惑・無属性策略型',
            element: 'neutral',
            summary: '幻影分身・潜伏2択魔法陣奇襲・ランダム状態異常で翻弄する無属性の策士',
            radius: 42,
            spawnX: ARENA_CENTER_X,
            spawnY: 165,
            maxHp: 900,
            hpByPlayers: { 1: 900, 2: 1400, 3: 2000, 4: 2600 },
            speed: 3.2,
            moveSpeed: {
                p1: 3.2,
                p2: 4.8,
                soloP1: 3.2,
                multiP1: 3.2,
                soloP2: 4.8,
                multiP2: 4.8
            },
            attackIntervalMs: {
                p1: 1900,
                p2: 950
            },
            randomActionSelection: true,
            attackProjectiles: ['phantom_homing', 'curse_bolt', 'feint_orb'],
            projectileDamage: {
                phantom_homing: BOSS_PHANTOM_HOMING_DAMAGE,
                curse_bolt: BOSS_PHANTOM_CURSE_DAMAGE,
                feint_orb: BOSS_PHANTOM_FEINT_P2_DAMAGE
            },
            attackPatterns: [
                { id: 'phantom_clone', name: '幻影分身＆追尾球', damage: BOSS_PHANTOM_HOMING_DAMAGE },
                { id: 'stealth_ambush', name: '潜伏〜2択魔法陣の奇襲', damage: BOSS_PHANTOM_AMBUSH_DAMAGE },
                { id: 'random_curse', name: '呪詛のランダム状態異常', damage: BOSS_PHANTOM_CURSE_DAMAGE },
                { id: 'feint_barrage', name: '策謀の牽制弾幕', damage: BOSS_PHANTOM_FEINT_P1_DAMAGE }
            ],
            patternCount: 4,
            executeAttack(ctx) {
                const {
                    room, roomId, matchId, boss, targetCx, targetCy,
                    io, registerTimeout, applyDamageToPlayer, applySlowToPlayer, knockbackPlayerFromPoint
                } = ctx;

                // 潜伏無敵中は他の攻撃を重ねない
                if (boss.isStealthed) return;

                // 完全ランダム抽選（0〜3）
                const patternIdx = Math.floor(Math.random() * 4);
                const isP2 = boss.phase === 2;

                if (patternIdx === 0) {
                    const cloneDurationMs = 4200;
                    const offsetAngle = Math.random() * Math.PI * 2;
                    const clonePos = clampArenaPoint(
                        boss.x + Math.cos(offsetAngle) * 190,
                        boss.y + Math.sin(offsetAngle) * 150,
                        95
                    );
                    const cloneId = `clone_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
                    if (!Array.isArray(boss.clones)) boss.clones = [];
                    boss.clones.push({ id: cloneId, x: clonePos.x, y: clonePos.y, expiresAt: Date.now() + cloneDurationMs });

                    io.to(roomId).emit('bossAttackEvent', {
                        bossId: boss.id,
                        element: boss.element,
                        type: 'phantom_clone_spawn',
                        cloneId,
                        x: clonePos.x,
                        y: clonePos.y,
                        durationMs: cloneDurationMs
                    });

                    const totalOrbs = isP2 ? 4 : 2;
                    const origins = [
                        { x: boss.x, y: boss.y },
                        { x: clonePos.x, y: clonePos.y }
                    ];
                    const orbs = [];
                    for (let i = 0; i < totalOrbs; i++) {
                        const origin = origins[i % origins.length];
                        const spread = ((Math.floor(i / origins.length)) - 0.5) * 0.42;
                        const ang = Math.atan2(targetCy - origin.y, targetCx - origin.x) + spread;
                        const spd = isP2 ? 3.9 : 3.4;
                        orbs.push({
                            x: origin.x,
                            y: origin.y,
                            vx: Math.cos(ang) * spd,
                            vy: Math.sin(ang) * spd,
                            speed: spd,
                            turnRate: isP2 ? 0.055 : 0.045,
                            damage: BOSS_PHANTOM_HOMING_DAMAGE
                        });
                    }

                    room.lastBossAttackAt = Object.assign({}, room.lastBossAttackAt, { phantom_homing: Date.now() });
                    io.to(roomId).emit('bossAttackEvent', {
                        bossId: boss.id,
                        element: boss.element,
                        type: 'phantom_homing',
                        orbs,
                        damage: BOSS_PHANTOM_HOMING_DAMAGE
                    });

                    registerTimeout(room, () => {
                        const cur = ctx.getRoom();
                        if (!cur || cur.matchId !== matchId || !cur.boss) return;
                        if (Array.isArray(cur.boss.clones)) {
                            cur.boss.clones = cur.boss.clones.filter((c) => c.id !== cloneId);
                        }
                        io.to(roomId).emit('bossAttackEvent', {
                            bossId: cur.boss.id,
                            element: cur.boss.element,
                            type: 'phantom_clone_despawn',
                            cloneId
                        });
                    }, cloneDurationMs);
                } else if (patternIdx === 1) {
                    const stealthMoveMs = 2600;
                    const warnDuration = 1000;
                    const ambushRadius = 100;

                    boss.isStealthed = true;
                    io.to(roomId).emit('bossStateUpdated', boss);
                    io.to(roomId).emit('bossAttackEvent', {
                        bossId: boss.id,
                        element: boss.element,
                        type: 'phantom_stealth_start',
                        x: boss.x,
                        y: boss.y,
                        durationMs: stealthMoveMs + warnDuration
                    });

                    registerTimeout(room, () => {
                        const cur = ctx.getRoom();
                        if (!cur || cur.state !== 'playing' || cur.matchId !== matchId || !cur.boss) return;

                        const liveList = Object.values(cur.players).filter((pl) => pl && !pl.isDead && !pl.isEliminated);
                        const anchor = liveList.length > 0
                            ? liveList[Math.floor(Math.random() * liveList.length)]
                            : { x: targetCx - 24, y: targetCy - 24 };

                        const realPos = clampArenaPoint(anchor.x + 24, anchor.y + 24, ambushRadius + 10);
                        const fakeAngle = Math.random() * Math.PI * 2;
                        const fakePos = clampArenaPoint(
                            realPos.x + Math.cos(fakeAngle) * 260,
                            realPos.y + Math.sin(fakeAngle) * 220,
                            ambushRadius + 10
                        );

                        const realFirst = Math.random() < 0.5;
                        const circles = realFirst
                            ? [{ x: realPos.x, y: realPos.y, radius: ambushRadius }, { x: fakePos.x, y: fakePos.y, radius: ambushRadius }]
                            : [{ x: fakePos.x, y: fakePos.y, radius: ambushRadius }, { x: realPos.x, y: realPos.y, radius: ambushRadius }];

                        io.to(roomId).emit('bossAttackEvent', {
                            bossId: cur.boss.id,
                            element: cur.boss.element,
                            type: 'phantom_ambush_warn',
                            circles,
                            warnDuration
                        });

                        registerTimeout(cur, () => {
                            const cur2 = ctx.getRoom();
                            if (!cur2 || cur2.state !== 'playing' || cur2.matchId !== matchId || !cur2.boss) return;

                            cur2.boss.x = realPos.x;
                            cur2.boss.y = realPos.y;
                            cur2.boss.isStealthed = false;
                            io.to(roomId).emit('bossStateUpdated', cur2.boss);

                            io.to(roomId).emit('bossAttackEvent', {
                                bossId: cur2.boss.id,
                                element: cur2.boss.element,
                                type: 'phantom_ambush_fire',
                                realX: realPos.x,
                                realY: realPos.y,
                                fakeX: fakePos.x,
                                fakeY: fakePos.y,
                                radius: ambushRadius,
                                damage: BOSS_PHANTOM_AMBUSH_DAMAGE
                            });

                            for (const id in cur2.players) {
                                const p = cur2.players[id];
                                if (!p || p.isDead || p.isEliminated) continue;
                                const pcx = p.x + 24;
                                const pcy = p.y + 24;
                                if (Math.hypot(pcx - realPos.x, pcy - realPos.y) <= ambushRadius) {
                                    const applied = applyDamageToPlayer(
                                        roomId,
                                        p,
                                        BOSS_PHANTOM_AMBUSH_DAMAGE,
                                        'phantom_ambush',
                                        matchId,
                                        cur2.boss.element
                                    );
                                    if (applied !== false) {
                                        if (typeof applySlowToPlayer === 'function') {
                                            applySlowToPlayer(roomId, p, 0.75, 2000, matchId);
                                        }
                                        if (typeof knockbackPlayerFromPoint === 'function') {
                                            knockbackPlayerFromPoint(roomId, p, realPos.x, realPos.y, ambushRadius + 36, matchId, 'phantom_ambush');
                                        }
                                    }
                                }
                            }
                        }, warnDuration);
                    }, stealthMoveMs);
                } else if (patternIdx === 2) {
                    const baseAngle = Math.atan2(targetCy - boss.y, targetCx - boss.x);
                    const countShots = isP2 ? 5 : 3;
                    const spread = isP2 ? 0.92 : 0.62;
                    const speed = isP2 ? 4.7 : 4.1;

                    room.lastBossAttackAt = Object.assign({}, room.lastBossAttackAt, { curse_bolt: Date.now() });
                    io.to(roomId).emit('bossAttackEvent', {
                        bossId: boss.id,
                        element: boss.element,
                        type: 'curse_bolt_fire',
                        x: boss.x,
                        y: boss.y,
                        baseAngle,
                        spread,
                        count: countShots,
                        speed,
                        damage: BOSS_PHANTOM_CURSE_DAMAGE
                    });
                } else {
                    const countShots = isP2 ? 18 : 10;
                    const speed = isP2 ? 4.5 : 3.8;
                    const damage = isP2 ? BOSS_PHANTOM_FEINT_P2_DAMAGE : BOSS_PHANTOM_FEINT_P1_DAMAGE;
                    const baseAngle = Math.random() * Math.PI * 2;

                    room.lastBossAttackAt = Object.assign({}, room.lastBossAttackAt, { feint_orb: Date.now() });
                    io.to(roomId).emit('bossAttackEvent', {
                        bossId: boss.id,
                        element: boss.element,
                        type: 'feint_barrage',
                        x: boss.x,
                        y: boss.y,
                        count: countShots,
                        baseAngle,
                        speed,
                        damage
                    });
                }
            },
            drawEntity(ctx, boss, now) {
                if (boss.isStealthed) return;
                const isRage = boss.phase === 2;
                const bx = boss.x;
                const by = boss.y;
                const rot = now / (isRage ? 240 : 420);

                ctx.save();

                const auraR = boss.radius + 20 + Math.sin(now / 140) * 5;
                const aura = ctx.createRadialGradient(bx, by, boss.radius * 0.25, bx, by, auraR);
                aura.addColorStop(0, isRage ? 'rgba(244, 63, 94, 0.34)' : 'rgba(226, 232, 240, 0.3)');
                aura.addColorStop(1, 'rgba(15, 23, 42, 0)');
                ctx.fillStyle = aura;
                ctx.beginPath();
                ctx.arc(bx, by, auraR, 0, Math.PI * 2);
                ctx.fill();

                ctx.save();
                ctx.translate(bx, by);
                ctx.rotate(rot);
                ctx.strokeStyle = isRage ? '#fb7185' : '#e2e8f0';
                ctx.lineWidth = 2.2;
                ctx.strokeRect(-(boss.radius + 4), -(boss.radius + 4), (boss.radius + 4) * 2, (boss.radius + 4) * 2);
                ctx.rotate(Math.PI / 4);
                ctx.strokeStyle = isRage ? '#f43f5e' : '#94a3b8';
                ctx.strokeRect(-(boss.radius + 2), -(boss.radius + 2), (boss.radius + 2) * 2, (boss.radius + 2) * 2);
                ctx.restore();

                const grad = ctx.createRadialGradient(bx, by - 6, 6, bx, by, boss.radius);
                grad.addColorStop(0, isRage ? '#fff1f2' : '#f8fafc');
                grad.addColorStop(0.55, isRage ? '#9f1239' : '#475569');
                grad.addColorStop(1, '#0f172a');

                ctx.beginPath();
                ctx.arc(bx, by, boss.radius - 3, 0, Math.PI * 2);
                ctx.fillStyle = grad;
                ctx.fill();
                ctx.lineWidth = 3;
                ctx.strokeStyle = isRage ? '#fda4af' : '#f1f5f9';
                ctx.stroke();

                ctx.fillStyle = isRage ? '#ff2a00' : '#0f172a';
                ctx.beginPath();
                ctx.moveTo(bx - 20, by - 8);
                ctx.lineTo(bx - 6, by - 2);
                ctx.lineTo(bx - 16, by + 5);
                ctx.closePath();
                ctx.fill();

                ctx.beginPath();
                ctx.moveTo(bx + 20, by - 8);
                ctx.lineTo(bx + 6, by - 2);
                ctx.lineTo(bx + 16, by + 5);
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
            clearRewardPt: 500
        }),
        Object.freeze({
            stageNumber: 2,
            stageId: 'stage_2',
            title: 'STAGE 2 : 古代要塞中枢',
            bossId: 'omega_core',
            unlockedByDefault: false,
            clearRewardPt: 1000
        }),
        Object.freeze({
            stageNumber: 3,
            stageId: 'stage_3',
            title: 'STAGE 3 : 紅蓮竜の巣窟',
            bossId: 'inferno_dragon',
            unlockedByDefault: false,
            clearRewardPt: 1500
        }),
        Object.freeze({
            stageNumber: 4,
            stageId: 'stage_4',
            title: 'STAGE 4 : 深淵の織成界',
            bossId: 'abyss_weaver',
            unlockedByDefault: false,
            clearRewardPt: 2000
        }),
        Object.freeze({
            stageNumber: 5,
            stageId: 'stage_5',
            title: '幻惑の蜃気楼',
            bossId: 'phantom_mirage',
            unlockedByDefault: false,
            clearRewardPt: 2500
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
            scaleAuraActive: false,
            scaleAuraUntil: 0,
            isStealthed: false,
            clones: [],
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
                    life: 120
                });
            }
        } else if (ev.type === 'phantom_clone_spawn') {
            callSeSafe(state, 'shield');
            const frames = Math.max(40, Math.round((ev.durationMs || 4200) / 16.67));
            state.bossEffects.push({
                type: 'phantom_clone',
                cloneId: ev.cloneId,
                x: ev.x,
                y: ev.y,
                timer: frames,
                maxTimer: frames
            });
        } else if (ev.type === 'phantom_clone_despawn') {
            for (let i = state.bossEffects.length - 1; i >= 0; i--) {
                if (state.bossEffects[i].type === 'phantom_clone' && state.bossEffects[i].cloneId === ev.cloneId) {
                    state.bossEffects.splice(i, 1);
                }
            }
        } else if (ev.type === 'phantom_homing') {
            callSeSafe(state, 'shot');
            for (const o of (ev.orbs || [])) {
                state.bossProjectiles.push({
                    kind: 'phantom_homing',
                    element: ev.element || def.element,
                    x: o.x,
                    y: o.y,
                    vx: o.vx,
                    vy: o.vy,
                    speed: o.speed || 3.4,
                    turnRate: o.turnRate || 0.045,
                    damage: o.damage || BOSS_PHANTOM_HOMING_DAMAGE,
                    life: 135
                });
            }
        } else if (ev.type === 'phantom_stealth_start') {
            callSeSafe(state, 'shield');
            if (state.bossState) {
                state.bossState.isStealthed = true;
                if (typeof state.addFloatingText === 'function') {
                    state.addFloatingText(ev.x, ev.y - 42, 'VANISHED...', '#cbd5e1');
                }
            }
            state.bossEffects.push({
                type: 'stealth_smoke',
                x: ev.x,
                y: ev.y,
                timer: 24,
                maxTimer: 24
            });
        } else if (ev.type === 'phantom_ambush_warn') {
            callSeSafe(state, 'zoneHit');
            state.bossEffects.push({
                type: 'ambush_warn',
                circles: ev.circles || [],
                timer: Math.max(20, Math.round((ev.warnDuration || 1000) / 16))
            });
        } else if (ev.type === 'phantom_ambush_fire') {
            callSeSafe(state, 'bossPulse');
            if (typeof state.onShake === 'function') state.onShake(12, 7);
            if (state.bossState) {
                state.bossState.x = ev.realX;
                state.bossState.y = ev.realY;
                state.bossState.isStealthed = false;
            }
            for (let i = state.bossEffects.length - 1; i >= 0; i--) {
                if (state.bossEffects[i].type === 'ambush_warn') {
                    state.bossEffects.splice(i, 1);
                }
            }
            state.bossEffects.push({
                type: 'ambush_fire',
                x: ev.realX,
                y: ev.realY,
                radius: ev.radius || 100,
                timer: 24,
                maxTimer: 24
            });
            state.bossEffects.push({
                type: 'ambush_fake_fade',
                x: ev.fakeX,
                y: ev.fakeY,
                radius: ev.radius || 100,
                timer: 18,
                maxTimer: 18
            });
        } else if (ev.type === 'curse_bolt_fire') {
            callSeSafe(state, 'shot');
            const total = Math.max(1, ev.count || 3);
            const spread = ev.spread || 0.62;
            const speed = ev.speed || 4.1;
            for (let i = 0; i < total; i++) {
                const offset = total === 1 ? 0 : ((i / (total - 1)) - 0.5) * spread;
                const ang = ev.baseAngle + offset;
                state.bossProjectiles.push({
                    kind: 'curse_bolt',
                    element: ev.element || def.element,
                    x: ev.x,
                    y: ev.y,
                    vx: Math.cos(ang) * speed,
                    vy: Math.sin(ang) * speed,
                    damage: ev.damage || BOSS_PHANTOM_CURSE_DAMAGE,
                    life: 145
                });
            }
        } else if (ev.type === 'feint_barrage') {
            callSeSafe(state, 'shot');
            const total = Math.max(1, ev.count || 10);
            const baseAngle = ev.baseAngle || 0;
            const speed = ev.speed || 3.8;
            for (let i = 0; i < total; i++) {
                const ang = baseAngle + (Math.PI * 2 / total) * i;
                state.bossProjectiles.push({
                    kind: 'feint_orb',
                    element: ev.element || def.element,
                    x: ev.x,
                    y: ev.y,
                    vx: Math.cos(ang) * speed,
                    vy: Math.sin(ang) * speed,
                    damage: ev.damage || BOSS_PHANTOM_FEINT_P1_DAMAGE,
                    life: 150
                });
            }
        } else if (ev.type === 'twin_serpent') {
            callSeSafe(state, 'shot');
            for (const s of (ev.snakes || [])) {
                state.bossProjectiles.push({
                    kind: 'snake_dark',
                    element: ev.element || def.element,
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
                    vx: Math.cos(s.angle) * (s.speed || 4.1),
                    vy: Math.sin(s.angle) * (s.speed || 4.1),
                    damage: s.damage || ev.damage || BOSS_ABYSS_SNAKE_DAMAGE,
                    life: 155
                });
            }
        } else if (ev.type === 'curse_wave') {
            callSeSafe(state, 'shot');
            const total = Math.max(1, ev.count || 16);
            const baseAngle = ev.baseAngle || 0;
            const speed = ev.speed || 3.8;
            for (let i = 0; i < total; i++) {
                const ang = baseAngle + (Math.PI * 2 / total) * i;
                state.bossProjectiles.push({
                    kind: 'shadow_orb',
                    element: ev.element || def.element,
                    x: ev.x,
                    y: ev.y,
                    vx: Math.cos(ang) * speed,
                    vy: Math.sin(ang) * speed,
                    damage: ev.damage || BOSS_ABYSS_SHADOW_DAMAGE,
                    life: 150
                });
            }
        } else if (ev.type === 'abyss_sigil_warn') {
            state.bossEffects.push({
                type: 'abyss_sigil_warn',
                zones: ev.zones || [],
                timer: Math.max(20, Math.round((ev.warnDuration || 820) / 16))
            });
        } else if (ev.type === 'abyss_sigil_fire') {
            callSeSafe(state, 'bossPulse');
            if (typeof state.onShake === 'function') state.onShake(10, 6);
            state.bossEffects.push({
                type: 'abyss_sigil_fire',
                zones: ev.zones || [],
                timer: 24
            });
        } else if (ev.type === 'abyss_ring_warn') {
            state.bossEffects.push({
                type: 'abyss_ring_warn',
                x: ev.x,
                y: ev.y,
                innerRadius: ev.innerRadius || 0,
                outerRadius: ev.outerRadius || 220,
                timer: Math.max(20, Math.round((ev.warnDuration || 850) / 16))
            });
        } else if (ev.type === 'abyss_ring_fire') {
            callSeSafe(state, 'bossPulse');
            if (typeof state.onShake === 'function') state.onShake(12, 7);
            state.bossEffects.push({
                type: 'abyss_ring_fire',
                x: ev.x,
                y: ev.y,
                innerRadius: ev.innerRadius || 0,
                outerRadius: ev.outerRadius || 220,
                timer: 22
            });
        } else if (ev.type === 'p2_awaken') {
            callSeSafe(state, 'bossPulse');
            if (typeof state.onShake === 'function') state.onShake(16, 9);
            if (state.bossState) {
                state.bossState.scaleAuraActive = true;
                state.bossState.scaleAuraUntil = performance.now() + (ev.scaleAuraDurationMs || 3000);
                if (typeof state.addFloatingText === 'function') {
                    state.addFloatingText(state.bossState.x, state.bossState.y - 60, 'DRAGON SCALE AURA!!', '#ffbe0b');
                }
            }
            state.bossEffects.push({
                type: 'awaken_shockwave',
                x: ev.x,
                y: ev.y,
                radius: ev.knockbackRadius || 240,
                timer: 24,
                maxTimer: 24
            });
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
                timer: Math.max(20, Math.round((ev.warnDuration || 680) / 16))
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
                timer: Math.max(20, Math.round((ev.warnDuration || 900) / 16))
            });
        } else if (ev.type === 'meteor_fire') {
            callSeSafe(state, 'bossPulse');
            if (typeof state.onShake === 'function') state.onShake(13, 8);
            const zones = ev.zones || [];
            state.bossEffects.push({
                type: 'meteor_fire',
                zones,
                timer: 24
            });
            const magmaDurationMs = ev.magmaDurationMs || BOSS_DRAGON_MAGMA_DURATION_MS;
            if (magmaDurationMs > 0 && zones.length > 0) {
                const magmaFrames = Math.max(60, Math.round(magmaDurationMs / 16.67));
                state.bossEffects.push({
                    type: 'magma_floor',
                    zones,
                    timer: magmaFrames,
                    maxTimer: magmaFrames
                });
            }
        } else if (ev.type === 'roar_warn') {
            const warnMs = ev.warnDuration || 780;
            if (ev.pullStrength && typeof state.setVortex === 'function') {
                state.setVortex(performance.now() + warnMs, ev.pullStrength);
            }
            state.bossEffects.push({
                type: 'roar_warn',
                x: ev.x, y: ev.y, radius: ev.radius,
                timer: Math.max(20, Math.round(warnMs / 16))
            });
        } else if (ev.type === 'roar_fire') {
            callSeSafe(state, 'bossPulse');
            if (typeof state.onShake === 'function') state.onShake(14, 8);
            state.bossEffects.push({
                type: 'roar_fire',
                x: ev.x, y: ev.y, radius: ev.radius,
                timer: 18
            });
            const fireCount = ev.fireCount || 10;
            const fireSpeed = ev.fireSpeed || 3.7;
            const curveRate = ev.curveRate || 0;
            for (let i = 0; i < fireCount; i++) {
                const ang = (Math.PI * 2 / fireCount) * i;
                state.bossProjectiles.push({
                    kind: 'fireball',
                    element: ev.element || def.element,
                    x: ev.x,
                    y: ev.y,
                    vx: Math.cos(ang) * fireSpeed,
                    vy: Math.sin(ang) * fireSpeed,
                    curveRate,
                    damage: ev.fireDamage || BOSS_DRAGON_FIRE_DAMAGE,
                    life: 145
                });
            }
        } else if (ev.type === 'roar_pulse') {
            callSeSafe(state, 'zoneHit');
            if (typeof state.onShake === 'function') state.onShake(6, 4);
            state.bossEffects.push({
                type: 'roar_pulse',
                x: ev.x, y: ev.y, radius: ev.radius,
                timer: 12,
                maxTimer: 12
            });
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

            if ((bp.kind === 'homing' || bp.kind === 'phantom_homing') && !player.isDead && !player.isEliminated) {
                const desiredAngle = Math.atan2(pcy - bp.y, pcx - bp.x);
                const curAngle = Math.atan2(bp.vy, bp.vx);
                let diff = desiredAngle - curAngle;
                while (diff > Math.PI) diff -= Math.PI * 2;
                while (diff < -Math.PI) diff += Math.PI * 2;
                const step = Math.max(-bp.turnRate, Math.min(bp.turnRate, diff));
                const nextAngle = curAngle + step;
                bp.vx = Math.cos(nextAngle) * bp.speed;
                bp.vy = Math.sin(nextAngle) * bp.speed;
                bp.x += bp.vx;
                bp.y += bp.vy;
            } else if (bp.kind === 'snake_dark') {
                bp.age = (bp.age || 0) + 1;
                const prevX = bp.x;
                const prevY = bp.y;
                bp.baseX += Math.cos(bp.angle) * bp.speed;
                bp.baseY += Math.sin(bp.angle) * bp.speed;
                const offset = bp.side * Math.sin(bp.age * bp.waveFreq) * bp.waveAmp;
                const perpX = -Math.sin(bp.angle);
                const perpY = Math.cos(bp.angle);
                bp.x = bp.baseX + perpX * offset;
                bp.y = bp.baseY + perpY * offset;
                bp.vx = bp.x - prevX;
                bp.vy = bp.y - prevY;
            } else {
                if (bp.kind === 'fireball' && bp.curveRate) {
                    const cosA = Math.cos(bp.curveRate);
                    const sinA = Math.sin(bp.curveRate);
                    const nvx = bp.vx * cosA - bp.vy * sinA;
                    const nvy = bp.vx * sinA + bp.vy * cosA;
                    bp.vx = nvx;
                    bp.vy = nvy;
                }
                bp.x += bp.vx;
                bp.y += bp.vy;
            }

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
                const hitRadius = bp.kind === 'homing'
                    ? 24
                    : (bp.kind === 'fireball' ? 23 : (bp.kind === 'shadow_orb' || bp.kind === 'feint_orb' ? 18 : 20));
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
        const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
        for (const ef of bossEffects) {
            gameCtx.save();
            if (ef.type === 'phantom_clone') {
                const flicker = 0.45 + 0.2 * Math.sin(now / 90);
                gameCtx.globalAlpha = Math.min(flicker, ef.timer / 20);
                const r = 38;
                gameCtx.save();
                gameCtx.translate(ef.x, ef.y);
                gameCtx.rotate(now / 260);
                gameCtx.strokeStyle = '#cbd5e1';
                gameCtx.lineWidth = 2;
                gameCtx.setLineDash([6, 4]);
                gameCtx.strokeRect(-r, -r, r * 2, r * 2);
                gameCtx.setLineDash([]);
                gameCtx.restore();

                const cGrad = gameCtx.createRadialGradient(ef.x, ef.y, 4, ef.x, ef.y, r);
                cGrad.addColorStop(0, 'rgba(241, 245, 249, 0.75)');
                cGrad.addColorStop(1, 'rgba(51, 65, 85, 0.25)');
                gameCtx.beginPath();
                gameCtx.arc(ef.x, ef.y, r - 4, 0, Math.PI * 2);
                gameCtx.fillStyle = cGrad;
                gameCtx.fill();
                gameCtx.strokeStyle = '#94a3b8';
                gameCtx.lineWidth = 2;
                gameCtx.stroke();

                gameCtx.font = 'bold 10px sans-serif';
                gameCtx.textAlign = 'center';
                gameCtx.fillStyle = '#e2e8f0';
                gameCtx.fillText('MIRAGE', ef.x, ef.y - r - 6);
            } else if (ef.type === 'stealth_smoke') {
                const progress = 1 - (ef.timer / (ef.maxTimer || 24));
                gameCtx.globalAlpha = Math.max(0, 1 - progress);
                gameCtx.beginPath();
                gameCtx.arc(ef.x, ef.y, 35 + progress * 55, 0, Math.PI * 2);
                gameCtx.strokeStyle = '#e2e8f0';
                gameCtx.lineWidth = 5;
                gameCtx.stroke();
            } else if (ef.type === 'ambush_warn') {
                for (const c of (ef.circles || [])) {
                    gameCtx.beginPath();
                    gameCtx.arc(c.x, c.y, c.radius, 0, Math.PI * 2);
                    gameCtx.fillStyle = 'rgba(203, 213, 225, 0.16)';
                    gameCtx.fill();
                    gameCtx.strokeStyle = '#f8fafc';
                    gameCtx.lineWidth = 2.5;
                    gameCtx.setLineDash([8, 5]);
                    gameCtx.stroke();
                    gameCtx.setLineDash([]);

                    gameCtx.save();
                    gameCtx.translate(c.x, c.y);
                    gameCtx.rotate(now / 260);
                    gameCtx.strokeStyle = 'rgba(168, 85, 247, 0.72)';
                    gameCtx.lineWidth = 2;
                    gameCtx.strokeRect(-c.radius * 0.45, -c.radius * 0.45, c.radius * 0.9, c.radius * 0.9);
                    gameCtx.restore();
                }
            } else if (ef.type === 'ambush_fire') {
                const progress = 1 - (ef.timer / (ef.maxTimer || 24));
                gameCtx.globalAlpha = Math.max(0, 1 - progress);
                gameCtx.beginPath();
                gameCtx.arc(ef.x, ef.y, ef.radius, 0, Math.PI * 2);
                gameCtx.fillStyle = 'rgba(241, 245, 249, 0.5)';
                gameCtx.fill();
                gameCtx.strokeStyle = '#f43f5e';
                gameCtx.lineWidth = 6;
                gameCtx.stroke();
            } else if (ef.type === 'ambush_fake_fade') {
                const progress = 1 - (ef.timer / (ef.maxTimer || 18));
                gameCtx.globalAlpha = Math.max(0, (1 - progress) * 0.45);
                gameCtx.beginPath();
                gameCtx.arc(ef.x, ef.y, ef.radius * (1 - progress * 0.2), 0, Math.PI * 2);
                gameCtx.strokeStyle = '#94a3b8';
                gameCtx.lineWidth = 2;
                gameCtx.stroke();
            } else if (ef.type === 'magma_floor') {
                const fade = ef.maxTimer ? Math.min(1, ef.timer / 24) : 1;
                gameCtx.globalAlpha = fade;
                const pulse = Math.sin(now / 130) * 0.12 + 0.34;
                for (const z of (ef.zones || [])) {
                    gameCtx.beginPath();
                    gameCtx.arc(z.x, z.y, z.radius, 0, Math.PI * 2);
                    gameCtx.fillStyle = `rgba(220, 38, 38, ${pulse.toFixed(2)})`;
                    gameCtx.fill();
                    gameCtx.strokeStyle = '#ff9f1c';
                    gameCtx.lineWidth = 2.5;
                    gameCtx.stroke();

                    gameCtx.beginPath();
                    gameCtx.arc(z.x, z.y, z.radius * 0.55, 0, Math.PI * 2);
                    gameCtx.strokeStyle = 'rgba(253, 224, 71, 0.45)';
                    gameCtx.lineWidth = 1.5;
                    gameCtx.stroke();
                }
            } else if (ef.type === 'awaken_shockwave') {
                const progress = 1 - (ef.timer / (ef.maxTimer || 24));
                gameCtx.globalAlpha = Math.max(0, 1 - progress);
                gameCtx.beginPath();
                gameCtx.arc(ef.x, ef.y, (ef.radius || 240) * (0.25 + progress * 0.85), 0, Math.PI * 2);
                gameCtx.strokeStyle = '#ffbe0b';
                gameCtx.lineWidth = 8;
                gameCtx.stroke();
            } else if (ef.type === 'abyss_sigil_warn') {
                for (const z of (ef.zones || [])) {
                    gameCtx.beginPath();
                    gameCtx.arc(z.x, z.y, z.radius, 0, Math.PI * 2);
                    gameCtx.fillStyle = 'rgba(139, 92, 246, 0.16)';
                    gameCtx.fill();
                    gameCtx.strokeStyle = '#c084fc';
                    gameCtx.lineWidth = 2.5;
                    gameCtx.setLineDash([7, 5]);
                    gameCtx.stroke();
                    gameCtx.setLineDash([]);

                    gameCtx.beginPath();
                    gameCtx.arc(z.x, z.y, z.radius * 0.55, 0, Math.PI * 2);
                    gameCtx.strokeStyle = 'rgba(232, 121, 249, 0.55)';
                    gameCtx.lineWidth = 1.5;
                    gameCtx.stroke();
                }
            } else if (ef.type === 'abyss_sigil_fire') {
                for (const z of (ef.zones || [])) {
                    gameCtx.beginPath();
                    gameCtx.arc(z.x, z.y, z.radius, 0, Math.PI * 2);
                    gameCtx.fillStyle = 'rgba(126, 34, 206, 0.48)';
                    gameCtx.fill();
                    gameCtx.strokeStyle = '#f472b6';
                    gameCtx.lineWidth = 5;
                    gameCtx.stroke();
                }
            } else if (ef.type === 'abyss_ring_warn') {
                gameCtx.beginPath();
                gameCtx.arc(ef.x, ef.y, ef.outerRadius, 0, Math.PI * 2, false);
                if (ef.innerRadius > 0) {
                    gameCtx.arc(ef.x, ef.y, ef.innerRadius, 0, Math.PI * 2, true);
                }
                gameCtx.fillStyle = 'rgba(168, 85, 247, 0.18)';
                gameCtx.fill('evenodd');

                gameCtx.strokeStyle = '#e879f9';
                gameCtx.lineWidth = 2.5;
                gameCtx.setLineDash([8, 6]);
                gameCtx.beginPath();
                gameCtx.arc(ef.x, ef.y, ef.outerRadius, 0, Math.PI * 2);
                gameCtx.stroke();
                if (ef.innerRadius > 0) {
                    gameCtx.beginPath();
                    gameCtx.arc(ef.x, ef.y, ef.innerRadius, 0, Math.PI * 2);
                    gameCtx.stroke();
                }
            } else if (ef.type === 'abyss_ring_fire') {
                gameCtx.beginPath();
                gameCtx.arc(ef.x, ef.y, ef.outerRadius, 0, Math.PI * 2, false);
                if (ef.innerRadius > 0) {
                    gameCtx.arc(ef.x, ef.y, ef.innerRadius, 0, Math.PI * 2, true);
                }
                gameCtx.fillStyle = 'rgba(147, 51, 234, 0.46)';
                gameCtx.fill('evenodd');

                gameCtx.strokeStyle = '#f0abfc';
                gameCtx.lineWidth = 5;
                gameCtx.beginPath();
                gameCtx.arc(ef.x, ef.y, ef.outerRadius, 0, Math.PI * 2);
                gameCtx.stroke();
                if (ef.innerRadius > 0) {
                    gameCtx.beginPath();
                    gameCtx.arc(ef.x, ef.y, ef.innerRadius, 0, Math.PI * 2);
                    gameCtx.stroke();
                }
            } else if (ef.type === 'slash_warn') {
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
            } else if (ef.type === 'roar_pulse') {
                const progress = 1 - (ef.timer / (ef.maxTimer || 12));
                gameCtx.globalAlpha = Math.max(0.15, 1 - progress * 0.85);
                gameCtx.beginPath();
                gameCtx.arc(ef.x, ef.y, ef.radius * (0.4 + progress * 0.6), 0, Math.PI * 2);
                gameCtx.fillStyle = 'rgba(255, 130, 20, 0.24)';
                gameCtx.fill();
                gameCtx.strokeStyle = '#fff3b0';
                gameCtx.lineWidth = 4;
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
            } else if (bp.kind === 'phantom_homing') {
                gameCtx.fillStyle = '#e2e8f0';
                gameCtx.beginPath();
                gameCtx.arc(bp.x, bp.y, 7, 0, Math.PI * 2);
                gameCtx.fill();
                gameCtx.strokeStyle = '#38bdf8';
                gameCtx.lineWidth = 2;
                gameCtx.stroke();
            } else if (bp.kind === 'curse_bolt') {
                gameCtx.fillStyle = '#581c87';
                gameCtx.beginPath();
                gameCtx.arc(bp.x, bp.y, 8, 0, Math.PI * 2);
                gameCtx.fill();
                gameCtx.strokeStyle = '#f43f5e';
                gameCtx.lineWidth = 2.5;
                gameCtx.stroke();
            } else if (bp.kind === 'feint_orb') {
                gameCtx.fillStyle = '#94a3b8';
                gameCtx.beginPath();
                gameCtx.arc(bp.x, bp.y, 5.5, 0, Math.PI * 2);
                gameCtx.fill();
                gameCtx.strokeStyle = '#f8fafc';
                gameCtx.lineWidth = 1.5;
                gameCtx.stroke();
            } else if (bp.kind === 'snake_dark') {
                const ang = Math.atan2(bp.vy, bp.vx);
                gameCtx.translate(bp.x, bp.y);
                gameCtx.rotate(ang);
                gameCtx.fillStyle = '#7e22ce';
                gameCtx.beginPath();
                gameCtx.moveTo(11, 0);
                gameCtx.lineTo(-6, -6.5);
                gameCtx.lineTo(-3, 0);
                gameCtx.lineTo(-6, 6.5);
                gameCtx.closePath();
                gameCtx.fill();
                gameCtx.strokeStyle = '#f0abfc';
                gameCtx.lineWidth = 2;
                gameCtx.stroke();
            } else if (bp.kind === 'shadow_orb') {
                gameCtx.fillStyle = '#3b0764';
                gameCtx.beginPath();
                gameCtx.arc(bp.x, bp.y, 5.5, 0, Math.PI * 2);
                gameCtx.fill();
                gameCtx.strokeStyle = '#c084fc';
                gameCtx.lineWidth = 2;
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

        const seenSkillIds = new Set();
        let totalGachaWeight = 0;
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

            if (!skill.id || !skill.name || !skill.type || !skill.rarity) {
                errors.push(`Ultra skill missing required field (id/name/type/rarity): ${skillId}`);
            }
            if (typeof skill.gachaWeight !== 'number' || skill.gachaWeight <= 0) {
                errors.push(`Ultra skill ${skill.id} missing valid gachaWeight`);
            } else {
                totalGachaWeight += skill.gachaWeight;
            }
            if (typeof skill.damageMultiplier !== 'number' || skill.damageMultiplier < 0) {
                errors.push(`Ultra skill ${skill.id} missing valid damageMultiplier`);
            }
            if (typeof skill.durationMs !== 'number' || skill.durationMs <= 0) {
                errors.push(`Ultra skill ${skill.id} missing valid durationMs`);
            }
            if (skill.cooldownMs !== 6000) {
                errors.push(`Ultra skill ${skill.id} cooldownMs must be 6000 (got ${skill.cooldownMs})`);
            }
            if (skill.maxStock !== 3) {
                errors.push(`Ultra skill ${skill.id} maxStock must be 3 (got ${skill.maxStock})`);
            }
            if (skill.id === 'end_of_days') {
                if (skill.chargeMs !== 350 || skill.durationMs !== 260) {
                    errors.push(`end_of_days timing mismatch (chargeMs=${skill.chargeMs}, durationMs=${skill.durationMs})`);
                }
                if (skill.damageMultiplier !== 4.0 || skill.range !== 620 || skill.halfWidth !== 56) {
                    errors.push(`end_of_days stat mismatch (mult=${skill.damageMultiplier}, range=${skill.range}, halfWidth=${skill.halfWidth})`);
                }
                if (
                    skill.normalBarrierDamageMultiplier !== 0.5 ||
                    skill.absoluteWallDamageMultiplier !== 0.25 ||
                    !skill.counterInteraction ||
                    skill.counterInteraction.damageMultiplier !== 0.5 ||
                    skill.counterInteraction.triggersCounter !== true
                ) {
                    errors.push('end_of_days barrier/counter interaction metadata mismatch');
                }
            }
            if (skill.id === 'sky_meteor') {
                if (skill.warnMs !== 650 || skill.durationMs !== 320) {
                    errors.push(`sky_meteor timing mismatch (warnMs=${skill.warnMs}, durationMs=${skill.durationMs})`);
                }
                if (
                    skill.meteorCount !== 5 ||
                    skill.radius !== 110 ||
                    skill.castRadius !== 200 ||
                    skill.magmaDurationMs !== 4000 ||
                    skill.magmaTickIntervalMs !== 1000 ||
                    skill.magmaTickDamage !== 10 ||
                    skill.damageMultiplier !== 2.2 ||
                    skill.formation !== 'circle_around_self' ||
                    skill.multiHit !== true
                ) {
                    errors.push('sky_meteor circle/magma parameter mismatch');
                }
            }
            if (skill.id === 'demon_blade') {
                if (skill.durationMs !== 5000 || skill.slashDamageMultiplier !== 2.0 || skill.slashRangeMultiplier !== 1.5) {
                    errors.push('demon_blade parameter mismatch');
                }
            }
            if (skill.id === 'ricochet_guns') {
                if (skill.durationMs !== 5000 || skill.intervalMs !== 625 || skill.maxWaves !== 8 || skill.fixedDamage !== 40 || skill.maxBounces !== 1) {
                    errors.push('ricochet_guns parameter mismatch');
                }
            }
            if (skill.id === 'phantom_boots') {
                if (skill.durationMs !== 4000 || skill.speedMultiplier !== 2.0 || skill.passWalls !== true) {
                    errors.push('phantom_boots parameter mismatch');
                }
            }
            if (skill.id === 'time_stop') {
                if (skill.durationMs !== 2500) {
                    errors.push('time_stop parameter mismatch');
                }
            }
        }

        if (ULTRA_SKILL_ORDER.length !== 8) {
            errors.push(`ULTRA_SKILL_ORDER must contain 8 skills (got ${ULTRA_SKILL_ORDER.length})`);
        }
        if (totalGachaWeight !== 100) {
            errors.push(`Ultra skill gachaWeight sum must be 100 (got ${totalGachaWeight})`);
        }

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

                if (!boss.id || typeof boss.id !== 'string' || boss.id !== stage.bossId) {
                    errors.push(`Boss ${stage.bossId} id mismatch or missing (got ${boss.id})`);
                }
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
                if (
                    !boss.hpByPlayers ||
                    typeof boss.hpByPlayers[1] !== 'number' || boss.hpByPlayers[1] <= 0 ||
                    typeof boss.hpByPlayers[2] !== 'number' || boss.hpByPlayers[2] <= 0 ||
                    typeof boss.hpByPlayers[3] !== 'number' || boss.hpByPlayers[3] <= 0 ||
                    typeof boss.hpByPlayers[4] !== 'number' || boss.hpByPlayers[4] <= 0
                ) {
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
                } else {
                    boss.attackPatterns.forEach((pat, pIdx) => {
                        if (!pat || !pat.id || !pat.name || typeof pat.damage !== 'number' || pat.damage < 0) {
                            errors.push(`Boss ${boss.id} attackPatterns[${pIdx}] invalid`);
                        }
                    });
                }
                if (typeof boss.executeAttack !== 'function') {
                    errors.push(`Boss ${boss.id} missing executeAttack function`);
                }
                if (typeof boss.drawEntity !== 'function') {
                    errors.push(`Boss ${boss.id} missing drawEntity function`);
                }
            });
        }

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

    validateDefinitions({ throwOnError: true });

    return {
        ARENA_WIDTH,
        ARENA_TOP,
        ARENA_HEIGHT,
        ARENA_CENTER_X,
        GAME_RULES,
        STATIC_OBSTACLES,
        SPECIAL_INKS,
        SPECIAL_INK_IDS,
        ELEMENT_META,
        ELEMENT_COLOR_MAP,
        determineElementFromPixels,
        getElementMultiplier,
        getElementInfo,
        sanitizeElementId,
        ULTRA_SKILLS,
        ULTRA_SKILL_ORDER,
        sanitizeUltraSkillId,
        getUltraSkillDef,
        getAllUltraSkills,
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
        validateDefinitions,
        handleClientBossAttack,
        updateBossProjectilesClient,
        drawBossEntity,
        drawBossEffectsAndProjectiles
    };
}));