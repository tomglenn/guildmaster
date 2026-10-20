import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { initializeAppearance } from './appearance';
import './styles.css';
import './guildhall.css';
import './guildhall-components.css';
import './guildhall-rich-content.css';
import './guildhall-mockup.css';
import './guildhall-records.css';

initializeAppearance();

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
