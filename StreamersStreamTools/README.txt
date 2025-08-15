The setup is now much simpler and almost fully automatic.

Part A: One Time Setup 
You only have to do this once.

Download the Tools:
Go to the latest release page and download the zip.
Extract it to a memorable location like your Desktop. (avoid program files)

Authorize Spotify (First Run Only):
Run spotify_watcher.exe. A black command window will open.
It will print a URL. Copy this URL and paste it into your web browser.
Log into Spotify and click "Agree".
After you agree, you'll be redirected to a blank page (it will say "www.google.com"). Copy the entire URL from the address bar of that new page.
Paste that full URL back into the black command window and press Enter.
It will say it's authenticated and watching Spotify.
You can now close this window for now as it's ready to be tested on stream.

Set up OBS
Open OBS.
Go to Tools -> Scripts.
Click the + button (bottom left) and add the vod_music_logger.lua file from the folder you unzipped.

Part B: Before You Go Live
Run spotify_watcher.exe. A black window will appear and say it's watching Spotify. You can just minimize this window, do NOT close it!
Stream/Record as normal. The OBS script will automatically start logging when you go live and stop when you end the stream.

Part C: After the Stream
1. Find the Log File
Once you stop your stream/recording, the log is saved.
Look inside the folder where you put the tools. A new subfolder called vod_music_logs will have been created.
Inside, you'll find a .json file named with the date and time, like 2025-08-15_20-15-00.json.
2. Send the File
Just send me that .json file on Discord, and I'll handle the rest.