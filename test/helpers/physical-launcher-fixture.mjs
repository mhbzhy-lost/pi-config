import { mkdirSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';

// 测试fake CLI保持原观察行为，但采用真实launcher要求的physical安装形状。
export function physicalLauncherFixture(fakeExecutable) {
 const modules=join(dirname(fakeExecutable),'physical/node_modules/@earendil-works');const root=join(modules,'pi-coding-agent');
 for(const name of ['pi-coding-agent','pi-agent-core','pi-ai','pi-tui']){
  const dir=join(modules,name);mkdirSync(join(dir,'dist'),{recursive:true});writeFileSync(join(dir,'package.json'),JSON.stringify({name:'@earendil-works/'+name,version:'1.4.0',type:'module',exports:{'.':{import:'./dist/index.js'}}}));
 }
 writeFileSync(join(root,'dist/index.js'),"throw Error('fixture不得为continue加载SDK');\n");
 const contents=readFileSync(fakeExecutable,'utf8');
 if(contents.startsWith('#!/usr/bin/env node')) writeFileSync(join(root,'dist/cli.js'),contents.replace(/^#![^\n]*\n/,''));
 else writeFileSync(join(root,'dist/cli.js'),`import {spawnSync} from 'node:child_process';const r=spawnSync(${JSON.stringify(fakeExecutable)},process.argv.slice(2),{env:process.env,stdio:'inherit'});process.exit(r.status??1);\n`);
 return {PI_HOST_ROOT:root,PI_PACKAGE_DIR:root,PI_REAL_BIN:join(root,'dist/cli.js'),PI_HOST_NODE:process.execPath};
}
