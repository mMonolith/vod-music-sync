const currentUrl = new URL(window.location.href);
const isMusicTab = currentUrl.searchParams.has('vod_sync_music_tab');
const isTwitch = currentUrl.hostname.includes('twitch.tv');
const isYouTube = currentUrl.hostname.includes('youtube.com');

let videoElement, lastTime = -1, currentPlatform = '', currentVodId = '', observer, lastIsPaused = false;
let ytIframe;

if (isMusicTab) {
    const findMusicVideo = setInterval(() => {
        videoElement = document.querySelector('video.html5-main-video');
        if (videoElement) {
            videoElement.addEventListener('canplay', () => { if (!videoElement.paused) videoElement.play(); }, { once: true });
            clearInterval(findMusicVideo);
        }
    }, 500);

    chrome.runtime.onMessage.addListener((request) => {
        if (request.type !== 'control_playback' || !videoElement) return;
        const currentVideoId = new URL(window.location.href).searchParams.get('v');
        if (request.videoId && currentVideoId !== request.videoId) {
            const newUrl = `https://www.youtube.com/watch?v=${request.videoId}&t=${Math.floor(Math.max(0, request.seekTo || 0))}s&vod_sync_music_tab=true`;
            window.location.href = newUrl;
            return;
        }
        if (request.seekTo && Math.abs(videoElement.currentTime - request.seekTo) > 2.5) {
            videoElement.currentTime = request.seekTo;
        }
        if (request.action === 'play' && videoElement.paused) {
            videoElement.play();
        } else if (request.action === 'pause' && !videoElement.paused) {
            videoElement.pause();
        }
    });

} else {
    setInterval(vodTimeUpdater, 400);
    startObserver();

    chrome.runtime.onMessage.addListener((request) => {
        if (request.type === 'init_ui' && isYouTube) {
            createYouTubeIframe();
        }
        if (isTwitch) {
            if (request.type === 'show_song_notification') { showOrUpdateInPageNotification(request.videoId, request.title, request.artist); } 
            else if (request.type === 'hide_song_notification') { hideInPageNotification(); }
        } else if (isYouTube) {
            if (request.type === 'control_youtube_iframe') { postMessageToYtIframe(request); } 
            else if (request.type === 'update_iframe_style') {
                const iframeContainer = document.getElementById('vod-sync-iframe-container');
                if (!iframeContainer) return;
                if (request.opacity !== undefined) iframeContainer.style.opacity = request.opacity;
                if (request.visible !== undefined) iframeContainer.style.display = request.visible ? 'block' : 'none';
                if (request.volume !== undefined) postMessageToYtIframe({ action: 'setVolume', volume: request.volume });
            }
        }
    });

    async function createYouTubeIframe() {
        if (document.getElementById('vod-sync-iframe-container')) return;
        const { iframeOpacity, iframeVisible } = await chrome.storage.sync.get({ iframeOpacity: 1, iframeVisible: true });
        const iframeContainer = document.createElement('div');
        iframeContainer.id = 'vod-sync-iframe-container';
        iframeContainer.style.cssText = `position: fixed; bottom: 15px; left: 15px; width: 320px; height: 180px; z-index: 2147483647; border-radius: 8px; overflow: hidden; box-shadow: 0 4px 15px rgba(0,0,0,0.4); border: 2px solid #9147ff; background-color: #000; opacity: ${iframeOpacity}; display: ${iframeVisible ? 'block' : 'none'}; transition: opacity 0.3s ease;`;
        const iframeSrc = `https://www.youtube.com/embed/?enablejsapi=1&origin=${window.location.origin}`;
        const iframe = document.createElement('iframe');
        iframe.id = 'vod-sync-iframe-player';
        iframe.type = 'text/html';
        iframe.width = '320';
        iframe.height = '180';
        iframe.src = iframeSrc;
        iframe.frameBorder = '0';
        iframe.allow = 'autoplay; encrypted-media';
        iframeContainer.appendChild(iframe);
        document.body.appendChild(iframeContainer);
        ytIframe = iframe;
    }

    function postMessageToYtIframe(request) { if (!ytIframe || !ytIframe.contentWindow) return; let command; switch (request.action) { case 'play': if (request.videoId) { command = { event: 'command', func: 'loadVideoById', args: [{ videoId: request.videoId, startSeconds: request.seekTo || 0 }] }; setTimeout(() => postMessageToYtIframe({ action: 'setVolume', volume: request.volume }), 1200); } else { command = { event: 'command', func: 'playVideo', args: [] }; } break; case 'pause': command = { event: 'command', func: 'pauseVideo', args: [] }; break; case 'stop': command = { event: 'command', func: 'stopVideo', args: [] }; break; case 'seek': if (request.seekTo !== undefined) command = { event: 'command', func: 'seekTo', args: [request.seekTo, true] }; break; case 'setVolume': if (request.volume !== undefined) command = { event: 'command', func: 'setVolume', args: [request.volume] }; break; } if (command) ytIframe.contentWindow.postMessage(JSON.stringify(command), 'https://www.youtube.com'); }
    function vodTimeUpdater() { if (!videoElement || !videoElement.isConnected) findVideoAndId(); if (!currentVodId || !videoElement) return; const currentTime = videoElement.currentTime; const isPaused = videoElement.paused; const playbackRate = videoElement.playbackRate; if (Math.abs(currentTime - lastTime) >= 0.4 || isPaused !== lastIsPaused) { lastTime = currentTime; lastIsPaused = isPaused; try { chrome.runtime.sendMessage({ type: 'time_update', platform: currentPlatform, vodId: currentVodId, currentTime, isPaused, playbackRate }); } catch (e) {} } }
    function findVideoAndId() { let foundVideo = null; if (isYouTube) { foundVideo = document.querySelector('video.html5-main-video'); } else if (isTwitch) { foundVideo = document.querySelector('[data-a-target="video-player"] video, .video-player__container video'); } if (foundVideo) videoElement = foundVideo; let platform = '', vodId = ''; if (isYouTube) { const params = new URLSearchParams(window.location.search); const vParam = params.get('v'); if (vParam) { platform = 'youtube'; vodId = vParam; } } else if (isTwitch) { const match = window.location.pathname.match(/\/videos\/(\d+)/); if (match?.[1]) { platform = 'twitch'; vodId = match[1]; } } currentPlatform = platform; currentVodId = vodId; }
    function startObserver() { findVideoAndId(); observer = new MutationObserver(findVideoAndId); observer.observe(document.body, { childList: true, subtree: true }); }
    function showOrUpdateInPageNotification(videoId, title, artist) { const NOTIFICATION_ID = 'vod-sync-inpage-notification'; let container = document.getElementById(NOTIFICATION_ID); if (!container) { container = document.createElement('div'); container.id = NOTIFICATION_ID; container.style.cssText = `position: fixed; bottom: 20px; left: 20px; z-index: 2147483647; background-color: #18181b; color: #efeff1; padding: 15px; border-radius: 8px; font-family: Roobert, "Helvetica Neue", Helvetica, Arial, sans-serif; font-size: 14px; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4); border: 1px solid #4d4d53; width: 320px; transform: translateX(-150%); transition: transform 0.4s ease-out;`; document.body.appendChild(container); setTimeout(() => { container.style.transform = 'translateX(0)'; }, 50); } const iconUrl = chrome.runtime.getURL('/icons/sync_icon48.png'); container.innerHTML = `<div style="display: flex; align-items: center; margin-bottom: 10px;"><img src="${iconUrl}" style="width: 24px; height: 24px; margin-right: 10px;"><p style="margin: 0; font-size: 12px; color: #adadb8;">VOD Music Sync Detected a Song</p></div><p title="${title}" style="margin: 0 0 5px 0; font-size: 16px; font-weight: bold; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${title}</p><p title="${artist}" style="margin: 0 0 12px 0; font-size: 13px; color: #adadb8;">${artist}</p><button id="vod-sync-open-btn" style="width: 100%; padding: 10px; background-color: #9147ff; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 14px; font-weight: bold;">Open Song in New Tab</button>`; container.querySelector('#vod-sync-open-btn').onclick = () => { chrome.runtime.sendMessage({ type: 'open_music_tab', videoId: videoId }); hideInPageNotification(); }; }
    function hideInPageNotification() { const notification = document.getElementById('vod-sync-inpage-notification'); if (notification) { notification.style.transform = 'translateX(-150%)'; setTimeout(() => notification.remove(), 500); } }
}