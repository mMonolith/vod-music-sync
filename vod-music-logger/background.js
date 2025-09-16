const API_BASE_URL = 'https://vod-sync.officilly-ranging-gamer.workers.dev';
const DEBUG = true;

function log(...args) { if (DEBUG) console.log(`[VOD Sync Debug ${new Date().toLocaleTimeString()}]`, ...args); }

let activeVodTabs = {};

chrome.alarms.create('keep-alive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => {});

chrome.tabs.onRemoved.addListener(tabId => {
    if (activeVodTabs[tabId]?.syncInterval) {
        clearInterval(activeVodTabs[tabId].syncInterval);
        delete activeVodTabs[tabId];
    }
    for (const vodTabId in activeVodTabs) {
        if (activeVodTabs[vodTabId].musicTabId === tabId) {
            activeVodTabs[vodTabId].musicTabId = null;
            activeVodTabs[vodTabId].activeMusicVideoId = null;
        }
    }
});

chrome.runtime.onMessage.addListener((request, sender) => {
    const tabId = sender.tab?.id;
    if (request.type === 'time_update' && tabId && request.vodId) {
        handleTimeUpdate(tabId, request.platform, request.vodId, request.currentTime, request.isPaused, request.playbackRate);
    } else if (request.type === 'open_music_tab' && tabId) {
        handleOpenMusicTab(tabId, request.videoId);
    }
});

async function handleTimeUpdate(tabId, platform, vodId, currentTime, isPaused, playbackRate) {
    if (!activeVodTabs[tabId] || activeVodTabs[tabId].vodId !== vodId) {
        if (activeVodTabs[tabId]?.syncInterval) clearInterval(activeVodTabs[tabId].syncInterval);
        try {
            const lookupRes = await fetch(`${API_BASE_URL}/lookup?platform=${platform}&id=${vodId}`);
            if (!lookupRes.ok) { setActionBadge(tabId, ''); delete activeVodTabs[tabId]; return; }
            const { logUrl } = await lookupRes.json();
            const logResponse = await fetch(logUrl);
            const logData = await logResponse.json();
            
            activeVodTabs[tabId] = {
                vodId, platform, log: logData.log, playerState: 'STOPPED', activeMusicVideoId: null,
                lastKnownSongTime: 0, isVODPaused: isPaused, musicTabId: null,
                currentTime: 0,
                syncInterval: setInterval(() => syncPlayerState(tabId), 750)
            };
            await chrome.storage.local.set({ ['activeLogForTab_' + tabId]: logData });
            setActionBadge(tabId, 'ON', '#00D800');
            if (platform === 'youtube') chrome.tabs.sendMessage(tabId, { type: 'init_ui' }).catch(e => {});
        } catch (error) { setActionBadge(tabId, 'ERR', '#FF0000'); return; }
    }
    const vodState = activeVodTabs[tabId];
    if (!vodState) return;

    if (vodState.currentTime > 10 && currentTime < 5) {
        vodState.playerState = 'STOPPED';
        vodState.activeMusicVideoId = null;
    }
    vodState.currentTime = currentTime;
    vodState.isVODPaused = isPaused;
    vodState.playbackRate = playbackRate;
}

async function syncPlayerState(tabId) {
    const vodState = activeVodTabs[tabId];
    if (!vodState || !vodState.log) return;

    const { currentTime, isVODPaused, playbackRate, playerState, activeMusicVideoId } = vodState;
    const { syncOffset, iframeVolume } = await chrome.storage.sync.get({ syncOffset: -2000, iframeVolume: 75 });

    const songContext = findLastEventOfType(vodState.log, currentTime, 'PLAY');

    if (!songContext) {
        if (playerState !== 'STOPPED') {
            log(`Action: No song context. Desired: STOPPED.`);
            vodState.playerState = 'STOPPED';
            vodState.activeMusicVideoId = null;
            dispatchCommand(tabId, vodState, { action: 'stop' });
        }
        return;
    }

    const lastAction = findLastEventFromTypes(vodState.log, currentTime, ['PAUSE', 'RESUME', 'PLAY'], songContext.timestamp);
    const targetVideoId = await findBestYouTubeMatch(songContext.track);
    if (!targetVideoId) return;

    const songPos = calculateTrueSongPosition(vodState.log, currentTime, playbackRate, songContext) + (syncOffset / 1000);
    const desiredPlayerState = (lastAction.event === 'PAUSE' || isVODPaused) ? 'PAUSED' : 'PLAYING';

    if (activeMusicVideoId !== targetVideoId) {
        log(`Action: New song required for Tab ${tabId}. Current: ${activeMusicVideoId}, Target: ${targetVideoId}.`);
        vodState.activeMusicVideoId = targetVideoId;
        vodState.playerState = 'PLAYING';
        dispatchCommand(tabId, vodState, { action: 'play', videoId: targetVideoId, seekTo: songPos, volume: iframeVolume });
        vodState.lastKnownSongTime = songPos;
        return;
    }

    if (desiredPlayerState !== playerState) {
        log(`Action: State change for Tab ${tabId}. From ${playerState} to ${desiredPlayerState}.`);
        const action = desiredPlayerState === 'PLAYING' ? 'play' : 'pause';
        dispatchCommand(tabId, vodState, { action });
        vodState.playerState = desiredPlayerState;
    }

    if (desiredPlayerState === 'PLAYING') {
        const timeDrift = Math.abs(songPos - vodState.lastKnownSongTime);
        if (timeDrift > 2.0) {
            log(`Action: Resyncing time for Tab ${tabId}. Drift: ${timeDrift.toFixed(1)}s`);
            dispatchCommand(tabId, vodState, { action: 'seek', seekTo: songPos });
        }
        vodState.lastKnownSongTime = songPos;
    }
}

function dispatchCommand(tabId, vodState, command) {
    if (vodState.platform === 'youtube') {
        chrome.tabs.sendMessage(tabId, { type: 'control_youtube_iframe', ...command }).catch(e => {});
    } else if (vodState.platform === 'twitch') {
        if (!vodState.musicTabId) {
            if (command.videoId) {
                const songContext = findLastEventOfType(vodState.log, vodState.currentTime, 'PLAY');
                if (songContext) {
                    chrome.tabs.sendMessage(tabId, { type: 'show_song_notification', videoId: command.videoId, title: songContext.track.title, artist: songContext.track.artist }).catch(e => {});
                }
            }
            return;
        }
        chrome.tabs.get(vodState.musicTabId, (tab) => {
            if (chrome.runtime.lastError) {
                vodState.musicTabId = null;
                return;
            }
            chrome.tabs.sendMessage(vodState.musicTabId, { type: 'control_playback', ...command }).catch(e => {});
        });
    }
}

async function handleOpenMusicTab(vodTabId, videoId) {
    const vodState = activeVodTabs[vodTabId];
    if (!vodState) return;
    vodState.activeMusicVideoId = videoId;
    const { syncOffset } = await chrome.storage.sync.get({ syncOffset: -2000 });
    const songContext = findLastEventOfType(vodState.log, vodState.currentTime, 'PLAY');
    const songPos = calculateTrueSongPosition(vodState.log, vodState.currentTime, vodState.playbackRate, songContext) + (syncOffset / 1000);
    const musicUrl = `https://www.youtube.com/watch?v=${videoId}&t=${Math.floor(Math.max(0, songPos))}s&vod_sync_music_tab=true`;

    if (vodState.musicTabId) {
        chrome.tabs.get(vodState.musicTabId, (tab) => {
            if (chrome.runtime.lastError) {
                chrome.tabs.create({ url: musicUrl, active: false }, (newTab) => { vodState.musicTabId = newTab.id; });
            } else {
                chrome.tabs.update(vodState.musicTabId, { url: musicUrl });
            }
        });
    } else {
        chrome.tabs.create({ url: musicUrl, active: false }, (newTab) => { vodState.musicTabId = newTab.id; });
    }
}

function findLastEventOfType(log, currentTime, eventType) { const ts = toHHMMSS(currentTime); for (let i = log.length - 1; i >= 0; i--) { if (log[i].timestamp <= ts && log[i].event === eventType) return log[i]; } return null; }
function findLastEventFromTypes(log, currentTime, types, sinceTimestamp = "00:00:00") { const ts = toHHMMSS(currentTime); for (let i = log.length - 1; i >= 0; i--) { if (log[i].timestamp <= ts && log[i].timestamp >= sinceTimestamp && types.includes(log[i].event)) return log[i]; } return null; }
function calculateTrueSongPosition(log, currentTime, playbackRate, songContextEvent) { if (!songContextEvent) return 0; let songTime = songContextEvent.position_ms / 1000; let lastEventTime = parseHHMMSSToSeconds(songContextEvent.timestamp); let isPlaying = true; const relevantEvents = log.filter(e => { const eventTime = parseHHMMSSToSeconds(e.timestamp); return eventTime > lastEventTime && eventTime <= currentTime; }); for (const event of relevantEvents) { const eventTime = parseHHMMSSToSeconds(event.timestamp); const timeSinceLastEvent = eventTime - lastEventTime; if (isPlaying) songTime += timeSinceLastEvent * playbackRate; if (event.event === 'PAUSE') isPlaying = false; if (event.event === 'RESUME') isPlaying = true; if (event.event === 'SEEK') songTime = event.position_ms / 1000; lastEventTime = eventTime; } if (isPlaying) songTime += (currentTime - lastEventTime) * playbackRate; return songTime; }
async function findBestYouTubeMatch(track) { const cacheKey = `yt_match_${track.title}_${track.artist}`; const cached = await chrome.storage.local.get(cacheKey); if (cached[cacheKey]) return cached[cacheKey]; const searchQuery = encodeURIComponent(`${track.title} ${track.artist}`); const searchUrl = `${API_BASE_URL}/youtube-search?q=${searchQuery}&duration=${track.duration_ms}`; try { const res = await fetch(searchUrl); if (!res.ok) return null; const data = await res.json(); if (data.bestMatchVideoId) await chrome.storage.local.set({ [cacheKey]: data.bestMatchVideoId }); return data.bestMatchVideoId; } catch (e) { return null; } }
function parseHHMMSSToSeconds(ts) { if (!ts) return 0; const [h, m, s] = ts.split(':').map(Number); return (h * 3600) + (m * 60) + s; }
function toHHMMSS(secs) { const s = Math.floor(secs), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60; return [h, m, sec].map(v => String(v).padStart(2, '0')).join(':'); }
async function setActionBadge(tabId, text, color = '#777') { try { await chrome.action.setBadgeBackgroundColor({ tabId, color }); await chrome.action.setBadgeText({ tabId, text }); } catch (e) {} }