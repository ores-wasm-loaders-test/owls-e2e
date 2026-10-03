import {test} from "node:test";
import assert from "node:assert/strict";
import {readFile,stat} from "node:fs/promises";
import {createHash} from "node:crypto";
import {resolve,extname} from "node:path";
import {chromium} from "playwright";

const root=resolve(import.meta.dirname,"..");
const sha=bytes=>createHash("sha256").update(bytes).digest("hex");
async function asset(id,path,kind,prepare=true) {
  const data=await readFile(path);
  return {id,url:"https://app.example/"+id,kind,bytes:data.length,sha256:sha(data),prepare};
}
async function browserTest(run) {
  const browser=await chromium.launch({channel:"chrome",headless:true});
  try {
    const context=await browser.newContext();
    const files=new Map(),requests=new Map();
    const page=await context.newPage();
    await context.route("https://app.example/**",async route=>{
      const path=new URL(route.request().url()).pathname.slice(1);
      requests.set(path,(requests.get(path)??0)+1);
      if(path==="")return route.fulfill({contentType:"text/html",body:'<!doctype html><html><head><meta charset="utf-8"></head><body><div id="host" style="width:400px;height:300px"></div></body></html>',
        headers:{"content-security-policy":"default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; worker-src 'self' blob:; img-src 'self' data:; connect-src 'self';"}});
      let file=files.get(path);
      if(!file && path==="owls.js")file=resolve(root,"zed_modules/ores-wasm-loaders/owls-web-loader/dist/index.js");
      if(!file)file=resolve(root,"fixtures/flutter/build/web",path);
      if(!file.startsWith(root+"/"))return route.abort();
      try {
        const body=await readFile(file);
        const type={".js":"text/javascript",".mjs":"text/javascript",".wasm":"application/wasm",".json":"application/json",".ttf":"font/ttf",".otf":"font/otf"}[extname(file)]??"application/octet-stream";
        return route.fulfill({body,contentType:type,headers:{"cache-control":"public,max-age=31536000,immutable"}});
      } catch {return route.fulfill({status:404,body:"missing fixture"});}
    });
    const errors=[];page.on("pageerror",e=>errors.push(e.message));
    await page.goto("https://app.example/");
    await page.evaluate(async()=>{globalThis.owls=await import("/owls.js");});
    await run({page,files,requests,errors});
  } finally {await browser.close();}
}
test("real generated wasm-bindgen glue initializes once after byte-only preparation",async()=>{
  await browserTest(async({page,files,requests,errors})=>{
    const pkg=resolve(root,"fixtures/bindgen/pkg");
    files.set("rust.js",resolve(pkg,"fixture.js"));files.set("rust.wasm",resolve(pkg,"fixture_bg.wasm"));
    const manifest={schemaVersion:1,appId:"tenant-a",release:"r1",runtime:"wasm-bindgen",entrypoint:"rust.js",assets:[
      await asset("rust.js",files.get("rust.js"),"module"),await asset("rust.wasm",files.get("rust.wasm"),"wasm")
    ]};
    const result=await page.evaluate(async manifest=>{
      const {Coordinator,browserPolicy,BindgenAdapter}=owls;
      const loader=new Coordinator(browserPolicy(["https://app.example"]));loader.register(manifest);
      await loader.prefetch("tenant-a@r1");
      let starts=0;
      const adapter=new BindgenAdapter("rust.wasm",async()=>import("/rust.js"),async glue=>{
        starts++;return {sum:glue.add(20,22),islands:glue.hydrate_islands()};
      });
      const [a,b]=await Promise.all([loader.activate("tenant-a@r1",adapter),loader.activate("tenant-a@r1",adapter)]);
      return {...a,same:a===b,starts};
    },manifest);
    assert.deepEqual(result,{sum:42,islands:"owls-hydrated",same:true,starts:1});
    assert.equal(requests.get("rust.wasm"),1);assert.deepEqual(errors,[]);
  });
});
test("actual Flutter WASM build stays dormant during prefetch then runs two embedded views", {timeout:90000},async()=>{
  await browserTest(async({page,errors})=>{
    const bootstrap=resolve(root,"fixtures/flutter/build/web/flutter_bootstrap.js");
    const manifest={schemaVersion:1,appId:"flutter-tenant",release:"r1",runtime:"flutter-web",entrypoint:"flutter_bootstrap.js",
      assets:[await asset("flutter_bootstrap.js",bootstrap,"script")]};
    const result=await page.evaluate(async manifest=>{
      const {Coordinator,browserPolicy,FlutterAdapter,mountFlutterView}=owls;
      const loader=new Coordinator({...browserPolicy(["https://app.example"]),timeoutMs:60000});
      loader.register(manifest);await loader.prefetch("flutter-tenant@r1");
      const dormant=!globalThis._flutter;
      const adapter=new FlutterAdapter({document,getLoader:()=>globalThis._flutter?.loader,loadConfig:{canvasKitBaseUrl:"/canvaskit/"},engineConfig:{}});
      const app=await loader.activate("flutter-tenant@r1",adapter);
      const again=await loader.activate("flutter-tenant@r1",adapter);
      const first=document.querySelector("#host"),second=document.createElement("div");
      second.style.cssText="width:400px;height:300px";document.body.append(second);
      const removeFirst=mountFlutterView(app,first),removeSecond=mountFlutterView(app,second);
      const views=document.querySelectorAll("flutter-view").length;
      removeFirst();removeFirst();removeSecond();
      return {dormant,same:app===again,views,remaining:document.querySelectorAll("flutter-view").length};
    },manifest);
    assert.equal(result.dormant,true);assert.equal(result.same,true);
    assert.equal(result.views,2);assert.equal(result.remaining,0);assert.deepEqual(errors,[]);
  });
});
test("persistent CacheStorage survives navigation and bridge acknowledges completion",async()=>{
  await browserTest(async({page,files,requests})=>{
    const wasm=resolve(root,"fixtures/bindgen/pkg/fixture_bg.wasm");
    files.set("raw.wasm",wasm);
    const a=await asset("raw.wasm",wasm,"wasm");
    const r={schemaVersion:1,appId:"cache",release:"r1",runtime:"raw-wasm",entrypoint:a.id,assets:[a]};
    for(let pass=0;pass<2;pass++) {
      if(pass){await page.reload();await page.evaluate(async()=>{globalThis.owls=await import("/owls.js");});}
      const result=await page.evaluate(async r=>{
        const {Coordinator,browserPolicy,CacheStorageStore,createWebViewBridge}=owls;
        const c=new Coordinator(browserPolicy(["https://app.example"]),undefined,new CacheStorageStore(caches,location.origin,"owls-cache-test"));c.register(r);
        return new Promise(resolve=>{
          const bridge=createWebViewBridge(c,new Map(),()=>location.href,msg=>resolve(JSON.parse(msg)));
          bridge.receive({requestId:"1",method:"prefetch",releaseKey:"cache@r1",document:location.href});
        });
      },r);
      assert.deepEqual(result,{requestId:"1",ok:true});
    }
    assert.equal(requests.get("raw.wasm"),1);
  });
});
