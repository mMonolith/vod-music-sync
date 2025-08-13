import spotipy
from spotipy.oauth2 import SpotifyPKCE
import time
import json
import os
import sys

CLIENT_ID = '75c3f7c5e078465496bbc13564521bc7'
REDIRECT_URI = 'https://www.google.com'
SCOPE = 'user-read-playback-state'
OUTPUT_FILE = os.path.join(os.getenv('TEMP'), 'vod_sync_data.json')
CACHE_PATH = os.path.join(os.getenv('TEMP'), 'vod_sync.cache')

auth_manager = SpotifyPKCE(
    client_id=CLIENT_ID,
    redirect_uri=REDIRECT_URI,
    scope=SCOPE,
    cache_path=CACHE_PATH,
    open_browser=False
)

token_info = auth_manager.get_cached_token()
if not token_info:
    auth_url = auth_manager.get_authorize_url()
    print("--- VOD Sync: First-Time Setup ---")
    print("\n1. Open this URL in your browser:\n", auth_url)
    print("\n2. Log in and grant permission.")
    print("3. You will be redirected. Copy the ENTIRE URL from your browser's address bar.")
    sys.stdout.write("\n4. Paste the full URL here and press Enter: "); sys.stdout.flush()
    redirected_url = sys.stdin.readline().strip()
    try:
        code = auth_manager.parse_response_code(redirected_url)
        auth_manager.get_access_token(code, check_cache=False)
    except Exception as e:
        print(f"\n[ERROR] Could not get token. Details: {e}"); input("Press Enter to exit."); sys.exit(1)

sp = spotipy.Spotify(auth_manager=auth_manager)
print("\n--- VOD Sync Spotify Watcher (v0.2.0) ---")
print("Successfully authenticated. Writing status to:", OUTPUT_FILE)
print("This window can be minimized...")

last_data_str = ""
while True:
    try:
        current_playback = sp.current_playback()
        output_data = { "is_playing": False, "track_id": None, "title": None, "artist": None, "progress_ms": 0, "duration_ms": 0 }
        if current_playback and current_playback.get('item'):
            item = current_playback['item']
            output_data["is_playing"] = current_playback.get('is_playing', False)
            output_data["track_id"] = item.get('id')
            output_data["title"] = item.get('name')
            output_data["artist"] = ', '.join([artist.get('name', 'Unknown') for artist in item.get('artists', [])])
            output_data["progress_ms"] = current_playback.get('progress_ms', 0)
            output_data["duration_ms"] = item.get('duration_ms', 0)

        current_data_str = json.dumps(output_data)
        if current_data_str != last_data_str:
            with open(OUTPUT_FILE, 'w', encoding='utf-8') as f:
                f.write(current_data_str)
            last_data_str = current_data_str
    except Exception as e:
        print(f"An error occurred: {e}")
        time.sleep(10)
    time.sleep(0.5)