// notifications-idb.js
// IndexedDB helpers for cached notifications and comments.

const CACHE_DB_NAME = 'ghnotif_cache';
const CACHE_DB_VERSION = 1;
const NOTIFICATIONS_STORE = 'notifications';
const COMMENT_CACHE_STORE = 'commentCache';
const CACHE_KEY = 'cache';

let cacheDbPromise = null;

function openCacheDb() {
    if (!('indexedDB' in window)) {
        return Promise.reject(new Error('IndexedDB is not available'));
    }
    if (cacheDbPromise) {
        return cacheDbPromise;
    }
    cacheDbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(CACHE_DB_NAME, CACHE_DB_VERSION);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(NOTIFICATIONS_STORE)) {
                db.createObjectStore(NOTIFICATIONS_STORE);
            }
            if (!db.objectStoreNames.contains(COMMENT_CACHE_STORE)) {
                db.createObjectStore(COMMENT_CACHE_STORE);
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('Failed to open IndexedDB'));
    });
    return cacheDbPromise;
}

function withStore(storeName, mode, action) {
    return openCacheDb().then(
        (db) =>
            new Promise((resolve, reject) => {
                const transaction = db.transaction(storeName, mode);
                const store = transaction.objectStore(storeName);
                let request = null;
                try {
                    request = action(store);
                } catch (error) {
                    reject(error);
                    return;
                }
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
                transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction aborted'));
            })
    );
}

function idbGetValue(storeName, key) {
    return withStore(storeName, 'readonly', (store) => store.get(key));
}

function idbSetValue(storeName, key, value) {
    return withStore(storeName, 'readwrite', (store) => store.put(value, key));
}

function idbDeleteValue(storeName, key) {
    return withStore(storeName, 'readwrite', (store) => store.delete(key));
}

function loadNotificationsCache() {
    return idbGetValue(NOTIFICATIONS_STORE, CACHE_KEY);
}

function saveNotificationsCache(notifications) {
    return idbSetValue(NOTIFICATIONS_STORE, CACHE_KEY, notifications);
}

function clearNotificationsCache() {
    return idbDeleteValue(NOTIFICATIONS_STORE, CACHE_KEY);
}

function loadCommentCacheStorage() {
    return idbGetValue(COMMENT_CACHE_STORE, CACHE_KEY);
}

function saveCommentCacheStorage(cache) {
    return idbSetValue(COMMENT_CACHE_STORE, CACHE_KEY, cache);
}

function clearCommentCacheStorage() {
    return idbDeleteValue(COMMENT_CACHE_STORE, CACHE_KEY);
}
