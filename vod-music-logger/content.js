const currentUrl = new URL(window.location.href);
const isMusicTab = currentUrl.searchParams.has('vod_sync_music_tab');
const isTwitch = currentUrl.hostname.includes('twitch.tv');

let videoElement;
let lastTime = -1;
let currentPlatform = '';
let currentVodId = '';
let observer;
const NOTIFICATION_ID = 'vod-sync-inpage-notification';
let lastIsPaused = false;

let notificationTimerInterval = null;
let currentNotificationAnchor = null; 
let isMouseOverNotification = false;
let notificationHideTimeout = null;

if (isMusicTab) {
    console.log("VOD Sync [MUSIC TAB]: Initializing listener.");
    
    const findMusicVideo = setInterval(() => {
        videoElement = document.querySelector('video.html5-main-video');
        if (videoElement) {
            clearInterval(findMusicVideo);
            console.log("VOD Sync [MUSIC TAB]: Video element found.");
        }
    }, 500);

    chrome.runtime.onMessage.addListener((request) => {
        if (request.type === 'control_playback' && videoElement) {
            switch(request.action) {
                case 'play':
                    if (request.seekTo !== undefined) {
                        videoElement.currentTime = request.seekTo;
                    }
                    videoElement.play();
                    break;
                case 'pause':
                    videoElement.pause();
                    break;
                case 'seek':
                    if (request.seekTo !== undefined) {
                        videoElement.currentTime = request.seekTo;
                    }
                    break;
            }
        }
    });

} else {
    console.log("VOD Sync [VOD TAB]: Initializing updater.");
    setInterval(vodTimeUpdater, 500);
    startObserver();
}

chrome.runtime.onMessage.addListener((request) => {
    if (isMusicTab) return;

    switch (request.type) {
        case 'show_song_notification':
            showOrUpdateInPageNotification(request.videoId, request.title, request.artist, request.anchor);
            break;
        case 'hide_song_notification':
            hideInPageNotification();
            break;
    }
});

function updateTimerDisplay() {
    if (!currentNotificationAnchor || !videoElement || !videoElement.isConnected) return;
    
    const timerEl = document.getElementById('vod-sync-timer');
    if (!timerEl) {
        hideInPageNotification();
        return;
    }
    
    const elapsedVodTimeSec = videoElement.currentTime - currentNotificationAnchor.vodTimeSec;
    const progressSec = Math.floor((currentNotificationAnchor.positionMs / 1000) + elapsedVodTimeSec);

    if (progressSec >= 0) {
        const minutes = Math.floor(progressSec / 60).toString().padStart(2, '0');
        const seconds = (progressSec % 60).toString().padStart(2, '0');
        timerEl.textContent = `${minutes}:${seconds}`;
    } else {
        timerEl.textContent = `00:00`;
    }
}

