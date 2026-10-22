import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { initializeAppearance } from './appearance';
import './styles.css';
import './cyberpunk.css';
import './guildhall.css';
import './workspace-themes.css';

initializeAppearance();

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
