local obs = obslua

local temp_path = os.getenv("TEMP")
local status_file_path = temp_path .. "\\vod_sync_data.json"

function script_description() return "v0.12.0: Finds the spotify watcher file automatically" end

function script_properties()
    local p = obs.obs_properties_create()
    obs.obs_properties_add_text(p, "instructions", "Instructions:\n1. Run spotify_watcher.exe.\n2. Go live or start recording.", obs.OBS_TEXT_INFO)
    return p
end

function script_update(s) end

local function parse_kv(content, key)
    local key_pattern = '"' .. key .. '": ?'
    local key_start, key_end = string.find(content, key_pattern)
    if not key_start then return nil end
    local value_start = key_end + 1
    local first_char = string.sub(content, value_start, value_start)
    if first_char == '"' then
        local value_end = string.find(content, '"', value_start + 1)
        if not value_end then return nil end
        return string.sub(content, value_start + 1, value_end - 1)
    elseif first_char == 't' or first_char == 'f' then
        local value_end = string.find(content, '[^a-z]', value_start) or (#content + 1)
        return string.sub(content, value_start, value_end - 1) == "true"
    elseif first_char == 'n' then
        return "none"
    else
        local value_end = string.find(content, '[^0-9.]', value_start) or (#content + 1)
        return tonumber(string.sub(content, value_start, value_end - 1))
    end
    return nil
end

local poll_rate_ms = 500
local last_poll_time = 0
local last_track_id = "INIT"
local last_is_playing = false
local last_progress_ms = 0
local final_log_file = nil
local recording_active = false
local script_dir = script_path():match("(.*/)")
local log_dir = script_dir .. "vod_music_logs/"

local function log(message) obs.script_log(obs.LOG_INFO, "[VOD-Sync-v12.0] " .. tostring(message)) end
local function format_timestamp(ms) local s = math.floor( ms/1000 ); return string.format("%02d:%02d:%02d", math.floor(s/3600), math.floor(s/60)%60, s%60) end
local function escape_str(s) if not s or s == "none" then return "" end; return s:gsub('"', '\"'):gsub('\\', '\\\\') end

function write_event(event, data)
    if not final_log_file then return end
    local output = obs.obs_frontend_get_streaming_output()
    if not obs.obs_output_active(output) then
        obs.obs_output_release(output)
        output = obs.obs_frontend_get_recording_output()
    end
    if not obs.obs_output_active(output) then
        obs.obs_output_release(output)
        return
    end
    local timestamp_ms = obs.obs_output_get_total_frames(output) * 1000 / obs.obs_get_active_fps()
    obs.obs_output_release(output)
    
    local entry_data = ""
    if event == "PLAY" and data and data.title and data.title ~= "none" then
        entry_data = ',\n        "position_ms": ' .. tostring(data.progress_ms or 0) .. ',\n        "track": {\n            "title": "' .. escape_str(data.title) .. '",\n            "artist": "' .. escape_str(data.artist) .. '",\n            "duration_ms": ' .. tostring(data.duration_ms or 0) .. '\n        }'
    elseif event == "SEEK" and data and data.progress_ms then
        entry_data = ',\n        "position_ms": ' .. tostring(data.progress_ms)
    end
    
    local entry = string.format(',\n    {\n        "event": "%s",\n        "timestamp": "%s"%s\n    }', event, format_timestamp(timestamp_ms), entry_data:gsub("\n", "\n"))
    final_log_file:write(entry)
    final_log_file:flush()
end

function script_tick(seconds)
    if not recording_active then return end
    local now = os.clock() * 1000
    if now < last_poll_time + poll_rate_ms then return end
    last_poll_time = now
    
    local file = io.open(status_file_path, "r")
    if not file then return end
    local content = file:read("*a")
    file:close()
    if content == "" then return end
    
    local track_id = parse_kv(content, "track_id")
    local is_playing = parse_kv(content, "is_playing")
    local progress_ms = parse_kv(content, "progress_ms")
    
    if track_id == nil or is_playing == nil or progress_ms == nil then return end
    
    if track_id ~= last_track_id then
        log("New Track: " .. track_id)
        local data = { 
            title = parse_kv(content, "title"), 
            artist = parse_kv(content, "artist"),
            duration_ms = parse_kv(content, "duration_ms"),
            progress_ms = progress_ms
        }
        if track_id ~= "none" then
            write_event("PLAY", data)
            if not is_playing then write_event("PAUSE") end
        elseif last_is_playing then
            write_event("PAUSE")
        end
        last_track_id = track_id
        last_is_playing = is_playing
        last_progress_ms = progress_ms
    elseif is_playing ~= last_is_playing then
        log("Status Change: Playing=" .. tostring(is_playing))
        if last_track_id ~= "none" then
            if is_playing then write_event("RESUME") else write_event("PAUSE") end
        end
        last_is_playing = is_playing
    elseif is_playing and math.abs(progress_ms - last_progress_ms) > 2000 then
        log("Scrub Detected. New Position: " .. progress_ms)
        local data = { progress_ms = progress_ms }
        write_event("SEEK", data)
    end
    last_progress_ms = is_playing and progress_ms or last_progress_ms
end

function on_event(event)
    if event == obs.OBS_FRONTEND_EVENT_RECORDING_STARTED or event == obs.OBS_FRONTEND_EVENT_STREAMING_STARTED then
        if recording_active then return end
        
        local check_file = io.open(status_file_path, "r")
        if not check_file then
            log("ERROR: Could not find vod_sync_data.json in AppData/Local/Temp. Is spotify_watcher.exe running?")
            return
        end
        check_file:close()

        recording_active = true
        log("Recording started.")
        os.execute('mkdir "' .. log_dir .. '"')
        local t = os.date("*t")
        local filename = string.format("%d-%02d-%02d_%02d-%02d-%02d.json", t.year, t.month, t.day, t.hour, t.min, t.sec)
        final_log_file = io.open(log_dir .. filename, "w")
        if final_log_file then
            local start_time_utc = os.date("!%Y-%m-%dT%H:%M:%SZ")
            local init_content = string.format('{\n    "metadata": {\n        "start_time_utc": "%s"\n    },\n    "log": [\n        {\n            "event": "START",\n            "timestamp": "00:00:00"\n        }', start_time_utc)
            final_log_file:write(init_content)
            final_log_file:flush()
        end
    elseif event == obs.OBS_FRONTEND_EVENT_RECORDING_STOPPED or event == obs.OBS_FRONTEND_EVENT_STREAMING_STOPPED then
        if not obs.obs_frontend_recording_active() and not obs.obs_frontend_streaming_active() then
            if not recording_active then return end
            recording_active = false
            log("Recording stopped.")
            if final_log_file then
                final_log_file:write('\n    ]\n}')
                final_log_file:close()
                final_log_file = nil
                last_track_id, last_is_playing, last_progress_ms = "INIT", false, 0
            end
        end
    end
end

function script_load(settings) obs.obs_frontend_add_event_callback(on_event); script_update(settings) end
function script_unload() if final_log_file then final_log_file:write('\n    ]\n}'); final_log_file:close(); end end