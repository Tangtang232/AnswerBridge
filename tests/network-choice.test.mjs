import test from 'node:test';import assert from 'node:assert/strict';import os from 'node:os';import {networkUrls} from '../server/config.mjs';
test('配对地址优先无线网，同时保留其他可选地址',()=>{
 const original=os.networkInterfaces;os.networkInterfaces=()=>({Meta:[{family:'IPv4',internal:false,address:'198.18.0.1'}],WLAN:[{family:'IPv4',internal:false,address:'192.168.1.3'}],Ethernet:[{family:'IPv4',internal:false,address:'10.0.0.3'}]});
 try{assert.deepEqual(networkUrls(4318).map(x=>x.name),['WLAN','Ethernet','Meta']);}finally{os.networkInterfaces=original;}
});
