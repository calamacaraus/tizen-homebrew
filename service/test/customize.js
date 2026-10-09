'use strict';

const { mkdtempSync } = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');

process.env.HOMEBREW_PORT = '8421';
process.env.HOMEBREW_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'homebrew-customize-'));

const WebSocket = require('ws');

const customize = require('../src/install/customize.js');
const manifest = require('../src/install/manifest.js');
const preview = require('../src/install/preview.js');
const zip = require('../src/install/zip.js');
const fixture = require('./fixture.js');

const results = [];
const check = (name, ok, detail) => {
    results.push(ok);
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  <- ${detail}`}`);
};

const refusal = (fn) => {
    try {
        fn();
        return null;
    } catch (error) {
        return error.code;
    }
};

const ICON = { type: 'image/png', data: fixture.PIXEL.toString('base64') };

const main = async () => {
    {
        const original = fixture.wgtWithIcon();
        const identity = manifest.identify(original);

        const { archive, changed } = await customize.apply(original, identity, { name: 'YouTube', icon: ICON });
        const after = manifest.identify(archive);
        const shown = preview.describe(archive);

        check('a custom name replaces the one in config.xml', changed && after.name === 'YouTube', JSON.stringify(after));

        check('and the package is still the same package, at the same version',
            after.packageId === identity.packageId && after.version === identity.version, JSON.stringify(after));

        check('the custom icon is in the archive, and config.xml points at it',
            after.iconPath === 'homebrew-icon.png' &&
            zip.read(zip.fromBuffer(archive), 'homebrew-icon.png').equals(fixture.PIXEL),
            JSON.stringify(after));

        check('so a preview of it shows the new tile',
            shown && shown.icon === `data:image/png;base64,${fixture.PIXEL.toString('base64')}`, shown && String(shown.icon).slice(0, 40));
    }

    {
        // YouTube for Tizen's own config.xml, as it ships: the app the first television test was done with.
        const { readFileSync } = require('fs');
        const ORIGINAL = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x4f, 0x4c, 0x44]);
        const youtube = fixture.zipAll([
            { name: 'config.xml', contents: readFileSync(join(__dirname, 'data', 'youtube-config.xml')), deflate: true },
            { name: 'icon.png', contents: ORIGINAL },
            { name: 'index.html', contents: Buffer.from('<html></html>') }
        ], { descriptor: true });

        const identity = manifest.identify(youtube);
        const { archive } = await customize.apply(youtube, identity, { name: null, icon: ICON });
        const source = zip.fromBuffer(archive);
        const xml = zip.read(source, 'config.xml').toString('utf8');

        check('YouTube for Tizen: its own icon.png is replaced with the new picture as well',
            zip.read(source, 'icon.png').equals(fixture.PIXEL), 'icon.png unchanged');

        check('and config.xml names the new file, with nothing else in it changed',
            /<icon src="homebrew-icon\.png"\/>/.test(xml) && (xml.match(/<icon\b/g) || []).length === 1 &&
            /<name>YouTube<\/name>/.test(xml) && /tUb3Xq7Lm9\.TubeService/.test(xml), xml.slice(0, 300));

        check('only icon paths inside the archive are overwritten',
            customize.declaredIcons('<icon src="./icon.png"/><icon src=\'../x.png\'/><icon src="http://a/b.png"/>').join() === 'icon.png',
            customize.declaredIcons('<icon src="./icon.png"/><icon src=\'../x.png\'/><icon src="http://a/b.png"/>').join());
    }

    {
        const xml = '<widget><name>Old</name><name xml:lang="ru">Старое</name><icon src="a.png" width="117" height="117"/></widget>';

        check('every localised name is replaced, and markup in a name is escaped',
            customize.renameWidget(xml, 'You<b>&Tube</b>') ===
            '<widget><name>You&lt;b&gt;&amp;Tube&lt;/b&gt;</name><name xml:lang="ru">You&lt;b&gt;&amp;Tube&lt;/b&gt;</name><icon src="a.png" width="117" height="117"/></widget>',
            customize.renameWidget(xml, 'You<b>&Tube</b>'));

        check('a name with replacement patterns in it is taken literally',
            customize.renameWidget('<widget><name>Old</name><icon src="a.png"/></widget>', "A$'B $& $1 $$") ===
            "<widget><name>A$'B $&amp; $1 $$</name><icon src=\"a.png\"/></widget>",
            customize.renameWidget('<widget><name>Old</name><icon src="a.png"/></widget>', "A$'B $& $1 $$"));

        check('and so is one for a native package',
            customize.relabelNative('<manifest><label>Old</label></manifest>', 'Pay$1Day') === '<manifest><label>Pay$1Day</label></manifest>',
            customize.relabelNative('<manifest><label>Old</label></manifest>', 'Pay$1Day'));

        const quoted = customize.reiconWidget("<widget><icon src='icon.png' width='117' height=\"117\"/></widget>", 'homebrew-icon.png');

        check('an icon declared with single quotes is replaced, not given a second src',
            quoted === '<widget><icon src="homebrew-icon.png"/></widget>', quoted);

        check('an icon keeps its element but loses the old file and its sizes',
            customize.reiconWidget(xml, 'homebrew-icon.png').indexOf('<icon src="homebrew-icon.png"/>') !== -1 &&
            customize.reiconWidget(xml, 'homebrew-icon.png').indexOf('a.png') === -1,
            customize.reiconWidget(xml, 'homebrew-icon.png'));

        check('and a widget that declared no icon is given one',
            customize.reiconWidget('<widget><name>X</name></widget>', 'homebrew-icon.png')
                .indexOf('<icon src="homebrew-icon.png"/>') !== -1, 'no icon added');
    }

    {
        const original = fixture.wgt();
        const same = await customize.apply(original, manifest.identify(original), null);

        check('with nothing set, the archive is passed through untouched', same.changed === false && same.archive === original, 'changed');
    }

    {
        check('a PNG that is not a PNG is refused',
            refusal(() => customize.validate({ packageId: 'tUb3Xq7Lm9', icon: { type: 'image/png', data: Buffer.from('GIF89a').toString('base64') } })) === 'badMessage',
            'accepted');

        check('as is a type other than PNG or JPEG',
            refusal(() => customize.validate({ packageId: 'tUb3Xq7Lm9', icon: { type: 'image/svg+xml', data: 'PHN2Zz4=' } })) === 'badMessage',
            'accepted');

        check('and an icon over the size limit',
            refusal(() => customize.validate({ packageId: 'tUb3Xq7Lm9',
                icon: { type: 'image/png', data: Buffer.concat([fixture.PIXEL, Buffer.alloc(customize.MAX_ICON)]).toString('base64') } })) === 'tooLarge',
            'accepted');

        const cleaned = customize.validate({ packageId: 'tUb3Xq7Lm9', name: '  You\u0007Tube  ' });

        check('a name is trimmed and has no control characters', cleaned.name === 'YouTube', JSON.stringify(cleaned.name));

        const listed = [
            { id: 'youtube', packageId: 'tUb3Xq7Lm9', repository: 'official' },
            { id: 'cat-1.youtube', packageId: 'tUb3Xq7Lm9', repository: 'cat-1' },
            { id: 'gh-x.youtube', packageId: null, collection: true, repository: 'gh-x' }
        ];

        check('an app installed before Homebrew kept records is found again by the package id its list names',
            customize.sourceFor(listed, {}, 'tUb3Xq7Lm9') === 'youtube', customize.sourceFor(listed, {}, 'tUb3Xq7Lm9'));

        check('but Homebrew\'s own record of where it came from comes first',
            customize.sourceFor(listed, { 'gh-x.youtube': { packageId: 'tUb3Xq7Lm9' } }, 'tUb3Xq7Lm9') === 'gh-x.youtube', 'not the record');

        check('and an app no list names is not guessed at',
            customize.sourceFor(listed, {}, 'alphaapp01') === null && customize.sourceFor(null, null, 'x') === null, 'guessed');

        check('and a package id is held to a plain alphabet',
            refusal(() => customize.validate({ packageId: '../../etc', name: 'x' })) === 'badMessage', 'accepted');
    }

    {
        const silence = console.log;
        console.log = () => {};
        require('../src/main.js');
        console.log = silence;

        await new Promise((resolve) => setTimeout(resolve, 500));

        const config = require('../src/config.js');
        const pin = config.read().pin;

        const socket = new WebSocket('ws://127.0.0.1:8421');
        const inbox = [];
        const waiters = [];

        socket.on('message', (raw) => {
            const message = JSON.parse(raw);
            inbox.push(message);
            waiters.splice(0).forEach((wake) => wake());
        });

        const next = (type) => new Promise((resolve, reject) => {
            const deadline = setTimeout(() => reject(new Error(`no ${type}`)), 3000);
            const look = () => {
                const at = inbox.findIndex((message) => message.type === type);
                if (at === -1) return waiters.push(look);
                clearTimeout(deadline);
                resolve(inbox.splice(at, 1)[0]);
            };
            look();
        });

        const send = (type, payload) => socket.send(JSON.stringify({ type, payload }));

        await new Promise((resolve) => socket.on('open', resolve));
        await next('hello');
        send('hello', { pin });
        await next('hello');

        send('setCustomization', { packageId: 'tUb3Xq7Lm9', name: 'YouTube', icon: ICON });
        const set = await next('customizations');

        const stored = config.read().customizations.tUb3Xq7Lm9;
        const onDisk = customize.iconBytes(config.CONFIG_DIR, stored.icon);

        check('a customisation set from the phone is stored and sent back with its icon',
            set.payload.items.tUb3Xq7Lm9.name === 'YouTube' && /^data:image\/png;base64,/.test(set.payload.items.tUb3Xq7Lm9.icon) &&
            set.payload.partial === true,
            JSON.stringify(set.payload).slice(0, 200));

        check('with the image kept as a file beside the configuration, not inside it',
            !stored.icon.data && stored.icon.file === 'tUb3Xq7Lm9.png' && onDisk && onDisk.equals(fixture.PIXEL),
            JSON.stringify(stored));

        send('setCustomization', { packageId: 'tUb3Xq7Lm9', name: null });
        const renamed = await next('customizations');

        check('clearing only the name keeps the icon',
            renamed.payload.items.tUb3Xq7Lm9.name === null && renamed.payload.items.tUb3Xq7Lm9.icon !== null,
            JSON.stringify(renamed.payload));

        send('setCustomization', { packageId: 'tUb3Xq7Lm9', name: 'YouTube', apply: true });
        await next('customizations');
        const unapplied = await next('error');

        check('applying one installed from nowhere it can be fetched again says how to see it',
            unapplied.payload.code === 'savedNotApplied' && /Install it once more/.test(unapplied.payload.message), JSON.stringify(unapplied.payload));

        // A JPEG in place of the PNG: the new file is written, and the old one removed only after.
        const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0]);
        send('setCustomization', { packageId: 'tUb3Xq7Lm9', icon: { type: 'image/jpeg', data: JPEG.toString('base64') } });
        await next('customizations');

        const swapped = config.read().customizations.tUb3Xq7Lm9.icon;

        check('a replaced icon of another type takes its place, and the old file goes',
            swapped.file === 'tUb3Xq7Lm9.jpg' && customize.iconBytes(config.CONFIG_DIR, swapped).equals(JPEG) &&
            customize.iconBytes(config.CONFIG_DIR, stored.icon) === null,
            JSON.stringify(swapped));

        send('setCustomization', { packageId: 'tUb3Xq7Lm9', reset: true });
        const reset = await next('customizations');

        check('and a reset takes the app back to its own name and icon, and removes the file',
            !reset.payload.items.tUb3Xq7Lm9 && !config.read().customizations.tUb3Xq7Lm9 &&
            customize.iconBytes(config.CONFIG_DIR, swapped) === null, JSON.stringify(reset.payload));

        socket.close();
    }

    const failed = results.filter((ok) => !ok).length;
    console.log(`\n${results.length - failed}/${results.length} checks passed.`);
    process.exit(failed ? 1 : 0);
};

main().catch((error) => {
    console.error('\nHarness error:', error.stack);
    process.exit(1);
});

