const API_BASE_URL = 'https://vod-sync.officilly-ranging-gamer.workers.dev';
const DEBUG = false;

function log(...args) {
    if (DEBUG) {
        console.log(`[VOD Sync Debug ${new Date().toLocaleTimeString()}]`, ...args);
    }
}

let activeVodTabs = {};

chrome.alarms.create('keep-alive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => {});

chrome.tabs.onRemoved.addListener(tabId => {
    if (activeVodTabs[tabId]?.syncInterval) {
        clearInterval(activeVodTabs[tabId].syncInterval);
    }
    delete activeVodTabs[tabId];
});

chrome.runtime.onMessage.addListener((request, sender) => {
    const tabId = sender.tab?.id;
    if (request.type === 'time_update' && tabId && request.vodId) {
        handleTimeUpdate(tabId, request.platform, request.vodId, request.currentTime, request.isPaused, request.playbackRate);
    }
});

async function handleTimeUpdate(tabId, platform, vodId, currentTime, isPaused, playbackRate) {
    if (!activeVodTabs[tabId] || activeVodTabs[tabId].vodId !== vodId) {
        if (activeVodTabs[tabId]?.syncInterval) clearInterval(activeVodTabs[tabId].syncInterval);
        
        try {
            const lookupRes = await fetch(`${API_BASE_URL}/lookup?platform=${platform}&id=${vodId}`);
            if (!lookupRes.ok) return;
            const { logUrl } = await lookupRes.json();
            const logResponse = await fetch(logUrl);
            const logData = await logResponse.json();
            
            activeVodTabs[tabId] = {
                vodId,
                log: logData.log,
                playerState: 'STOPPED',
                activeMusicVideoId: null,
                lastKnownSongTime: 0,
                isVODPaused: isPaused,
                syncInterval: setInterval(() => syncPlayerState(tabId), 750)
            };
            await chrome.storage.local.set({ ['activeLogForTab_' + tabId]: logData });
            setActionBadge(tabId, 'ON', '#00D800');
        } catch (error) {
            setActionBadge(tabId, 'ERR', '#FF0000');
            return;
        }
    }
    
    if (activeVodTabs[tabId]) {
        activeVodTabs[tabId].currentTime = currentTime;
        activeVodTabs[tabId].isVODPaused = isPaused;
        activeVodTabs[tabId].playbackRate = playbackRate;
    }
}

async function syncPlayerState(tabId) {
    const vodState = activeVodTabs[tabId];
    if (!vodState || !vodState.log) return;

    const { currentTime, isVODPaused, playbackRate, playerState, activeMusicVideoId } = vodState;
    const { syncOffset, iframeVolume } = await chrome.storage.sync.get({ syncOffset: -2000, iframeVolume: 75 });
    
    const songContextEvent = findLastEventOfType(vodState.log, currentTime, 'PLAY');

    if (!songContextEvent) {
        if (playerState !== 'STOPPED') {
            vodState.playerState = 'STOPPED';
            vodState.activeMusicVideoId = null;
            chrome.tabs.sendMessage(tabId, { type: 'control_youtube_iframe', action: 'stop' }).catch(e => {});
        }
        return;
    }

    const lastAction = findLastEventFromTypes(vodState.log, currentTime, ['PAUSE', 'RESUME', 'PLAY'], songContextEvent.timestamp);
    const targetVideoId = await findBestYouTubeMatch(songContextEvent.track);
    if (!targetVideoId) return;

    const trueSongPosition = calculateTrueSongPosition(vodState.log, currentTime, playbackRate, songContextEvent) + (syncOffset / 1000);
    
    let desiredPlayerState = (lastAction.event === 'PAUSE' || isVODPaused) ? 'PAUSED' : 'PLAYING';

    if (activeMusicVideoId !== targetVideoId) {
        vodState.activeMusicVideoId = targetVideoId;
        vodState.playerState = 'PLAYING';
        chrome.tabs.sendMessage(tabId, {
            type: 'control_youtube_iframe', action: 'play',
            videoId: targetVideoId, seekTo: Math.max(0, trueSongPosition), volume: iframeVolume
        }).catch(e => {});
        vodState.lastKnownSongTime = trueSongPosition;
        return;
    }

    if (desiredPlayerState !== playerState) {
        const action = desiredPlayerState === 'PLAYING' ? 'play' : 'pause';
        chrome.tabs.sendMessage(tabId, { type: 'control_youtube_iframe', action }).catch(e => {});
        vodState.playerState = desiredPlayerState;
    }
    
    if (playerState === 'PLAYING') {
        const timeDifference = Math.abs(trueSongPosition - vodState.lastKnownSongTime);
        if (timeDifference > 2.0) {
            chrome.tabs.sendMessage(tabId, { type: 'control_youtube_iframe', action: 'seek', seekTo: Math.max(0, trueSongPosition) }).catch(e => {});
        }
        vodState.lastKnownSongTime = trueSongPosition;
    }
}

function findLastEventOfType(log, currentTime, eventType) {
    const ts = toHHMMSS(currentTime);
    for (let i = log.length - 1; i >= 0; i--) {
        if (log[i].timestamp <= ts && log[i].event === eventType) return log[i];
    }
    return null;
}

function findLastEventFromTypes(log, currentTime, types, sinceTimestamp = "00:00:00") {
    const ts = toHHMMSS(currentTime);
    for (let i = log.length - 1; i >= 0; i--) {
        if (log[i].timestamp <= ts && log[i].timestamp >= sinceTimestamp && types.includes(log[i].event)) {
            return log[i];
        }
    }
    return null;
}

function calculateTrueSongPosition(log, currentTime, playbackRate, songContextEvent) {
    let songTime = songContextEvent.position_ms / 1000;
    let lastEventTime = parseHHMMSSToSeconds(songContextEvent.timestamp);
    let isPlaying = true;

    const relevantEvents = log.filter(e => {
        const eventTime = parseHHMMSSToSeconds(e.timestamp);
        return eventTime > lastEventTime && eventTime <= currentTime;
    });

    for (const event of relevantEvents) {
        const eventTime = parseHHMMSSToSeconds(event.timestamp);
        const timeSinceLastEvent = eventTime - lastEventTime;
        if (isPlaying) {
            songTime += timeSinceLastEvent * playbackRate;
        }

        if (event.event === 'PAUSE') isPlaying = false;
        if (event.event === 'RESUME') isPlaying = true;
        if (event.event === 'SEEK') songTime = event.position_ms / 1000;
        
        lastEventTime = eventTime;
    }

    if (isPlaying) {
        songTime += (currentTime - lastEventTime) * playbackRate;
    }

    return songTime;
}

async function findBestYouTubeMatch(track) {
    const cacheKey = `yt_match_${track.title}_${track.artist}`;
    const cached = await chrome.storage.local.get(cacheKey);
    if (cached[cacheKey]) return cached[cacheKey];
    const searchQuery = encodeURIComponent(`${track.title} ${track.artist}`);
    const searchUrl = `${API_BASE_URL}/youtube-search?q=${searchQuery}&duration=${track.duration_ms}`;
    try {
        const res = await fetch(searchUrl);
        if (!res.ok) return null;
        const data = await res.json();
        if (data.bestMatchVideoId) await chrome.storage.local.set({ [cacheKey]: data.bestMatchVideoId });
        return data.bestMatchVideoId;
    } catch (e) { return null; }
}

function parseHHMMSSToSeconds(ts) { if (!ts) return 0; const [h, m, s] = ts.split(':').map(Number); return (h * 3600) + (m * 60) + s; }
function toHHMMSS(secs) { const s = Math.floor(secs), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60; return [h, m, sec].map(v => String(v).padStart(2, '0')).join(':'); }
async function setActionBadge(tabId, text, color = '#777') { try { await chrome.action.setBadgeBackgroundColor({ tabId, color }); await chrome.action.setBadgeText({ tabId, text }); } catch (e) {} }