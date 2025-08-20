document.addEventListener('DOMContentLoaded', () => {
    
    const spotifyRadio = document.getElementById('provider-spotify');
    const youtubeRadio = document.getElementById('provider-youtube');
    const spotifySection = document.getElementById('spotify-login-section');
    const youtubeSection = document.getElementById('youtube-login-section');
    const loginButton = document.getElementById('login-button');
    const spotifyStatus = document.getElementById('spotify-status');
    const SPOTIFY_CLIENT_ID = '75c3f7c5e078465496bbc13564521bc7';

    const youtubeSettingsDiv = document.getElementById('youtube-settings');
    const pauseVodToggle = document.getElementById('pause-vod-toggle');
    const showPopupToggle = document.getElementById('show-popup-toggle');

    function updateSections() {
        if (youtubeRadio.checked) {
            spotifySection.style.display = 'none';
            youtubeSection.style.display = 'block';
            youtubeSettingsDiv.style.display = 'block';
        } else {
            spotifySection.style.display = 'block';
            youtubeSection.style.display = 'none';
            youtubeSettingsDiv.style.display = 'none';
        }
    }

    function setProvider(provider) {
        chrome.storage.sync.set({ music_provider: provider }, updateSections);
    }

    chrome.storage.sync.get({ 
        music_provider: 'spotify', 
        pauseVod: false,
        showPopups: true 
    }, (result) => {
        (result.music_provider === 'youtube' ? youtubeRadio : spotifyRadio).checked = true;
        pauseVodToggle.checked = result.pauseVod;
        showPopupToggle.checked = result.showPopups;
        updateSections();
        updateSpotifyStatus();
    });

    spotifyRadio.addEventListener('change', () => setProvider('spotify'));
    youtubeRadio.addEventListener('change', () => setProvider('youtube'));
    pauseVodToggle.addEventListener('change', () => {
        chrome.storage.sync.set({ pauseVod: pauseVodToggle.checked });
    });
    showPopupToggle.addEventListener('change', () => {
        chrome.storage.sync.set({ showPopups: showPopupToggle.checked });
    });

    async function updateSpotifyStatus() {
        const { spotify_token } = await chrome.storage.local.get(['spotify_token']);
        if (spotify_token) {
            spotifyStatus.textContent = 'Status: Logged in to Spotify.';
            loginButton.textContent = 'Logout';
        } else {
            spotifyStatus.textContent = 'Status: Not logged in.';
            loginButton.textContent = 'Login with Spotify';
        }
    }

    async function generatePKCE() {
        const verifier = Array.from(crypto.getRandomValues(new Uint8Array(32))).map(b => b.toString(16).padStart(2, '0')).join('');
        const sha256 = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
        const challenge = btoa(String.fromCharCode(...new Uint8Array(sha256))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
        return { verifier, challenge };
    }

    loginButton.addEventListener('click', async () => {
        const { spotify_token } = await chrome.storage.local.get(['spotify_token']);
        if (spotify_token) {
            await chrome.storage.local.remove(['spotify_token', 'spotify_refresh_token', 'spotify_token_expires']);
            await updateSpotifyStatus();
        } else {
            const { verifier, challenge } = await generatePKCE();
            const redirectUri = chrome.identity.getRedirectURL();
            const scope = 'user-modify-playback-state user-read-playback-state';
            const authUrl = `https://accounts.spotify.com/authorize?client_id=${SPOTIFY_CLIENT_ID}&response_type=code&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(scope)}&code_challenge_method=S256&code_challenge=${challenge}`;
            
            chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true }, (redirect_url) => {
                if (chrome.runtime.lastError || !redirect_url) {
                    spotifyStatus.textContent = `Error: ${chrome.runtime.lastError?.message || 'Login failed.'}`;
                    return;
                }
                const code = new URL(redirect_url).searchParams.get('code');
                chrome.runtime.sendMessage({ type: 'exchange_code', code: code, code_verifier: verifier }, (response) => {
                    if (response && response.success) {
                        updateSpotifyStatus();
                    } else {
                        spotifyStatus.textContent = 'Error: Token exchange failed. The background service may have been inactive. Please try again.';
                    }
                });
            });
        }
    });
});