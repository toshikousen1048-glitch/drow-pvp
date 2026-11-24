(function (root) {
    'use strict';

    const STORAGE_KEY = 'pixel_pvp_sound_settings_v1';
    const DEFAULT_BGM_VOLUME = 0.35;
    const DEFAULT_SE_VOLUME = 1.0;
    const MAX_CONCURRENT_VOICES = 14;

    // シーン別BGMトラック定義（5ファイル対応）
    const BGM_SOURCE_MAP = {
        menu: 'menu BGM.mp3',
        drawing: 'drawing BGM.mp3',
        judge: 'judge BGM.mp3',
        pvp: 'PVP BGM.mp3',
        boss: 'Boss BGM.mp3'
    };

    let audioCtx = null;
    let bgmEnabled = true;
    let seEnabled = true;
    let bgmVolume = DEFAULT_BGM_VOLUME;
    let seVolume = DEFAULT_SE_VOLUME;

    let currentBgmTrack = 'none';
    let currentBgmRate = 1.0;
    let pendingBgmTrack = 'none';
    let pendingBgmRate = 1.0;
    let activeBgmAudio = null;
    let activeVoices = 0;

    const BGM_AUDIO_MAP = {};
    const seCooldownMap = {};

    function clamp(val, min, max, fallback) {
        const num = Number(val);
        if (!Number.isFinite(num)) return fallback;
        return Math.min(max, Math.max(min, num));
    }

    function nowMs() {
        return typeof performance !== 'undefined' ? performance.now() : Date.now();
    }

    function canPlaySe(key, cooldownMs) {
        if (!cooldownMs || cooldownMs <= 0) return true;
        const t = nowMs();
        const last = seCooldownMap[key] || 0;
        if (t - last < cooldownMs) return false;
        seCooldownMap[key] = t;
        return true;
    }

    function acquireVoice(durationSec) {
        if (activeVoices >= MAX_CONCURRENT_VOICES) return null;
        activeVoices++;
        let released = false;
        const release = () => {
            if (released) return;
            released = true;
            activeVoices = Math.max(0, activeVoices - 1);
        };
        setTimeout(release, Math.ceil(durationSec * 1000) + 60);
        return release;
    }

    function loadSettings() {
        try {
            if (typeof localStorage === 'undefined') return;
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return;
            const parsed = JSON.parse(raw);
            if (typeof parsed.bgmEnabled === 'boolean') bgmEnabled = parsed.bgmEnabled;
            if (typeof parsed.seEnabled === 'boolean') seEnabled = parsed.seEnabled;
            if (parsed.bgmVolume !== undefined) bgmVolume = clamp(parsed.bgmVolume, 0, 1, DEFAULT_BGM_VOLUME);
            if (parsed.seVolume !== undefined) seVolume = clamp(parsed.seVolume, 0, 1, DEFAULT_SE_VOLUME);
        } catch (e) {}
    }

    function saveSettings() {
        try {
            if (typeof localStorage === 'undefined') return;
            localStorage.setItem(STORAGE_KEY, JSON.stringify({
                bgmEnabled,
                seEnabled,
                bgmVolume,
                seVolume
            }));
        } catch (e) {}
    }

    function getOrCreateBgmAudio(track) {
        if (typeof Audio === 'undefined') return null;
        const safeTrack = Object.prototype.hasOwnProperty.call(BGM_SOURCE_MAP, track) ? track : 'menu';
        if (!BGM_AUDIO_MAP[safeTrack]) {
            try {
                const audio = new Audio(encodeURI(BGM_SOURCE_MAP[safeTrack]));
                audio.loop = true;
                audio.volume = bgmEnabled ? bgmVolume : 0;
                audio.preload = 'auto';
                audio.addEventListener('error', () => {
                    console.warn('[SoundSystem] BGMファイルが見つかりません:', BGM_SOURCE_MAP[safeTrack]);
                });
                BGM_AUDIO_MAP[safeTrack] = audio;
            } catch (e) {
                return null;
            }
        }
        return BGM_AUDIO_MAP[safeTrack];
    }

    function init() {
        try {
            if (!audioCtx && typeof window !== 'undefined') {
                const AudioContextClass = window.AudioContext || window.webkitAudioContext;
                if (AudioContextClass) {
                    audioCtx = new AudioContextClass();
                }
            }
            if (audioCtx && audioCtx.state === 'suspended') {
                audioCtx.resume().catch(() => {});
            }
            if (bgmEnabled && pendingBgmTrack !== 'none') {
                const targetAudio = activeBgmAudio || getOrCreateBgmAudio(pendingBgmTrack);
                if (targetAudio && targetAudio.paused) {
                    targetAudio.volume = bgmVolume;
                    targetAudio.playbackRate = pendingBgmRate;
                    activeBgmAudio = targetAudio;
                    currentBgmTrack = pendingBgmTrack;
                    targetAudio.play().catch(() => {});
                }
            }
        } catch (e) {}
    }

    function startBgm(track, rate) {
        const safeRate = clamp(rate === undefined ? 1.0 : rate, 0.5, 2.0, 1.0);
        currentBgmRate = safeRate;

        if (!track || track === 'none') {
            pendingBgmTrack = 'none';
            stopBgm();
            return;
        }

        const safeTrack = Object.prototype.hasOwnProperty.call(BGM_SOURCE_MAP, track) ? track : 'menu';
        pendingBgmTrack = safeTrack;
        pendingBgmRate = safeRate;

        if (!bgmEnabled) {
            stopBgm(true);
            return;
        }

        const nextAudio = getOrCreateBgmAudio(safeTrack);
        if (!nextAudio) return;

        if (currentBgmTrack === safeTrack && activeBgmAudio === nextAudio) {
            try {
                nextAudio.volume = bgmVolume;
                nextAudio.playbackRate = safeRate;
                if (nextAudio.paused) {
                    nextAudio.play().catch(() => {});
                }
            } catch (e) {}
            return;
        }

        if (activeBgmAudio && activeBgmAudio !== nextAudio) {
            try {
                activeBgmAudio.pause();
                activeBgmAudio.currentTime = 0;
            } catch (e) {}
        }

        currentBgmTrack = safeTrack;
        activeBgmAudio = nextAudio;
        try {
            nextAudio.currentTime = 0;
            nextAudio.volume = bgmVolume;
            nextAudio.playbackRate = safeRate;
            nextAudio.play().catch(() => {});
        } catch (e) {}
    }

    function stopBgm(keepPending) {
        if (!keepPending) {
            pendingBgmTrack = 'none';
        }
        if (activeBgmAudio) {
            try {
                activeBgmAudio.pause();
                activeBgmAudio.currentTime = 0;
            } catch (e) {}
            activeBgmAudio = null;
        }
        currentBgmTrack = 'none';
        currentBgmRate = 1.0;
    }

    function setPlaybackRate(rate) {
        const safeRate = clamp(rate, 0.5, 2.0, 1.0);
        currentBgmRate = safeRate;
        pendingBgmRate = safeRate;
        if (activeBgmAudio) {
            try {
                activeBgmAudio.playbackRate = safeRate;
            } catch (e) {}
        }
    }

    function setBgmVolume(vol) {
        bgmVolume = clamp(vol, 0, 1, DEFAULT_BGM_VOLUME);
        if (activeBgmAudio && bgmEnabled) {
            try {
                activeBgmAudio.volume = bgmVolume;
            } catch (e) {}
        }
        saveSettings();
        return bgmVolume;
    }

    function setSeVolume(vol) {
        seVolume = clamp(vol, 0, 1, DEFAULT_SE_VOLUME);
        saveSettings();
        return seVolume;
    }

    function setBgmEnabled(enabled) {
        bgmEnabled = Boolean(enabled);
        saveSettings();
        if (!bgmEnabled) {
            stopBgm(true);
        } else if (pendingBgmTrack !== 'none') {
            startBgm(pendingBgmTrack, pendingBgmRate);
        }
        return bgmEnabled;
    }

    function setSeEnabled(enabled) {
        seEnabled = Boolean(enabled);
        saveSettings();
        return seEnabled;
    }

    function toggleBgm() {
        return setBgmEnabled(!bgmEnabled);
    }

    function toggleSe() {
        const next = setSeEnabled(!seEnabled);
        if (next) SE.click();
        return next;
    }

    function playTone(freq, type, duration, vol, endFreq) {
        if (!seEnabled || !audioCtx || seVolume <= 0) return;
        const dur = clamp(duration, 0.02, 2.0, 0.1);
        const releaseVoice = acquireVoice(dur);
        if (!releaseVoice) return;

        try {
            if (audioCtx.state === 'suspended') {
                audioCtx.resume().catch(() => {});
            }
            const now = audioCtx.currentTime;
            const osc = audioCtx.createOscillator();
            const gain = audioCtx.createGain();
            const baseVol = clamp(vol === undefined ? 0.08 : vol, 0.001, 0.5, 0.08) * seVolume;

            osc.type = type || 'sine';
            osc.frequency.setValueAtTime(Math.max(20, freq || 440), now);
            if (endFreq && endFreq > 0) {
                osc.frequency.exponentialRampToValueAtTime(Math.max(20, endFreq), now + dur);
            }
            gain.gain.setValueAtTime(baseVol, now);
            gain.gain.exponentialRampToValueAtTime(0.001, now + dur);

            osc.onended = releaseVoice;
            osc.connect(gain);
            gain.connect(audioCtx.destination);
            osc.start(now);
            osc.stop(now + dur);
        } catch (e) {
            releaseVoice();
        }
    }

    function playNoise(duration, vol) {
        if (!seEnabled || !audioCtx || seVolume <= 0) return;
        const dur = clamp(duration, 0.02, 1.5, 0.12);
        const releaseVoice = acquireVoice(dur);
        if (!releaseVoice) return;

        try {
            if (audioCtx.state === 'suspended') {
                audioCtx.resume().catch(() => {});
            }
            const sampleRate = audioCtx.sampleRate || 44100;
            const bufferSize = Math.max(1, Math.floor(sampleRate * dur));
            const buffer = audioCtx.createBuffer(1, bufferSize, sampleRate);
            const data = buffer.getChannelData(0);
            for (let i = 0; i < bufferSize; i++) {
                data[i] = Math.random() * 2 - 1;
            }
            const noise = audioCtx.createBufferSource();
            noise.buffer = buffer;

            const gain = audioCtx.createGain();
            const now = audioCtx.currentTime;
            const baseVol = clamp(vol === undefined ? 0.08 : vol, 0.001, 0.5, 0.08) * seVolume;
            gain.gain.setValueAtTime(baseVol, now);
            gain.gain.exponentialRampToValueAtTime(0.001, now + dur);

            noise.onended = releaseVoice;
            noise.connect(gain);
            gain.connect(audioCtx.destination);
            noise.start(now);
        } catch (e) {
            releaseVoice();
        }
    }

    const RAW_SE = {
        draw: () => {
            if (!canPlaySe('draw', 55)) return;
            playTone(520 + Math.random() * 180, 'sine', 0.05, 0.05);
        },
        erase: () => {
            if (!canPlaySe('erase', 70)) return;
            playTone(260, 'triangle', 0.06, 0.05, 160);
        },
        bucket: () => playTone(330, 'sine', 0.12, 0.08, 660),
        undo: () => playTone(440, 'triangle', 0.1, 0.07, 220),
        click: () => playTone(660, 'square', 0.06, 0.05),
        shot: () => {
            if (!canPlaySe('shot', 50)) return;
            playTone(880, 'square', 0.12, 0.06, 220);
        },
        melee: () => {
            if (!canPlaySe('melee', 60)) return;
            playNoise(0.12, 0.09);
            playTone(340, 'sawtooth', 0.12, 0.06, 95);
        },
        shield: () => playTone(440, 'sine', 0.25, 0.08, 880),
        block: () => {
            if (!canPlaySe('block', 60)) return;
            playTone(1200, 'square', 0.1, 0.09, 600);
        },
        hit: () => {
            if (!canPlaySe('hit', 60)) return;
            playTone(160, 'sawtooth', 0.15, 0.1, 55);
        },
        wallBreak: () => {
            if (!canPlaySe('wallBreak', 80)) return;
            playNoise(0.22, 0.12);
            playTone(140, 'square', 0.2, 0.09, 45);
        },
        itemSpeed: () => {
            playTone(523, 'square', 0.08, 0.07);
            setTimeout(() => playTone(659, 'square', 0.08, 0.07), 70);
            setTimeout(() => playTone(1046, 'square', 0.15, 0.08), 140);
        },
        itemHeal: () => {
            playTone(587, 'sine', 0.1, 0.09);
            setTimeout(() => playTone(880, 'sine', 0.2, 0.09), 90);
        },
        itemPower: () => {
            playTone(220, 'sawtooth', 0.1, 0.09);
            setTimeout(() => playTone(330, 'sawtooth', 0.1, 0.09), 80);
            setTimeout(() => playTone(440, 'sawtooth', 0.22, 0.1), 160);
        },
        ultra: () => {
            playTone(280, 'triangle', 0.26, 0.09, 980);
            setTimeout(() => playTone(560, 'sine', 0.22, 0.07, 1120), 60);
        },
        ultraCharge: () => playTone(240, 'sawtooth', 0.32, 0.08, 880),
        ultraWall: () => {
            playTone(392, 'sine', 0.28, 0.09, 784);
            setTimeout(() => playTone(587, 'triangle', 0.25, 0.07, 1174), 70);
        },
        ultraImpact: () => {
            playNoise(0.32, 0.14);
            playTone(200, 'sawtooth', 0.34, 0.11, 42);
        },
        counter: () => {
            playTone(1480, 'square', 0.09, 0.1, 740);
            setTimeout(() => {
                playNoise(0.18, 0.12);
                playTone(620, 'sawtooth', 0.24, 0.1, 180);
            }, 65);
        },
        // Phase 3 新必殺技 4種対応SE
        demonBlade: () => {
            if (!canPlaySe('demonBlade', 250)) return;
            playNoise(0.18, 0.1);
            playTone(320, 'sawtooth', 0.22, 0.09, 920);
            setTimeout(() => playTone(880, 'triangle', 0.24, 0.07, 440), 75);
        },
        ricochetGun: () => {
            if (!canPlaySe('ricochetGun', 120)) return;
            playNoise(0.08, 0.06);
            playTone(980, 'square', 0.11, 0.06, 360);
        },
        ricochetBounce: () => {
            if (!canPlaySe('ricochetBounce', 45)) return;
            playTone(1320, 'triangle', 0.07, 0.05, 880);
        },
        phantomBoots: () => {
            if (!canPlaySe('phantomBoots', 250)) return;
            playTone(440, 'sine', 0.16, 0.07, 1180);
            setTimeout(() => playTone(740, 'triangle', 0.18, 0.06, 1480), 65);
        },
        timeStop: () => {
            if (!canPlaySe('timeStop', 400)) return;
            playTone(660, 'sine', 0.42, 0.1, 82);
            setTimeout(() => playTone(330, 'triangle', 0.38, 0.08, 55), 70);
        },
        timeResume: () => {
            if (!canPlaySe('timeResume', 400)) return;
            playTone(180, 'triangle', 0.24, 0.08, 720);
            setTimeout(() => playTone(540, 'sine', 0.22, 0.07, 1080), 75);
        },
        bossSlash: () => {
            if (!canPlaySe('bossSlash', 90)) return;
            playNoise(0.25, 0.13);
            playTone(720, 'sawtooth', 0.22, 0.09, 110);
        },
        bossPulse: () => {
            if (!canPlaySe('bossPulse', 120)) return;
            playNoise(0.35, 0.15);
            playTone(180, 'sawtooth', 0.35, 0.12, 40);
        },
        zoneHit: () => {
            if (!canPlaySe('zoneHit', 100)) return;
            playTone(110, 'sawtooth', 0.14, 0.07, 72);
        },
        // STAGE 3 (INFERNO DRAGON) 専用強化ギミック・P2覚醒SE
        dragonAwaken: () => {
            if (!canPlaySe('dragonAwaken', 500)) return;
            playNoise(0.35, 0.13);
            playTone(140, 'sawtooth', 0.32, 0.1, 520);
            setTimeout(() => playTone(587, 'square', 0.28, 0.07, 880), 110);
        },
        dragonBreath: () => {
            if (!canPlaySe('dragonBreath', 120)) return;
            playNoise(0.18, 0.09);
            playTone(420, 'sawtooth', 0.18, 0.07, 150);
        },
        dragonClawWarn: () => {
            if (!canPlaySe('dragonClawWarn', 120)) return;
            playTone(540, 'triangle', 0.14, 0.05, 820);
        },
        dragonClawFire: () => {
            if (!canPlaySe('dragonClawFire', 100)) return;
            playNoise(0.22, 0.12);
            playTone(860, 'sawtooth', 0.2, 0.09, 130);
        },
        dragonMeteorWarn: () => {
            if (!canPlaySe('dragonMeteorWarn', 150)) return;
            playTone(280, 'sine', 0.24, 0.05, 420);
        },
        dragonMeteorFire: () => {
            if (!canPlaySe('dragonMeteorFire', 140)) return;
            playNoise(0.32, 0.13);
            playTone(190, 'sawtooth', 0.3, 0.11, 44);
        },
        magmaSlip: () => {
            if (!canPlaySe('magmaSlip', 200)) return;
            playTone(95, 'sawtooth', 0.12, 0.06, 65);
        },
        dragonRoarWarn: () => {
            if (!canPlaySe('dragonRoarWarn', 150)) return;
            playTone(170, 'triangle', 0.28, 0.06, 360);
        },
        dragonRoarFire: () => {
            if (!canPlaySe('dragonRoarFire', 140)) return;
            playNoise(0.28, 0.12);
            playTone(260, 'sawtooth', 0.26, 0.1, 80);
        },
        dragonRoarPulse: () => {
            if (!canPlaySe('dragonRoarPulse', 100)) return;
            playTone(145, 'sawtooth', 0.11, 0.06, 78);
        },
        // STAGE 4 (ABYSS WEAVER) 専用ギミック・状態異常・フェーズ遷移SE
        abyssSigilWarn: () => {
            if (!canPlaySe('abyssSigilWarn', 120)) return;
            playTone(310, 'sine', 0.22, 0.06, 465);
            setTimeout(() => playTone(465, 'triangle', 0.16, 0.04, 390), 55);
        },
        abyssSigilFire: () => {
            if (!canPlaySe('abyssSigilFire', 120)) return;
            playNoise(0.22, 0.11);
            playTone(240, 'sawtooth', 0.26, 0.09, 72);
            setTimeout(() => playTone(165, 'triangle', 0.22, 0.07, 58), 45);
        },
        abyssSerpent: () => {
            if (!canPlaySe('abyssSerpent', 120)) return;
            playTone(540, 'triangle', 0.14, 0.06, 290);
            setTimeout(() => playTone(660, 'sine', 0.14, 0.05, 340), 55);
        },
        abyssRingWarn: () => {
            if (!canPlaySe('abyssRingWarn', 120)) return;
            playTone(210, 'triangle', 0.26, 0.06, 520);
        },
        abyssRingFire: () => {
            if (!canPlaySe('abyssRingFire', 120)) return;
            playNoise(0.28, 0.12);
            playTone(290, 'sawtooth', 0.3, 0.1, 64);
        },
        abyssShadowWave: () => {
            if (!canPlaySe('abyssShadowWave', 120)) return;
            playNoise(0.11, 0.07);
            playTone(480, 'square', 0.14, 0.05, 190);
        },
        slowDebuff: () => {
            if (!canPlaySe('slowDebuff', 250)) return;
            playTone(220, 'triangle', 0.24, 0.08, 95);
        },
        // STAGE 5 (PHANTOM MIRAGE / 幻惑の蜃気楼) 専用ギミック・状態異常・演出SE
        mirageStealth: () => {
            if (!canPlaySe('mirageStealth', 220)) return;
            playTone(760, 'sine', 0.24, 0.07, 240);
            setTimeout(() => playTone(520, 'triangle', 0.28, 0.06, 180), 65);
        },
        mirageCircleWarn: () => {
            if (!canPlaySe('mirageCircleWarn', 160)) return;
            playTone(480, 'sine', 0.22, 0.06, 720);
            setTimeout(() => playTone(640, 'triangle', 0.2, 0.05, 960), 60);
        },
        mirageAmbushFire: () => {
            if (!canPlaySe('mirageAmbushFire', 140)) return;
            playNoise(0.26, 0.12);
            playTone(360, 'sawtooth', 0.24, 0.1, 88);
            setTimeout(() => playTone(540, 'square', 0.16, 0.07, 180), 50);
        },
        mirageCloneDeploy: () => {
            if (!canPlaySe('mirageCloneDeploy', 180)) return;
            playTone(420, 'triangle', 0.18, 0.06, 840);
            setTimeout(() => playTone(630, 'sine', 0.22, 0.06, 1050), 70);
        },
        mirageHomingOrb: () => {
            if (!canPlaySe('mirageHomingOrb', 130)) return;
            playTone(620, 'sine', 0.15, 0.05, 340);
            setTimeout(() => playTone(780, 'triangle', 0.13, 0.04, 420), 45);
        },
        mirageBarrage: () => {
            if (!canPlaySe('mirageBarrage', 140)) return;
            playNoise(0.11, 0.07);
            playTone(560, 'square', 0.13, 0.05, 220);
        },
        attackDebuff: () => {
            if (!canPlaySe('attackDebuff', 250)) return;
            playTone(300, 'sawtooth', 0.22, 0.07, 110);
        },
        dotDebuff: () => {
            if (!canPlaySe('dotDebuff', 250)) return;
            playTone(190, 'triangle', 0.2, 0.06, 130);
            setTimeout(() => playTone(160, 'sine', 0.18, 0.05, 95), 75);
        },
        statusDebuff: () => {
            if (!canPlaySe('statusDebuff', 220)) return;
            playTone(250, 'triangle', 0.24, 0.07, 98);
        },
        bossPhase2: () => {
            if (!canPlaySe('bossPhase2', 500)) return;
            playNoise(0.32, 0.13);
            playTone(196, 'sawtooth', 0.28, 0.1, 587);
            setTimeout(() => playTone(587, 'square', 0.32, 0.08, 880), 110);
        },
        bossDefeat: () => {
            if (!canPlaySe('bossDefeat', 500)) return;
            playNoise(0.45, 0.15);
            playTone(150, 'sawtooth', 0.45, 0.12, 38);
            const fanfare = [523, 659, 784, 1046];
            fanfare.forEach((n, idx) => setTimeout(() => playTone(n, 'square', 0.28, 0.08), 260 + idx * 110));
        },
        gachaSpin: () => playTone(320 + Math.random() * 420, 'triangle', 0.06, 0.06),
        gachaOpen: () => {
            playTone(523, 'triangle', 0.12, 0.08, 1046);
            setTimeout(() => playTone(784, 'sine', 0.22, 0.08, 1567), 80);
        },
        gachaFlashS: () => {
            [587, 784, 988, 1318, 1568].forEach((n, idx) => {
                setTimeout(() => playTone(n, 'square', 0.24, 0.08), idx * 65);
            });
        },
        gachaRefund: () => {
            playTone(660, 'sine', 0.09, 0.08);
            setTimeout(() => playTone(880, 'sine', 0.16, 0.08), 80);
        },
        judgeTick: () => playTone(700 + Math.random() * 300, 'triangle', 0.04, 0.05),
        judgeRank: (rank) => {
            const chords = {
                C: [392, 330],
                B: [523, 659],
                A: [523, 659, 784],
                S: [523, 659, 784, 1046, 1318]
            };
            const seq = chords[rank] || chords.B;
            seq.forEach((n, idx) => {
                setTimeout(() => playTone(n, 'square', idx === seq.length - 1 ? 0.5 : 0.14, 0.08), idx * 110);
            });
        },
        countdown: (isFight) => {
            if (isFight) playTone(880, 'square', 0.35, 0.09);
            else playTone(440, 'square', 0.15, 0.07);
        },
        ko: () => {
            if (!canPlaySe('ko', 150)) return;
            playNoise(0.4, 0.14);
            playTone(130, 'sawtooth', 0.45, 0.12, 35);
        },
        win: () => {
            if (!canPlaySe('win', 300)) return;
            const notes = [523, 659, 784, 1046];
            notes.forEach((n, idx) => setTimeout(() => playTone(n, 'square', idx === 3 ? 0.4 : 0.12, 0.08), idx * 120));
        }
    };

    const SE_ALIASES = {
        demon_blade: 'demonBlade',
        ricochet_guns: 'ricochetGun',
        ricochet_bounce: 'ricochetBounce',
        phantom_boots: 'phantomBoots',
        time_stop: 'timeStop',
        time_resume: 'timeResume',
        p2_awaken: 'dragonAwaken',
        breath: 'dragonBreath',
        claw_warn: 'dragonClawWarn',
        claw_fire: 'dragonClawFire',
        meteor_warn: 'dragonMeteorWarn',
        meteor_fire: 'dragonMeteorFire',
        magma: 'magmaSlip',
        roar_warn: 'dragonRoarWarn',
        roar_fire: 'dragonRoarFire',
        roar_pulse: 'dragonRoarPulse',
        abyss_sigil_warn: 'abyssSigilWarn',
        abyss_sigil_fire: 'abyssSigilFire',
        twin_serpent: 'abyssSerpent',
        abyss_ring_warn: 'abyssRingWarn',
        abyss_ring_fire: 'abyssRingFire',
        curse_wave: 'abyssShadowWave',
        slow_debuff: 'slowDebuff',
        mirage_stealth: 'mirageStealth',
        stealth_start: 'mirageStealth',
        mirage_circle_warn: 'mirageCircleWarn',
        dual_circle_warn: 'mirageCircleWarn',
        mirage_ambush_fire: 'mirageAmbushFire',
        ambush_impact: 'mirageAmbushFire',
        mirage_clone_deploy: 'mirageCloneDeploy',
        clone_deploy: 'mirageCloneDeploy',
        mirage_homing_orb: 'mirageHomingOrb',
        homing_orb: 'mirageHomingOrb',
        mirage_barrage: 'mirageBarrage',
        suppress_barrage: 'mirageBarrage',
        attack_debuff: 'attackDebuff',
        dot_debuff: 'dotDebuff',
        status_debuff: 'statusDebuff',
        boss_phase2: 'bossPhase2',
        boss_defeat: 'bossDefeat'
    };

    function resolveSeKey(prop) {
        if (typeof prop !== 'string') return null;
        if (typeof RAW_SE[prop] === 'function') return prop;
        if (Object.prototype.hasOwnProperty.call(SE_ALIASES, prop) && typeof RAW_SE[SE_ALIASES[prop]] === 'function') {
            return SE_ALIASES[prop];
        }
        return null;
    }

    const SE = new Proxy(RAW_SE, {
        get(target, prop) {
            const resolved = resolveSeKey(prop);
            if (resolved) {
                return target[resolved];
            }
            return () => {};
        }
    });

    function playSe(key) {
        try {
            const args = Array.prototype.slice.call(arguments, 1);
            const resolved = resolveSeKey(key);
            if (resolved) {
                RAW_SE[resolved].apply(null, args);
                return true;
            }
            return false;
        } catch (e) {
            return false;
        }
    }

    function playBossEventSe(eventType) {
        return playSe(eventType);
    }

    function syncBossBgm(bossState, isPlaying) {
        try {
            if (!isPlaying) return;
            const rate = (bossState && bossState.phase === 2) ? 1.12 : 1.0;
            if (currentBgmTrack !== 'boss') {
                startBgm('boss', rate);
            } else if (currentBgmRate !== rate) {
                setPlaybackRate(rate);
            }
        } catch (e) {}
    }

    loadSettings();

    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        ['pointerdown', 'keydown', 'touchstart'].forEach((evName) => {
            window.addEventListener(evName, init, { passive: true });
        });
    }

    const SoundSystem = {
        BGM_SOURCE_MAP,
        init,
        startBgm,
        stopBgm,
        setPlaybackRate,
        setBgmVolume,
        setSeVolume,
        getBgmVolume: () => bgmVolume,
        getSeVolume: () => seVolume,
        setBgmEnabled,
        setSeEnabled,
        toggleBgm,
        toggleSe,
        isBgmEnabled: () => bgmEnabled,
        isSeEnabled: () => seEnabled,
        getCurrentBgmTrack: () => currentBgmTrack,
        getCurrentBgmRate: () => currentBgmRate,
        playSe,
        playBossEventSe,
        syncBossBgm,
        SE
    };

    if (root) {
        root.SoundSystem = SoundSystem;
    }
    if (typeof module === 'object' && module.exports) {
        module.exports = SoundSystem;
    }
}(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this)));