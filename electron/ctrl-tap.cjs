// Only an isolated Ctrl release fires. Modified keys, mouse use and auto-repeat do not.
function createCtrlTap({ctrlCodes,trigger,now=Date.now}){
 const down=new Set();let candidate=false,started=0,last=-Infinity;
 return {
  down(event){const code=event.keycode;if(ctrlCodes.includes(code)){if(down.has(code))return;if(down.size===0){candidate=!event.altKey&&!event.shiftKey&&!event.metaKey;started=now();}else candidate=false;down.add(code);}else if(down.size)candidate=false;},
  up(event){if(!ctrlCodes.includes(event.keycode))return;const existed=down.delete(event.keycode);if(!existed)return;if(!down.size){const time=now();if(candidate&&time-started<1500&&time-last>350&&!event.altKey&&!event.shiftKey&&!event.metaKey){last=time;trigger();}candidate=false;}},
  cancel(){candidate=false;},reset(){candidate=false;down.clear();}
 };
}
module.exports={createCtrlTap};
