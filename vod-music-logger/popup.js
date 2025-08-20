document.addEventListener('DOMContentLoaded', () => {
    const enableToggle = document.getElementById('enable-toggle');
    const optionsBtn = document.getElementById('options-btn');
    const songContainer = document.getElementById('current-song-container');
    const reopenBtn = document.getElementById('reopen-btn');
    const historyBtn = document.getElementById('history-btn');
    const historyContainer = document.getElementById('song-history-container');

    chrome.storage.sync.get({ extensionEnabled: true }, (data) => {
        enableToggle.checked = data.extensionEnabled;
    });
    enableToggle.addEventListener('change', () => {
        chrome.storage.sync.set({ extensionEnabled: enableToggle.checked });
    });

    optionsBtn.addEventListener('click', () => {
        chrome.runtime.openOptionsPage();
    });

    chrome.storage.local.get({ currentSongInfo: null }, (data) => {
        if (data.currentSongInfo) {
            const { title, artist, provider } = data.currentSongInfo;
            document.getElementById('song-title').textContent = title;
            document.getElementById('song-artist').textContent = artist;
            songContainer.style.display = 'block';

            if (provider === 'youtube') {
                reopenBtn.style.display = 'block';
            } else {
                reopenBtn.style.display = 'none';
            }
        }
    });

    reopenBtn.addEventListener('click', () => {
        chrome.runtime.sendMessage({ type: 'reopen_last_song' });
        window.close();
    });

    historyBtn.addEventListener('click', () => {
        const isVisible = historyContainer.style.display === 'block';
        if (isVisible) {
            historyContainer.style.display = 'none';
            historyBtn.textContent = 'View Song History';
            return;
        }

        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (!tabs || tabs.length === 0) return;
            const tabId = tabs[0].id;
            const storageKey = `activeLogForTab_${tabId}`;
            
            chrome.storage.local.get(storageKey, (result) => {
                if (result[storageKey] && result[storageKey].log) {
                    const log = result[storageKey].log;
                    const playEvents = log.filter(e => e.event === 'PLAY' && e.track);

                    const uniqueSongs = [...new Map(playEvents.map(e => [e.track.title, e])).values()];

                    historyContainer.innerHTML = '';

                    if (uniqueSongs.length > 0) {
                        uniqueSongs.forEach(event => {
                            const item = document.createElement('div');
                            item.className = 'history-item';
                            item.innerHTML = `<p class="title" title="${event.track.title}">${event.track.title}</p><p class="artist" title="${event.track.artist}">${event.track.artist}</p>`;
                            historyContainer.appendChild(item);
                        });
                    } else {
                        historyContainer.innerHTML = '<div class="history-item"><p>No songs found in the log for this VOD.</p></div>';
                    }

                    historyContainer.style.display = 'block';
                    historyBtn.textContent = 'Hide Song History';
                } else {
                    historyContainer.innerHTML = '<div class="history-item"><p>Not a VOD tab or no log loaded.</p></div>';
                    historyContainer.style.display = 'block';
                    historyBtn.textContent = 'Hide Song History';
                }
            });
        });
    });
});