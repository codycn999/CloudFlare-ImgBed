import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../frontend/package.json', import.meta.url));
const Vue = require('vue');
const { parse } = require('@vue/compiler-sfc');
const { compile } = require('@vue/compiler-dom');
const { renderToString } = require('@vue/server-renderer');
const code = readFileSync(new URL('../frontend/src/utils/replacementHelpers.js', import.meta.url), 'utf8');
const { replacementCompatible } = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));

function component(name, fetchWithAuth = async () => {}) {
    const { descriptor } = parse(readFileSync(new URL(`../frontend/src/components/dashboard/${name}.vue`, import.meta.url), 'utf8'));
    const script = descriptor.script.content.replace(/^import .+;$/gm, '').replace('export default', 'return');
    const options = new Function('fetchWithAuth', 'replacementCompatible', script)(fetchWithAuth, replacementCompatible);
    options.render = new Function('Vue', compile(descriptor.template.content, { mode: 'function', prefixIdentifiers: true }).code)(Vue);
    return options;
}

async function render(name, props) {
    const app = Vue.createSSRApp(component(name), props);
    app.config.globalProperties.$t = key => key;
    for (const name of ['ElTooltip', 'ElCheckbox', 'ElImage', 'ElCard', 'FontAwesomeIcon']) {
        app.component(name, { setup(props, { slots }) { return () => Vue.h('span', slots.default?.()); } });
    }
    return renderToString(app);
}

test('file list and card show replace, folder list never shows replace', async () => {
    const props = { item: { name: 'sample.png', metadata: { FileType: 'image/png' } }, visibleColumns: [], fileLink: '/file/sample.png' };
    assert.match(await render('FileCard', props), /aria-label="replaceFile.title"/);
    assert.match(await render('FileListItem', props), /aria-label="replaceFile.title"/);
    assert.doesNotMatch(await render('FileListItem', { ...props, item: { name: 'folder/', isFolder: true } }), /aria-label="replaceFile.title"/);
});

test('picker defaults to keeping source and sends one explicit target with deletion choice', async () => {
    const calls = []; const events = [];
    const options = component('ReplaceFileDialog', async (url, request) => {
        calls.push([url, request]); return Response.json({ success: true, sourceDeleted: false, warnings: [] });
    });
    const vm = { ...options.data(), ...options.methods,
        source: { name: 'folder/source.png', metadata: { FileType: 'image/png', ContentVersion: 'source-v' } },
        target: { name: 'archive/target.png', metadata: { FileType: 'image/png', ContentVersion: 'target-v' } },
        $emit: (...args) => events.push(args), $t: key => key };
    assert.equal(vm.deleteSource, false);
    await vm.submit();
    assert.equal(calls.length, 1);
    const body = JSON.parse(calls[0][1].body);
    assert.deepEqual(body, { target: 'archive/target.png', deleteSource: false,
        expectedSourcePath: 'folder/source.png', expectedTargetPath: 'archive/target.png', sourceVersion: 'source-v', targetVersion: 'target-v' });
    assert.equal(events[0][0], 'replaced'); assert.equal(vm.saving, false);
    vm.deleteSource = true; await vm.submit();
    assert.equal(JSON.parse(calls[1][1].body).deleteSource, true);
});

test('replacement errors keep the dialog open and repeated clicks while saving do not submit', async () => {
    const events = []; let count = 0;
    const options = component('ReplaceFileDialog', async () => { count++; return Response.json({ success: false, message: '文件内容已变化' }, { status: 409 }); });
    const vm = { ...options.data(), ...options.methods,
        source: { name: 'a.png', metadata: { FileType: 'image/png' } }, target: { name: 'b.png', metadata: { FileType: 'image/png' } },
        $emit: (...args) => events.push(args), $t: key => key };
    vm.saving = true; await vm.submit(); assert.equal(count, 0);
    vm.saving = false; await vm.submit(); assert.equal(count, 1);
    assert.equal(vm.error, '文件内容已变化'); assert.deepEqual(events, []);
});
