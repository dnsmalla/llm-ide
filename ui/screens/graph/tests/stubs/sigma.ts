// Node has no WebGL: the component tests render server-side and never mount a view, so sigma is stubbed.
export default class Sigma {
  constructor() {
    throw new Error("sigma is stubbed in node tests");
  }
}
