const memoryCache = new Map();
const pendingRequests = new Map();

(() => {
  if (window.__digitalFarmFetchCacheInstalled) {
    return;
  }
  window.__digitalFarmFetchCacheInstalled = true;

  const CACHE_PREFIX = 'digitalFarmFetchCache::';
  const API_HOSTS = new Set(['localhost', '127.0.0.1']);
  const WEATHER_HOSTS = new Set(['api.open-meteo.com', 'geocoding-api.open-meteo.com']);
  const originalFetch = window.fetch.bind(window);

  function normalizeHeaders(headersLike) {
    const headers = new Headers(headersLike || {});
    const authHeader = headers.get('Authorization') || '';
    return {
      headers,
      authScope: authHeader ? `auth:${authHeader}` : 'public'
    };
  }

  function buildCacheKey(url, authScope) {
    return `${CACHE_PREFIX}${authScope}::${url}`;
  }

  function getTtlForUrl(url) {
    if (url.includes('/farm/profile') || url.includes('/farmers/profile')) {
      return 5 * 60 * 1000;
    }

    if (
      url.includes('/animals') ||
      url.includes('/vaccinations') ||
      url.includes('/complaints') ||
      url.includes('/ai/history') ||
      url.includes('/biosecurity/checklist')
    ) {
      return 45 * 1000;
    }

    if (url.includes('open-meteo.com')) {
      return 10 * 60 * 1000;
    }

    if (url.includes('/blogs') || url.includes('/feedback')) {
      return 60 * 1000;
    }

    return 2 * 60 * 1000;
  }

  function isCacheableGet(url, method) {
    if (method !== 'GET') {
      return false;
    }

    try {
      const parsed = new URL(url, window.location.href);
      const isLocalApi =
        API_HOSTS.has(parsed.hostname) &&
        parsed.port === '5000' &&
        parsed.pathname.startsWith('/api/v1/');
      const isWeatherApi = WEATHER_HOSTS.has(parsed.hostname);
      return isLocalApi || isWeatherApi;
    } catch (error) {
      return false;
    }
  }

  function readCachedResponse(cacheKey, ttlMs) {
    try {
      const raw = localStorage.getItem(cacheKey);
      if (!raw) return null;

      const entry = JSON.parse(raw);
      if (!entry || Date.now() - Number(entry.timestamp || 0) > ttlMs) {
        localStorage.removeItem(cacheKey);
        return null;
      }

      return new Response(entry.body, {
        status: entry.status || 200,
        statusText: entry.statusText || 'OK',
        headers: entry.headers || { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      localStorage.removeItem(cacheKey);
      return null;
    }
  }

  async function storeResponse(cacheKey, response) {
    const clone = response.clone();

    memoryCache.set(cacheKey, {
      timestamp: Date.now(),
      response: clone.clone()
    });

    try {
      const body = await clone.text();
      const headers = {};
      clone.headers.forEach((value, key) => {
        headers[key] = value;
      });

      localStorage.setItem(cacheKey, JSON.stringify({
        timestamp: Date.now(),
        status: clone.status,
        statusText: clone.statusText,
        headers,
        body
      }));
    } catch (error) {
      console.warn('Digital Farm cache store skipped:', error);
    }
  }

  function clearApiCache(authScope) {
    const prefix = `${CACHE_PREFIX}${authScope}::`;
    const keysToRemove = [];

    memoryCache.forEach((_, key) => {
      if (key.startsWith(prefix)) {
        memoryCache.delete(key);
      }
    });

    pendingRequests.forEach((_, key) => {
      if (key.startsWith(prefix)) {
        pendingRequests.delete(key);
      }
    });

    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key && key.startsWith(prefix)) {
        keysToRemove.push(key);
      }
    }

    keysToRemove.forEach((key) => localStorage.removeItem(key));
  }

  window.fetch = async (input, init = {}) => {
    const requestUrl = typeof input === 'string' ? input : input.url;
    const method = String(
      init.method || (typeof input !== 'string' ? input.method : 'GET') || 'GET'
    ).toUpperCase();
    const { authScope } = normalizeHeaders(
      init.headers || (typeof input !== 'string' ? input.headers : undefined)
    );

    if (isCacheableGet(requestUrl, method)) {
      const absoluteUrl = new URL(requestUrl, window.location.href).toString();
      const cacheKey = buildCacheKey(absoluteUrl, authScope);
      const ttlMs = getTtlForUrl(absoluteUrl);

      const memEntry = memoryCache.get(cacheKey);
      if (memEntry && Date.now() - memEntry.timestamp < ttlMs) {
        return memEntry.response.clone();
      }

      const cached = readCachedResponse(cacheKey, ttlMs);
      if (cached) {
        memoryCache.set(cacheKey, {
          timestamp: Date.now(),
          response: cached.clone()
        });
        return cached;
      }

      if (pendingRequests.has(cacheKey)) {
        const pendingResponse = await pendingRequests.get(cacheKey);
        return pendingResponse.clone();
      }

      const fetchPromise = originalFetch(input, init)
        .then(async (response) => {
          if (response.ok) {
            await storeResponse(cacheKey, response);
          }
          return response.clone();
        })
        .finally(() => {
          pendingRequests.delete(cacheKey);
        });

      pendingRequests.set(cacheKey, fetchPromise);
      const response = await fetchPromise;
      return response.clone();
    }

    const response = await originalFetch(input, init);

    if (response.ok) {
      try {
        const parsed = new URL(requestUrl, window.location.href);
        if (
          API_HOSTS.has(parsed.hostname) &&
          parsed.port === '5000' &&
          parsed.pathname.startsWith('/api/v1/')
        ) {
          clearApiCache(authScope);
        }
      } catch (error) {
        console.warn('Digital Farm cache invalidation skipped:', error);
      }
    }

    return response;
  };
})();
