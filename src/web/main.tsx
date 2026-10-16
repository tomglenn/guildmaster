import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { initializeAppearance } from './appearance';
import './styles.css';

initializeAppearance();

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
