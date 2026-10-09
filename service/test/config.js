'use strict';

const { mkdtempSync, mkdirSync, writeFileSync, existsSync } = require('fs');
const { dirname } = require('path');
const { tmpdir } = require('os');

process.env.HOMEBREW_CONFIG_DIR = mkdtempSync(`${tmpdir()}/homebrew-config-test-`);

const config = require('../src/config.js');

const results = [];
const check = (name, ok, detail) => {
    results.push(ok);
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  <- ${detail}`}`);
};

const PAIR = { certificates: ['-----BEGIN CERTIFICATE-----\nQUFB\n-----END CERTIFICATE-----\n'], key: 'k' };

const drop = (value) => {
    mkdirSync(dirname(config.HANDOFF_PATH), { recursive: true });
    writeFileSync(config.HANDOFF_PATH, JSON.stringify(value));
};

check('nothing to adopt is not an error', config.adoptHandoff() === null, 'a missing hand-off threw');

{
    config.update({ catalogUrl: 'https://example.test/catalog.json', lastInstalled: [{ packageId: 'x' }] });

    drop({ author: PAIR, distributor: PAIR, devices: ['TESTSET1234', 'OTHERSET0001'] });

    const adopted = config.adoptHandoff();
    const stored = config.read();

    check('a dropped pair is adopted', adopted && adopted.join(',') === 'TESTSET1234,OTHERSET0001',
        JSON.stringify(adopted));

    check('and lands where resigning looks for it',
        stored.author.key === 'k' && stored.distributor.certificates.length === 1, JSON.stringify(stored.author));

    check('every device it names is kept, not just the first',
        stored.certDuids.join(',') === 'TESTSET1234,OTHERSET0001' && stored.certDuid === 'TESTSET1234',
        JSON.stringify(stored.certDuids));

    check('the television it covers may install', config.hasCertificates('TESTSET1234') === true, 'refused');
    check('one it does not is still refused', config.hasCertificates('NOTOURS0001') === false, 'allowed');

    check('and nothing else in the config was disturbed',
        stored.catalogUrl === 'https://example.test/catalog.json' && stored.lastInstalled.length === 1,
        JSON.stringify({ catalogUrl: stored.catalogUrl, lastInstalled: stored.lastInstalled }));

    check('the hand-off is consumed, so a restart does not repeat it',
        !existsSync(config.HANDOFF_PATH) && config.adoptHandoff() === null, 'the drop survived');
}

{
    config.forgetCertificates();

    drop({ author: PAIR });
    check('half a pair is refused rather than half-stored',
        config.adoptHandoff() === null && config.hasCertificates() === false, JSON.stringify(config.read().author));

    drop('placeholder');
    writeFileSync(config.HANDOFF_PATH, 'not json at all');
    check('an unreadable hand-off is ignored', config.adoptHandoff() === null, 'it threw');
}

{
    config.clear();
    config.update({ authorCert: 'base64', distributorCert: 'base64', password: 'p' });

    check('a pair from before PEM is not mistaken for a usable one',
        config.hasCertificates() === false, 'a .p12 config was accepted');

    check('and is recognizable, so the log can say why',
        config.hasLegacyCertificates() === true, 'the old shape went unnoticed');
}

{
    config.clear();

    const minted = config.pairingPin();

    check('a pairing code is minted when there is none', /^\d{6}$/.test(minted), String(minted));

    check('and then kept, so a service that restarts on boot does not unpair every phone',
        config.pairingPin() === minted && config.read().pin === minted, `${minted} became ${config.pairingPin()}`);

    config.update({ author: PAIR, distributor: PAIR });
    config.forgetCertificates();

    check('forgetting the certificates does not take the code with them',
        config.pairingPin() === minted, 'the code changed when the certificates were cleared');
}

{
    // Power lost mid-write, or flash damage: the file no longer parses.
    config.update({ author: 'KEPT', pin: '654321' });
    config.update({ note: 'a later change' });

    const path = require('path').join(process.env.HOMEBREW_CONFIG_DIR, 'homebrewConfig.json');
    writeFileSync(path, '{"author":"KEPT","pin":"65');

    const quiet = console.error;
    console.error = () => {};
    const after = config.read();
    console.error = quiet;

    check('a damaged configuration is restored from its last good copy, keys and PIN with it',
        after.author === 'KEPT' && after.pin === '654321', JSON.stringify({ author: after.author, pin: after.pin }));

    check('and the damaged file is kept aside, not overwritten',
        require('fs').readdirSync(process.env.HOMEBREW_CONFIG_DIR).some((name) => /\.damaged-\d+$/.test(name)), 'gone');

    let threw = false;
    try { config.read().repositories.push('x'); } catch (e) { threw = true; }
    check('what a read returns cannot be changed in place by accident', threw, 'changed');
}

config.clear();

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed.`);
process.exit(failed ? 1 : 0);
