class PCM extends AudioWorkletProcessor {
  constructor(){super();this.samples=[];this.phase=0;this.sum=0;this.count=0;}
  process(inputs){const data=inputs[0]?.[0];if(data)for(const value of data){this.sum+=value;this.count++;this.phase+=16000/sampleRate;if(this.phase>=1){this.phase-=1;this.samples.push(Math.max(-32768,Math.min(32767,Math.round(this.sum/this.count*32767))));this.sum=0;this.count=0;}if(this.samples.length===1600){const pcm=new Int16Array(this.samples);let energy=0;for(const x of pcm)energy+=(x/32768)**2;this.port.postMessage({pcm:pcm.buffer,level:Math.sqrt(energy/pcm.length)},[pcm.buffer]);this.samples=[];}}return true;}
}
registerProcessor('pcm',PCM);
