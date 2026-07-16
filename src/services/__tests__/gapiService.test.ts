import { describe, it, expect, vi, beforeEach } from 'vitest';

// Each test calls vi.resetModules() so the module-level vars
// (gapiClientPromise, isGapiLoaded) are fresh for every case.

// Helper — creates fresh module imports after resetting the module registry.
async function freshModule() {
  vi.resetModules();
  return import('../gapiService');
}

// Helper — installs a fully working fake window.gapi so initGapiClient can resolve.
function installMockGapi() {
  const mockSetToken = vi.fn();
  const mockInit     = vi.fn().mockResolvedValue(undefined);
  const mockLoad     = vi.fn().mockImplementation((_mod: string, cb: () => void) => cb());

  window.gapi = {
    load: mockLoad,
    client: {
      init: mockInit,
      setToken: mockSetToken,
    },
    config: { update: vi.fn() },
  };

  return { mockSetToken, mockInit, mockLoad };
}

// Helper — makes the script tag's onload fire synchronously.
function patchAppendChild() {
  vi.spyOn(document.body, 'appendChild').mockImplementation((node: Node) => {
    const script = node as HTMLScriptElement;
    // Fire onload on the next microtask tick so the Promise chain can proceed.
    Promise.resolve().then(() => {
      if (typeof script.onload === 'function') {
        (script.onload as EventListener)(new Event('load'));
      }
    });
    return node;
  });
}

beforeEach(() => {
  // Restore spies (e.g. document.body.appendChild) between tests so they don't leak.
  vi.restoreAllMocks();
  // Remove any leftover <script> tags from prior test runs.
  document.querySelectorAll('script[src="https://apis.google.com/js/api.js"]').forEach(s => s.remove());
});

describe('getGapiClient', () => {
  it('throws when called before initGapiClient', async () => {
    const { getGapiClient } = await freshModule();
    await expect(getGapiClient()).rejects.toThrow('GAPI client has not been initialized');
  });
});

describe('initGapiClient', () => {
  it('resolves and exposes gapi.client on success', async () => {
    const { mockSetToken } = installMockGapi();
    patchAppendChild();

    const { initGapiClient, getGapiClient } = await freshModule();

    await initGapiClient('access-token-1');
    expect(mockSetToken).toHaveBeenCalledWith({ access_token: 'access-token-1' });

    const client = await getGapiClient();
    expect(client).toBe(window.gapi.client);
  });

  it('second call skips reload and just sets token', async () => {
    const { mockSetToken, mockLoad } = installMockGapi();
    patchAppendChild();

    const { initGapiClient } = await freshModule();

    await initGapiClient('token-first');
    await initGapiClient('token-second');

    // gapi.load should have been called only once (during the first init)
    expect(mockLoad).toHaveBeenCalledTimes(1);
    // setToken should have been called twice (once per initGapiClient call)
    expect(mockSetToken).toHaveBeenNthCalledWith(1, { access_token: 'token-first' });
    expect(mockSetToken).toHaveBeenNthCalledWith(2, { access_token: 'token-second' });
  });

  it('rejects and resets gapiClientPromise when gapi.client.init throws', async () => {
    installMockGapi();
    window.gapi.client.init = vi.fn().mockRejectedValue(new Error('init failed'));
    patchAppendChild();

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { initGapiClient, getGapiClient } = await freshModule();

    await expect(initGapiClient('token')).rejects.toThrow('init failed');

    // After failure the promise is reset, so getGapiClient should throw the
    // "not initialized" error (not the init error).
    await expect(getGapiClient()).rejects.toThrow('GAPI client has not been initialized');

    consoleSpy.mockRestore();
  });

  it('rejects when script load fails', async () => {
    installMockGapi();

    vi.spyOn(document.body, 'appendChild').mockImplementation((node: Node) => {
      const script = node as HTMLScriptElement;
      Promise.resolve().then(() => {
        if (typeof script.onerror === 'function') {
          (script.onerror as EventListener)(new Event('error'));
        }
      });
      return node;
    });

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { initGapiClient } = await freshModule();

    await expect(initGapiClient('token')).rejects.toThrow('Failed to load gapi script.');
    consoleSpy.mockRestore();
  });

  it('reuses existing script element if already in DOM', async () => {
    const { mockSetToken } = installMockGapi();

    // Pre-insert a fake script element
    const existing = document.createElement('script');
    existing.src = 'https://apis.google.com/js/api.js';
    document.body.appendChild(existing);

    const { initGapiClient } = await freshModule();

    // Schedule the 'load' event as a macrotask AFTER initGapiClient has
    // attached its listener (which happens synchronously inside the Promise
    // constructor). The `await initGapiClient(...)` suspends this coroutine
    // so the event loop can process the setTimeout callback.
    setTimeout(() => existing.dispatchEvent(new Event('load')), 10);

    await initGapiClient('reuse-token');
    expect(mockSetToken).toHaveBeenCalledWith({ access_token: 'reuse-token' });
  });

  it('resolves immediately if script already loaded (readyState complete)', async () => {
    const { mockSetToken } = installMockGapi();

    const existing = document.createElement('script');
    existing.src = 'https://apis.google.com/js/api.js';
    Object.defineProperty(existing, 'readyState', {
      value: 'complete',
      writable: true,
    });
    document.body.appendChild(existing);

    const { initGapiClient } = await freshModule();

    await initGapiClient('readyState-token');
    expect(mockSetToken).toHaveBeenCalledWith({ access_token: 'readyState-token' });
  });
});
