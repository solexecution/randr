import './ui/styles.css';
import { App } from './ui/app.js';

const root = document.getElementById('root');
const app = new App(root);
window.__forgeApp = app; // dev aid: inspect state from the console
app.start().catch((err) => {
  root.innerHTML = `<div style="padding:40px;font-family:monospace;color:#ef5350">
    Failed to start: ${err.message}</div>`;
  console.error(err);
});

// Register the service worker for offline use (production build only).
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(import.meta.env.BASE_URL + 'sw.js').catch(() => {});
  });
}
