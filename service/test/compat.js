'use strict';

// Which Tizen an app is for, read from the names real collections and catalogs use.

const compat = require('../src/install/compat.js');
const manifest = require('../src/install/manifest.js');
const fixture = require('./fixture.js');

const results = [];
const check = (name, ok, detail) => {
    results.push(ok);
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  <- ${detail}`}`);
};

const names = {
    'Overscan-tizen6.wgt': '6.0',
    'Nuvio-Legacy-tizen4.tpk': '4.0',
    'Nuvio-Legacy-Tizen6.5.wgt': '6.5',
    'tube-1.1.0-tizen-5.5.wgt': '5.5',
    'YouTube - Tizen 5.0 ONLY': '5.0',
    'Stremio Tizen4': '4.0',
    'Alpha-Player.wgt': null,
    'echo-tizen-v0.2.0-unsigned.wgt': null,
    'TizenTube.wgt': null,
    'TizenBrew.wgt': null
};

const read = Object.keys(names).map((name) => [name, compat.fromName(name)]);
check('the Tizen a file or entry is named for is read, and nothing is read from names that do not say',
    read.every(([name, found]) => found === names[name]), JSON.stringify(read));

check('versions compare as Tizen versions',
    compat.compare('5.5', '9.0') === -1 && compat.compare('6', '6.0') === 0 && compat.compare('9.0', '5.5') === 1 &&
    compat.compare('10.0', '9.0') === 1 && compat.compare(null, '9.0') === null, 'wrong order');

check('the builds of one app are put together by their name without the Tizen part',
    compat.baseOf('Overscan Tizen6') === compat.baseOf('Overscan Tizen9') &&
    compat.baseOf('YouTube - Tizen 5.0 ONLY') === compat.baseOf('YouTube') &&
    compat.baseOf('Nuvio Legacy Tizen4') !== compat.baseOf('Nuvio Official'),
    [compat.baseOf('Overscan Tizen6'), compat.baseOf('YouTube - Tizen 5.0 ONLY')].join(' / '));

const widget = fixture.zip('config.xml', Buffer.from('<?xml version="1.0"?><widget xmlns:tizen="http://tizen.org/ns/widgets" ' +
    'version="1.0.0"><tizen:application id="tUb3Xq7Lm9.Tube" package="tUb3Xq7Lm9" required_version="5.5"/><name>Tube</name></widget>'));
check('a package says the least Tizen it needs', manifest.identify(widget).requires === '5.5', String(manifest.identify(widget).requires));

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed.`);
process.exit(failed ? 1 : 0);
