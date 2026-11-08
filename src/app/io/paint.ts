/**
 * Resolves after the browser has had a chance to paint, so a status set just
 * before long synchronous work shows: after the next frame, or after a short
 * wait where no frame comes (a hidden tab draws none).
 */
export function paint(): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const go = () => {
      if (done) return;
      done = true;
      setTimeout(resolve, 0);
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(go);
    setTimeout(go, 50);
  });
}
