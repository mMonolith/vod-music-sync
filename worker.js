const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Secret',
};

function jsonResponse(data, status = 200) {
    const body = typeof data === 'string' ? data : JSON.stringify(data);
    const headers = { ...corsHeaders, 'Content-Type': 'application/json' };
    return new Response(body, { status, headers });
}

function parseKvValue(value) {
    if (!value) return { logUrl: null, vodName: "" };
    try {
        return JSON.parse(value);
    } catch (e) {
        return { logUrl: value, vodName: "" };
    }
}

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);

        if (request.method === 'OPTIONS') {
            return new Response(null, { headers: corsHeaders });
        }
        
        const isAdminRequest = request.headers.get('X-Admin-Secret') === env.ADMIN_SECRET;

        if (isAdminRequest) {
            if (url.pathname === '/list' && request.method === 'GET') {
                const list = await env.VOD_SYNC.list();
                const vodKeys = list.keys.filter(key => key.name.startsWith('twitch:') || key.name.startsWith('youtube:'));
                
                const vodData = [];
                for (const key of vodKeys) {
                    const value = await env.VOD_SYNC.get(key.name);
                    const data = parseKvValue(value);
                    vodData.push({ key: key.name, ...data });
                }
                return jsonResponse(vodData);
            }

            if (request.method === 'POST') {
                if (url.pathname === '/upload') {
                    const logContent = await request.text();
                    const logId = crypto.randomUUID();
                    await env.VOD_SYNC.put(`log:${logId}`, logContent, { metadata: { uploaded: new Date().toISOString() } });
                    return jsonResponse({ logId });
                }

                if (url.pathname === '/submit') {
                    const { twitchId, youtubeId, logUrl, vodName } = await request.json();
                    if (!logUrl) return jsonResponse('Missing logUrl', 400);

                    const valueToStore = JSON.stringify({ logUrl, vodName: vodName || "" });
                    
                    const promises = [];
                    if (twitchId) promises.push(env.VOD_SYNC.put(`twitch:${twitchId}`, valueToStore));
                    if (youtubeId) promises.push(env.VOD_SYNC.put(`youtube:${youtubeId}`, valueToStore));

                    if (promises.length === 0) return jsonResponse('No VOD IDs provided', 400);
                    await Promise.all(promises);
                    return jsonResponse('VODs linked/updated successfully');
                }

                if (url.pathname === '/delete') {
                    const { keysToDelete } = await request.json();
                    if (!keysToDelete || !Array.isArray(keysToDelete)) return jsonResponse('Invalid request body', 400);
                    const promises = keysToDelete.map(key => env.VOD_SYNC.delete(key));
                    await Promise.all(promises);
                    return jsonResponse('VOD links deleted');
                }
            }
        }

        if (url.pathname.startsWith('/logs/')) {
            const logId = url.pathname.split('/')[2];
            const logContent = await env.VOD_SYNC.get(`log:${logId}`);
            if (logContent === null) return jsonResponse('Log Not Found', 404);
            return new Response(logContent, { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }

        if (url.pathname === '/lookup') {
            const platform = url.searchParams.get('platform');
            const vodId = url.searchParams.get('id');
            if (!platform || !vodId) return jsonResponse('Missing platform or id', 400);
            
            const value = await env.VOD_SYNC.get(`${platform}:${vodId}`);
            if (value === null) return jsonResponse('Not Found', 404);
            
            return jsonResponse(parseKvValue(value));
        }
        
        return jsonResponse('Not Found', 404);
    },
};