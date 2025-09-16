import spotipy
from spotipy.oauth2 import SpotifyPKCE
import time
import json
import os
import sys
import threading
import tkinter as tk
from tkinter import ttk, messagebox
import webbrowser

CLIENT_ID = '75c3f7c5e078465496bbc13564521bc7'
REDIRECT_URI = 'https://www.google.com'
SCOPE = 'user-read-playback-state'

if getattr(sys, 'frozen', False):
    BASE_PATH = sys._MEIPASS
else:
    BASE_PATH = os.path.dirname(os.path.abspath(__file__))

TEMP_PATH = os.getenv('TEMP')
OUTPUT_FILE = os.path.join(TEMP_PATH, 'vod_sync_data.json')
CACHE_PATH = os.path.join(TEMP_PATH, 'vod_sync.cache')
ICON_PATH = os.path.join(BASE_PATH, 'watcher_icon.ico')

class SpotifyWatcherApp:
    def __init__(self, root):
        self.root = root
        self.root.title("VOD Sync Watcher")
        self.root.geometry("400x250")
        self.root.resizable(False, False)
        
        try:
            self.root.iconbitmap(ICON_PATH)
        except tk.TclError:
            print("Icon not found, skipping.")

        self.style = ttk.Style()
        self.style.theme_use('clam')
        self.style.configure("TLabel", background="#2c2c2c", foreground="white", font=("Segoe UI", 10))
        self.style.configure("TFrame", background="#2c2c2c")
        self.style.configure("TButton", font=("Segoe UI", 10, "bold"), foreground="white", background="#1DB954")
        self.style.map("TButton", background=[('active', '#1ED760')])
        
        self.main_frame = ttk.Frame(root, padding="15")
        self.main_frame.pack(fill=tk.BOTH, expand=True)
        self.root.configure(background="#2c2c2c")

        self.title_label = ttk.Label(self.main_frame, text="VOD Music Sync Watcher", font=("Segoe UI", 14, "bold"))
        self.title_label.pack(pady=(0, 10))
        
        self.status_label = ttk.Label(self.main_frame, text="Initializing...", wraplength=370, justify=tk.CENTER)
        self.status_label.pack(pady=5)
        
        self.song_label = ttk.Label(self.main_frame, text="Not Playing", wraplength=370, justify=tk.CENTER, font=("Segoe UI", 9, "italic"))
        self.song_label.pack(pady=5)

        self.auth_frame = ttk.Frame(self.main_frame)
        self.url_entry = ttk.Entry(self.auth_frame, width=40)
        self.submit_button = ttk.Button(self.auth_frame, text="Submit", command=self.submit_auth_code)
        
        self.sp = None
        self.auth_manager = None
        self.stop_event = threading.Event()

        self.root.protocol("WM_DELETE_WINDOW", self.on_closing)
        
        self.watcher_thread = threading.Thread(target=self.run_watcher, daemon=True)
        self.watcher_thread.start()

    def update_status(self, status, song=""):
        self.status_label.config(text=status)
        self.song_label.config(text=song or " ")

    def show_auth_ui(self, auth_url):
        self.update_status("Authentication required. Click the button, log in, and paste the final URL below.")
        
        auth_button = ttk.Button(self.main_frame, text="1. Open Spotify Login", command=lambda: webbrowser.open(auth_url))
        auth_button.pack(pady=5, fill=tk.X)
        
        self.auth_frame.pack(pady=10)
        ttk.Label(self.auth_frame, text="2. Paste URL here:").pack(side=tk.LEFT, padx=(0, 5))
        self.url_entry.pack(side=tk.LEFT, expand=True, fill=tk.X)
        self.submit_button.pack(side=tk.LEFT, padx=(5, 0))

    def submit_auth_code(self):
        redirected_url = self.url_entry.get().strip()
        if not redirected_url:
            messagebox.showerror("Error", "URL field cannot be empty.")
            return

        try:
            self.update_status("Authenticating...")
            code = self.auth_manager.parse_response_code(redirected_url)
            self.auth_manager.get_access_token(code, check_cache=False)
            self.sp = spotipy.Spotify(auth_manager=self.auth_manager)
            self.auth_frame.pack_forget()
        except Exception as e:
            messagebox.showerror("Authentication Failed", f"Could not get token. Please check the URL and try again.\n\nDetails: {e}")
            self.update_status("Authentication failed. Please try again.")

    def run_watcher(self):
        self.auth_manager = SpotifyPKCE(client_id=CLIENT_ID, redirect_uri=REDIRECT_URI, scope=SCOPE, cache_path=CACHE_PATH, open_browser=False)
        
        token_info = self.auth_manager.get_cached_token()
        if not token_info:
            auth_url = self.auth_manager.get_authorize_url()
            self.root.after(0, self.show_auth_ui, auth_url)
            
            while not self.auth_manager.get_cached_token():
                if self.stop_event.is_set(): return
                time.sleep(0.5)

        self.sp = spotipy.Spotify(auth_manager=self.auth_manager)
        self.root.after(0, self.update_status, "Watcher is running...", "Waiting for Spotify...")

        last_data_str = ""
        while not self.stop_event.is_set():
            try:
                current_playback = self.sp.current_playback()
                output_data = {"is_playing": False, "track_id": None, "title": None, "artist": None, "progress_ms": 0, "duration_ms": 0}
                
                if current_playback and current_playback.get('item'):
                    item = current_playback['item']
                    is_playing = current_playback.get('is_playing', False)
                    title = item.get('name')
                    artist = ', '.join([artist.get('name', 'Unknown') for artist in item.get('artists', [])])

                    output_data["is_playing"] = is_playing
                    output_data["track_id"] = item.get('id')
                    output_data["title"] = title
                    output_data["artist"] = artist
                    output_data["progress_ms"] = current_playback.get('progress_ms', 0)
                    output_data["duration_ms"] = item.get('duration_ms', 0)
                    
                    status_text = "Playing" if is_playing else "Paused"
                    song_text = f"{title} - {artist}"
                    self.root.after(0, self.update_status, f"Watcher is running ({status_text})", song_text)
                else:
                    self.root.after(0, self.update_status, "Watcher is running", "Spotify is not active.")

                current_data_str = json.dumps(output_data)
                if current_data_str != last_data_str:
                    with open(OUTPUT_FILE, 'w', encoding='utf-8') as f:
                        f.write(current_data_str)
                    last_data_str = current_data_str

            except Exception as e:
                error_message = f"An error occurred: {e}. Retrying..."
                self.root.after(0, self.update_status, error_message)
                time.sleep(10)
            
            time.sleep(0.5)

    def on_closing(self):
        self.stop_event.set()
        self.root.destroy()

if __name__ == "__main__":
    root = tk.Tk()
    app = SpotifyWatcherApp(root)
    root.mainloop()