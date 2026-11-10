import workletUrl from './pcm-worklet.js?url';
export async function startAudio({system,microphone,onChunk,onLevel,onEnded}){
  const streams=[];let context;
  const stop=()=>{streams.forEach(s=>s.getTracks().forEach(t=>t.stop()));if(context&&context.state!=='closed')void context.close();};
  try{
    if(system){const stream=await navigator.mediaDevices.getDisplayMedia({video:true,audio:true});streams.push(stream);if(!stream.getAudioTracks().length)throw Error('未取得系统声音，请确认使用 Windows 桌面客户端');}
    if(microphone)streams.push(await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true},video:false}));
    if(!streams.length)throw Error('请选择至少一个声音来源');
    context=new AudioContext({sampleRate:16000});await context.audioWorklet.addModule(workletUrl);
    const processor=new AudioWorkletNode(context,'pcm',{numberOfInputs:1,numberOfOutputs:1,channelCount:1});
    streams.forEach(stream=>{const audio=new MediaStream(stream.getAudioTracks());const source=context.createMediaStreamSource(audio);const gain=context.createGain();gain.gain.value=streams.length>1?0.65:1;source.connect(gain).connect(processor);stream.getAudioTracks().forEach(t=>t.onended=onEnded);});
    const muted=context.createGain();muted.gain.value=0;processor.connect(muted).connect(context.destination);
    processor.port.onmessage=({data})=>{onChunk(data.pcm);onLevel(data.level);};await context.resume();return stop;
  }catch(error){stop();throw error;}
}
