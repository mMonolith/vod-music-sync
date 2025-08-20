const API_BASE_URL = 'https://vod-sync.officilly-ranging-gamer.workers.dev';
const SPOTIFY_CLIENT_ID = '75c3f7c5e078465496bbc13564521bc7';

let activeVodTabs = {}; 
let activeMusicTabId = null;

chrome.alarms.create('keep-alive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => {});

chrome.tabs.onRemoved.addListener(tabId => {
    if (activeVodTabs[tabId]) {
        chrome.storage.local.remove('activeLogForTab_' + tabId);
        delete activeVodTabs[tabId];
        chrome.storage.local.get({ currentSongInfo: null }, (data) => {
            if (data.currentSongInfo && data.currentSongInfo.vodTabId === tabId) {
                chrome.storage.local.remove('currentSongInfo');
            }
        });
    }
    if (tabId === activeMusicTabId) activeMusicTabId = null;
});

function calculateCurrentSongPositionMs(vodState) {
    if (!vodState || !vodState.currentSongAnchor) return 0;
    const { positionMs, vodTimeSec } = vodState.currentSongAnchor;
    const elapsedVodTimeMs = (vodState.currentTime - vodTimeSec) * 1000;
    return Math.max(0, positionMs + elapsedVodTimeMs);
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    const tabId = sender.tab?.id;
    switch (request.type) {
        case 'time_update':
            if (tabId && request.vodId) {
                if (activeVodTabs[tabId]) {
                    activeVodTabs[tabId].currentTime = request.currentTime;
                    activeVodTabs[tabId].isPaused = request.isPaused;
                }
                handleTimeUpdate(tabId, request.platform, request.vodId, request.currentTime, request.isPaused);
            }
            break;
        case 'open_music_tab':
             if (request.videoId && tabId && activeVodTabs[tabId]) {
                const vodState = activeVodTabs[tabId];
                const seekToMs = calculateCurrentSongPositionMs(vodState);
                openYouTubeTab(request.videoId, Math.floor(seekToMs / 1000), !vodState.isPaused);
            }
            break;
        case 'reopen_last_song':
             chrome.storage.local.get({ currentSongInfo: null }, (data) => {
                if (data.currentSongInfo && data.currentSongInfo.provider === 'youtube') {
                    const { videoId, vodTabId } = data.currentSongInfo;
                    const vodState = activeVodTabs[vodTabId];
                    if (vodState) {
                         const seekToMs = calculateCurrentSongPositionMs(vodState);
                         openYouTubeTab(videoId, Math.floor(seekToMs / 1000), !vodState.isPaused);
                    }
                }
            });
            break;
        case 'exchange_code':
            exchangeCodeForTokenPKCE(request.code, request.code_verifier).then(() => sendResponse({ success: true })).catch(e => sendResponse({ success: false, error: e.message }));
            return true;
    }
    return true; 
});

async function handleTimeUpdate(tabId, platform, vodId, currentTime, isPaused) {
    const settings = await chrome.storage.sync.get({ extensionEnabled: true });
    if (!settings.extensionEnabled) {
        if (activeVodTabs[tabId]?.log) setActionBadge(tabId, 'OFF', '#FF0000');
        return;
    }

    if (!activeVodTabs[tabId] || activeVodTabs[tabId].vodId !== vodId) {
        try {
            const lookupRes = await fetch(`${API_BASE_URL}/lookup?platform=${platform}&id=${vodId}`);
            if (!lookupRes.ok) { 
                if (activeVodTabs[tabId]) setActionBadge(tabId, ''); 
                delete activeVodTabs[tabId];
                return;
            }
            const data = await lookupRes.json();
            const { logUrl } = data;
            activeVodTabs[tabId] = { vodId, lastEventIndex: -1, log: null, currentTime, isPaused, logUrl, lastEvent: null, currentSongAnchor: null, currentSongInfo: null };
            setActionBadge(tabId, '...');
            
            const cacheKey = `logcache_${logUrl}`;
            const cachedLog = await chrome.storage.local.get(cacheKey);
            if (cachedLog[cacheKey]) {
                activeVodTabs[tabId].log = cachedLog[cacheKey];
            } else {
                const logResponse = await fetch(logUrl);
                const logData = await logResponse.json();
                activeVodTabs[tabId].log = logData;
                await chrome.storage.local.set({ [cacheKey]: logData });
            }
            await chrome.storage.local.set({ ['activeLogForTab_' + tabId]: activeVodTabs[tabId].log });

            setActionBadge(tabId, 'ON', '#00D800');
        } catch (error) {
            delete activeVodTabs[tabId];
            setActionBadge(tabId, 'OFF', '#FF0000');
            return;
        }
    }

    const vodState = activeVodTabs[tabId];
    if (!vodState || !vodState.log) return;

    const currentTimestamp = toHHMMSS(currentTime);
    const logEntries = vodState.log.log;
    let newLastIndex = vodState.lastEventIndex;

    const targetEventIndex = findLastEventIndex(vodState.log, currentTimestamp);

    if (targetEventIndex !== vodState.lastEventIndex) {
        const event = logEntries[targetEventIndex];
        vodState.lastEvent = event;
        await dispatchAction(tabId, event, vodState);
        newLastIndex = targetEventIndex;

    } else {
        for (let i = vodState.lastEventIndex + 1; i < logEntries.length; i++) {
            if (logEntries[i].timestamp <= currentTimestamp) {
                const event = logEntries[i];
                vodState.lastEvent = event;
                await dispatchAction(tabId, event, vodState);
                newLastIndex = i;
            } else {
                break;
            }
        }
    }
    
    vodState.lastEventIndex = newLastIndex;
}

