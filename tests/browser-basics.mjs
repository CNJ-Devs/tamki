import {_electron as electron} from 'playwright';
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const profile=await mkdtemp(path.join(tmpdir(),'tamki-browser-basics-'));
const server=createServer((req,res)=>{
 if(req.url==='/icon'){res.setHeader('content-type','image/png');res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXWsAAAAASUVORK5CYII=','base64'));return;}
 res.setHeader('content-type','text/html');res.end(`<title>Fixture ${req.url}</title><link rel="icon" href="/icon"><a id="next" href="/two">Next</a><p>needle needle</p><input id="edit">`);
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${server.address().port}`;
let app;
const launch=()=>electron.launch({args:['.'],env:{...process.env,TAMKI_TEST_PROFILE:profile,TAMKI_BACKGROUND_TEST:'1'}});
try{
 app=await launch();let shell=await app.firstWindow();shell.setDefaultTimeout(10000);await shell.waitForFunction(()=>window.tamki);
 await shell.evaluate(async()=>{const s=await window.tamki.library('state');await window.tamki.library('preferences',{...s.preferences,language:'en'});});
 await app.evaluate(({Menu})=>{Menu.prototype.popup=function(){globalThis.__menu=this.items;};});
 const call=(type,value)=>shell.evaluate(([type,value])=>window.tamki.action(type,value),[type,value]);
 await call('new');await call('navigate',base+'/one');
 await shell.waitForFunction(async()=> (await window.tamki.action('state')).tabs.some(t=>t.title==='Fixture /one'));
 const first=(await call('state')).active;
 const web=app.context().pages().find(p=>p.url()===base+'/one');assert(web);
 await web.locator('#next').click({button:'right'});
 const labels=await app.evaluate(()=>globalThis.__menu.map(i=>i.label));assert(labels.includes('Open link in new tab'));
 await app.evaluate(()=>globalThis.__menu.find(i=>i.label==='Open link in new tab').click());
 let state=await call('state');assert.equal(state.active,first);assert.equal(state.tabs.length,2);
 await call('find-open');await call('find',{text:'needle'});
 await shell.waitForFunction(async()=> {const s=await window.tamki.action('state');return s.tabs.find(t=>t.id===s.active)?.find?.matches===2;});
 await call('find',{text:'needle',next:true});await call('find-close');
 await call('zoom',1);assert.equal((await call('state')).tabs.find(t=>t.id===first).zoom,110);
 await call('tab-mute',first);assert.equal((await call('state')).tabs.find(t=>t.id===first).muted,true);
 await call('bookmark-toggle');assert.equal((await call('state')).bookmarks.length,1);
 await call('bookmarks-open');const panel=app.context().pages().find(p=>p.url().includes('tab-picker.html'));await panel.getByRole('dialog',{name:'Bookmarks',exact:true}).waitFor();
 await panel.getByRole('button',{name:'Edit bookmark',exact:true}).click();await panel.getByLabel('Title',{exact:true}).fill('Saved fixture');await panel.getByRole('button',{name:'Save',exact:true}).click();
 assert.equal((await call('state')).bookmarks[0].title,'Saved fixture');
 await call('tabs-dismiss');
 await shell.locator('#address').fill('Saved');
 await panel.getByRole('option').filter({hasText:'Saved fixture'}).waitFor();
 await shell.locator('#address').press('ArrowDown');await shell.locator('#address').press('Enter');
 await call('navigate',base+'/three');await shell.waitForFunction(async()=> (await window.tamki.action('state')).tabs.some(t=>t.title==='Fixture /three'));
 await app.close();app=await launch();shell=await app.firstWindow();await shell.waitForFunction(()=>window.tamki);
 await shell.waitForFunction(async()=> (await window.tamki.action('state')).tabs.some(t=>t.title==='Fixture /three'));
 state=await call('state');const restored=state.tabs.find(t=>t.url===base+'/three');assert(restored.back);assert(restored.muted);assert.equal(restored.zoom,110);assert.equal(state.bookmarks[0].title,'Saved fixture');
 await call('back');await shell.waitForFunction(async()=> (await window.tamki.action('state')).tabs.some(t=>t.title==='Fixture /one'));
 console.log('PASS: hidden context menu, background link, find, zoom, mute, bookmarks, suggestions and navigation-history restart.');
}finally{await app?.close();server.close();await rm(profile,{recursive:true,force:true});}
