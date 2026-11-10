import test from 'node:test';import assert from 'node:assert/strict';
import {loadConfig,publicConfig} from '../server/config.mjs';
import {viewSettings,mergeSettings} from '../server/settings.mjs';
test('共享屏幕保护默认开启，能保存开关且兼容旧配置',()=>{
 const config=loadConfig({});assert.equal(config.screenProtection,true);assert.equal(publicConfig(config).screenProtection,true);
 const draft=viewSettings(config);draft.screenProtection=false;const off=mergeSettings(config,draft);assert.equal(off.screenProtection,false);assert.equal(viewSettings(off).screenProtection,false);
 const old=structuredClone(config);delete old.screenProtection;assert.equal(viewSettings(old).screenProtection,true);
 const invalid=viewSettings(config);invalid.screenProtection='false';assert.throws(()=>mergeSettings(config,invalid),/保护设置无效/);
});
