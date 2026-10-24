import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { getDatabase } from '../functions/utils/databaseAdapter.js';
import { onRequest as notes } from '../functions/api/manage/notes/[[path]].js';
import { onRequest as agent } from '../functions/api/agent/[[path]].js';
import { onRequest as rename } from '../functions/api/manage/rename/[[path]].js';
import { onRequest as move } from '../functions/api/manage/move/[[path]].js';
import { onRequest as replace } from '../functions/api/manage/replace/[[path]].js';
import { onRequest as remove } from '../functions/api/manage/delete/[[path]].js';
import { onRequest as trash } from '../functions/api/manage/trash/[[path]].js';
import { onRequest as middleware } from '../functions/api/manage/_middleware.js';
import { NOTES_PREFIX, NOTES_LIMIT, readFileNotes, readNotesBody } from '../functions/utils/fileNotes.js';
import { agentOpenApi } from '../functions/utils/agentOpenApi.js';

let oldFetch, oldCaches;
beforeEach(() => { oldFetch=globalThis.fetch; oldCaches=globalThis.caches; globalThis.fetch=async()=>Response.json({success:true}); globalThis.caches={default:{put:async()=>{}}}; });
afterEach(() => {globalThis.fetch=oldFetch;globalThis.caches=oldCaches;});

function fixture(engine='KV') {
    const map=new Map(), tasks=[], env={TG_BOT_TOKEN:'123:test',TG_CHAT_ID:'-100123'};
    if(engine==='KV') env.img_url={
        get:async key=>map.get(key)?.value??null,
        getWithMetadata:async key=>structuredClone(map.get(key)||{value:null,metadata:null}),
        put:async(key,value,options={})=>map.set(key,structuredClone({value,metadata:options.metadata||null})),
        delete:async key=>map.delete(key),
        list:async({prefix=''}={})=>({keys:[...map].filter(([key])=>key.startsWith(prefix)).map(([name,r])=>({name,metadata:r.metadata})),list_complete:true})
    };
    else {
        const sqlite=new DatabaseSync(':memory:');sqlite.exec(readFileSync(new URL('../database/init.sql',import.meta.url),'utf8'));
        env.img_d1={prepare(sql){let args=[];const statement={bind(...values){args=values.map(v=>v===undefined?null:typeof v==='boolean'?Number(v):v);return statement;},async first(){return sqlite.prepare(sql).get(...args)||null;},async run(){return sqlite.prepare(sql).run(...args);},async all(){return {results:sqlite.prepare(sql).all(...args)};}};return statement;}};
    }
    const db=getDatabase(env);
    const ctx=(path,method='GET',body,token)=>({env,data:{},params:{path:path.split('/')},waitUntil:p=>tasks.push(p),next:async()=>Response.json({success:true}),request:new Request('https://test.example/api/manage/notes/'+path,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})})});
    const ag=(route,method='GET',body,token='both')=>({...ctx('',method,body,token),request:new Request('https://test.example/api/agent/'+route,{method,headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},...(body!==undefined?{body:JSON.stringify(body)}:{})})});
    const init=async()=>{
        const tokens=Object.fromEntries(['list','organize','replace','delete','purge','manage','upload'].map(p=>[p,{token:p,permissions:[p],permissionVersion:2}]));
        tokens.both={token:'both',permissions:['list','organize'],permissionVersion:2};
        tokens.expired={token:'expired',permissions:['list','organize'],expiresAt:'2000-01-01T00:00:00Z'};
        await db.put('manage@sysConfig@security',JSON.stringify({apiTokens:{tokens}}));
    };
    const add=async(path)=>{await db.put(path,'',{metadata:{FileName:path.split('/').pop(),TimeStamp:1700000000000,FileType:'application/pdf',Channel:'TelegramNew',TgFileId:'immutable',Directory:path.split('/').slice(0,-1).join('/')+'/',Tags:['keep']}});return (await db.getWithMetadata(path)).metadata.FixedId;};
    return {map,db,env,tasks,ctx,ag,init,add};
}

