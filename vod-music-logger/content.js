const currentUrl = new URL(window.location.href);
const isMusicTab = currentUrl.searchParams.has('vod_sync_music_tab');
const isTwitch = currentUrl.hostname.includes('twitch.tv');
const isYouTube = currentUrl.hostname.includes('youtube.com');

let videoElement, lastTime = -1, currentPlatform = '', currentVodId = '', observer, lastIsPaused = false;
let ytIframe;

if (!isMusicTab) {
    setInterval(vodTimeUpdater, 400);
    startObserver();
    if (isYouTube) createYouTubeIframe();
}

chrome.runtime.onMessage.addListener((request) => {
    if (isMusicTab) return;

    if (isYouTube) {
        if (request.type === 'control_youtube_iframe') {
            postMessageToYtIframe(request);
        } else if (request.type === 'update_iframe_style') {
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
    iframeContainer.style.cssText = `
        position: fixed; bottom: 15px; left: 15px; width: 320px; height: 180px;
        z-index: 2147483647; border-radius: 8px; overflow: hidden;
        box-shadow: 0 4px 15px rgba(0,0,0,0.4); border: 2px solid #9147ff; background-color: #000;
        opacity: ${iframeOpacity};
        display: ${iframeVisible ? 'block' : 'none'};
        transition: opacity 0.3s ease;
    `;

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

function postMessageToYtIframe(request) {
    if (!ytIframe || !ytIframe.contentWindow) return;
    let command;
    switch (request.action) {
        case 'play':
            if (request.videoId) {
                command = { event: 'command', func: 'loadVideoById', args: [{ videoId: request.videoId, startSeconds: request.seekTo || 0 }] };
                setTimeout(() => postMessageToYtIframe({ action: 'setVolume', volume: request.volume }), 1200);
            } else {
                command = { event: 'command', func: 'playVideo', args: [] };
            }
            break;
        case 'pause': command = { event: 'command', func: 'pauseVideo', args: [] }; break;
        case 'stop': command = { event: 'command', func: 'stopVideo', args: [] }; break;
        case 'seek': if (request.seekTo !== undefined) command = { event: 'command', func: 'seekTo', args: [request.seekTo, true] }; break;
        case 'setVolume': if (request.volume !== undefined) command = { event: 'command', func: 'setVolume', args: [request.volume] }; break;
    }
    if (command) ytIframe.contentWindow.postMessage(JSON.stringify(command), 'https://www.youtube.com');
}

function vodTimeUpdater() {
    if (!videoElement || !videoElement.isConnected) findVideoAndId();
    if (!currentVodId || !videoElement) return;

    const currentTime = videoElement.currentTime;
    const isPaused = videoElement.paused;
    const playbackRate = videoElement.playbackRate;

    if (Math.abs(currentTime - lastTime) >= 0.5 || isPaused !== lastIsPaused) {
        lastTime = currentTime;
        lastIsPaused = isPaused;
        try {
            chrome.runtime.sendMessage({
                type: 'time_update', platform: currentPlatform, vodId: currentVodId,
                currentTime, isPaused, playbackRate
            });
        } catch (e) { /* Extension context invalidated, safe to ignore */ }
    }
}

function findVideoAndId() {
    const foundVideo = document.querySelector('video.html5-main-video');
    if (foundVideo) videoElement = foundVideo;

    let platform = '', vodId = '';
    if (isYouTube) {
        const params = new URLSearchParams(window.location.search);
        const vParam = params.get('v');
        if (vParam) { platform = 'youtube'; vodId = vParam; }
    }
    currentPlatform = platform;
    currentVodId = vodId;
}

function startObserver() {
    findVideoAndId();
    observer = new MutationObserver(findVideoAndId);
    observer.observe(document.body, { childList: true, subtree: true });
}