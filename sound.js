(function (root) {
    'use strict';

    const STORAGE_KEY = 'pixel_pvp_sound_settings_v1';
    const DEFAULT_BGM_VOLUME = 0.35;
    const DEFAULT_SE_VOLUME = 1.0;

    // シーン別BGMトラック定義（4ファイル対応）
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
    let lastDrawSoundTime = 0;

    const BGM_AUDIO_MAP = {};

    // =========================================================================
    // 設定の読み込み・保存（安全ガード付き）
    // =========================================================================
    function clamp(val, min, max, fallback) {
        const num = Number(val);
        if (!Number.isFinite(num)) return fallback;
        return Math.min(max, Math.max(min, num));
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
        } catch (e) {
            // ストレージ利用不可環境でも動作継続
        }
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
        } catch (e) {
            // 無視
        }
    }

    // =========================================================================
    // Audio初期化 & BGMオーディオプール生成
    // =========================================================================
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
                    // 音声ファイル欠損時も例外を投げず安全に継続
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
            // 自動再生ブロック解除後、待機中のBGMがあれば再生を再試行
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
        } catch (e) {
            // フォールバック：音声無効環境でもエラーにしない
        }
    }

    // =========================================================================
    // BGM制御（再生・停止・切替・テンポ変更・音量・ミュート）
    // =========================================================================
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

        // 同じトラックが選択中なら頭出しせずテンポ・音量のみ同期
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

    // =========================================================================
    // SE合成エンジン（Web Audio API・未初期化時完全安全）
    // =========================================================================
    function playTone(freq, type, duration, vol, endFreq) {
        if (!seEnabled || !audioCtx || seVolume <= 0) return;
        try {
            if (audioCtx.state === 'suspended') {
                audioCtx.resume().catch(() => {});
            }
            const now = audioCtx.currentTime;
            const osc = audioCtx.createOscillator();
            const gain = audioCtx.createGain();
            const baseVol = clamp(vol === undefined ? 0.08 : vol, 0.001, 0.5, 0.08) * seVolume;
            const dur = clamp(duration, 0.02, 2.0, 0.1);

            osc.type = type || 'sine';
            osc.frequency.setValueAtTime(Math.max(20, freq || 440), now);
            if (endFreq && endFreq > 0) {
                osc.frequency.exponentialRampToValueAtTime(Math.max(20, endFreq), now + dur);
            }
            gain.gain.setValueAtTime(baseVol, now);
            gain.gain.exponentialRampToValueAtTime(0.001, now + dur);

            osc.connect(gain);
            gain.connect(audioCtx.destination);
            osc.start(now);
            osc.stop(now + dur);
        } catch (e) {
            // 安全フォールバック
        }
    }

    function playNoise(duration, vol) {
        if (!seEnabled || !audioCtx || seVolume <= 0) return;
        try {
            if (audioCtx.state === 'suspended') {
                audioCtx.resume().catch(() => {});
            }
            const dur = clamp(duration, 0.02, 1.5, 0.12);
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

            noise.connect(gain);
            gain.connect(audioCtx.destination);
            noise.start(now);
        } catch (e) {
            // 安全フォールバック
        }
    }

    const RAW_SE = {
        // エディタ・UI操作
        draw: () => {
            const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
            if (now - lastDrawSoundTime < 55) return;
            lastDrawSoundTime = now;
            playTone(520 + Math.random() * 180, 'sine', 0.05, 0.05);
        },
        erase: () => {
            const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
            if (now - lastDrawSoundTime < 70) return;
            lastDrawSoundTime = now;
            playTone(260, 'triangle', 0.06, 0.05, 160);
        },
        bucket: () => playTone(330, 'sine', 0.12, 0.08, 660),
        undo: () => playTone(440, 'triangle', 0.1, 0.07, 220),
        click: () => playTone(660, 'square', 0.06, 0.05),

        // 通常バトルアクション（Z / X / C）
        shot: () => playTone(880, 'square', 0.12, 0.06, 220),
        melee: () => {
            playNoise(0.12, 0.09);
            playTone(340, 'sawtooth', 0.12, 0.06, 95);
        },
        shield: () => playTone(440, 'sine', 0.25, 0.08, 880),
        block: () => playTone(1200, 'square', 0.1, 0.09, 600),
        hit: () => playTone(160, 'sawtooth', 0.15, 0.1, 55),
        wallBreak: () => {
            playNoise(0.22, 0.12);
            playTone(140, 'square', 0.2, 0.09, 45);
        },

        // アイテム取得
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

        // 必殺技（Space：発動・溜め/構え/予兆・着弾・カウンター）
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

        // BOSS攻撃・撃破
        bossSlash: () => {
            playNoise(0.25, 0.13);
            playTone(720, 'sawtooth', 0.22, 0.09, 110);
        },
        bossPulse: () => {
            playNoise(0.35, 0.15);
            playTone(180, 'sawtooth', 0.35, 0.12, 40);
        },
        zoneHit: () => playTone(110, 'sawtooth', 0.18, 0.08, 75),
        bossDefeat: () => {
            playNoise(0.45, 0.15);
            playTone(150, 'sawtooth', 0.45, 0.12, 38);
            const fanfare = [523, 659, 784, 1046];
            fanfare.forEach((n, idx) => setTimeout(() => playTone(n, 'square', 0.28, 0.08), 260 + idx * 110));
        },

        // ガチャ・判定の間・勝敗
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
            playNoise(0.4, 0.14);
            playTone(130, 'sawtooth', 0.45, 0.12, 35);
        },
        win: () => {
            const notes = [523, 659, 784, 1046];
            notes.forEach((n, idx) => setTimeout(() => playTone(n, 'square', idx === 3 ? 0.4 : 0.12, 0.08), idx * 120));
        }
    };

    // 未定義キーが呼ばれても例外を投げず安全にフォールバックするProxy
    const SE = new Proxy(RAW_SE, {
        get(target, prop) {
            if (typeof prop === 'string' && typeof target[prop] === 'function') {
                return target[prop];
            }
            return () => {};
        }
    });

    function playSe(key) {
        try {
            const args = Array.prototype.slice.call(arguments, 1);
            if (typeof key === 'string' && typeof RAW_SE[key] === 'function') {
                RAW_SE[key].apply(null, args);
                return true;
            }
            return false;
        } catch (e) {
            return false;
        }
    }

    // =========================================================================
    // 初期化 & 自動再生ブロック解除リスナー
    // =========================================================================
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
        SE
    };

    if (root) {
        root.SoundSystem = SoundSystem;
    }
    if (typeof module === 'object' && module.exports) {
        module.exports = SoundSystem;
    }
}(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this)));
