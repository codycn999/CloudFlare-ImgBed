import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require=createRequire(new URL('../frontend/package.json',import.meta.url));
const {parse}=require('@vue/compiler-sfc');
const source=readFileSync(new URL('../frontend/src/components/dashboard/FileNotes.vue',import.meta.url),'utf8');
function vm(fetchWithAuth){
    const descriptor=parse(source).descriptor;
    const script=descriptor.script.content.replace(/^import .+;$/gm,'').replace('export default','return');
    const options=new Function('fetchWithAuth','ElMessage','ElMessageBox',script)(fetchWithAuth,{success(){}},{confirm:async()=>{}});
    const instance={...options.data(),...options.methods,fileKey:'docs/report.pdf',$t:key=>key};
    for(const [key,get] of Object.entries(options.computed))Object.defineProperty(instance,key,{get:()=>get.call(instance)});
    return instance;
}
test('notes editor reads before saving, sends the revision and permits explicit clear',async()=>{
    const calls=[];const instance=vm(async(url,request)=>{calls.push([url,request]);return Response.json(request?{success:true,notes:'',revision:'v2',updatedAt:2}:{success:true,notes:'existing',revision:'v1',updatedAt:1,maxLength:32768});});
    await instance.save();assert.equal(calls.length,0);
    await instance.load();assert.equal(instance.draft,'existing');assert.equal(instance.dirty,false);
    instance.draft='';await instance.save();
    assert.equal(calls[1][0],'/api/manage/notes/docs/report.pdf');
    assert.deepEqual(JSON.parse(calls[1][1].body),{notes:'',expectedRevision:'v1'});
    assert.equal(instance.revision,'v2');assert.equal(instance.dirty,false);
});
test('notes conflicts retain the draft; repeated save while pending is ignored',async()=>{
    let calls=0;const instance=vm(async()=>{calls++;return Response.json({success:false},{status:409});});
    Object.assign(instance,{loaded:true,draft:'local draft',saved:'old',revision:'v1',saving:true});
    await instance.save();assert.equal(calls,0);
    instance.saving=false;await instance.save();assert.equal(calls,1);
    assert.equal(instance.draft,'local draft');assert.equal(instance.revision,'v1');assert.equal(instance.error,'fileNotes.conflict');assert.equal(instance.saving,false);
});
test('notes UI renders plain text and guards closing unsaved drafts',()=>{
    assert.ok(!source.includes('v-html'));
    assert.match(source,/type="textarea"/);assert.match(source,/maxlength="limit"/);
    const detail=readFileSync(new URL('../frontend/src/components/dashboard/FileDetailDialog.vue',import.meta.url),'utf8');
    assert.match(detail,/:before-close="beforeDetailClose"/);assert.match(detail,/confirmDiscard\(\)/);
});