async function dispatchAction(tabId, event, vodState) {
    if (event.event === 'PLAY') {
        vodState.currentSongAnchor = {
            positionMs: event.position_ms || 0,
            vodTimeSec: parseHHMMSSToSeconds(event.timestamp)
        };
        vodState.currentSongInfo = null; 
    } else if (event.event === 'SEEK' && vodState.currentSongAnchor) {
        vodState.currentSongAnchor = {
            positionMs: event.position_ms,
            vodTimeSec: parseHHMMSSToSeconds(event.timestamp)
        };
    } else if (event.event === 'START') {
        vodState.currentSongInfo = null;
        vodState.currentSongAnchor = null;
        chrome.tabs.sendMessage(tabId, { type: 'hide_song_notification' }).catch(e => {});
    }

    const { music_provider } = await chrome.storage.sync.get({ music_provider: 'spotify' });
    if (music_provider === 'spotify') {
        await executeSpotifyAction(tabId, event, vodState);
    } else {
        await executeYouTubeAction(tabId, event, vodState);
    }
}

async function executeSpotifyAction(tabId, event, vodState) {
    const token = await getValidToken();
    if (!token) { console.error("VOD Sync: Spotify token not valid."); setActionBadge(tabId, 'AUTH', '#FFC300'); return; }
    const playerStateRes = await fetch('https://api.spotify.com/v1/me/player', { headers: { 'Authorization': `Bearer ${token}` }});
    if (!playerStateRes.ok || playerStateRes.status === 204) { setActionBadge(tabId, 'PLAYER', '#FF5733'); return; }
    const headers = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };
    switch (event.event) {
        case 'PLAY': {
            if (!event.track || !event.track.title) return;
            const q = encodeURIComponent(`track:${event.track.title} artist:${event.track.artist}`);
            const searchRes = await fetch(`https://api.spotify.com/v1/search?q=${q}&type=track&limit=1`, { headers });
            const searchData = await searchRes.json();
            if (searchData.tracks?.items?.length > 0) {
                const trackUri = searchData.tracks.items[0].uri;
                const seekToMs = calculateCurrentSongPositionMs(vodState);
                const body = JSON.stringify({ uris: [trackUri], position_ms: seekToMs });
                await fetch('https://api.spotify.com/v1/me/player/play', { method: 'PUT', headers, body });
                if (vodState.isPaused) { setTimeout(() => fetch('https://api.spotify.com/v1/me/player/pause', { method: 'PUT', headers }), 250); }
                chrome.storage.local.set({ currentSongInfo: { provider: 'spotify', title: event.track.title, artist: event.track.artist }});
            }
            break;
        }
        case 'PAUSE': {
            await fetch('https://api.spotify.com/v1/me/player/pause', { method: 'PUT', headers });
            chrome.storage.local.remove('currentSongInfo');
            break;
        }
        case 'RESUME': {
            if (!vodState.isPaused) { await fetch('https://api.spotify.com/v1/me/player/play', { method: 'PUT', headers }); }
            break;
        }
        case 'SEEK': {
            if (event.position_ms !== undefined) { await fetch(`https://api.spotify.com/v1/me/player/seek?position_ms=${event.position_ms}`, { method: 'PUT', headers }); }
            break;
        }
    }
}

