const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const HTML_PATH = path.resolve(__dirname, '../../ghinbox/webapp/notifications.html');

function extractAssetScript() {
  const html = fs.readFileSync(HTML_PATH, 'utf8');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  const assetScript = scripts.find((match) => match[1].includes('const ASSET_VERSION ='));
  assert.ok(assetScript, 'notifications.html should contain the asset-version head script');
  return assetScript[1];
}

function runAssetScript({ search = '', storedValue = null } = {}) {
  const writes = [];
  const storageOps = [];
  const sandbox = {
    document: {
      write: (html) => writes.push(html),
    },
    localStorage: {
      getItem: (key) => {
        storageOps.push({ op: 'get', key });
        return storedValue;
      },
      setItem: (key, value) => {
        storageOps.push({ op: 'set', key, value });
      },
      removeItem: (key) => {
        storageOps.push({ op: 'remove', key });
      },
    },
    location: { search },
    URLSearchParams,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(extractAssetScript(), sandbox);

  return {
    api: sandbox.GhinboxAssetVersion,
    assetBust: sandbox.ghnotifAssetBust,
    assetVersion: sandbox.ghnotifAssetVersion,
    storageOps,
    writes,
  };
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test('resolveAssetBust falls back to ASSET_VERSION without force-refresh state', () => {
  const { api } = runAssetScript();

  assert.deepEqual(
    plain(api.resolveAssetBust({
      explicitValue: null,
      storedValue: null,
      assetVersion: 'deploy-2',
    })),
    {
      cacheBust: 'deploy-2',
      storageValue: null,
      clearStored: false,
    }
  );
});

test('resolveAssetBust keeps a force-refresh bust only for the same deploy', () => {
  const { api } = runAssetScript();
  const storedValue = api.serializeCacheBust('deploy-2', 'force-refresh-1');

  assert.deepEqual(
    plain(api.resolveAssetBust({
      explicitValue: null,
      storedValue,
      assetVersion: 'deploy-2',
    })),
    {
      cacheBust: 'force-refresh-1',
      storageValue: null,
      clearStored: false,
    }
  );
});

test('resolveAssetBust discards legacy and older-deploy cache-bust values', () => {
  const { api } = runAssetScript();

  assert.deepEqual(
    plain(api.resolveAssetBust({
      explicitValue: null,
      storedValue: 'legacy-plain-string',
      assetVersion: 'deploy-2',
    })),
    {
      cacheBust: 'deploy-2',
      storageValue: null,
      clearStored: true,
    }
  );

  assert.deepEqual(
    plain(api.resolveAssetBust({
      explicitValue: null,
      storedValue: api.serializeCacheBust('deploy-1', 'force-refresh-1'),
      assetVersion: 'deploy-2',
    })),
    {
      cacheBust: 'deploy-2',
      storageValue: null,
      clearStored: true,
    }
  );

  assert.deepEqual(
    plain(api.resolveAssetBust({
      explicitValue: api.serializeCacheBust('deploy-1', 'force-refresh-url'),
      storedValue: api.serializeCacheBust('deploy-1', 'force-refresh-storage'),
      assetVersion: 'deploy-2',
    })),
    {
      cacheBust: 'deploy-2',
      storageValue: null,
      clearStored: true,
    }
  );
});

test('resolveAssetBust persists a current explicit force-refresh payload', () => {
  const { api } = runAssetScript();
  const explicitValue = api.serializeCacheBust('deploy-2', 'force-refresh-2');

  assert.deepEqual(
    plain(api.resolveAssetBust({
      explicitValue,
      storedValue: null,
      assetVersion: 'deploy-2',
    })),
    {
      cacheBust: 'force-refresh-2',
      storageValue: explicitValue,
      clearStored: false,
    }
  );
});

test('resolveAssetBust ignores stale explicit values instead of shadowing current storage', () => {
  const { api } = runAssetScript();

  assert.deepEqual(
    plain(api.resolveAssetBust({
      explicitValue: 'legacy-plain-string',
      storedValue: api.serializeCacheBust('deploy-2', 'force-refresh-current'),
      assetVersion: 'deploy-2',
    })),
    {
      cacheBust: 'force-refresh-current',
      storageValue: null,
      clearStored: false,
    }
  );
});

test('head script clears stale stored payloads and loads the deployed version', () => {
  const staleStoredValue = JSON.stringify({
    version: 'deploy-1',
    bust: 'force-refresh-old',
  });
  const { assetBust, assetVersion, storageOps } = runAssetScript({
    storedValue: staleStoredValue,
  });

  assert.equal(assetBust, `?v=${encodeURIComponent(assetVersion)}`);
  assert.deepEqual(storageOps, [
    { op: 'get', key: 'ghnotif_cache_bust' },
    { op: 'remove', key: 'ghnotif_cache_bust' },
  ]);
});
