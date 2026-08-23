import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';
import './observability.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

// SW from the origin root so its scope covers the app (the spec's known gotcha).
if ('serviceWorker' in navigator && !import.meta.env.DEV) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      /* offline shell is a nicety; the board still works without it */
    });
  });
}
