'use strict';

const { readFileSync, existsSync, statSync } = require('fs');

const { getJson, getBuffer } = require('../remote/fetch.js');
const { size } = require('../obs/units.js');

const MAX_PACKAGE = 200 * 1024 * 1024;
const USER_AGENT = 'TizenHomebrew/1.0';

const OWNER_REPO = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const PACKAGE_SUFFIX = /\.(wgt|tpk)$/i;
const SHA256 = /^[0-9a-f]{64}$/;

const rejected = (code, message) => Object.assign(new Error(message), { code });

const quiet = { info: () => {}, ok: () => {}, warn: () => {}, err: () => {}, debug: () => {} };
const reporter = (log) => (log ? log.on('pkg') : quiet);

const withinLimit = (archive, description) => {
    if (archive.length > MAX_PACKAGE) {
        throw rejected('tooLarge', `${description} is ${archive.length} bytes, over the ${MAX_PACKAGE} limit.`);
    }
    return archive;
};

// GitHub reports `sha256:<hex>` as an asset's digest (older uploads may have none); a catalog may state `sha256`.
const digestOf = (value) => {
    const hex = String(value || '').trim().toLowerCase().replace(/^sha256:/, '');
    return SHA256.test(hex) ? hex : null;
};

// `owner/repo`, or a github.com URL pasted from the browser (`…/owner/repo/releases`), down to `owner/repo`.
const repoOf = (reference) => {
    const typed = String(reference || '').trim();
    const linked = /^(https?:\/\/)?(www\.)?github\.com\//i.test(typed);

    const path = typed
        .replace(/^(https?:\/\/)?(www\.)?github\.com\//i, '')
        .replace(/[?#].*$/, '')
        .replace(/\/+$/, '');

    const parts = path.split('/');
    const candidate = (linked ? parts.slice(0, 2) : parts).join('/').replace(/\.git$/i, '');

    return OWNER_REPO.test(candidate) ? candidate : null;
};

// Unauthenticated, so a private repository looks like a missing one, and `releases/latest` skips drafts.
const latestRelease = async (reference, log) => {
    const repo = repoOf(reference);
    if (!repo) throw rejected('badMessage', `"${reference}" is not an owner/repo reference.`);

    reporter(log).info(`asking github for the latest release of ${repo}`);

    try {
        return await getJson(`https://api.github.com/repos/${repo}/releases/latest`, {
            headers: { 'user-agent': USER_AGENT, accept: 'application/vnd.github+json' },
            httpsOnly: true
        });
    } catch (error) {
        if (error.status === 404) {
            throw rejected('notFound', `${repo} has no published releases, or is private.`);
        }
        throw Object.assign(rejected('downloadFailed', error.message), { status: error.status });
    }
};

// A catalog's `asset` is a part of the name (`tizen-5.5`); a file picked from a release listing is the whole
// name, and `exact` says so — `Charlie.wgt` is also part of `Charlie-ForceGM.wgt`.
const pickAsset = (assets, wanted, exact = false) => (assets || []).find((candidate) =>
    PACKAGE_SUFFIX.test(candidate.name) &&
    (!wanted || (exact ? candidate.name === wanted : candidate.name.includes(wanted))));

// Every package file in a release, as the phone lists them to choose from.
const packagesIn = (release) => (release.assets || [])
    .filter((asset) => PACKAGE_SUFFIX.test(asset.name))
    .map((asset) => ({
        name: asset.name,
        size: asset.size || null,
        sha256: digestOf(asset.digest),
        url: asset.browser_download_url,
        updatedAt: asset.updated_at || null
    }));

const DOWNLOAD = { headers: { 'user-agent': USER_AGENT }, maxBytes: MAX_PACKAGE, httpsOnly: true, timeout: 30000 };

const download = async (url, description) => {
    try {
        return withinLimit(await getBuffer(url, DOWNLOAD), description);
    } catch (error) {
        if (error.code === 'tooLarge') throw rejected('tooLarge', `${description} is over the ${size(MAX_PACKAGE)} limit.`);
        if (error.code === 'badMessage') throw rejected('badMessage', error.message);
        throw Object.assign(rejected('downloadFailed', error.message), { status: error.status });
    }
};

const fromGitHub = async (repo, log, wanted = null, exact = false) => {
    const say = reporter(log);

    const release = await latestRelease(repo, log);

    const asset = pickAsset(release.assets, wanted, exact);

    if (!asset) {
        const offered = packagesIn(release).map((file) => file.name);

        throw rejected('notFound', `${release.tag_name || 'The latest release'} has no .wgt or .tpk asset` +
            `${wanted ? ` ${exact ? 'named' : 'matching'} "${wanted}"` : ''}` +
            `${offered.length ? ` (it has ${offered.join(', ')})` : ''}.`);
    }

    say.info(`release ${release.tag_name || '(untagged)'} carries ${asset.name}` +
        `${asset.size ? ` (${size(asset.size)})` : ''}`);
    say.info(`downloading ${asset.browser_download_url}`);

    const archive = await download(asset.browser_download_url, asset.name);

    return {
        archive,
        name: asset.name,
        expected: digestOf(asset.digest),
        origin: { type: 'github', repo: repoOf(repo), asset: asset.name, tag: release.tag_name || null }
    };
};

const fromUrl = async (url, log, expected = null) => {
    if (!url.startsWith('https://')) throw rejected('badMessage', 'Package URLs must use https.');

    reporter(log).info(`downloading ${url}`);

    const archive = await download(url, url.split('/').pop() || url);

    return { archive, name: url.split('/').pop(), expected: digestOf(expected), origin: { type: 'url', url } };
};

const fromFile = (path, log) => {
    // A package off a stick, and nothing else on the television's disk.
    if (!PACKAGE_SUFFIX.test(String(path))) throw rejected('badPackage', 'Only .wgt and .tpk files can be installed.');
    if (!existsSync(path)) throw rejected('notFound', `No file at ${path}.`);
    if (statSync(path).size > MAX_PACKAGE) throw rejected('badPackage', 'File is larger than the size limit.');

    reporter(log).info(`reading ${path} off the television's own disk`);

    return { archive: readFileSync(path), name: path.split('/').pop() };
};

const resolve = async ({ source, reference, asset = null, catalog = [], upload = null, log = null }) => {
    switch (source) {
        case 'upload':
            if (!upload || !upload.length) throw rejected('badPackage', 'No package body received.');
            reporter(log).info(`taking ${size(upload.length)} straight from the request body`);
            return { archive: withinLimit(upload, 'Upload'), name: reference || 'upload' };

        case 'catalog': {
            const entry = catalog.find((candidate) => candidate.id === reference);
            if (!entry) throw rejected('notFound', `No catalog app with id "${reference}".`);
            reporter(log).info(`catalog entry "${reference}" is ${entry.source.type} ${entry.source.ref}` +
                `${entry.source.asset ? ` (asset ${entry.source.exact ? 'named' : 'matching'} "${entry.source.asset}")` : ''}`);

            const resolved = entry.source.type === 'github'
                ? await fromGitHub(entry.source.ref, log, entry.source.asset || null, Boolean(entry.source.exact))
                : await fromUrl(entry.source.ref, log, entry.sha256 || null);

            // A catalog that states a hash is believed over nothing, never over GitHub's own.
            return { ...resolved, expected: resolved.expected || digestOf(entry.sha256), entry: entry.id };
        }

        case 'github': return fromGitHub(reference, log, asset, Boolean(asset));
        case 'url': return fromUrl(reference, log);
        case 'file': return fromFile(reference, log);

        default: throw rejected('badMessage', `Unknown install source "${source}".`);
    }
};

module.exports = { resolve, latestRelease, pickAsset, packagesIn, digestOf, repoOf, MAX_PACKAGE, PACKAGE_SUFFIX };