for(const engine of ['KV','D1']) {
    test(engine+': long multiline notes roundtrip outside file metadata, with revisions and clear',async()=>{
        const f=fixture(engine);await f.init();const id=await f.add('docs/report.pdf');
        const original=await f.db.getWithMetadata('docs/report.pdf');
        let result=await (await notes(f.ctx(id,'GET',undefined,'list'))).json();assert.equal(result.notes,'');assert.equal(result.revision,'');
        const text='中文🙂\n<script>alert(1)</script>\n'.repeat(500);
        result=await(await notes(f.ctx(id,'POST',{notes:text,expectedRevision:''},'organize'))).json();
        assert.equal(result.notes,text);assert.ok(result.revision);assert.ok(result.updatedAt);
        assert.deepEqual(await f.db.getWithMetadata('docs/report.pdf'),original);
        assert.equal((await readFileNotes(f.db,id)).notes,text);
        assert.equal((await notes(f.ctx(id,'POST',{notes:'stale',expectedRevision:''},'organize'))).status,409);
        const cleared=await(await notes(f.ctx(id,'POST',{notes:'',expectedRevision:result.revision},'organize'))).json();
        assert.equal(cleared.notes,'');assert.notEqual(cleared.revision,result.revision);
        assert.equal((await notes(f.ctx(id,'POST',{notes:'lost',expectedRevision:result.revision},'organize'))).status,409);
    });

    test(engine+': Agent reads and updates notes; dryRun preserves storage; bulk lists stay lightweight',async()=>{
        const f=fixture(engine);await f.init();const id=await f.add('docs/report.pdf');
        const route='files/'+id+'/notes';
        assert.equal((await agent(f.ag(route,'GET',undefined,'list'))).status,200);
        const before=await f.db.get(NOTES_PREFIX+id);
        const preview=await(await agent(f.ag(route,'POST',{notes:'摘要\n第二行',expectedRevision:'',dryRun:true},'organize'))).json();
        assert.equal(preview.dryRun,true);assert.equal(await f.db.get(NOTES_PREFIX+id),before);
        const saved=await(await agent(f.ag(route,'POST',{notes:'摘要\n第二行',expectedRevision:''},'organize'))).json();
        assert.equal(saved.success,true);
        const detail=await(await agent(f.ag('files/'+id))).json();assert.equal(detail.notes,saved.notes);assert.equal(detail.notesRevision,saved.revision);
        const files=await(await agent(f.ag('files?recursive=true'))).json();assert.equal(files.files.length,1);assert.equal(files.files[0].notes,undefined);
        assert.equal((await agent(f.ag(route,'POST',{notes:'write',expectedRevision:saved.revision},'list'))).status,403);
        assert.equal((await agent(f.ag(route,'GET',undefined,'organize'))).status,403);
        assert.equal((await agent(f.ag(route,'POST',{notes:'write',expectedRevision:saved.revision},'manage'))).status,403);
        assert.equal((await agent(f.ag(route,'GET',undefined,'expired'))).status,401);
        await Promise.all(f.tasks);
    });

    test(engine+': notes follow rename/move and survive trash/restore, purge removes them',async()=>{
        const f=fixture(engine);await f.init();const id=await f.add('docs/report.pdf');
        await notes(f.ctx(id,'POST',{notes:'保留备注',expectedRevision:''}));
        assert.equal((await rename(f.ctx('docs/report.pdf','POST',{newFileName:'renamed.pdf'}))).status,200);
        const moveCtx=f.ctx('docs/renamed.pdf');moveCtx.request=new Request('https://test.example/api/manage/move/docs/renamed.pdf?dist=archive');
        assert.equal((await move(moveCtx)).status,200);
        assert.equal((await(await notes(f.ctx('docs/report.pdf'))).json()).notes,'保留备注');
        assert.equal((await remove(f.ctx('archive/renamed.pdf','DELETE'))).status,200);
        assert.equal((await notes(f.ctx(id))).status,404);assert.equal((await agent(f.ag('files/'+id))).status,404);
        assert.equal((await notes(f.ctx(id,'POST',{notes:'bad',expectedRevision:''}))).status,404);
        assert.equal((await trash(f.ctx(id+'/restore','POST'))).status,200);
        assert.equal((await readFileNotes(f.db,id)).notes,'保留备注');
        await remove(f.ctx('archive/renamed.pdf','DELETE'));assert.equal((await trash(f.ctx(id,'DELETE'))).status,200);
        assert.equal(await f.db.get(NOTES_PREFIX+id),null);await Promise.all(f.tasks);
    });

    test(engine+': content replacement keeps target notes and source trash retains its own note',async()=>{
        const f=fixture(engine);await f.init();const source=await f.add('source.pdf'),target=await f.add('target.pdf');
        await notes(f.ctx(source,'POST',{notes:'source note',expectedRevision:''}));
        await notes(f.ctx(target,'POST',{notes:'target note',expectedRevision:''}));
        const response=await replace(f.ctx('source.pdf','POST',{target:'target.pdf',deleteSource:true,expectedSourcePath:'source.pdf',expectedTargetPath:'target.pdf'}));
        assert.equal(response.status,200,await response.clone().text());
        assert.equal((await readFileNotes(f.db,target)).notes,'target note');assert.equal((await readFileNotes(f.db,source)).notes,'source note');
        assert.equal((await trash(f.ctx(source+'/restore','POST'))).status,200);
        assert.equal((await(await notes(f.ctx(source))).json()).notes,'source note');await Promise.all(f.tasks);
    });
}