function openYouTubeTab(videoId, seekToSec = 0, shouldPlay = true) {
    const youtubeUrl = `https://www.youtube.com/watch?v=${videoId}&t=${seekToSec}s&vod_sync_music_tab=true`;
    if (activeMusicTabId !== null) {
        chrome.tabs.get(activeMusicTabId, (tab) => {
            if (chrome.runtime.lastError) {
                activeMusicTabId = null;
                chrome.tabs.create({ url: youtubeUrl, active: false }, (newTab) => { 
                    activeMusicTabId = newTab.id; 
                    setTimeout(() => chrome.tabs.sendMessage(newTab.id, { type: 'control_playback', action: shouldPlay ? 'play' : 'pause', seekTo: seekToSec }), 1500);
                });
            } else {
                chrome.tabs.update(activeMusicTabId, { url: youtubeUrl, active: false });
            }
        });
    } else {
        chrome.tabs.create({ url: youtubeUrl, active: false }, (newTab) => { 
            activeMusicTabId = newTab.id;
            setTimeout(() => chrome.tabs.sendMessage(newTab.id, { type: 'control_playback', action: shouldPlay ? 'play' : 'pause', seekTo: seekToSec }), 1500);
        });
    }
}

async function executeYouTubeAction(tabId, event, vodState) {
    if (!activeMusicTabId) {
        const { showPopups } = await chrome.storage.sync.get({ showPopups: true });
        if (!showPopups) return;
        
        switch (event.event) {
            case 'PLAY':
                if (!event.track?.title) {
                    vodState.currentSongInfo = null;
                    chrome.storage.local.remove('currentSongInfo');
                    chrome.tabs.sendMessage(tabId, { type: 'hide_song_notification' }).catch(e => {});
                    return;
                }
                try {
                    const bestMatchVideoId = await findBestYouTubeMatch(event.track);
                    if (bestMatchVideoId) {
                        const songInfo = { provider: 'youtube', vodTabId: tabId, title: event.track.title, artist: event.track.artist, videoId: bestMatchVideoId };
                        vodState.currentSongInfo = songInfo;
                        chrome.storage.local.set({ currentSongInfo: songInfo });
                        
                        chrome.tabs.sendMessage(tabId, {
                            type: 'show_song_notification', videoId: bestMatchVideoId,
                            title: event.track.title, artist: event.track.artist, 
                            anchor: vodState.currentSongAnchor
                        }).catch(e => {});
                    }
                } catch (e) { console.error('[VOD Sync] YT Action Error:', e); }
                break;
            
            case 'SEEK':
                if (vodState.currentSongInfo) {
                    chrome.tabs.sendMessage(tabId, {
                        type: 'show_song_notification', videoId: vodState.currentSongInfo.videoId,
                        title: vodState.currentSongInfo.title, artist: vodState.currentSongInfo.artist,
                        anchor: vodState.currentSongAnchor
                    }).catch(e => {});
                }
                break;

            case 'PAUSE':
                chrome.tabs.sendMessage(tabId, { type: 'hide_song_notification' }).catch(e => {});
                chrome.storage.local.remove('currentSongInfo');
                break;

            case 'RESUME':
                if (vodState.currentSongInfo) {
                    chrome.tabs.sendMessage(tabId, {
                        type: 'show_song_notification', videoId: vodState.currentSongInfo.videoId,
                        title: vodState.currentSongInfo.title, artist: vodState.currentSongInfo.artist,
                        anchor: vodState.currentSongAnchor 
                    }).catch(e => {});
                    chrome.storage.local.set({ currentSongInfo: vodState.currentSongInfo });
                }
                break;
        }

    } else {
        switch (event.event) {
            case 'PLAY': {
                if (!event.track || !event.track.title) return;
                const bestMatchVideoId = await findBestYouTubeMatch(event.track);
                if (bestMatchVideoId) {
                    const seekToMs = calculateCurrentSongPositionMs(vodState);
                    openYouTubeTab(bestMatchVideoId, Math.floor(seekToMs / 1000), !vodState.isPaused);
                    const songInfo = { provider: 'youtube', vodTabId: tabId, title: event.track.title, artist: event.track.artist, videoId: bestMatchVideoId };
                    vodState.currentSongInfo = songInfo;
                    chrome.storage.local.set({ currentSongInfo: songInfo });
                }
                break;
            }
            case 'PAUSE': {
                chrome.tabs.sendMessage(activeMusicTabId, { type: 'control_playback', action: 'pause' }).catch(e => {});
                break;
            }
            case 'RESUME': {
                if (vodState.currentSongInfo && !vodState.isPaused) {
                    chrome.tabs.sendMessage(activeMusicTabId, { type: 'control_playback', action: 'play' }).catch(e => {});
                }
                break;
            }
            case 'SEEK': {
                if (event.position_ms !== undefined) {
                    chrome.tabs.sendMessage(activeMusicTabId, { type: 'control_playback', action: 'seek', seekTo: event.position_ms / 1000 }).catch(e => {});
                }
                break;
            }
        }
    }
}

