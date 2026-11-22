const cableInput = /^CABLE Input \(VB-Audio/i;
const cableOutput = /^CABLE Output \(VB-Audio/i;
const headset = /耳机|头戴|headphone|headset|hands.free|airpods/i;
const handsFree = /hands.free|免提/i;
const virtualOutput = /cable|virtual audio|steam streaming|voicemeeter/i;
const normalize = label => (label || '').replace(/ \(Bluetooth\)$/i, '').trim().toLowerCase();
const deviceName = label => normalize(label)
  .replace(/^[^(]*\(/, '').replace(/\)$/, '')
  .replace(/\s+(?:hands.free(?: ag audio)?|stereo|免提|立体声)$/i, '');

function selectDevices(state, savedLabel, manualLabel, chooseOutput = false) {
  const input = state.inputs.find(device => cableOutput.test(device.Label));
  if (!input || !state.outputs.some(device => cableInput.test(device.Label))) {
    throw Error('未检测到 VB-Audio Virtual Cable，请安装或启用 CABLE Input 和 CABLE Output 后重试。');
  }
  const outputs = state.outputs.filter(device => !virtualOutput.test(device.Label));
  const byLabel = label => outputs.find(device => normalize(device.Label) === normalize(label));
  const byId = id => outputs.find(device => device.Id === id);
  const choices = [...new Set(outputs.map(device => device.Label))];
  if (chooseOutput) return { choices };
  const manual = manualLabel ? byLabel(manualLabel) : null;
  if (manualLabel && !manual) return { choices };
  const saved = byLabel(savedLabel);
  const listening = byId(state.defaultOutput);
  const communication = byId(state.communicationOutput);
  const microphone = state.inputs.find(device => device.Id === state.communicationInput);
  const connectedHeadsets = outputs.filter(device => headset.test(device.Label));
  const focus = saved || (listening && headset.test(listening.Label) && listening);
  const matchingHandsFree = microphone && handsFree.test(microphone.Label)
    && (!focus || deviceName(focus.Label) === deviceName(microphone.Label))
    && connectedHeadsets.find(device => handsFree.test(device.Label) && deviceName(device.Label) === deviceName(microphone.Label));
  if (savedLabel && !saved && !connectedHeadsets.length && !manual) return { choices };
  const selected = manual || matchingHandsFree || saved
    || (listening && (headset.test(listening.Label) || connectedHeadsets.length === 0) && listening)
    || (communication && headset.test(communication.Label) && communication)
    || (connectedHeadsets.length === 1 && connectedHeadsets[0])
    || (outputs.length === 1 && outputs[0]);
  return selected ? { inputLabel: input.Label, outputLabel: selected.Label } : { choices };
}

module.exports = { selectDevices };
