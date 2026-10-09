'use strict';

const compat = require('./compat.js');

// A collection is a GitHub repository whose newest release carries many packages — One public
// tizen-community-packages is forty of them in one release. Each package file becomes one catalog
// entry, so the phone lists them like any other app.
//
// What a release says about its files is all there is to go on before anything is downloaded: the
// file name, its size, and the sha256 GitHub records. A version is read out of the name when the name
// carries one (Alpha-1.0.46.wgt); the package id is not known until an install reads config.xml,
// which is why the pipeline remembers which entry put which package on the television.

const { digestOf, PACKAGE_SUFFIX } = require('./sources.js');

// `-1.0.46`, `_v2.3`, ` 1.17.2-rc1` at the end of a name, once `-unsigned` and the like are set aside.
const VERSION_TAIL = /[-_ ]v?(\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.]+)?)$/;
const DECORATION = /[-_ ](unsigned|signed|release|final)$/i;

const slug = (text) => String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'app';

// The platform a build is for (`-tizen-5.5`), kept as part of the name so variants stay apart.
// Shaped like a Tizen platform version (2.4 to 9.0), so `charlie-tizen-1.17.2` is still read as v1.17.2.
const PLATFORM = /[-_]tizen[-_]?[2-9](?:\.\d)?$/i;

// `echo-tizen-v0.2.0-unsigned.wgt` -> { base: 'echo-tizen', version: '0.2.0' }
// `tube-1.1.0-tizen-5.5.wgt`         -> { base: 'tube-tizen-5.5', version: '1.1.0' }
const readName = (file) => {
    let stem = file.replace(PACKAGE_SUFFIX, '');
    let version = null;

    const platform = PLATFORM.exec(stem);
    if (platform) stem = stem.slice(0, platform.index);

    for (let pass = 0; pass < 2; pass += 1) {
        stem = stem.replace(DECORATION, '');

        const found = VERSION_TAIL.exec(stem);

        if (found && !version) {
            version = found[1];
            stem = stem.slice(0, found.index);
        }
    }

    return { base: platform ? `${stem}${platform[0]}` : stem, version };
};

// `Alpha-Player` -> `Alpha Player`, `echo-tizen` -> `Echo Tizen`; capitals someone chose are kept.
const prettify = (base) => base.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim()
    .split(' ')
    .map((word) => (word === word.toLowerCase() ? word.charAt(0).toUpperCase() + word.slice(1) : word))
    .join(' ');

// The id is built from the name without its version, so Alpha-1.0.46 and Alpha-1.0.47 are the
// same entry and the second is its update rather than a new app.
const expand = (repository, release) => {
    const seen = {};

    return (release.assets || [])
        .filter((asset) => PACKAGE_SUFFIX.test(asset.name))
        .map((asset) => {
            const { base, version } = readName(asset.name);

            // Two files that read as the same app (App-1.0.wgt and App-2.0.wgt in one release) stay apart.
            const first = slug(base);
            let key = first;
            for (let count = 2; seen[key]; count += 1) key = `${first}-${count}`;
            seen[key] = true;

            return {
                id: `${repository.id}.${key}`,
                name: prettify(base) || asset.name,
                description: `${asset.name} · ${repository.ref}${release.tag_name ? ` · ${release.tag_name}` : ''}`,
                version,
                packageId: null,
                sha256: digestOf(asset.digest),
                size: asset.size || null,
                icon: null,
                releasedAt: asset.updated_at || release.published_at || null,
                collection: true,
                forTizen: compat.fromName(asset.name),
                repository: repository.id,
                source: { type: 'github', ref: repository.ref, asset: asset.name, exact: true }
            };
        });
};

module.exports = { expand, readName, prettify, slug };
