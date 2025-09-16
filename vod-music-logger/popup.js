document.addEventListener('DOMContentLoaded', () => {
    const offsetSlider = document.getElementById('offset-slider');
    const offsetDisplay = document.getElementById('offset-display');
    const opacitySlider = document.getElementById('opacity-slider');
    const volumeSlider = document.getElementById('volume-slider');
    const toggleBtn = document.getElementById('toggle-iframe-btn');
    const playerControls = document.getElementById('player-controls');
    const songListContainer = document.getElementById('song-list-container');
    const statusMessage = document.getElementById('status-message');
    
    let activeTabId = null;

    function sendMessageToContentScript(message) {
        if (activeTabId) {
            chrome.tabs.sendMessage(activeTabId, message).catch(err => {});
        }
    }

    chrome.storage.sync.get({
        syncOffset: -2000,
        iframeOpacity: 1,
        iframeVolume: 75,
        iframeVisible: true
    }, (settings) => {
        offsetSlider.value = settings.syncOffset;
        offsetDisplay.textContent = `${settings.syncOffset}ms`;
        opacitySlider.value = settings.iframeOpacity;
        volumeSlider.value = settings.iframeVolume;
        toggleBtn.textContent = settings.iframeVisible ? 'Hide Player' : 'Show Player';
    });

    offsetSlider.addEventListener('input', () => {
        offsetDisplay.textContent = `${offsetSlider.value}ms`;
    });
    offsetSlider.addEventListener('change', () => {
        chrome.storage.sync.set({ syncOffset: parseInt(offsetSlider.value, 10) });
    });

    opacitySlider.addEventListener('input', () => sendMessageToContentScript({ type: 'update_iframe_style', opacity: parseFloat(opacitySlider.value) }));
    opacitySlider.addEventListener('change', () => chrome.storage.sync.set({ iframeOpacity: parseFloat(opacitySlider.value) }));

    volumeSlider.addEventListener('input', () => sendMessageToContentScript({ type: 'update_iframe_style', volume: parseInt(volumeSlider.value, 10) }));
    volumeSlider.addEventListener('change', () => chrome.storage.sync.set({ iframeVolume: parseInt(volumeSlider.value, 10) }));

    toggleBtn.addEventListener('click', () => {
        chrome.storage.sync.get({ iframeVisible: true }, (settings) => {
            const nowVisible = !settings.iframeVisible;
            chrome.storage.sync.set({ iframeVisible: nowVisible });
            toggleBtn.textContent = nowVisible ? 'Hide Player' : 'Show Player';
            sendMessageToContentScript({ type: 'update_iframe_style', visible: nowVisible });
        });
    });

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (!tabs[0]?.id) {
            statusMessage.textContent = 'Could not find an active tab.';
            playerControls.style.display = 'none';
            return;
        }
        activeTabId = tabs[0].id;
        const isYouTubeVOD = tabs[0].url?.includes("youtube.com/watch");

        if (!isYouTubeVOD) {
            playerControls.style.display = 'none';
        }

        const storageKey = `activeLogForTab_${activeTabId}`;
        chrome.storage.local.get(storageKey, (result) => {
            if (result[storageKey]?.log) {
                const log = result[storageKey].log;
                const playEvents = log.filter(e => e.event === 'PLAY' && e.track?.title);

                if (playEvents.length > 0) {
                    statusMessage.style.display = 'none';
                    songListContainer.innerHTML = '';
                    playEvents.forEach(event => {
                        const item = document.createElement('div');
                        item.className = 'song-item';
                        item.innerHTML = `
                            <div class="song-info">
                                <p class="title" title="${event.track.title}">${event.track.title}</p>
                                <p class="artist" title="${event.track.artist}">${event.track.artist}</p>
                            </div>
                            <span class="song-timestamp">${event.timestamp}</span>
                        `;
                        songListContainer.appendChild(item);
                    });
                } else {
                    statusMessage.textContent = 'No songs found in this VOD.';
                }
            } else {
                statusMessage.textContent = 'Not on a VOD page or no log loaded.';
            }
        });
    });
});