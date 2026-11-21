import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.jsx';
import './styles.css';

const rootEl = document.getElementById('root');
if (rootEl === null) {
  throw new Error('Root element missing from index.html');
}
createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
