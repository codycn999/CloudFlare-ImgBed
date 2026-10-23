import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onRequest as middleware } from '../functions/api/manage/_middleware.js';
import { onRequest as agent } from '../functions/api/agent/[[path]].js';
import { onRequest as tokens } from '../functions/api/manage/apiTokens.js';
import { onRequest as rename } from '../functions/api/manage/rename/[[path]].js';
import { getDatabase } from '../functions/utils/databaseAdapter.js';
import { validateApiToken } from '../functions/utils/auth/tokenValidator.js';

function fixture() {
    const map = new Map(), tasks = [];
    const env = { img_url: {
        get: async key => map.get(key)?.value ?? null,
        getWithMetadata: async key => structuredClone(map.get(key) || { value: null, metadata: null }),
        put: async (key, value, options = {}) => map.set(key, structuredClone({ value, metadata: options.metadata || null })),
        delete: async key => map.delete(key),
        list: async ({ prefix = '' } = {}) => ({ keys: [...map].filter(([k]) => k.startsWith(prefix)).map(([name,r]) => ({ name, metadata:r.metadata })), list_complete:true })
    } };
    const grants = Object.fromEntries(['list','organize','replace','delete','upload','manage'].map(p => [p, { token:p, permissions:[p], permissionVersion:2 }]));
    grants.legacyOrg = { token:'legacyOrg', permissions:['organize'] };
    grants.legacyManage = { token:'legacyManage', permissions:['manage'] };
    map.set('manage@sysConfig@security', { value: JSON.stringify({ apiTokens: { tokens:grants } }) });
    const context = (path, token, method='GET', body) => ({ env, data:{}, params:{ path:['test.png'] }, waitUntil:p=>tasks.push(p),
        request:new Request('https://example.test'+path, { method, headers:{ Authorization:'Bearer '+token, 'Content-Type':'application/json' }, ...(body ? { body:JSON.stringify(body) } : {}) }),
        next: async()=>Response.json({ allowed:true }) });
    return { map, env, tasks, context, db:getDatabase(env) };
}

test('six grants are independent at the manage middleware, including reserved words in file paths', async()=>{
    const f=fixture();
    const routes = [
        ['/api/manage/list','GET','list'],
        ['/api/manage/tags/catalog','GET','list'],
        ['/api/manage/tags/autocomplete','GET','list'],
        ['/api/manage/rename/list/file.png','POST','organize'],
        ['/api/manage/move/delete/file.png','GET','organize'],
        ['/api/manage/tags/list/file.png','POST','organize'],
        ['/api/manage/tags/catalog','POST','organize'],
        ['/api/manage/replace/list/file.png','POST','replace'],
        ['/api/manage/delete/list/file.png','GET','delete'],
        ['/api/manage/metadata/list/file.png','PATCH','manage'],
        ['/api/manage/sysConfig/security','GET','manage'],
        ['/api/manage/apiTokens','POST','manage'],
        ['/api/manage/batch/settings','GET','manage'],
        ['/api/manage/batch/list','GET','manage'],
        ['/api/manage/cusConfig/list','GET','manage'],
        ...['rebuild','merge-operations','delete-operations','info'].map(a=>['/api/manage/list?action='+a,'GET','manage'])
    ];
    for(const [path, method, required] of routes) for(const grant of ['list','organize','replace','delete','upload','manage']) {
        const response=await middleware[1](f.context(path,grant,method));
        assert.equal(response.status,grant===required?200:401,`${grant} ${method} ${path}`);
    }
});

test('read-only Agent reads library data but organization POST cannot mutate state', async()=>{
    const f=fixture();
    await f.db.put('test.png','',{metadata:{FileName:'test.png',FileType:'image/png',Channel:'TelegramNew',TimeStamp:1700000000000}});
    const id=(await f.db.getWithMetadata('test.png')).metadata.FixedId;
    for(const path of ['', 'openapi.json', 'files', 'folders', 'tags', 'files/'+id]) {
        assert.equal((await agent(f.context('/api/agent/'+path,'list'))).status,200,path);
    }
    await Promise.all(f.tasks);
    const before=structuredClone([...f.map]);
    for(const [path,body] of [['folders',{path:'blocked'}],['tags',{tags:['blocked']}],['files/'+id+'/rename',{name:'new.png'}],['files/'+id+'/move',{folder:'new'}],['files/'+id+'/tags',{tags:['new']}],['files/'+id+'/tags',{tags:['new'],dryRun:true}]]) {
        assert.equal((await agent(f.context('/api/agent/'+path,'list','POST',body))).status,403,path);
    }
    assert.deepEqual([...f.map],before);
    const capabilities=await(await agent(f.context('/api/agent/','list'))).json();
    assert.ok(capabilities.operations.includes('getFile'));
    assert.ok(!capabilities.operations.includes('renameFile'));
    assert.equal(capabilities.replacement,null);
});

test('organization grants writes without implicit browsing, replacement, or metadata repair',async()=>{
    const f=fixture();
    assert.equal((await agent(f.context('/api/agent/folders','organize','POST',{path:'organized'}))).status,200);
    assert.equal((await agent(f.context('/api/agent/files','organize'))).status,403);
    const response=await rename(f.context('/api/manage/rename/test.png','organize','POST',{newFileName:'test.png',FileType:'image/jpeg'}));
    assert.equal(response.status,403);
    assert.equal((await validateApiToken(f.context('/','organize').request,f.db,'replace')).valid,false);
});

test('legacy grants display explicitly; saving and revoking keeps the secret and expiry',async()=>{
    const f=fixture();
    const listed=await(await tokens(f.context('/api/manage/apiTokens','manage'))).json();
    assert.deepEqual(listed.tokens.find(t=>t.id==='legacyOrg').permissions,['list','organize']);
    assert.deepEqual(listed.tokens.find(t=>t.id==='legacyManage').permissions,['organize','replace','manage']);
    assert.equal((await validateApiToken(f.context('/','legacyOrg').request,f.db,'replace')).valid,false);
    assert.equal((await validateApiToken(f.context('/','legacyManage').request,f.db,'replace')).valid,true);
    const settings=JSON.parse(f.map.get('manage@sysConfig@security').value);
    settings.apiTokens.tokens.legacyOrg.expiresAt='2099-01-01T00:00:00.000Z';
    f.map.set('manage@sysConfig@security',{value:JSON.stringify(settings)});
    assert.equal((await tokens(f.context('/api/manage/apiTokens','manage','PUT',{tokenId:'legacyOrg',permissions:['list']}))).status,200);
    const saved=JSON.parse(f.map.get('manage@sysConfig@security').value).apiTokens.tokens.legacyOrg;
    assert.equal(saved.token,'legacyOrg'); assert.equal(saved.permissionVersion,2);
    assert.equal(saved.expiresAt,'2099-01-01T00:00:00.000Z');
    assert.equal((await agent(f.context('/api/agent/folders','legacyOrg','POST',{path:'no'}))).status,403);
});

test('new tokens use explicit v2 grants and reject malformed grants',async()=>{
    const f=fixture();
    for(const permissions of [[],['unknown'],'manage',[null]]) {
        assert.equal((await tokens(f.context('/api/manage/apiTokens','manage','POST',{name:'test',owner:'admin',permissions}))).status,400);
    }
    const created=await(await tokens(f.context('/api/manage/apiTokens','manage','POST',{name:'test',owner:'admin',permissions:['manage']}))).json();
    assert.equal((await validateApiToken(f.context('/',created.token).request,f.db,'replace')).valid,false);
    assert.equal((await validateApiToken(f.context('/',created.token).request,f.db,'organize')).valid,false);
});
