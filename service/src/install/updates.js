'use strict';

// What is installed is free; what has been released costs a request per app, so it waits to be asked.

const sources = require('./sources.js');
const versions = require('./versions.js');
const { took } = require('../obs/units.js');

const CACHE_TTL = 6 * 60 * 60 * 1000;

// Short, because being wrong shows an install button beside an app installed a moment ago.
const INSTALLED_TTL = 60 * 1000;

const SLOW_LIST = 1000;

// Has to be truthy: one field answers both "is it installed" and "at which version".
const UNKNOWN_VERSION = '?';

const AT_ONCE = 3;

const quiet = { info: () => {}, ok: () => {}, warn: () => {}, err: () => {}, debug: () => {} };

// A collection's entries come from one release listing the library already holds, so they are never
// asked about one at a time.
const askable = (entry) => entry.source.type === 'github' && !entry.collection;

// Both sides readable as versions, so their order means something.
const comparable = (left, right) => Boolean(versions.parse(left) && versions.parse(right));

// `packages` and the GitHub lookup are handed in so this can be exercised off a television.
const createUpdates = ({ packages, log, config, appIcons = null, latestRelease = sources.latestRelease }) => {
    const say = log ? log.on('cat') : quiet;

    // repo -> { version, at }. A remembered null is "asked, told nothing", not "never asked".
    const remembered = {};

    const fresh = (repo) => {
        const known = remembered[repo];
        return known && Date.now() - known.at < CACHE_TTL ? known : null;
    };

    // Package id -> where the set says its icon is, from the same listing.
    const iconPaths = {};

    // The phone's picture for an installed app: the one this service kept, or one read off the set now.
    const iconFor = (packageId, fallback) => {
        if (!appIcons || !packageId) return fallback || null;
        if (!appIcons.has(packageId)) appIcons.fromTv(packageId, iconPaths[packageId]);
        return appIcons.urlOf(packageId) || fallback || null;
    };

    // Package id -> installed version, kept because getPackagesInfo takes six seconds on a full set.
    let holding = null;

        let asking = null;

        let generation = 0;

    const askTheSet = () => {
        if (asking) return asking;

        const era = generation;
        const began = Date.now();

        // Logged before the call: getPackagesInfo has been seen to never come back on Tizen 9.
        say.info('asking the television what it is holding');

        asking = packages.list({ say }).then(
            (list) => {
                asking = null;

                const map = list.reduce((byId, entry) => {
                    byId[entry.id] = entry.version || UNKNOWN_VERSION;
                    return byId;
                }, {});

                list.forEach((entry) => { if (entry.iconPath) iconPaths[entry.id] = entry.iconPath; });

                // Icons of apps no longer on the set go with them.
                if (appIcons && list.length) appIcons.prune(list.map((entry) => entry.id));

                // Fills in versions this service wrote down itself; only ever overwrites a `?`.
                (config ? config.read().lastInstalled || [] : []).forEach((seen) => {
                    if (seen.version && map[seen.packageId] === UNKNOWN_VERSION) {
                        map[seen.packageId] = seen.version;
                    }
                });

                const elapsed = Date.now() - began;

                say[elapsed >= SLOW_LIST ? 'info' : 'debug'](
                    `${list.length} packages installed, listed in ${took(elapsed)}`);

                holding = { map, at: era === generation ? Date.now() : 0 };

                return map;
            },
            (error) => {
                asking = null;

                // Off a television nothing is installed, which is the development harness rather than a fault.
                if (error.code !== 'notOnTv') say.warn(`could not list what is installed: ${error.message}`);

                return holding ? holding.map : {};
            }
        );

        return asking;
    };

    const installedNow = async () => {
        if (!holding) return askTheSet();

        if (Date.now() - holding.at >= INSTALLED_TTL) askTheSet();

        return holding.map;
    };

    const prime = () => {
        askTheSet();
    };

    // Stamped stale rather than dropped, so the next read is served immediately and refreshes behind it.
    const changed = () => {
        generation += 1;
        if (holding) holding = { map: holding.map, at: 0 };
        askTheSet();
    };

    // What this service itself put on the television, by catalog entry: the package id a collection
    // entry cannot know before its first install, and the sha256 of the file it came from.
    const learned = () => (config ? config.read().installedFrom || {} : {});

    // Installed by 0.3.x, before origins were kept: its list entry's record still says which list it was.
    const recalled = (entry, memo, packageId) => (memo && memo.packageId === packageId ? {
        source: 'catalog', entry: entry.id, repository: entry.repository || 'official',
        repo: entry.source && entry.source.type === 'github' ? entry.source.ref : null,
        asset: entry.collection ? entry.source.asset : null,
        verified: false, at: memo.at || null, recalled: true
    } : null);

    // An origin describes the copy it installed. One the TV now holds at another version came some other way
    // since — the laptop, the store — so its file, date and checksum no longer describe what is there.
    const asHeld = (origin, installedVersion) => {
        if (!origin) return null;
        if (origin.version && installedVersion && installedVersion !== UNKNOWN_VERSION && origin.version !== installedVersion) {
            return { ...origin, verified: false, replaced: true };
        }
        return origin;
    };

    const originsKept = () => (config ? config.read().origins || {} : {});

    // `checked` separates "not asked yet" from "asked, and there are no releases".
    //
    // `update` is a newer version, or — when there is no version to compare, as with a collection file
    // named Bravo.wgt — a file whose sha256 is not the one installed. `rebuilt` is the quieter case of a
    // different file at the same version: offered, but not counted as an update.
    const mark = async (entries) => {
        const installed = await installedNow();
        const memory = learned();
        const origins = originsKept();

        return entries.map((entry) => {
            const memo = memory[entry.id] || null;
            const packageId = entry.packageId || (memo && memo.packageId) || null;
            const current = packageId ? installed[packageId] || null : null;

            const known = askable(entry) ? fresh(entry.source.ref) : { version: entry.version };
            const available = known ? known.version : null;

            // The very file installed is never its own update — a file named App-1.0.46.wgt whose config.xml
            // says 1.0.0 would otherwise be reinstalled every day.
            const same = Boolean(current && memo && memo.sha256 && entry.sha256 && memo.sha256 === entry.sha256 &&
                (!memo.version || memo.version === current));

            const newer = !same && versions.isNewer(available, current);
            const differs = Boolean(current && memo && memo.sha256 && entry.sha256 && memo.sha256 !== entry.sha256 &&
                (!memo.version || memo.version === current));
            const ordered = comparable(available, current);

            const update = newer || (differs && !ordered);

            return {
                ...entry,
                packageId,
                version: available || entry.version,
                installed: current,
                origin: current && packageId ? asHeld(origins[packageId], current) || recalled(entry, memo, packageId) : null,
                icon: current ? iconFor(packageId, entry.icon) : entry.icon || null,
                available,
                checked: Boolean(known),
                update,
                rebuilt: Boolean(differs && ordered && !newer && versions.compare(available, current) === 0)
            };
        });
    };

    const ask = async (repo) => {
        const found = await (async () => {
            try {
                const release = await latestRelease(repo);
                const version = versions.clean(release.tag_name);

                if (version) say.info(`${repo} has released ${version}`);
                else say.warn(`${repo}'s newest release is tagged ${release.tag_name || '(untagged)'}, which is not a version`);

                return version;
            } catch (error) {
                say.warn(`could not ask github about ${repo}: ${error.message}`);

                // A television that has spent its hour will not do better on the next forty repositories.
                if (error.status === 403 || error.status === 429) throw error;

                return null;
            }
        })();

        remembered[repo] = { version: found, at: Date.now() };
    };

    // `id` re-asks one entry even when the answer is in hand; without one, everything stale.
    const check = async (entries, { id = null } = {}) => {
        const wanted = entries.filter((entry) => askable(entry) &&
            (id ? entry.id === id : !fresh(entry.source.ref)));

        if (!wanted.length) return mark(entries);

        say.info(`checking ${wanted.length === 1 ? wanted[0].name : `${wanted.length} apps`} for a newer release`);

        const queue = wanted.slice();
        let stopped = null;

        const worker = async () => {
            while (queue.length && !stopped) {
                const entry = queue.shift();

                try {
                    await ask(entry.source.ref);
                } catch (error) {
                    stopped = error;
                }
            }
        };

        await Promise.all(new Array(Math.min(AT_ONCE, queue.length)).fill(null).map(worker));

        if (stopped) {
            say.warn(`stopped checking: github refused (${stopped.message}). ` +
                'It allows sixty requests an hour to a television nobody has signed in from.');
        }

        const marked = await mark(entries);

        marked.filter((entry) => entry.update).forEach((entry) => say.ok(
            `${entry.name} ${entry.installed} is installed and ${entry.available} is out`));

        return marked;
    };

    // Apps this service installed that no list names — an upload, a URL, the GitHub tab, a USB stick — and
    // that are still on the television, so the phone can show them with the rest of what is installed.
    const others = async (entries) => {
        const installed = await installedNow();
        const memory = learned();
        const origins = originsKept();

        const listed = {};
        entries.forEach((entry) => {
            const packageId = entry.packageId || (memory[entry.id] && memory[entry.id].packageId);
            if (packageId) listed[packageId] = true;
        });

        return Object.keys(origins)
            .filter((packageId) => !listed[packageId] && installed[packageId])
            .map((packageId) => ({
                id: `installed-${packageId}`,
                packageId,
                name: origins[packageId].name || packageId,
                installed: installed[packageId] === UNKNOWN_VERSION ? origins[packageId].version || installed[packageId] : installed[packageId],
                origin: asHeld(origins[packageId], installed[packageId]),
                icon: iconFor(packageId, null),
                unlisted: true,
                source: { type: origins[packageId].source || 'upload', ref: origins[packageId].repo || origins[packageId].host || null }
            }));
    };

    return { mark, check, others, prime, changed };
};

module.exports = { createUpdates, CACHE_TTL, AT_ONCE, INSTALLED_TTL };
