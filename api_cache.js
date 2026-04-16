const memoryCache = new Map();
const pendingRequests = new Map();

(() => {
  if (window.__digitalFarmFetchCacheInstalled) {
    return;
  }
  window.__digitalFarmFetchCacheInstalled = true;

  const CACHE_PREFIX = 'digitalFarmFetchCache::';
  const API_HOSTS = new Set(['localhost', '127.0.0.1', 'digitalfarm-backend.onrender.com']);
  const WEATHER_HOSTS = new Set(['api.open-meteo.com', 'geocoding-api.open-meteo.com']);
  const LOCAL_API_BASE = 'http://localhost:5000/api/v1';
  const RENDER_API_BASE = 'https://digitalfarm-backend.onrender.com/api/v1';
  const SAME_ORIGIN_API_BASE = `${window.location.origin}/api/v1`;

  function hasApiOnSameOrigin() {
    const host = window.location.hostname;
    const port = window.location.port;

    if (!host) {
      return false;
    }

    if ((host === 'localhost' || host === '127.0.0.1') && port === '5000') {
      return true;
    }

    return host.endsWith('.onrender.com');
  }

  function isLocalFrontend() {
    const host = window.location.hostname;
    return !host || host === 'localhost' || host === '127.0.0.1';
  }

  function getApiBaseUrl() {
    if (hasApiOnSameOrigin()) {
      return SAME_ORIGIN_API_BASE;
    }

    return isLocalFrontend() ? LOCAL_API_BASE : RENDER_API_BASE;
  }

  const ACTIVE_API_BASE = getApiBaseUrl();

  function stripApiBase(pathname) {
    return pathname.startsWith('/api/v1')
      ? pathname.slice('/api/v1'.length)
      : pathname;
  }

  function buildApiUrl(pathname, search = '') {
    return `${ACTIVE_API_BASE}${stripApiBase(pathname)}${search}`;
  }

  window.__DIGITAL_FARM_API_BASE = ACTIVE_API_BASE;
  window.digitalFarmApi = (path = '') => buildApiUrl(path.startsWith('/') ? path : `/${path}`);

  function rewriteLocalApiUrl(url) {
    try {
      const parsed = new URL(url, window.location.href);
      if (parsed.pathname.startsWith('/api/v1/')) {
        const isKnownApiOrigin =
          parsed.origin === window.location.origin ||
          parsed.origin === 'http://localhost:5000' ||
          parsed.origin === 'https://digitalfarm-backend.onrender.com';

        if (isKnownApiOrigin) {
          return buildApiUrl(parsed.pathname, parsed.search);
        }
      }
    } catch (error) {
      // Ignore parse errors and keep original URL
    }
    return url;
  }

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
        (API_HOSTS.has(parsed.hostname) || parsed.origin === window.location.origin) &&
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

  async function fetchWithFallback(inputValue, initValue, requestedUrl) {
    try {
      return await originalFetch(inputValue, initValue);
    } catch (error) {
      if (
        typeof requestedUrl === 'string' &&
        requestedUrl.startsWith(LOCAL_API_BASE) &&
        isLocalFrontend()
      ) {
        const fallbackUrl = requestedUrl.replace(LOCAL_API_BASE, RENDER_API_BASE);
        const fallbackInput = typeof inputValue === 'string'
          ? fallbackUrl
          : new Request(fallbackUrl, inputValue);
        return await originalFetch(fallbackInput, initValue);
      }
      throw error;
    }
  }

  window.fetch = async (input, init = {}) => {
    let requestUrl = typeof input === 'string' ? input : input.url;
    const effectiveUrl = rewriteLocalApiUrl(requestUrl);
    let effectiveInput = input;

    if (typeof input === 'string') {
      effectiveInput = effectiveUrl;
    } else if (effectiveUrl !== requestUrl) {
      effectiveInput = new Request(effectiveUrl, input);
    }

    const method = String(
      init.method || (typeof input !== 'string' ? input.method : 'GET') || 'GET'
    ).toUpperCase();
    const { authScope } = normalizeHeaders(
      init.headers || (typeof input !== 'string' ? input.headers : undefined)
    );

    if (isCacheableGet(effectiveUrl, method)) {
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

      const fetchPromise = fetchWithFallback(effectiveInput, init, effectiveUrl)
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

    const response = await fetchWithFallback(effectiveInput, init, effectiveUrl);

    if (response.ok) {
      try {
        const parsed = new URL(effectiveUrl, window.location.href);
        if (
          (API_HOSTS.has(parsed.hostname) || parsed.origin === window.location.origin) &&
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