async function findBestYouTubeMatch(track) {
    const searchQuery = encodeURIComponent(`${track.title} ${track.artist}`);
    const searchUrl = `${API_BASE_URL}/youtube-search?q=${searchQuery}&duration=${track.duration_ms}`;
    
    const res = await fetch(searchUrl);
    if (!res.ok) throw new Error('Worker YouTube search failed');
    const data = await res.json();
    return data.bestMatchVideoId;
}

function parseHHMMSSToSeconds(ts) { if (!ts) return 0; const [h, m, s] = ts.split(':').map(Number); return (h * 3600) + (m * 60) + s; }
async function setActionBadge(tabId, text, color = '#777') { try { await chrome.action.setBadgeBackgroundColor({ tabId, color }); await chrome.action.setBadgeText({ tabId, text }); } catch (e) {} }
function findLastEventIndex(logData, ts) { let i = -1; for(let j=0; j<logData.log.length; j++){ if(logData.log[j].timestamp <= ts){ i = j; } else { break; }} return i; }
function toHHMMSS(secs){const s=parseInt(secs,10),h=Math.floor(s/3600),m=Math.floor((s-h*3600)/60),sec=s-h*3600-m*60;return[h,m,sec].map(v=>String(v).padStart(2,'0')).join(':');}

async function exchangeCodeForTokenPKCE(code, code_verifier) { const rU=chrome.identity.getRedirectURL();const p=new URLSearchParams();p.append('client_id',SPOTIFY_CLIENT_ID);p.append('grant_type','authorization_code');p.append('code',code);p.append('redirect_uri',rU);p.append('code_verifier',code_verifier);const res=await fetch('https://accounts.spotify.com/api/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:p});if(!res.ok)throw new Error('Token exchange failed: '+await res.text());const data=await res.json();if(data.access_token){await chrome.storage.local.set({spotify_token:data.access_token,spotify_refresh_token:data.refresh_token,spotify_token_expires:Date.now()+(data.expires_in*1000)});}else{throw new Error('Token exchange failed');}}
async function getValidToken() {return new Promise((resolve)=>{chrome.storage.local.get(['spotify_token','spotify_token_expires','spotify_refresh_token'],async(result)=>{if(result.spotify_token&&Date.now()<result.spotify_token_expires){resolve(result.spotify_token);return;} if(!result.spotify_refresh_token){resolve(null);return;} const p=new URLSearchParams();p.append('grant_type','refresh_token');p.append('refresh_token',result.spotify_refresh_token);p.append('client_id',SPOTIFY_CLIENT_ID);const res=await fetch('https://accounts.spotify.com/api/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:p});if(!res.ok){chrome.storage.local.remove(['spotify_token','spotify_refresh_token','spotify_token_expires']);resolve(null);return;}const data=await res.json();if(data.access_token){chrome.storage.local.set({spotify_token:data.access_token,spotify_token_expires:Date.now()+(data.expires_in*1000),spotify_refresh_token:data.refresh_token||result.spotify_refresh_token},()=>resolve(data.access_token));}else{chrome.storage.local.remove(['spotify_token','spotify_refresh_token','spotify_token_expires']);resolve(null);}});});}