test('notes handlers and middleware independently enforce read/write grants',async()=>{
    const f=fixture();await f.init();const id=await f.add('report.pdf');
    for(const grant of ['list','organize','replace','delete','purge','manage','upload'])for(const method of ['GET','POST']){
        const expected=grant===(method==='GET'?'list':'organize')?200:401;
        const context=f.ctx(id,method,method==='POST'?{notes:'',expectedRevision:''}:undefined,grant);
        assert.equal((await notes(context)).status,expected,grant+method);
        assert.equal((await middleware[1](context)).status,expected,grant+method);
    }
});

test('notes reject invalid bodies, oversize requests, stale paths, system keys and missing files',async()=>{
    const f=fixture();await f.init();const id=await f.add('report.pdf');
    for(const [body,status] of [[{notes:[],expectedRevision:''},400],[{notes:null,expectedRevision:''},400],[{notes:'a'},400],[{notes:'a',expectedRevision:'',dryRun:'true'},400],[{notes:'a',expectedRevision:'',expectedPath:'wrong.pdf'},409],[{notes:'文'.repeat(NOTES_LIMIT+1),expectedRevision:''},413]]) assert.equal((await notes(f.ctx(id,'POST',body))).status,status);
    assert.equal((await notes(f.ctx(id,'POST',{notes:'文'.repeat(NOTES_LIMIT),expectedRevision:''}))).status,200);
    assert.equal((await notes(f.ctx('manage@sysConfig@security'))).status,404);
    assert.equal((await notes(f.ctx('missing.pdf'))).status,404);
    assert.equal((await notes(f.ctx(id,'DELETE'))).status,405);
    await assert.rejects(readNotesBody(new Request('https://test.example',{method:'POST',body:'a'.repeat(256*1024+1)})),{status:413});
    for(const body of ['null','[]','{']) await assert.rejects(readNotesBody(new Request('https://test.example',{method:'POST',body})),{status:400});
});

test('OpenAPI and capability discovery describe notes read/write permissions and limits',async()=>{
    const schema=agentOpenApi('https://test.example'), op=schema.paths['/files/{id}/notes'];
    assert.ok(op.get);assert.equal(op.post.operationId,'updateNotes');
    assert.deepEqual(op.post.requestBody.content['application/json'].schema.required,['notes','expectedRevision']);
    const f=fixture();await f.init();const capability=await(await agent(f.ag(''))).json();
    assert.ok(capability.operations.includes('updateNotes'));assert.equal(capability.notes.maxLength,NOTES_LIMIT);
    const reader=await(await agent(f.ag('','GET',undefined,'list'))).json();assert.ok(!reader.operations.includes('updateNotes'));
});
