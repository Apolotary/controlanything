/** Bootstrap: the app, or the morning spike (?spike=camera). */
import '@fontsource/chakra-petch/600.css';
import '@fontsource/chakra-petch/700.css';
import '@fontsource/share-tech-mono/400.css';
import './style.css';

const params = new URLSearchParams(location.search);

async function boot(): Promise<void> {
  try {
    if (params.get('spike') === 'camera') {
      const m = await import('./spike-camera');
      await m.runCameraSpike(params);
    } else {
      const m = await import('./app');
      await m.startApp(params);
    }
  } catch (e) {
    console.error(e);
    const pre = document.createElement('pre');
    pre.style.cssText = 'position:fixed;inset:auto 0 0 0;max-height:40vh;overflow:auto;margin:0;padding:10px;background:#300;color:#fdd;font:12px monospace;z-index:9';
    pre.textContent = `startup failed: ${(e as Error).stack ?? String(e)}`;
    document.body.appendChild(pre);
  }
}

void boot();
