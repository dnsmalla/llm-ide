import type Sigma from "sigma";
import type { CameraState } from "sigma/types";

export interface FpsResult {
  /** rAF callbacks per second (browser frames). */
  fpsRaf: number;
  /** sigma `afterRender` events per second (sigma draws). */
  fpsRender: number;
  framesRaf: number;
  framesRender: number;
  elapsedMs: number;
}

/**
 * Scripted 5 s camera move (pan + zoom in, pan + zoom out, return) through
 * sigma's camera animation. Counts requestAnimationFrame callbacks and sigma
 * `afterRender` events over the same window.
 */
export async function measureCameraFps(sigma: Sigma): Promise<FpsResult> {
  const camera = sigma.getCamera();
  const steps: Array<[Partial<CameraState>, number]> = [
    [{ x: 0.25, y: 0.6, ratio: 0.5 }, 1600],
    [{ x: 0.75, y: 0.4, ratio: 1.6 }, 1700],
    [{ x: 0.5, y: 0.5, ratio: 1 }, 1700],
  ];
  let framesRaf = 0;
  let framesRender = 0;
  let running = true;
  const tick = () => {
    if (!running) return;
    framesRaf++;
    requestAnimationFrame(tick);
  };
  const onRender = () => {
    if (running) framesRender++;
  };
  sigma.on("afterRender", onRender);
  const start = performance.now();
  requestAnimationFrame(tick);
  try {
    for (const [state, duration] of steps) {
      await camera.animate(state, { duration });
    }
  } finally {
    running = false;
    sigma.off("afterRender", onRender);
  }
  const elapsedMs = performance.now() - start;
  const secs = elapsedMs / 1000;
  return { fpsRaf: framesRaf / secs, fpsRender: framesRender / secs, framesRaf, framesRender, elapsedMs };
}
