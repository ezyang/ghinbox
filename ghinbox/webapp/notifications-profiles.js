// Profile model decisions: default profiles, saved-profile merging with
// legacy-repo migration, profile entry classification, and the signature /
// cache-key / storage-value derivations. DOM-free; Node tests import this.
(function (root, factory) {
    let identity = root.GhinboxNotificationIdentity;
    if (!identity && typeof require === 'function') {
        identity = require('./notifications-identity.js');
    }
    const api = factory(identity);
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    root.GhinboxProfiles = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (identity) {
    const DEFAULT_PROFILE_ID = 'pytorch';
    const PYTORCH_ORG_QUERIES = [
        'org:pytorch',
        'org:meta-pytorch',
        'org:google-pytorch',
    ];
    const EVERYTHING_ELSE_QUERY =
        '-org:pytorch -org:meta-pytorch -org:google-pytorch';
    const DEFAULT_PROFILES = [
        {
            id: 'pytorch',
            name: 'All notifications',
            entries: [...PYTORCH_ORG_QUERIES, EVERYTHING_ELSE_QUERY],
            system: true,
        },
        {
            id: 'everything-else',
            name: 'Everything else',
            entries: [EVERYTHING_ELSE_QUERY],
            system: true,
        },
        {
            id: 'custom',
            name: 'Custom',
            entries: ['pytorch/pytorch'],
            system: false,
        },
    ];

    function splitProfileEntries(value) {
        return String(value || '')
            .split(/[\n,]+/)
            .map((entry) => entry.trim())
            .filter(Boolean);
    }

    function normalizeProfile(profile, fallback) {
        const base = fallback || {};
        const id = String(profile?.id || base.id || '').trim();
        const name = String(profile?.name || base.name || id).trim();
        const entries = Array.isArray(profile?.entries)
            ? profile.entries.map((entry) => String(entry || '').trim()).filter(Boolean)
            : Array.isArray(base.entries)
                ? base.entries.slice()
                : [];
        if (!id || !name) {
            return null;
        }
        return {
            id,
            name,
            entries,
            system: Boolean(profile?.system ?? base.system),
        };
    }

    function buildProfiles(saved, legacyRepo) {
        const defaults = DEFAULT_PROFILES.map((profile) => ({
            ...profile,
            entries: profile.entries.slice(),
        }));
        const byId = new Map(defaults.map((profile) => [profile.id, profile]));
        if (Array.isArray(saved)) {
            saved.forEach((profile) => {
                const fallback = byId.get(String(profile?.id || ''));
                // Built-in query scopes are policy, not user configuration.
                if (!fallback || fallback.system) {
                    return;
                }
                const normalized = normalizeProfile(profile, fallback);
                if (normalized) {
                    byId.set(normalized.id, normalized);
                }
            });
        }

        const trimmedLegacy = String(legacyRepo || '').trim();
        const custom = byId.get('custom');
        if (trimmedLegacy && custom && custom.entries.join('\n') === 'pytorch/pytorch') {
            custom.entries = splitProfileEntries(trimmedLegacy);
        }

        return DEFAULT_PROFILES.map((profile) => byId.get(profile.id)).filter(Boolean);
    }

    function resolveInitialProfileId(profiles, savedProfileId, legacyRepo) {
        if (profiles.some((profile) => profile.id === savedProfileId)) {
            return savedProfileId;
        }
        return String(legacyRepo || '').trim() ? 'custom' : DEFAULT_PROFILE_ID;
    }

    function classifyProfileEntry(entry) {
        const value = String(entry || '').trim();
        const repo = identity.parseRepoInput(value);
        if (repo) {
            return {
                kind: 'repo',
                value,
                owner: repo.owner,
                repo: repo.repo,
                fullName: `${repo.owner}/${repo.repo}`,
                query: `repo:${repo.owner}/${repo.repo}`,
            };
        }
        const repoQuery = value.match(/^repo:([^/\s]+)\/([^/\s]+)$/);
        if (repoQuery) {
            return {
                kind: 'repo',
                value,
                owner: repoQuery[1],
                repo: repoQuery[2],
                fullName: `${repoQuery[1]}/${repoQuery[2]}`,
                query: value,
            };
        }
        if (!value.includes(':') && !value.includes(' ') && !value.startsWith('-')) {
            return {
                kind: 'invalid',
                value,
                query: value,
            };
        }
        return {
            kind: 'query',
            value,
            query: value,
        };
    }

    function getProfileEntriesText(profile) {
        return (profile?.entries || []).join('\n');
    }

    function getProfileSignature(profile) {
        const id = profile?.id || 'unknown';
        return `${id}:${getProfileEntriesText(profile)}`;
    }

    function getNotificationsCacheKey(profile) {
        return `profile:${getProfileSignature(profile)}`;
    }

    function getProfileEntriesStorageValue(entries) {
        return entries.length === 1 ? entries[0] : entries.join('\n');
    }

    return {
        DEFAULT_PROFILE_ID,
        DEFAULT_PROFILES,
        buildProfiles,
        classifyProfileEntry,
        getNotificationsCacheKey,
        getProfileEntriesStorageValue,
        getProfileEntriesText,
        getProfileSignature,
        normalizeProfile,
        resolveInitialProfileId,
        splitProfileEntries,
    };
});
