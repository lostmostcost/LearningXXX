// AudioWorklet (WBS-023): forwards each block of microphone samples, as
// 32-bit floats at the context's sample rate, to the page. No processing here.
class PcmForward extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel && channel.length) this.port.postMessage(channel.slice(0));
    return true;
  }
}
registerProcessor("pcm-forward", PcmForward);