function showOrUpdateInPageNotification(videoId, title, artist, anchor) {
    if (!anchor) return;
    
    if (notificationHideTimeout) {
        clearTimeout(notificationHideTimeout);
        notificationHideTimeout = null;
    }

    currentNotificationAnchor = anchor;
    
    const existingNotification = document.getElementById(NOTIFICATION_ID);

    if (!existingNotification) {
        const container = document.createElement('div');
        container.id = NOTIFICATION_ID;
        container.style.cssText = `
            position: fixed; bottom: 20px; left: 20px; z-index: 2147483647; background-color: #18181b; color: #efeff1; 
            padding: 15px; border-radius: 8px; font-family: Roobert, "Helvetica Neue", Helvetica, Arial, sans-serif; 
            font-size: 14px; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4); border: 1px solid #4d4d53;
            width: 320px; transform: translateX(-150%); transition: transform 0.4s ease-out;
        `;
        container.innerHTML = `
            <p style="margin: 0 0 5px 0; font-size: 12px; color: #adadb8;">VOD Music Sync</p>
            <p id="vod-sync-title" style="margin: 0 0 12px 0; font-size: 16px; font-weight: bold; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;"></p>
            <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px;">
                <p id="vod-sync-artist" style="margin: 0; font-size: 13px; color: #adadb8; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;"></p>
                <p id="vod-sync-timer" style="margin: 0; font-size: 13px; color: #efeff1; font-family: monospace;">00:00</p>
            </div>
            <button id="vod-sync-open-btn" style="width: 100%; padding: 10px; background-color: #9147ff; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 14px; font-weight: bold;">Open Song</button>
            <button id="vod-sync-close-btn" style="position: absolute; top: 8px; right: 8px; background: none; border: none; color: white; font-size: 20px; cursor: pointer; opacity: 0.7; line-height: 1;">&times;</button>
        `;
        document.body.appendChild(container);
        setTimeout(() => { container.style.transform = 'translateX(0)'; }, 50);

        container.querySelector('#vod-sync-open-btn').addEventListener('click', () => {
            chrome.runtime.sendMessage({ type: 'open_music_tab', videoId: videoId });
            hideInPageNotification();
        });
        container.querySelector('#vod-sync-close-btn').addEventListener('click', hideInPageNotification);
        
        container.addEventListener('mouseenter', () => {
            isMouseOverNotification = true;
            if (notificationHideTimeout) {
                clearTimeout(notificationHideTimeout);
                notificationHideTimeout = null;
            }
        });
        container.addEventListener('mouseleave', () => {
            isMouseOverNotification = false;
        });
        
        if (notificationTimerInterval) clearInterval(notificationTimerInterval);
        notificationTimerInterval = setInterval(updateTimerDisplay, 1000);
    }
    
    const titleEl = document.getElementById('vod-sync-title');
    const artistEl = document.getElementById('vod-sync-artist');
    if (titleEl) {
        titleEl.textContent = title;
        titleEl.title = title;
    }
    if (artistEl) {
        artistEl.textContent = artist;
        artistEl.title = artist;
    }
}

function hideInPageNotification() {
    if (notificationHideTimeout) clearTimeout(notificationHideTimeout);

    notificationHideTimeout = setTimeout(() => {
        if (isMouseOverNotification) {
            return; 
        }

        if (notificationTimerInterval) {
            clearInterval(notificationTimerInterval);
            notificationTimerInterval = null;
        }
        currentNotificationAnchor = null;
        const notification = document.getElementById(NOTIFICATION_ID);
        if (notification) {
            notification.remove();
        }
    }, 500);
}

function vodTimeUpdater() {
    if (!videoElement || !videoElement.isConnected) findVideoAndId();
    if (!currentVodId || !videoElement) return;

    const currentTime = Math.floor(videoElement.currentTime);
    const isPaused = videoElement.paused;
    if (currentTime !== lastTime || isPaused !== lastIsPaused) {
        lastTime = currentTime;
        lastIsPaused = isPaused;
        try {
            chrome.runtime.sendMessage({ type: 'time_update', platform: currentPlatform, vodId: currentVodId, currentTime: currentTime, isPaused: isPaused });
        } catch (e) {
        }
    }
}

function handleVideoElement(newVideoElement) {
    if (videoElement === newVideoElement) return;
    videoElement = newVideoElement;
    if (videoElement) {
        lastIsPaused = videoElement.paused;
    }
}

function findVideoAndId() {
    const foundVideo = document.querySelector('video');
    if (foundVideo !== videoElement) handleVideoElement(foundVideo);
    let platform = '', vodId = '';
    if (videoElement) {
        if (isTwitch) {
            const match = currentUrl.pathname.match(/\/videos\/(\d+)/);
            if (match && match[1]) { platform = 'twitch'; vodId = match[1]; }
        } else {
            vodId = currentUrl.searchParams.get('v');
            if (vodId) { platform = 'youtube'; }
        }
    }
    currentPlatform = platform; 
    currentVodId = vodId;
}

function startObserver() {
    findVideoAndId();
    if (observer) observer.disconnect();
    observer = new MutationObserver(findVideoAndId);
    observer.observe(document.body, { childList: true, subtree: true });
}